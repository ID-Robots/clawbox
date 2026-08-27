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
import os
import shutil
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import agent, api, crypto, passphrase, s3
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
    #: Members deliberately NOT recreated (unsafe absolute symlinks). Almost
    #: always empty. Carried out to the caller rather than left in the log so
    #: a restore that dropped something can never present itself as complete.
    skipped_members: list[str] = field(default_factory=list)


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


def _find_manifest_member(tf: tarfile.TarFile) -> str | None:
    """The archive's own `<root>/manifest.json`, found by looking.

    The root is normally derivable from the snapshot NAME, but not always: a
    plaintext `.tar.gz` that `crypto.is_likely_encrypted()` misreads gets run
    through the decrypt path and renamed to `<name>.decrypted.tar.gz`, and the
    name-derived lookup then asks for a root that was never in the tarball and
    fails with "archive missing manifest.json" on an archive that is perfectly
    good. Looking costs one pass and cannot be wrong.
    """
    for member in tf:
        if member.name.endswith("/manifest.json") and member.name.count("/") == 1:
            return member.name
    return None


def _read_manifest_from_open(tf: tarfile.TarFile, archive_root: str) -> dict:
    """Pull `<root>/manifest.json` out of an already-open tarball.

    Reusing the same TarFile across the manifest read and the asset
    extraction below saves a full gzip-stream restart on multi-hundred-MB
    archives.
    """
    member_name = f"{archive_root}/manifest.json"
    try:
        m = tf.getmember(member_name)
    except KeyError:
        # Fall back to whatever root the tarball actually has — see
        # `_find_manifest_member` for the case that makes the name unreliable.
        found = _find_manifest_member(tf)
        if found is None:
            raise RestoreError(
                f"archive missing manifest.json (looked for {member_name!r})",
            ) from None
        m = tf.getmember(found)
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


# Python 3.12 warns about an unset extraction filter and 3.14 DEFAULTS to
# `data`, which refuses absolute symlinks — exactly the ones
# `_link_target_allowed` exists to permit, so a restore that works on the
# device's 3.10 today would start silently dropping the identity bridge on a
# newer interpreter. `fully_trusted` restores the historical behaviour, and it
# is safe HERE specifically because this module does its own vetting first:
# every member passes `_member_name_unsafe` (no absolute paths, no `..`) and
# every link passes `_member_link_unsafe` / `_link_target_allowed`, on a
# tarball whose integrity was already verified. The keyword does not exist
# before 3.12, hence the version gate rather than passing it unconditionally.
_EXTRACT_KWARGS: dict[str, str] = (
    {"filter": "fully_trusted"} if sys.version_info >= (3, 12) else {}
)


def _link_target_allowed(link: str, allowed_roots: tuple[str, ...]) -> bool:
    """May an ABSOLUTE symlink target be recreated?

    Yes when it points inside something this very archive declares it owns.
    The Hermes shared-identity bridge is exactly that shape:
    `~/.hermes/SOUL.md` and `~/.hermes/memories/{MEMORY,USER}.md` are absolute
    symlinks into `~/.clawbox/agent-identity/`, which the manifest lists as its
    own `identity` asset. Refusing them meant a restore quietly dropped the
    agent's memory pointers and still reported success -- observed on the QA
    box, where `memories/` came back holding nothing but a stale lock file.

    Everything else absolute stays refused. A link to /etc/shadow is not made
    safe by being inside a verified tarball.
    """
    target = os.path.normpath(link)
    return any(
        target == root or target.startswith(root.rstrip("/") + "/")
        for root in allowed_roots
    )


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


