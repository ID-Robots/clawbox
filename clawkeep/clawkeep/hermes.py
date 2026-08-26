"""Build a ClawKeep archive of the HERMES agent's state.

The OpenClaw edition delegates "what to back up" to `openclaw backup create`
(:mod:`clawkeep.openclaw`). The Hermes edition has no such CLI — `hermes` ships
no `backup` subcommand — so this module *is* the archiver, and it writes the
same on-disk layout the OpenClaw CLI does:

    <root>/manifest.json
    <root>/payload/posix/<absolute-source-path-without-leading-slash>/...

Emitting that layout rather than inventing one is the whole point:
:mod:`clawkeep.restore` is manifest-driven, so extraction, the atomic swap and
the cross-asset rollback all work on a Hermes archive without knowing Hermes
exists. The two editions differ only in who fills the tarball.

WHAT IS IN A HERMES BACKUP
--------------------------
An explicit ALLOWLIST (:data:`ASSETS`), never a denylist. Hermes is a checkout
of an upstream project that moves daily and drops new directories into
`~/.hermes` without asking us; a denylist would sweep each new one into the
archive — and the first 2 GB model cache upstream adds would silently turn a
90-second backup into an hour and blow the customer's storage quota. An
allowlist fails the safe way: something new is missed until we add it, which
costs a line here and never costs the customer an upload.

Included, and why each is worth the bytes:

  config       `config.yaml`     the agent's whole configuration
  credentials  `.env`            provider API keys + platform tokens — SENSITIVE,
                                 see the note below
  sessions     `state.db`        conversation history (copied through sqlite's
                                 own backup API, never as a raw file read)
  memories     `memories/`       MEMORY.md / USER.md — what the agent knows
  skills       `skills/`         installed skills
  hooks        `hooks/`          user automation
  cron         `cron/`           scheduled jobs
  session-log  `sessions/`       per-session scratch state
  plugins      `plugins/`        user-installed plugins (e.g. the ClawBox AI
                                 image backend) — these OVERRIDE bundled ones,
                                 so losing them changes behaviour
  pets         `pets/`           display pets
  pairing      `pairing/`        device pairing records — SENSITIVE
  identity     `~/.clawbox/agent-identity/`
                                 the shared identity bridge. `~/.hermes/SOUL.md`
                                 is a SYMLINK into it, so backing up the link
                                 target is the only way the restored box is the
                                 same agent rather than a factory one.

Deliberately EXCLUDED, and why — every one of these is regenerable, and
together they are ~99% of the bytes under `~/.hermes`:

  hermes-agent/        ~1.5 GB git checkout of the upstream agent. Reinstalled
                       by the updater; archiving it would make every snapshot
                       enormous and restore a stale copy over a newer one.
  bin/                 ~43 MB virtualenv. Rebuilt by the installer.
  cache/, image_cache/, audio_cache/, logs/
                       Caches and logs. `models_dev_cache.json` alone is 4 MB
                       of a manifest re-fetched on demand.
  *_cache.json, *.etag, *.lock, *.bak, .update_check
                       Transient. A `.lock` restored over a live box would be a
                       stale lock nothing holds.
  SOUL.md              A symlink; its TARGET travels as the `identity` asset.

ON CREDENTIALS
--------------
`.env` and `pairing/` ARE in the archive, and that is a deliberate choice, not
an oversight. A backup that restored the agent's config and memories but not
its provider keys would come back mute — the customer would "restore" and land
on a dead box, which is the false-success failure this feature exists to avoid.
OpenClaw's own archive includes its credentials for the same reason.

What makes that safe is that ClawKeep encryption is MANDATORY: `runner.run_once`
refuses to back up at all when no device passphrase is set
(`EXIT_NEED_PASSPHRASE`), and the tarball is AES-encrypted with that
user-held passphrase before a single byte leaves the device. The plaintext
tarball exists only inside a 0700 staging directory and is wiped after
encryption. The portal never holds the passphrase and cannot read a snapshot.

The corollary, which the UI and docs must keep saying out loud: a ClawKeep
archive is a CREDENTIAL. It must never be moved off the device in its decrypted
form, and anyone who has both the file and the passphrase has the box's
provider keys.
"""

from __future__ import annotations

import io
import json
import logging
import os
import shutil
import sqlite3
import tarfile
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .openclaw import Archive

log = logging.getLogger(__name__)

#: Identifies which agent wrote an archive. Lands in the manifest as `agent`
#: and is what lets a restore refuse a snapshot that belongs to the other
#: edition — see `clawkeep.agent.assert_archive_matches_device`.
AGENT_ID = "hermes"

