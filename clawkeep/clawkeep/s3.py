"""S3 transport against the R2 prefix the portal grants us.

Each backup run uploads one `.tar.gz`; cloud usage is `sum(sizes)` over the
prefix and `snapshot_count` is `count(objects)` under the prefix. Restore
goes the other way: list snapshots, download a chosen one, hand it to the
restore module to extract.

`boto3` is imported lazily so the rest of the package (config parsing,
unit tests, etc.) can run on a host that has not yet installed boto3.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .api import Credentials

# Sidecar object that annotates snapshots with a human label + lock flag.
# Lives in the SAME prefix as the backups but is NEVER itself a snapshot:
# it is excluded from list_snapshots()/stats() so it can't show up in the
# UI or be counted against the user's quota / snapshotCount.
MANIFEST_OBJECT = "manifest.json"
MANIFEST_VERSION = 1


class S3Error(Exception):
    pass


@dataclass(frozen=True)
class CloudStats:
    cloud_bytes: int
    snapshot_count: int


@dataclass(frozen=True)
class Snapshot:
    """One backup file under the prefix as the UI sees it."""
    name: str               # object name relative to the prefix (e.g. "<ts>-openclaw-backup.tar.gz")
    size_bytes: int
    last_modified_ms: int   # unix ms — easy for the React side to format with timeAgo()
    # Annotations merged in from manifest.json. A snapshot with no manifest
    # entry (e.g. created before this feature shipped) reads back as
    # label=None, locked=False — i.e. unnamed and unprotected.
    label: Optional[str] = None
    locked: bool = False


def _join(prefix: str, name: str) -> str:
    """Compose the object key. The portal-issued prefix may or may not end
    with a slash — the canonical layout in section 3 of clawkeep-plan.md
    treats the prefix as a directory."""
    if not prefix:
        return name
    if prefix.endswith("/"):
        return prefix + name
    return f"{prefix}/{name}"


def _client(creds: Credentials) -> Any:
    """Build an S3 client pointed at the portal-issued R2 endpoint.

    Imported lazily so callers that never reach upload() (tests, dry-runs)
    don't need boto3 on their PYTHONPATH.
    """
    try:
        import boto3
        from botocore.config import Config as BotoConfig
    except ImportError as e:  # pragma: no cover — install-time configuration error
        raise S3Error(
            "boto3 is required for clawkeep cloud uploads but is not installed. "
            "Install with `pip install boto3`."
        ) from e

    cfg = BotoConfig(
        # R2 expects "auto" as the SigV4 region. Anything else (e.g. us-east-1)
        # signs correctly but Cloudflare rejects with SignatureDoesNotMatch on
        # presigned URLs. "auto" is the documented value.
        region_name="auto",
        signature_version="s3v4",
        retries={"max_attempts": 3, "mode": "standard"},
        s3={"addressing_style": "path"},
    )
    return boto3.client(
        "s3",
        endpoint_url=creds.endpoint,
        aws_access_key_id=creds.accessKeyId,
        aws_secret_access_key=creds.secretAccessKey,
        aws_session_token=creds.sessionToken,
        config=cfg,
    )


def upload(
    creds: Credentials,
    *,
    archive_path: Path,
    object_name: str,
    progress_cb: Optional[Callable[[int], None]] = None,
) -> str:
    """PUT the archive into s3://<bucket>/<prefix>/<object_name>. Returns the key.

    Uses boto3's `upload_file` which transparently switches to multipart for
    files >8MB — the openclaw archive is typically hundreds of MB on a real
    Jetson, so multipart matters.

    `progress_cb` is forwarded as boto3's `Callback=` and fires per chunk with
    the *delta* bytes transferred since the last call — the runner accumulates
    those into the live upload-progress fields in state.json so the UI can
    show MB/s.
    """
    try:
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover
        raise S3Error("boto3/botocore not installed") from e

    cli = _client(creds)
    key = _join(creds.prefix, object_name)
    try:
        cli.upload_file(str(archive_path), creds.bucket, key, Callback=progress_cb)
    except (BotoCoreError, ClientError, OSError) as e:
        raise S3Error(f"upload failed for s3://{creds.bucket}/{key}: {e}") from e
    return key


def _empty_manifest() -> dict[str, Any]:
    return {"version": MANIFEST_VERSION, "snapshots": {}}


def read_manifest(creds: Credentials) -> dict[str, Any]:
    """GET manifest.json from the prefix. A missing manifest (NoSuchKey) is
    not an error — it just means nothing has been annotated yet, so we return
    a fresh empty manifest. Any other S3 failure is surfaced as S3Error.

    The returned dict always has a well-formed `{"version", "snapshots": {}}`
    shape so callers can index `["snapshots"]` without guarding."""
    try:
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover
        raise S3Error("boto3/botocore not installed") from e

    cli = _client(creds)
    key = _join(creds.prefix, MANIFEST_OBJECT)
    try:
        resp = cli.get_object(Bucket=creds.bucket, Key=key)
        raw = resp["Body"].read()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404", "NotFound"):
            return _empty_manifest()
        raise S3Error(f"manifest read failed for s3://{creds.bucket}/{key}: {e}") from e
    except BotoCoreError as e:
        raise S3Error(f"manifest read failed for s3://{creds.bucket}/{key}: {e}") from e

    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        # A corrupt manifest shouldn't wedge backups — treat it as empty and
        # the next write rewrites it cleanly.
        return _empty_manifest()
    if not isinstance(data, dict):
        return _empty_manifest()
    snaps = data.get("snapshots")
    if not isinstance(snaps, dict):
        data["snapshots"] = {}
    data.setdefault("version", MANIFEST_VERSION)
    return data


def write_manifest(creds: Credentials, manifest: dict[str, Any]) -> None:
    """PUT manifest.json into the prefix (overwrites)."""
    try:
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover
        raise S3Error("boto3/botocore not installed") from e

    cli = _client(creds)
    key = _join(creds.prefix, MANIFEST_OBJECT)
    body = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
    try:
        cli.put_object(
            Bucket=creds.bucket,
            Key=key,
            Body=body,
            ContentType="application/json",
        )
    except (BotoCoreError, ClientError) as e:
        raise S3Error(f"manifest write failed for s3://{creds.bucket}/{key}: {e}") from e


def delete_snapshot(creds: Credentials, object_name: str) -> None:
    """DELETE one object under the prefix. Raises S3Error on failure.

    This is the raw object delete — callers are responsible for the
    locked-snapshot guard and for pruning the manifest entry."""
    try:
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover
        raise S3Error("boto3/botocore not installed") from e

    cli = _client(creds)
    key = _join(creds.prefix, object_name)
    try:
        cli.delete_object(Bucket=creds.bucket, Key=key)
    except (BotoCoreError, ClientError) as e:
        raise S3Error(f"delete failed for s3://{creds.bucket}/{key}: {e}") from e


def _strip_prefix(prefix: str, key: str) -> str:
    """Return the object name without the user prefix (so the UI never has
    to know about the prefix layout)."""
    if prefix and key.startswith(prefix):
        return key[len(prefix):].lstrip("/")
    return key


def _last_modified_ms(value: object) -> int:
    """Coerce list-objects-v2's LastModified (a datetime) to unix ms.
    botocore returns a tz-aware datetime; we accept None / strings defensively
    since stub clients in tests may pass either."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp() * 1000)
    return 0