def _extract_file_from_open(
    tf: tarfile.TarFile,
    *,
    archive_subpath: str,
    staging_root: Path,
) -> Path:
    """Extract a SINGLE-FILE asset: the one member whose name is exactly
    `archive_subpath`.

    The directory extractor below cannot do this. It computes each member's
    path relative to `archive_subpath` and skips the empty result, so an asset
    that IS the subpath extracts nothing and then fails with "no members
    under …". OpenClaw never hit that, because every asset it declares is a
    directory; Hermes' `config.yaml`, `.env` and `state.db` are files, and they
    are the three most important things in its archive.

    Returns the PATH it wrote, rather than a byte count, so the caller never
    has to re-derive the name. It used to look for `staging_root/<sourcePath
    basename>` while this wrote `staging_root/<archivePath basename>` — the two
    agree only because the Hermes layout embeds one inside the other, and a
    manifest that broke that coincidence would move the live target aside and
    then fail to rename anything into place.

    (There is no `allowed_roots` here on purpose: a single-file asset is one
    regular file, checked below, so there is no link-target policy to apply.)
    """
    staging_root.mkdir(parents=True, exist_ok=True)
    name = archive_subpath.rsplit("/", 1)[-1]
    try:
        for member in tf:
            if member.name != archive_subpath:
                continue
            if not member.isfile():
                raise RestoreError(
                    f"{archive_subpath!r} is declared as a file asset but is "
                    "not a regular file in the archive",
                )
            member.name = name
            tf.extract(member, path=staging_root, **_EXTRACT_KWARGS)
            return staging_root / name
    except (tarfile.TarError, OSError) as e:
        raise RestoreError(f"extraction failed for {archive_subpath}: {e}") from e
    raise RestoreError(f"no member at {archive_subpath} in archive")


def _extract_asset_from_open(
    tf: tarfile.TarFile,
    *,
    archive_subpath: str,
    staging_root: Path,
    allowed_roots: tuple[str, ...] = (),
    skipped: list[str] | None = None,
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
                if _member_link_unsafe(member) and not _link_target_allowed(
                    member.linkname or "", allowed_roots,
                ):
                    # An absolute symlink pointing OUTSIDE anything this
                    # archive owns. Skipped rather than aborting the whole
                    # restore over one bad link — but RECORDED, so the caller
                    # can say what did not come back. Dropping members and
                    # then reporting success is the exact failure this file
                    # is otherwise so careful about.
                    log.warning(
                        "skipping unsafe link %r → %r", member.name, member.linkname,
                    )
                    if skipped is not None:
                        skipped.append(f"{member.name} → {member.linkname}")
                    continue
                relative = member.name[len(prefix):] if member.name != archive_subpath else ""
                if not relative:
                    if not member.isdir():
                        # The asset root is in the archive but is not a
                        # directory — a symlink, most likely. Treating it as
                        # proof of presence would hand `_swap_into_place` an
                        # empty staging directory to move over live data.
                        raise RestoreError(
                            f"{archive_subpath!r} is declared as a directory asset "
                            f"but the archive holds it as {member.type!r}",
                        )
                    # The asset's own root directory. There is nothing to
                    # extract for it -- `staging_root` already exists -- but
                    # seeing it PROVES the asset is present in the archive,
                    # which for an EMPTY directory is the only proof there
                    # will ever be.
                    #
                    # Not counting it was a restore-stopping bug: `~/.hermes`
                    # ships `hooks/` and `pairing/` empty on a real box, so
                    # the loop below found no children, `extracted_any` stayed
                    # False, and the whole restore aborted on "no members
                    # under ..." -- after earlier assets had already been
                    # swapped, so the customer got a rollback instead of their
                    # data. Observed on the Hermes QA box, not theorised.
                    extracted_any = True
                    continue
                member.name = relative
                tf.extract(member, path=staging_root, **_EXTRACT_KWARGS)
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
    entry: str = "dir",
    allowed_roots: tuple[str, ...] = (),
    skipped: list[str] | None = None,
) -> tuple[int, Path]:
    """Extract one asset. Returns `(bytes_extracted, path_to_swap_into_place)`.

    The second element is what removes the old coupling: a directory asset
    swaps `staging_root` itself, a file asset swaps the file the extractor
    actually wrote, and only the extractor decides which.
    """
    try:
        with tarfile.open(archive_path, "r:gz") as tf:
            if entry == "file":
                written = _extract_file_from_open(
                    tf, archive_subpath=archive_subpath, staging_root=staging_root,
                )
                return written.stat().st_size, written
            extracted = _extract_asset_from_open(
                tf,
                archive_subpath=archive_subpath,
                staging_root=staging_root,
                allowed_roots=allowed_roots,
                skipped=skipped,
            )
            return extracted, staging_root
    except RestoreError:
        # Already a typed, human-readable failure from the extractor — do not
        # re-wrap it as "extraction failed" and lose the reason.
        raise
    except (tarfile.TarError, OSError) as e:
        raise RestoreError(f"extraction failed for {archive_subpath}: {e}") from e