#: Manifest schema version. Matches OpenClaw's `schemaVersion: 1` because the
#: layout IS OpenClaw's layout; the only addition is the optional `entry` key,
#: which older readers do not need (they only ever wrote directories).
SCHEMA_VERSION = 1


class HermesError(Exception):
    """Anything that stops a Hermes archive being built or verified.

    Mirrors `openclaw.OpenclawError` so `runner` can catch one union type.
    """


@dataclass(frozen=True)
class HermesAsset:
    """One allowlisted thing to archive.

    `entry` distinguishes a directory (swapped wholesale on restore) from a
    single file. OpenClaw only ever ships directories, so `"dir"` is the
    default everywhere the key is absent.
    """

    kind: str
    #: Path relative to the agent root, or — when `root` is set — relative to
    #: that other root instead.
    relative: str
    entry: str = "dir"
    #: True when this asset carries provider keys or platform tokens. Recorded
    #: in the manifest so restore and the UI can say so rather than guess.
    credential_bearing: bool = False
    #: `"hermes"` (default) resolves under `~/.hermes`; `"clawbox"` resolves
    #: under `~/.clawbox`, which is where the shared identity bridge lives.
    root: str = "hermes"
    #: Copy through sqlite's online-backup API instead of reading the bytes.
    #: A live agent holds `state.db` open in WAL mode, and a plain file copy of
    #: a WAL database is a torn database — it restores as an empty or corrupt
    #: history, which the customer only discovers when they need it.
    sqlite: bool = False


ASSETS: tuple[HermesAsset, ...] = (
    HermesAsset("config", "config.yaml", entry="file"),
    HermesAsset("credentials", ".env", entry="file", credential_bearing=True),
    HermesAsset("sessions", "state.db", entry="file", sqlite=True),
    HermesAsset("memories", "memories"),
    HermesAsset("skills", "skills"),
    HermesAsset("hooks", "hooks"),
    HermesAsset("cron", "cron"),
    HermesAsset("session-log", "sessions"),
    HermesAsset("plugins", "plugins"),
    HermesAsset("pets", "pets"),
    HermesAsset("pairing", "pairing", credential_bearing=True),
    HermesAsset("identity", "agent-identity", root="clawbox"),
)

#: Only these assets survive `only_config=True` — the "just the settings"
#: backup the config flag promises. Credentials are NOT among them: a
#: config-only snapshot is the one a customer is most likely to hand to
#: support, so it must not be a key dump.
ONLY_CONFIG_KINDS = frozenset({"config"})


def hermes_home() -> Path:
    """Hermes' data root. Mirrors `hermesHome()` in `src/lib/hermes-env.ts`
    and `HERMES_HOME` resolution in the Hermes CLI, so all three agree on a
    box where the env var is set."""
    override = os.environ.get("HERMES_HOME", "").strip()
    if override:
        return Path(override)
    return Path(os.environ.get("HOME", "/home/clawbox")) / ".hermes"


def clawbox_home() -> Path:
    """Where the shared identity bridge lives (`~/.clawbox`)."""
    override = os.environ.get("CLAWBOX_HOME", "").strip()
    if override:
        return Path(override)
    return Path(os.environ.get("HOME", "/home/clawbox")) / ".clawbox"


def _root_for(asset: HermesAsset) -> Path:
    return clawbox_home() if asset.root == "clawbox" else hermes_home()


def source_path(asset: HermesAsset) -> Path:
    return _root_for(asset) / asset.relative


def _tar_name(target: Path) -> str:
    """A source path spelled the way `tarfile` will store it.

    `TarFile.gettarinfo` rewrites every arcname before it lands in the
    archive: it splits off a drive letter, swaps `os.sep` for "/", and strips
    leading slashes. The manifest has to name members by the name they end up
    with, so it must apply exactly the same three steps — otherwise the
    manifest says `.../home/x/.hermes/config.yaml` while the member is called
    something else, `verify_archive` reports every asset as missing payload,
    and a restore that would have worked refuses. (Only the drive-letter step
    changes anything on the Linux boxes this ships to; it is the dev machines
    that would otherwise disagree with production.)
    """
    _, without_drive = os.path.splitdrive(str(target))
    return without_drive.replace(os.sep, "/").lstrip("/")


def _archive_subpath(archive_root: str, target: Path) -> str:
    """`<root>/payload/posix/<abs-path-without-leading-slash>` — the layout
    `restore._extract_asset_from_open` strips back off."""
    return f"{archive_root}/payload/posix/{_tar_name(target)}"


