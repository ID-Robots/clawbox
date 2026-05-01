"""S3 transport against the R2 prefix the portal grants us.

Each backup run uploads one `.tar.gz`; cloud usage is `sum(sizes)` over the
prefix and `snapshot_count` is `count(objects)` under the prefix. Restore
goes the other way: list snapshots, download a chosen one, hand it to the
restore module to extract.

`boto3` is imported lazily so the rest of the package (config parsing,
unit tests, etc.) can run on a host that has not yet installed boto3.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .api import Credentials


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
                out.append(Snapshot(
                    name=name,
                    size_bytes=int(obj.get("Size", 0)),
                    last_modified_ms=_last_modified_ms(obj.get("LastModified")),
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