def _staging_beside(target: Path, *, kind: str, ts: int) -> Path:
    """Where an asset is built before it is swapped in: a hidden SIBLING of the
    live target, not a child of the downloaded-archive tmpdir.

    `Path.rename` is `rename(2)`, which refuses to cross filesystems (EXDEV).
    Staging under `tempfile.mkdtemp()` and then renaming onto `~/.hermes/…`
    is a restore that dies at the very last step on any box where /tmp is its
    own mount — a tmpfs, which is the norm on a Jetson image. A sibling is
    always on the target's own filesystem, so the swap is both possible AND
    atomic, and atomicity is the property this whole design rests on.

    (The module docstring has said "a sibling staging directory next to the
    live target" since the first version. The code did not do it.)
    """
    return target.with_name(f".clawkeep-restore-{kind}-{ts}-{target.name}")


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


def _retire_sqlite_sidecars(target: Path, *, ts: int) -> None:
    """Move a restored database's stale `-wal` / `-shm` files aside.

    A sqlite database in WAL mode keeps its most recent writes in a `-wal`
    sidecar — 2.6 MB of them on the QA box, against a 2.8 MB `state.db`. The
    copy in the archive came through `Connection.backup()`, so it is already
    fully checkpointed and complete on its own. The sidecars sitting next to
    it belong to the database we just moved OUT of the way, and sqlite decides
    whether to replay a WAL by looking for the file, not by asking whether it
    matches: leaving them is how a correct restore turns into a corrupt or
    silently-stale history on the next open.

    Moved aside rather than deleted, and beside the same `.bak-restore-<ts>`
    suffix as the database itself, so a restore stays fully reversible by
    hand. Failures are logged, not raised — the data is already in place, and
    the caller finding out about a `-shm` it could not rename is not worth
    rolling back a good restore.
    """
    for suffix in ("-wal", "-shm"):
        sidecar = target.with_name(target.name + suffix)
        if not sidecar.exists():
            continue
        try:
            sidecar.rename(sidecar.with_name(f"{sidecar.name}.bak-restore-{ts}"))
        except OSError as e:  # pragma: no cover — best effort
            log.warning("could not move sqlite sidecar %s aside: %s", sidecar, e)


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
    # Asset staging happens beside each live target (see `_staging_beside`),
    # which is outside `staging_dir` and so outside its cleanup. Track them so
    # a failure part-way through does not leave `.clawkeep-restore-*` litter in
    # the customer's state directory.
    sibling_stagings: list[Path] = []
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

        # The manifest is read BEFORE the integrity check, because WHICH
        # verifier to run is a property of the ARCHIVE rather than of this box:
        # an OpenClaw snapshot is verified by `openclaw backup verify` and a
        # Hermes one by our own reader. Reading it first costs one tarball open
        # and buys a plain-language refusal for the cross-edition case instead
        # of a raw "verify failed (rc=1)". Nothing on disk is touched until
        # after the verify either way, so the guarantee is unchanged.
        #
        # We re-open per asset below because gzip framing makes seek-back
        # expensive — streaming forward from a fresh handle is cheaper than
        # rewinding a shared one across multi-hundred-MB archives.
        try:
            with tarfile.open(archive_path, "r:gz") as tf:
                manifest = _read_manifest_from_open(tf, snapshot_name[: -len(".tar.gz")])
        except (tarfile.TarError, OSError) as e:
            raise RestoreError(f"could not read manifest from {archive_path}: {e}") from e

        # One portal account gets ONE R2 prefix, shared by every device paired
        # to it — so this snapshot list legitimately holds other devices'
        # backups, including this box's own from before it was converted to the
        # other edition (a converted box keeps its `~/.clawkeep` pairing, and
        # its stale `~/.openclaw` alongside the live `~/.hermes`). Swapping an
        # OpenClaw snapshot onto a Hermes box would restore state the running
        # agent never reads and report success. Refuse by name, before anything
        # is verified or moved.
        try:
            agent.assert_archive_matches_device(manifest)
        except agent.AgentMismatchError as e:
            raise RestoreError(str(e)) from e

        log.info("verifying %s (%d bytes)", archive_path, size)
        try:
            agent.verify_archive(cfg, archive_path, agent=agent.archive_agent(manifest))
        except agent.ARCHIVE_ERRORS as e:
            raise RestoreError(f"archive verify failed: {e}") from e

        ts = int(time.time())
        results: list[RestoredAsset] = []

        archive_root = str(manifest.get("archiveRoot", "")).strip()
        if not archive_root:
            raise RestoreError("manifest is missing archiveRoot")
        assets = manifest.get("assets", [])
        if not isinstance(assets, list) or not assets:
            raise RestoreError("manifest declares no assets to restore")

        # Everything this archive declares as its own. An absolute symlink may
        # point inside these and nowhere else.
        allowed_roots = tuple(
            os.path.normpath(str(a.get("sourcePath")))
            for a in assets
            if isinstance(a, dict) and a.get("sourcePath")
        )
        skipped_members: list[str] = []
        # sqlite targets whose stale `-wal`/`-shm` need retiring, applied after
        # every asset has landed. See the note at the call site.
        pending_sqlite: list[Path] = []

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

            # `entry` is new with the Hermes manifest and absent from every
            # archive written before it, so "dir" is the default — that is all
            # OpenClaw has ever declared.
            entry = str(asset.get("entry") or "dir")
            if entry not in ("dir", "file"):
                raise RestoreError(f"manifest asset {kind!r} has unknown entry {entry!r}")

            target = Path(source_path)
            asset_staging = _staging_beside(target, kind=kind, ts=ts)
            sibling_stagings.append(asset_staging)
            log.info("extracting asset %s → %s", kind, asset_staging)
            try:
                bytes_restored, swap_source = _extract_asset(
                    archive_path,
                    archive_subpath=archive_subpath,
                    staging_root=asset_staging,
                    entry=entry,
                    allowed_roots=allowed_roots,
                    skipped=skipped_members,
                )
                backup = _swap_into_place(swap_source, target, ts=ts)
                if asset.get("sqlite"):
                    # DEFERRED, not done here. Retiring the sidecars is the one
                    # step in this loop that `_rollback_swaps` cannot reverse,
                    # and the thing it would destroy is the newest data on the
                    # box: a WAL database keeps its most recent writes in the
                    # sidecar — 2.6 MB of them against a 2.8 MB `state.db` on
                    # the QA box. Retiring them here and then failing on a
                    # LATER asset would roll the old database back into place
                    # with its WAL renamed away, silently losing every
                    # conversation that had not been checkpointed. So the
                    # target is remembered and dealt with only once the whole
                    # restore has succeeded.
                    pending_sqlite.append(target)
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

        # Every asset is in place and no rollback can happen from here, so the
        # one irreversible step is finally safe to take.
        for db_target in pending_sqlite:
            _retire_sqlite_sidecars(db_target, ts=ts)

        return RestoreResult(
            archive_name=snapshot_name,
            archive_size_bytes=size,
            assets=results,
            skipped_members=skipped_members,
        )
    finally:
        # Best-effort cleanup of the staging tree. The swap moved any
        # asset-staging children out, so what's left is the downloaded
        # archive + empty asset dirs. Don't raise from here — the restore
        # itself succeeded.
        for leftover in sibling_stagings:
            try:
                if leftover.is_dir():
                    shutil.rmtree(leftover, ignore_errors=True)
                else:
                    leftover.unlink(missing_ok=True)
            except Exception as e:  # noqa: BLE001 — cleanup never fails a restore
                log.warning("could not clean up asset staging at %s: %s", leftover, e)
        try:
            shutil.rmtree(staging_dir, ignore_errors=True)
        except Exception as e:  # noqa: BLE001 — never let cleanup fail the restore
            log.warning("could not clean up restore staging at %s: %s", staging_dir, e)
