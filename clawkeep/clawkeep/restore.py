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

from . import api, crypto, openclaw, passphrase, s3
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


class WrongPasswordError(RestoreError):
    """Raised when the supplied passphrase fails to decrypt the archive.

    Distinct from generic RestoreError so the CLI / API surface can map it
    to a dedicated exit code (and the UI can prompt the user to re-enter
    their password instead of giving up on the restore entirely).
    """


class PassphraseMissingError(RestoreError):
    """Raised when the chosen archive is encrypted but no passphrase is
    available — neither on disk nor passed by the caller. The UI handles
    this by surfacing a password prompt.
    """


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


def _member_name_unsafe(member: tarfile.TarInfo, prefix: str) -> bool:
    """True if the member's *name* tries to escape `prefix` (absolute path or
    `..` segments). Path-traversal in member names is always fatal — there's
    no benign reason for an openclaw archive to ship one.
    """
    name = member.name
    if not name.startswith(prefix):
        return True
    tail = name[len(prefix):]
    if tail.startswith("/"):
        tail = tail[1:]
    parts = tail.split("/")
    return any(p == ".." for p in parts if p)


def _member_link_unsafe(member: tarfile.TarInfo) -> bool:
    """True for symlinks/hardlinks whose target is absolute. Relative `..`
    targets are allowed: openclaw plugin-runtime-deps legitimately ship
    symlinks with `..` in their target (e.g. `dist/.buildstamp`). The
    archive itself is cryptographically verified upstream by
    `openclaw backup verify`, so trusted symlinks are OK to extract; we
    still reject absolute targets as a defence-in-depth catch.
    """
    if not (member.islnk() or member.issym()):
        return False
    link = member.linkname or ""
    return link.startswith("/")


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
                if _member_name_unsafe(member, archive_subpath):
                    raise RestoreError(
                        f"archive contains an unsafe member: {member.name!r}"
                    )
                if _member_link_unsafe(member):
                    # Absolute symlink target — skip rather than abort the
                    # restore; the file isn't critical (openclaw rebuilds
                    # plugin metadata on next launch) and the alternative
                    # is failing the entire restore over a single bad link.
                    log.warning(
                        "skipping unsafe link %r → %r", member.name, member.linkname,
                    )
                    continue
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


def _rollback_swaps(done: list[RestoredAsset], *, ts: int) -> list[str]:
    """Reverse every successful asset swap. Used when a *later* asset's
    extract or swap fails — the user shouldn't be left with a mixed
    half-old/half-new state. Each entry's `target_path` currently holds
    the new content; `backup_path` holds the old. We rename the new aside
    (so the user can still recover it manually) and move the old back.

    Returns a list of human-readable error strings — one per asset whose
    rollback itself failed. The caller folds these into the user-facing
    RestoreError so on-call can see the full picture.
    """
    errors: list[str] = []
    for asset in done:
        try:
            new_aside = asset.target_path.with_name(
                f"{asset.target_path.name}.failed-rollback-{ts}",
            )
            asset.target_path.rename(new_aside)
            asset.backup_path.rename(asset.target_path)
        except OSError as e:
            errors.append(f"{asset.kind}: {e}")
    return errors


def _plaintext_name_for(snapshot_name: str, *, staging_dir: Path | None = None) -> str:
    """Strip the `.enc` suffix when present so the resulting name lands
    on the post-decrypt `.tar.gz`. Callers that pass an already-plain
    snapshot get a `.decrypted.tar.gz` suffix to keep it disambiguated
    from the (defensively-renamed) ciphertext sibling on disk.

    `staging_dir` is consulted when set: if the chosen plaintext name
    already exists in that directory (e.g. a half-finished previous
    restore got partially-cleaned), a numeric suffix is appended until
    the name is unique. Prevents two concurrent restores or a retry
    after a crash from silently overwriting an in-flight staging file.
    """
    if snapshot_name.endswith(crypto.ENCRYPTED_SUFFIX):
        base = snapshot_name[: -len(crypto.ENCRYPTED_SUFFIX)]
        suffix = ""
    else:
        base = snapshot_name
        suffix = ".decrypted.tar.gz"

    if staging_dir is None:
        return base + suffix

    candidate = base + suffix
    if not (staging_dir / candidate).exists():
        return candidate
    # Collision — append `.<n>` before the .tar.gz suffix until free.
    # Bounded probe so a permission error masquerading as "exists"
    # doesn't spin forever.
    for n in range(1, 1000):
        if suffix:
            probe = f"{base}.{n}{suffix}"
        else:
            # `base` already ends in .tar.gz; insert n before that suffix.
            stem = base[: -len(".tar.gz")] if base.endswith(".tar.gz") else base
            ext = ".tar.gz" if base.endswith(".tar.gz") else ""
            probe = f"{stem}.{n}{ext}"
        if not (staging_dir / probe).exists():
            return probe
    # Fall through with the bare candidate; the open-for-write that
    # follows will surface the collision as a real error.
    return candidate