def _sqlite_snapshot(src: Path, dest: Path) -> None:
    """Copy a live sqlite database consistently.

    `Connection.backup()` takes a read lock per page-batch rather than
    freezing the whole file, so it works against the running agent and yields
    a database with no partial transaction in it. A `shutil.copy` of the same
    file mid-WAL-checkpoint does not.
    """
    try:
        # `mode=ro` so an archiver can never write to the customer's live
        # history, even by accident. immutable=0 because the file IS being
        # written by the agent while we read.
        uri = f"file:{src}?mode=ro"
        source = sqlite3.connect(uri, uri=True)
        try:
            target = sqlite3.connect(dest)
            try:
                source.backup(target)
            finally:
                target.close()
        finally:
            source.close()
    except sqlite3.Error as e:
        raise HermesError(f"could not snapshot sqlite database {src}: {e}") from e


def _add_tree(tf: tarfile.TarFile, *, src: Path, arcname: str) -> int:
    """Add `src` (a directory) under `arcname`, returning bytes of regular
    files added. Symlinks are stored as links, not followed — following them
    would let a link inside `skills/` pull an arbitrary tree into the
    archive."""
    total = 0
    tf.add(src, arcname=arcname, recursive=False)
    for entry in sorted(src.rglob("*")):
        rel = entry.relative_to(src)
        name = f"{arcname}/{rel.as_posix()}"
        try:
            tf.add(entry, arcname=name, recursive=False)
            if entry.is_file() and not entry.is_symlink():
                total += entry.stat().st_size
        except OSError as e:
            # One unreadable file must not lose the customer the other
            # thousand. Recorded loudly; the manifest's `skipped` list carries
            # it out to whoever reads the archive.
            log.warning("skipping unreadable %s: %s", entry, e)
    return total


def create_archive(
    *,
    output_dir: Path,
    only_config: bool = False,
    verify: bool = True,
    now: datetime | None = None,
) -> Archive:
    """Write one `<timestamp>-hermes-backup.tar.gz` into `output_dir`.

    The filename stem MUST equal the tarball's top-level directory: restore
    derives the manifest's location from the snapshot NAME
    (`snapshot_name[:-len('.tar.gz')] + '/manifest.json'`), so a mismatch makes
    the archive unreadable by the very code that has to read it.

    Returns the same `Archive` dataclass `openclaw.create_archive` returns, so
    `runner` needs no idea which backend ran.
    """
    moment = now or datetime.now(timezone.utc)
    # Two spellings of the same instant, on purpose. The FILENAME stem cannot
    # carry ":" (it is a path on disk and an S3 object key), so it uses "-";
    # `createdAt` keeps real ISO-8601 because that is what readers parse.
    stamp = moment.strftime("%Y-%m-%dT%H-%M-%S.000Z")
    created_at = moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    archive_root = f"{stamp}-hermes-backup"
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / f"{archive_root}.tar.gz"

    wanted = [a for a in ASSETS if not only_config or a.kind in ONLY_CONFIG_KINDS]

    manifest_assets: list[dict[str, object]] = []
    skipped: list[dict[str, str]] = []
    # Staging for sqlite snapshots — they cannot be added straight from the
    # live path. 0700 because `state.db` is conversation history.
    staging = Path(tempfile.mkdtemp(prefix="clawkeep-hermes-", dir=str(output_dir)))
    try:
        os.chmod(staging, 0o700)
        with tarfile.open(archive_path, "w:gz") as tf:
            for asset in wanted:
                target = source_path(asset)
                if not target.exists():
                    # Absent is normal, not an error: a box nobody has given a
                    # pet has no `pets/`. Recorded so a reader of the manifest
                    # can tell "was not there" from "we forgot".
                    skipped.append({"kind": asset.kind, "reason": "not present"})
                    continue

                arcname = _archive_subpath(archive_root, target)
                try:
                    if asset.sqlite:
                        snap = staging / f"{asset.kind}.db"
                        _sqlite_snapshot(target, snap)
                        tf.add(snap, arcname=arcname, recursive=False)
                    elif asset.entry == "file":
                        tf.add(target, arcname=arcname, recursive=False)
                    else:
                        _add_tree(tf, src=target, arcname=arcname)
                except HermesError:
                    raise
                except OSError as e:
                    raise HermesError(f"could not archive {asset.kind} ({target}): {e}") from e

                manifest_assets.append({
                    "kind": asset.kind,
                    "sourcePath": str(target),
                    "archivePath": arcname,
                    "entry": asset.entry,
                    "credentialBearing": asset.credential_bearing,
                })

            if not manifest_assets:
                raise HermesError(
                    "nothing to back up: none of the Hermes state paths exist "
                    f"under {hermes_home()}",
                )

            manifest = {
                "schemaVersion": SCHEMA_VERSION,
                "agent": AGENT_ID,
                "createdAt": created_at,
                "archiveRoot": archive_root,
                "platform": "linux",
                "options": {"onlyConfig": only_config},
                "paths": {"stateDir": str(hermes_home())},
                # Out loud, in the archive itself, so anything that reads a
                # snapshot without reading this file still learns it is
                # handling secrets.
                "containsCredentials": any(
                    bool(a.get("credentialBearing")) for a in manifest_assets
                ),
                "assets": manifest_assets,
                "skipped": skipped,
            }
            blob = json.dumps(manifest, indent=2).encode("utf-8")
            info = tarfile.TarInfo(f"{archive_root}/manifest.json")
            info.size = len(blob)
            info.mtime = int(moment.timestamp())
            info.mode = 0o600
            tf.addfile(info, io.BytesIO(blob))
    except Exception:
        # A half-written tarball must not survive to be uploaded and then
        # fail a restore months later.
        archive_path.unlink(missing_ok=True)
        raise
    finally:
        _rmtree_quiet(staging)

    try:
        os.chmod(archive_path, 0o600)
        size = archive_path.stat().st_size
    except OSError as e:
        raise HermesError(f"could not stat archive {archive_path}: {e}") from e

    if verify:
        verify_archive(archive_path)

    return Archive(
        path=archive_path,
        archive_root=archive_root,
        created_at=created_at,
        size_bytes=size,
        asset_count=len(manifest_assets),
    )