def stats(creds: Credentials) -> CloudStats:
    """Sum sizes + count objects under the prefix."""
    try:
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover
        raise S3Error("boto3/botocore not installed") from e

    cli = _client(creds)
    total = 0
    count = 0
    try:
        paginator = cli.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=creds.bucket, Prefix=creds.prefix):
            for obj in page.get("Contents", []) or []:
                name = _strip_prefix(creds.prefix, str(obj.get("Key", "")))
                # The sidecar manifest is bookkeeping, not a backup — exclude it
                # from both byte usage and the snapshot count so the UI/quota
                # never see it.
                if name == MANIFEST_OBJECT:
                    continue
                total += int(obj.get("Size", 0))
                count += 1
    except (BotoCoreError, ClientError) as e:
        raise S3Error(f"list_objects_v2 failed for s3://{creds.bucket}/{creds.prefix}: {e}") from e
    return CloudStats(cloud_bytes=total, snapshot_count=count)


def list_snapshots(creds: Credentials) -> list[Snapshot]:
    """List every object under the prefix as a Snapshot, newest first.

    Newest-first ordering is the order the UI wants — the user almost always
    restores the most recent backup, so it goes at the top of the list and
    we don't need a client-side sort.
    """
    try:
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover
        raise S3Error("boto3/botocore not installed") from e

    # Manifest annotations are merged in below. A read failure here would be
    # surfaced as S3Error; a *missing* manifest yields an empty mapping so
    # every snapshot reads back as unnamed + unlocked (back-compat).
    manifest = read_manifest(creds)
    entries = manifest.get("snapshots", {})

    cli = _client(creds)
    out: list[Snapshot] = []
    try:
        paginator = cli.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=creds.bucket, Prefix=creds.prefix):
            for obj in page.get("Contents", []) or []:
                key = str(obj.get("Key", ""))
                if not key:
                    continue
                name = _strip_prefix(creds.prefix, key)
                # Skip "directory marker" objects (zero-byte, key ends with /) —
                # MinIO/some R2 lifecycles emit them, but they're not snapshots.
                if not name or name.endswith("/"):
                    continue
                # The sidecar manifest is never itself a snapshot.
                if name == MANIFEST_OBJECT:
                    continue
                entry = entries.get(name) if isinstance(entries, dict) else None
                label: Optional[str] = None
                locked = False
                if isinstance(entry, dict):
                    raw_label = entry.get("label")
                    label = raw_label if isinstance(raw_label, str) and raw_label else None
                    locked = bool(entry.get("locked", False))
                out.append(Snapshot(
                    name=name,
                    size_bytes=int(obj.get("Size", 0)),
                    last_modified_ms=_last_modified_ms(obj.get("LastModified")),
                    label=label,
                    locked=locked,
                ))
    except (BotoCoreError, ClientError) as e:
        raise S3Error(f"list_objects_v2 failed for s3://{creds.bucket}/{creds.prefix}: {e}") from e

    out.sort(key=lambda s: s.last_modified_ms, reverse=True)
    return out


def download(
    creds: Credentials,
    *,
    object_name: str,
    dest_path: Path,
) -> None:
    """GET an object into dest_path. Uses boto3's `download_file` so multipart
    transfer kicks in for the >300MB tarballs we routinely produce."""
    try:
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover
        raise S3Error("boto3/botocore not installed") from e

    cli = _client(creds)
    key = _join(creds.prefix, object_name)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        cli.download_file(creds.bucket, key, str(dest_path))
    except (BotoCoreError, ClientError, OSError) as e:
        raise S3Error(f"download failed for s3://{creds.bucket}/{key}: {e}") from e