def _resolve_passphrase_file(
    explicit_path: Path | None,
    *,
    encrypted: bool,
) -> Path | None:
    """Return the passphrase file to use for decryption, or None if the
    archive is unencrypted (legacy `.tar.gz`).

    Order of preference:
      1. The caller's explicit path (the API route writes a 0600 tmpfile
         from a one-shot UI prompt and passes it here).
      2. The device-local stored passphrase, if present.
      3. None — only valid when the archive isn't encrypted.

    Raises PassphraseMissingError when an encrypted archive has no
    passphrase available from either source; the UI handles that signal
    by prompting and retrying with `explicit_path` set.
    """
    if not encrypted:
        return None
    if explicit_path is not None:
        if not explicit_path.is_file():
            raise PassphraseMissingError(
                f"explicit passphrase file does not exist: {explicit_path}",
            )
        return explicit_path
    if passphrase.is_set():
        return passphrase.default_passphrase_path()
    raise PassphraseMissingError(
        "archive is encrypted but no passphrase is set on this device",
    )


def restore_snapshot(
    cfg: Config,
    token: str,
    snapshot_name: str,
    *,
    passphrase_file: Path | None = None,
) -> RestoreResult:
    """Top-level orchestrator. Raises RestoreError on any failure; the live
    state on disk is rolled back to its pre-restore form (atomic rename) if
    the swap step fails partway through.

    `passphrase_file` is consulted first when the snapshot is encrypted —
    typically a 0600 tmpfile written by the API route from a one-shot UI
    prompt — falling back to the device-local stored passphrase. Pass
    None for unencrypted (legacy) snapshots.
    """
    # New-format archives always end in `.tar.gz.enc`; legacy ones end in
    # `.tar.gz`. We accept either so a mixed-archive prefix is restorable.
    if snapshot_name.endswith(crypto.ENCRYPTED_SUFFIX):
        if not snapshot_name.endswith(".tar.gz" + crypto.ENCRYPTED_SUFFIX):
            raise RestoreError(
                f"expected .tar.gz{crypto.ENCRYPTED_SUFFIX} snapshot name, got {snapshot_name!r}",
            )
        is_encrypted_name = True
    elif snapshot_name.endswith(".tar.gz"):
        is_encrypted_name = False
    else:
        raise RestoreError(f"expected a .tar.gz snapshot name, got {snapshot_name!r}")

    creds = api.mint_credentials(cfg.server, token)

    staging_dir = Path(tempfile.mkdtemp(prefix="clawkeep-restore-"))
    archive_path = staging_dir / snapshot_name
    try:
        log.info("downloading snapshot %s", snapshot_name)
        s3.download(creds, object_name=snapshot_name, dest_path=archive_path)
        size = archive_path.stat().st_size

        # Sniff the header — a legacy `.tar.gz` could in theory be an
        # encrypted blob misnamed at upload time, and vice versa. The
        # filename suffix is the primary signal; the magic check is a
        # cheap belt-and-suspenders so we never feed openclaw a
        # ciphertext to "verify".
        header_says_encrypted = crypto.is_likely_encrypted(archive_path)
        encrypted = is_encrypted_name or header_says_encrypted

        if encrypted:
            pw_file = _resolve_passphrase_file(passphrase_file, encrypted=True)
            assert pw_file is not None  # encrypted=True guarantees this
            decrypted_path = staging_dir / _plaintext_name_for(
                snapshot_name, staging_dir=staging_dir,
            )
            log.info("decrypting %s (%d bytes)", archive_path, size)
            try:
                crypto.decrypt_file(
                    ciphertext_path=archive_path,
                    plaintext_path=decrypted_path,
                    password_file=pw_file,
                )
            except crypto.CryptoError as e:
                if crypto.is_bad_password_error(e):
                    raise WrongPasswordError(
                        "the passphrase did not decrypt this archive",
                    ) from e
                raise RestoreError(f"decryption failed: {e}") from e
            # Drop the on-disk ciphertext now that we have the plaintext;
            # re-running restore on a failure would just re-download it.
            try:
                archive_path.unlink(missing_ok=True)
            except OSError:  # pragma: no cover — best effort
                pass
            archive_path = decrypted_path
            size = archive_path.stat().st_size
            # Fix up the snapshot name we feed to verify_archive / manifest
            # readers below — they expect the plaintext form.
            snapshot_name = archive_path.name

        log.info("verifying %s (%d bytes)", archive_path, size)
        try:
            openclaw.verify_archive(cfg.openclaw.binary, archive_path)
        except openclaw.OpenclawError as e:
            raise RestoreError(f"archive verify failed: {e}") from e

        ts = int(time.time())
        results: list[RestoredAsset] = []

        # Read the manifest with one tarball open. We re-open per asset
        # below because gzip framing makes seek-back expensive — streaming
        # forward from a fresh handle is cheaper than rewinding a shared
        # one across multi-hundred-MB archives.
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
            try:
                bytes_restored = _extract_asset(
                    archive_path,
                    archive_subpath=archive_subpath,
                    staging_root=asset_staging,
                )
                backup = _swap_into_place(asset_staging, target, ts=ts)
            except Exception as primary:
                # An asset failure after earlier assets already swapped would
                # leave the device with a mixed restore (some new content,
                # some old). Reverse every successful swap so the user lands
                # back where they started.
                rollback_errs = _rollback_swaps(results, ts=ts)
                msg = f"asset {kind!r} failed: {primary}"
                if rollback_errs:
                    msg += f" (cross-asset rollback errors: {'; '.join(rollback_errs)})"
                raise RestoreError(msg) from primary

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
