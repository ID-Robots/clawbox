"""Restore an `openclaw backup` archive over the live state directory.

Pipeline:
    1. Mint creds from the portal (so the user's quota/expiry is honoured).
    2. Download the chosen snapshot to a staging file.
    3. `openclaw backup verify` the staging file. Fail loudly if the archive
       was corrupted in transit or signed with a different layout — we'd
       rather refuse to touch ~/.openclaw than half-restore it.
    4. Read the archive's manifest.json to discover which on-disk source
       paths each asset wants to land at.
    5. For each asset: extract its sub-tree from `payload/posix/...` into a
       sibling staging directory next to the live target.
    6. Atomic-rename the live target to a `.bak-restore-<ts>` directory and
       the staging directory into place. We swap atomically so the gateway
       (which keeps file handles open while running) sees a consistent
       directory at any point in time.

We do NOT restart any systemd services here — that's the caller's job. The
TS bridge invokes `sudo systemctl restart clawbox-gateway` after a
successful restore so user-facing services pick up the swapped state.
"""

from __future__ import annotations

import json
import logging
import shutil
import tarfile
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from . import api, openclaw, s3
from .config import Config

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class RestoredAsset:
    kind: str           # "state" / "credentials" / etc — straight from the manifest
    target_path: Path   # where the asset was placed on disk
    backup_path: Path   # where the previous content was moved aside
    bytes_restored: int


@dataclass(frozen=True)
class RestoreResult:
    archive_name: str
    archive_size_bytes: int
    assets: list[RestoredAsset]


class RestoreError(Exception):
    pass


def _read_manifest_from_open(tf: tarfile.TarFile, archive_root: str) -> dict:
    """Pull `<root>/manifest.json` out of an already-open tarball.

    Reusing the same TarFile across the manifest read and the asset
    extraction below saves a full gzip-stream restart on multi-hundred-MB
    archives.
    """
    member_name = f"{archive_root}/manifest.json"
    try:
        m = tf.getmember(member_name)
    except KeyError as e:
        raise RestoreError(f"archive missing manifest.json (looked for {member_name!r})") from e
    extracted = tf.extractfile(m)
    if extracted is None:
        raise RestoreError("manifest.json is not a regular file in the archive")
    data = extracted.read()
    try:
        meta = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise RestoreError(f"manifest.json is not valid UTF-8 JSON: {e}") from e
    if not isinstance(meta, dict):
        raise RestoreError(f"manifest.json must be a JSON object, got {type(meta).__name__}")
    return meta


def _read_manifest(archive_path: Path, archive_root: str) -> dict:
    """Standalone manifest read — kept for tests / ad-hoc tooling. The hot
    path uses `_read_manifest_from_open` to avoid re-opening the tarball."""
    try:
        with tarfile.open(archive_path, "r:gz") as tf:
            return _read_manifest_from_open(tf, archive_root)
    except (tarfile.TarError, OSError) as e:
        raise RestoreError(f"could not read manifest from {archive_path}: {e}") from e


def _safe_member(member: tarfile.TarInfo, prefix: str) -> bool:
    """Reject path-traversal members. tarfile.data_filter (Python 3.12+)
    handles this, but we still target 3.10. The archive layout is fixed
    under `<root>/payload/posix/...` so anything outside that is suspicious.

    Returns True if the member is in-prefix and safe to extract.
    """
    name = member.name
    if not name.startswith(prefix):
        return False
    # Block absolute paths and `..` segments anywhere inside the relative tail.
    tail = name[len(prefix):]
    if tail.startswith("/"):
        tail = tail[1:]
    parts = tail.split("/")
    if any(p in ("..", "") for p in parts if p):
        return False
    if member.islnk() or member.issym():
        # Symlinks/hardlinks aren't part of the openclaw archive layout we
        # know — refuse to extract them rather than risk traversal via
        # symlink-into-arbitrary-paths.
        link = member.linkname or ""
        if link.startswith("/") or ".." in link.split("/"):
            return False
    return True


def _extract_asset_from_open(
    tf: tarfile.TarFile,
    *,
    archive_subpath: str,
    staging_root: Path,
) -> int:
    """Extract every member under `archive_subpath/` into `staging_root/`.

    `archive_subpath` is `<root>/payload/posix/<absolute-source-path>` per
    the openclaw layout. We strip that prefix off each member name so
    the extracted tree mirrors `<absolute-source-path>` rooted at
    `staging_root`. Returns the total bytes extracted (sum of regular-file
    sizes) so the caller doesn't have to re-walk the directory.

    The TarFile must already be positioned at the start (a fresh `open` —
    after manifest read we re-open in the caller because tarfile doesn't
    support seek-back across gzip frames cheaply).
    """
    staging_root.mkdir(parents=True, exist_ok=True)
    prefix = archive_subpath.rstrip("/") + "/"

    bytes_extracted = 0
    extracted_any = False
    try:
        # Stream rather than `getmembers()` — for ~10k-entry archives the
        # full TarInfo list is multiple megabytes of Python objects we
        # don't need to hold simultaneously.
        for member in tf:
            if member.name == archive_subpath or member.name.startswith(prefix):
                if not _safe_member(member, archive_subpath):
                    raise RestoreError(
                        f"archive contains an unsafe member: {member.name!r}"
                    )
                relative = member.name[len(prefix):] if member.name != archive_subpath else ""
                if not relative:
                    continue
                member.name = relative
                tf.extract(member, path=staging_root)
                if member.isfile():
                    bytes_extracted += member.size
                extracted_any = True
    except (tarfile.TarError, OSError) as e:
        raise RestoreError(f"extraction failed for {archive_subpath}: {e}") from e

    if not extracted_any:
        raise RestoreError(f"no members under {archive_subpath} in archive")
    return bytes_extracted