def _rmtree_quiet(p: Path) -> None:
    try:
        shutil.rmtree(p, ignore_errors=True)
    except Exception as e:  # noqa: BLE001 — cleanup must never fail a backup
        log.warning("could not clean staging %s: %s", p, e)


def read_manifest(archive: Path) -> dict:
    """Pull `<root>/manifest.json` out of a Hermes archive.

    Finds the root by scanning rather than deriving it from the filename, so
    this works on a file the caller renamed.
    """
    try:
        with tarfile.open(archive, "r:gz") as tf:
            for member in tf:
                if member.name.endswith("/manifest.json") and member.name.count("/") == 1:
                    handle = tf.extractfile(member)
                    if handle is None:
                        raise HermesError("manifest.json is not a regular file")
                    return json.loads(handle.read().decode("utf-8"))
    except (tarfile.TarError, OSError, ValueError, UnicodeDecodeError) as e:
        raise HermesError(f"could not read manifest from {archive}: {e}") from e
    raise HermesError(f"archive {archive} has no top-level manifest.json")


def verify_archive(archive: Path) -> None:
    """The Hermes half of `openclaw backup verify`.

    Checks, in order: the tarball opens; it carries a manifest; the manifest
    declares this agent and at least one asset; and EVERY declared asset
    actually has bytes under its `archivePath`. That last one is the check
    that matters — a manifest listing an asset the payload does not contain is
    exactly the archive that restores 4 of 5 assets and calls it a success.
    """
    manifest = read_manifest(archive)
    if manifest.get("agent") != AGENT_ID:
        raise HermesError(
            f"archive was written by {manifest.get('agent') or 'openclaw'!r}, "
            f"not {AGENT_ID!r}",
        )
    assets = manifest.get("assets")
    if not isinstance(assets, list) or not assets:
        raise HermesError("manifest declares no assets")

    wanted: dict[str, str] = {}
    for asset in assets:
        if not isinstance(asset, dict):
            raise HermesError(f"manifest asset is not an object: {asset!r}")
        sub = asset.get("archivePath")
        kind = str(asset.get("kind", "?"))
        if not isinstance(sub, str) or not sub:
            raise HermesError(f"manifest asset {kind!r} has no archivePath")
        wanted[sub] = kind

    seen: set[str] = set()
    try:
        with tarfile.open(archive, "r:gz") as tf:
            for member in tf:
                for sub in wanted:
                    if member.name == sub or member.name.startswith(sub + "/"):
                        seen.add(sub)
    except (tarfile.TarError, OSError) as e:
        raise HermesError(f"could not read {archive}: {e}") from e

    missing = sorted(wanted[sub] for sub in wanted if sub not in seen)
    if missing:
        raise HermesError(
            "archive is missing payload for declared asset(s): " + ", ".join(missing),
        )