def _extract_asset(
    archive_path: Path,
    *,
    archive_subpath: str,
    staging_root: Path,
) -> int:
    """Standalone variant — opens the tarball just for one asset. Kept for
    tests; the orchestrator uses `_extract_asset_from_open` to share a
    single TarFile across all assets."""
    try:
        with tarfile.open(archive_path, "r:gz") as tf:
            return _extract_asset_from_open(
                tf, archive_subpath=archive_subpath, staging_root=staging_root,
            )
    except (tarfile.TarError, OSError) as e:
        raise RestoreError(f"extraction failed for {archive_subpath}: {e}") from e


def _swap_into_place(staging: Path, target: Path, *, ts: int) -> Path:
    """Move `target` aside to `<target>.bak-restore-<ts>`, then move
    `staging` to `target`. Returns the path of the moved-aside backup.

    Atomic-rename semantics on Linux mean processes that hold file handles
    inside the old `target` keep seeing those bytes (their handles still
    reference the original inodes), while new opens see the new tree.
    """
    backup = target.with_name(f"{target.name}.bak-restore-{ts}")
    if backup.exists():
        # Astronomically unlikely (timestamp collision) but defend anyway —
        # losing a previous restore's backup directory would be bad.
        raise RestoreError(f"backup target {backup} already exists; aborting restore")

    target_existed = target.exists()
    if target_existed:
        try:
            target.rename(backup)
        except OSError as e:
            raise RestoreError(f"could not move {target} aside to {backup}: {e}") from e

    try:
        staging.rename(target)
    except OSError as e:
        # Best-effort rollback so the user isn't left with no live state at
        # all. If this rollback fails we surface both errors so ops can see
        # what went wrong.
        rollback_err = ""
        if target_existed:
            try:
                backup.rename(target)
            except OSError as e2:
                rollback_err = f" (rollback failed: {e2})"
        raise RestoreError(
            f"could not move {staging} into place at {target}: {e}{rollback_err}",
        ) from e

    return backup


def restore_snapshot(cfg: Config, token: str, snapshot_name: str) -> RestoreResult:
    """Top-level orchestrator. Raises RestoreError on any failure; the live
    state on disk is rolled back to its pre-restore form (atomic rename) if
    the swap step fails partway through.
    """
    if not snapshot_name.endswith(".tar.gz"):
        raise RestoreError(f"expected a .tar.gz snapshot name, got {snapshot_name!r}")

    creds = api.mint_credentials(cfg.server, token)

    staging_dir = Path(tempfile.mkdtemp(prefix="clawkeep-restore-"))
    archive_path = staging_dir / snapshot_name
    try:
        log.info("downloading snapshot %s", snapshot_name)
        s3.download(creds, object_name=snapshot_name, dest_path=archive_path)
        size = archive_path.stat().st_size

        log.info("verifying %s (%d bytes)", archive_path, size)
        try:
            openclaw.verify_archive(cfg.openclaw.binary, archive_path)
        except openclaw.OpenclawError as e:
            raise RestoreError(f"archive verify failed: {e}") from e

        ts = int(time.time())
        results: list[RestoredAsset] = []

        # Read manifest + extract assets from a single open of the tarball.
        # gzip framing makes seek-back expensive, so we re-open per asset
        # below for actual extraction; the manifest is small and lives at
        # the top of the archive, so reading it first is cheap.
        try:
            with tarfile.open(archive_path, "r:gz") as tf:
                manifest = _read_manifest_from_open(tf, snapshot_name[: -len(".tar.gz")])
        except (tarfile.TarError, OSError) as e:
            raise RestoreError(f"could not read manifest from {archive_path}: {e}") from e

        archive_root = str(manifest.get("archiveRoot", "")).strip()
        if not archive_root:
            raise RestoreError("manifest is missing archiveRoot")
        assets = manifest.get("assets", [])
        if not isinstance(assets, list) or not assets:
            raise RestoreError("manifest declares no assets to restore")

        for asset in assets:
            if not isinstance(asset, dict):
                raise RestoreError(f"manifest asset is not an object: {asset!r}")
            kind = str(asset.get("kind", ""))
            source_path = asset.get("sourcePath")
            archive_subpath = asset.get("archivePath")
            if not isinstance(source_path, str) or not source_path:
                raise RestoreError(f"manifest asset missing sourcePath: {asset!r}")
            if not isinstance(archive_subpath, str) or not archive_subpath:
                raise RestoreError(f"manifest asset missing archivePath: {asset!r}")

            target = Path(source_path)
            asset_staging = staging_dir / f"asset-{kind}-{ts}"
            log.info("extracting asset %s → %s", kind, asset_staging)
            bytes_restored = _extract_asset(
                archive_path,
                archive_subpath=archive_subpath,
                staging_root=asset_staging,
            )

            backup = _swap_into_place(asset_staging, target, ts=ts)

            results.append(RestoredAsset(
                kind=kind,
                target_path=target,
                backup_path=backup,
                bytes_restored=bytes_restored,
            ))

        return RestoreResult(
            archive_name=snapshot_name,
            archive_size_bytes=size,
            assets=results,
        )
    finally:
        # Best-effort cleanup of the staging tree. The swap moved any
        # asset-staging children out, so what's left is the downloaded
        # archive + empty asset dirs. Don't raise from here — the restore
        # itself succeeded.
        try:
            shutil.rmtree(staging_dir, ignore_errors=True)
        except Exception as e:  # noqa: BLE001 — never let cleanup fail the restore
            log.warning("could not clean up restore staging at %s: %s", staging_dir, e)
