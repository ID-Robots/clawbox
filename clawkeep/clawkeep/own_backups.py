"""What ClawKeep leaves out of an OpenClaw snapshot: the box's own backups.

`openclaw backup create` (2026.9.4) takes the whole state directory as ONE
asset and carries everything in it. Measured on the real CLI: a
`~/.openclaw/backups/nightly/workspace-*.tar.gz` and a
`…-openclaw-backup.tar.gz.enc` both come out of the archive byte for byte, and
the dry-run lists neither as skipped. It has no way to leave a path out — no
flag in `backup create --help`, no `backup` key in `openclaw config schema` —
and the one related rule it has is that its OWN output may not be written
inside a source path ("Backup output must not be written inside a source
path"). So what sits in the state directory is older archives something else
put there: a snapshot kept for offline use, the owner's own nightly script. On
the box that reported it (TASK-1301), 20 GB of them took cloud snapshots from
2.5-4 GB to 11-13 GB and the account over its quota.

THE RULE (:func:`left_out_rule`)
  A REGULAR file the archiver would carry — never a link, never a directory —
  is left out when

    * it is inside `<state>/backups/`, at any depth, and its name ends in an
      archive suffix (:data:`ARCHIVE_SUFFIXES`: tar, tgz, gz, bz2, xz, zst,
      zip, 7z, enc, gpg, age, …);
    * it is anywhere in the backup and its name is OpenClaw's own archive name
      (`<archive root>.tar.gz`, `<timestamp>-openclaw-backup.tar.gz`) or
      ClawKeep's encrypted form of it (`….tar.gz.enc`).

  Nothing else is ever left out, and the rule reads nothing but the path and
  the name, so two runs over the same tree leave out the same files. The
  canonical state directory is the one the dry-run declares (`kind: state`).

HOW
  The way `backup_guard` omits a managed link: set aside for the length of the
  build, under the same `archive.lock`, and put back the moment the build
  ends, succeeded or not. A file is set aside by ONE `rename(2)` into a hold
  directory on the SAME filesystem and outside everything the backup covers —
  ClawKeep's data dir (`set-aside/`), else a `.clawkeep-set-aside/` beside the
  folder the file is in. A rename never copies a byte; when neither place is on
  the file's filesystem, the file is left exactly where it is, goes into this
  snapshot, and is warned about by name. Nothing here copies or deletes a
  customer file.

THE JOURNAL (`set-aside-files.json` in the data dir)
  Every file is written down with where it is going BEFORE it moves (the file
  fsynced, then its directory), so a build killed at any point — the bridge's
  four-hour SIGKILL, a power cut — leaves each file findable. The put-back runs
  when the build ends, before the next build does anything else, and on every
  idle tick. Each entry is judged from what is on disk, never from what the
  journal hopes:

    * in the hold dir, its own name free    → renamed back;
    * gone from the hold dir, back in place → already back (the crash fell
      between the two); the entry is dropped;
    * in both, one inode                    → a put-back cut short between
      its link and its unlink; the hold name is dropped;
    * in both, two files                    → something wrote a new file of
      that name meanwhile; ours comes back beside it as
      `<name>.clawkeep-returned` (`-2`, `-3`…), neither overwritten;
    * its folder gone                       → recreated, and the file put back;
    * its folder now a link or a file       → the file stays in the hold dir,
      the entry stays in the journal, and every run says where it is.

  An unreadable journal is left for a person, and nothing new is set aside on
  top of a record nobody can read.

SNAPSHOT-SIZED ARCHIVES
  The walk that finds the links the archiver would refuse measures each
  archive-named file it passes (one `stat`, of those only), so this costs no
  second walk. An archive file of :data:`LARGE_ARCHIVE_BYTES` or more that the
  snapshot WILL carry — outside the rule, or one that could not be set aside —
  is reported before the upload: in the log and in `state.json`, which the app
  and the `backup_status` tool read.
"""

from __future__ import annotations

import dataclasses
import errno
import json
import logging
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

#: Where set-aside files are written down, inside ClawKeep's own data dir.
JOURNAL_NAME = "set-aside-files.json"
#: The hold directory inside ClawKeep's data dir …
HOLD_DIRNAME = "set-aside"
#: … and the one beside a backed-up folder, for a file on another filesystem.
SIBLING_HOLD_NAME = ".clawkeep-set-aside"
#: One hold directory per build inside either of them: `run-XXXXXXXX`.
_RUN_PREFIX = "run-"
#: The state directory's own folder for backups.
BACKUPS_DIRNAME = "backups"
#: The name endings that make a file an archive (the LAST suffix, lower-cased):
#: `x.tar.gz` ends in `.gz`, `x.tar.gz.enc` in `.enc`.
ARCHIVE_SUFFIXES = frozenset({
    ".tar", ".tgz", ".tbz", ".tbz2", ".txz", ".tzst",
    ".gz", ".bz2", ".xz", ".zst", ".lz4",
    ".zip", ".7z", ".rar",
    ".enc", ".gpg", ".pgp", ".age",
})
#: OpenClaw's archive name — its `archiveRoot`, a local timestamp with the
#: zone written `Z` or `+03-00`, then `.tar.gz` — and ClawKeep's `.enc` of it.
_OPENCLAW_ARCHIVE = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}-\d{2})"
    r"-openclaw-backup\.tar\.gz(?:\.enc)?",
)
#: An archive file this big that the snapshot carries is warned about.
LARGE_ARCHIVE_BYTES = 256 * 1024 * 1024
#: Carried snapshot-sized archives named one by one; the rest are counted.
LISTED_LARGE = 5
#: What a file put back beside a new file of its name is called.
RETURNED_SUFFIX = ".clawkeep-returned"
#: `link(2)` failures that mean "this filesystem has no hard links".
_NO_HARD_LINKS = frozenset({errno.EPERM, errno.EOPNOTSUPP, errno.EMLINK, errno.ENOSYS})
#: Files named one by one in a log line; the rest are counted.
_LOGGED = 20

RULE_STATE_BACKUPS = "archive in the state directory's backups folder"
RULE_OPENCLAW_ARCHIVE = "OpenClaw backup archive"


def _inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def _device(path: str | Path) -> int:
    """The filesystem `path` is on. A rename between two of them is refused
    by the kernel (EXDEV) — this is how the refusal is known in advance."""
    return os.stat(path).st_dev


def archive_named(name: str) -> bool:
    """Does this file NAME say archive? Nothing is opened to decide it."""
    return (os.path.splitext(name)[1].lower() in ARCHIVE_SUFFIXES
            or _OPENCLAW_ARCHIVE.fullmatch(name) is not None)


def left_out_rule(path: str, state_dir: str | None) -> str:
    """The rule that leaves this archive file out of the snapshot — see the
    module docstring — or "" when none does."""
    name = os.path.basename(path)
    if _OPENCLAW_ARCHIVE.fullmatch(name):
        return RULE_OPENCLAW_ARCHIVE
    if state_dir is not None:
        backups = os.path.join(state_dir, BACKUPS_DIRNAME)
        if path != backups and _inside(path, backups) and (
            os.path.splitext(name)[1].lower() in ARCHIVE_SUFFIXES
        ):
            return RULE_STATE_BACKUPS
    return ""


def display_path(path: str) -> str:
    """`~/…` for a path in the home directory: how the app and the log say it."""
    home = os.path.expanduser("~").rstrip("/")
    if home and path.startswith(home + "/"):
        return "~/" + path[len(home) + 1:]
    return path


@dataclass(frozen=True)
class ArchiveFile:
    """An archive-named regular file the archiver would carry."""

    path: str
    size: int
    #: Which rule leaves it out (:func:`left_out_rule`); "" when none does.
    rule: str
    #: The planned asset it is in. A hold directory beside it is on its disk.
    asset_root: str


# ── the journal ──────────────────────────────────────────────────────────────

def _clean_abs(value: object) -> bool:
    return isinstance(value, str) and os.path.isabs(value) and os.path.normpath(value) == value


def _held_by_us(held: str) -> bool:
    """A hold path is `<hold dir>/run-…/<name>`, and nothing else is: the
    journal is ClawKeep's own file, and a garbled one must not become a
    rename of some other file into the backed-up tree."""
    run_dir = os.path.dirname(held)
    return (os.path.basename(run_dir).startswith(_RUN_PREFIX)
            and os.path.basename(os.path.dirname(run_dir)) in (HOLD_DIRNAME, SIBLING_HOLD_NAME))


def _journal_entries(journal: Path) -> list[dict[str, object]] | None:
    """The journal's usable entries; `None` when the file exists but cannot
    be read — then it is left exactly where it is."""
    try:
        raw = json.loads(journal.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        log.warning("set-aside journal %s is unreadable, leaving it for a person: %s", journal, e)
        return None
    entries = raw.get("files") if isinstance(raw, dict) else None
    good: list[dict[str, object]] = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        path, held, size = entry.get("path"), entry.get("held"), entry.get("bytes")
        if _clean_abs(path) and _clean_abs(held) and path != held and _held_by_us(str(held)):
            good.append({
                "path": path,
                "held": held,
                "bytes": size if isinstance(size, int) and size >= 0 else 0,
            })
    return good


def _fsync_dir(directory: Path) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass  # a filesystem that cannot sync a directory has nothing better to offer
    finally:
        os.close(fd)


def _write_journal(journal: Path, entries: list[dict[str, object]]) -> None:
    """Write the journal so that it is ON DISK before anything it names moves:
    the file is fsynced, renamed into place, and its directory fsynced — a
    rename that outlived a power cut the journal did not would leave a file
    in the hold dir that nothing knows to bring back."""
    if not entries:
        journal.unlink(missing_ok=True)
        return
    journal.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(journal.parent), prefix=".set-aside-files.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"files": entries}, fh, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, journal)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    _fsync_dir(journal.parent)


# ── setting aside ────────────────────────────────────────────────────────────

class _Holds:
    """This build's hold directories, one per filesystem it needed, made on
    first use. A hold directory is never inside anything the backup covers."""

    def __init__(self, roots: list[str], data_dir: Path) -> None:
        self._roots = roots
        self._data_dir = data_dir
        self._run_dirs: dict[str, Path] = {}
        self._count = 0

    def _candidates(self, asset_root: str) -> list[Path]:
        beside = Path(os.path.dirname(asset_root.rstrip("/")) or "/") / SIBLING_HOLD_NAME
        return [
            place for place in (self._data_dir / HOLD_DIRNAME, beside)
            if not any(_inside(str(place), root) for root in self._roots)
        ]

    def _run_dir(self, hold: Path, device: int) -> Path | None:
        known = self._run_dirs.get(str(hold))
        if known is not None:
            return known
        try:
            # The FOLDER the hold dir is made in decides its filesystem;
            # nothing is created on a disk the file is not on.
            if _device(hold.parent) != device:
                return None
            hold.mkdir(mode=0o700, exist_ok=True)
            if not stat.S_ISDIR(os.lstat(hold).st_mode):
                return None  # something else took the name — never a link
            run_dir = Path(tempfile.mkdtemp(prefix=_RUN_PREFIX, dir=hold))
            if _device(run_dir) != device:
                _rmdir_quiet(str(run_dir))
                return None
        except OSError as e:
            log.warning("could not make a hold directory in %s: %s", hold, e)
            return None
        self._run_dirs[str(hold)] = run_dir
        return run_dir

    def place_for(self, archive: ArchiveFile, device: int) -> str | None:
        for hold in self._candidates(archive.asset_root):
            run_dir = self._run_dir(hold, device)
            if run_dir is not None:
                self._count += 1
                name = os.path.basename(archive.path)[:200]
                return str(run_dir / f"{self._count:04d}-{name}")
        return None

    def drop_empty(self) -> None:
        for run_dir in self._run_dirs.values():
            _rmdir_quiet(str(run_dir))
            _rmdir_quiet(str(run_dir.parent))


def _rmdir_quiet(directory: str) -> None:
    try:
        os.rmdir(directory)
    except OSError:
        pass  # not empty, or not ours to remove


def set_aside(
    found: list[ArchiveFile], roots: list[str], journal: Path, data_dir: Path,
) -> list[ArchiveFile]:
    """Take every file the rule leaves out out of the tree for the archive
    build. Returns the files set aside, sized as they were moved; every other
    one stays where it is and goes into the snapshot."""
    wanted = [archive for archive in found if archive.rule]
    if not wanted:
        return []
    pending = _journal_entries(journal)
    if pending is None:
        log.warning(
            "not setting aside %d backup archive(s) — the set-aside journal is unreadable; "
            "they go into this snapshot", len(wanted),
        )
        return []
    known = {entry["path"] for entry in pending}
    holds = _Holds(roots, data_dir)
    planned: list[tuple[ArchiveFile, str]] = []
    stuck: list[ArchiveFile] = []
    for archive in wanted:
        if archive.path in known:
            continue
        try:
            device = _device(os.path.dirname(archive.path))
        except OSError:
            continue  # gone since the walk: nothing to carry either
        held = holds.place_for(archive, device)
        if held is None:
            stuck.append(archive)
        else:
            planned.append((archive, held))
    if stuck:
        log.warning(
            "%d backup archive(s) stay in this snapshot: no hold directory outside the backup is "
            "on their filesystem, and ClawKeep never copies one across disks: %s",
            len(stuck), ", ".join(a.path for a in stuck[:_LOGGED]),
        )

    def entries(items: list[tuple[ArchiveFile, str]]) -> list[dict[str, object]]:
        return pending + [{"path": a.path, "held": held, "bytes": a.size} for a, held in items]

    moved: list[tuple[ArchiveFile, str]] = []
    try:
        if planned:
            _write_journal(journal, entries(planned))
        for archive, held in planned:
            try:
                now = os.lstat(archive.path)
                # Still a regular file — never move a link or a directory
                # that took the scanned file's name.
                if not stat.S_ISREG(now.st_mode):
                    continue
                os.rename(archive.path, held)
            except OSError as e:
                # EXDEV included: a rename that would cross filesystems fails
                # rather than copying, and the file simply stays.
                log.warning(
                    "could not set aside %s, it stays in this snapshot: %s", archive.path, e,
                )
                continue
            moved.append((dataclasses.replace(archive, size=now.st_size), held))
        if planned:
            _write_journal(journal, entries(moved))
    finally:
        holds.drop_empty()
    if moved:
        log.info(
            "leaving %d backup archive(s), %d bytes, out of this snapshot; they are put back when "
            "it is built: %s%s",
            len(moved), sum(a.size for a, _ in moved),
            ", ".join(f"{a.path} ({a.rule})" for a, _ in moved[:_LOGGED]),
            f" … and {len(moved) - _LOGGED} more" if len(moved) > _LOGGED else "",
        )
    return [archive for archive, _ in moved]


# ── putting back ─────────────────────────────────────────────────────────────

def _ensure_dir(directory: str) -> bool:
    """Is `directory` a real directory — recreated if it went away? A folder
    that became a link or a file is not one: nothing is put back through it."""
    missing: list[str] = []
    probe = directory
    while True:
        try:
            found = os.lstat(probe)
            break
        except FileNotFoundError:
            parent = os.path.dirname(probe)
            if parent == probe:
                return False
            missing.append(probe)
            probe = parent
        except OSError:
            return False
    if not stat.S_ISDIR(found.st_mode):
        return False
    for folder in reversed(missing):
        try:
            os.mkdir(folder)
        except FileExistsError:
            if not stat.S_ISDIR(os.lstat(folder).st_mode):
                return False
        except OSError:
            return False
    return True


def _link_or_rename(held: str, dest: str) -> None:
    """Move `held` to `dest` WITHOUT replacing anything at `dest`: `link(2)`
    refuses an existing name, and only then is the hold name dropped. On a
    filesystem with no hard links, a rename behind a fresh existence check."""
    try:
        os.link(held, dest, follow_symlinks=False)
    except FileExistsError:
        raise
    except OSError as e:
        if e.errno not in _NO_HARD_LINKS:
            raise
        if os.path.lexists(dest):
            raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST), dest) from e
        os.rename(held, dest)
        return
    try:
        os.unlink(held)
    except OSError as e:
        # The file IS back; the hold name is dropped by the next put-back.
        log.warning("put back %s but could not drop its hold name %s: %s", dest, held, e)


def _return_one(path: str, held: str) -> str | None:
    """Put one file back. Returns where it went, "" when there was nothing to
    put back, and `None` when it has to stay in the journal."""
    try:
        was = os.lstat(held)
    except FileNotFoundError:
        if not os.path.lexists(path):
            log.warning(
                "a file ClawKeep set aside is neither at %s nor in its hold directory (%s); "
                "something removed it meanwhile", path, held,
            )
        return ""
    except OSError as e:
        log.warning("cannot look at set-aside file %s (%s stays in the journal): %s", held, path, e)
        return None
    if not stat.S_ISREG(was.st_mode):
        log.warning("not putting back %s: its hold name %s is no longer a regular file", path, held)
        return None
    try:
        here = os.lstat(path)
    except FileNotFoundError:
        here = None
    except OSError as e:
        log.warning("cannot look at %s, its file stays at %s: %s", path, held, e)
        return None
    if here is not None and os.path.samestat(here, was):
        try:
            os.unlink(held)
        except OSError as e:
            log.warning("could not drop hold name %s of %s: %s", held, path, e)
            return None
        return path
    folder = os.path.dirname(path)
    if not _ensure_dir(folder):
        log.warning(
            "not putting back %s: its folder %s is now a link or a file. The file is kept at %s "
            "and every backup run tries again", path, folder, held,
        )
        return None
    for n in range(1, 101):
        dest = path if n == 1 else path + RETURNED_SUFFIX + ("" if n == 2 else f"-{n - 1}")
        try:
            _link_or_rename(held, dest)
        except FileExistsError:
            continue
        except OSError as e:
            log.warning("could not put back %s, it is kept at %s: %s", path, held, e)
            return None
        if dest != path:
            log.warning(
                "put back %s as %s: a new file took its name while it was set aside, and neither "
                "was overwritten", path, dest,
            )
        return dest
    log.warning("could not find a free name to put back %s; it is kept at %s", path, held)
    return None


def put_back(journal: Path) -> list[str]:
    """Put back every file the journal names — see the module docstring for
    each case. Returns where each one went; what cannot go back yet stays in
    the journal, and in its hold directory."""
    entries = _journal_entries(journal)
    if entries is None:
        return []
    if not entries:
        journal.unlink(missing_ok=True)
        return []
    returned: list[str] = []
    remaining: list[dict[str, object]] = []
    run_dirs: set[str] = set()
    for entry in entries:
        path, held = str(entry["path"]), str(entry["held"])
        run_dirs.add(os.path.dirname(held))
        where = _return_one(path, held)
        if where is None:
            remaining.append(entry)
        elif where:
            returned.append(where)
    _write_journal(journal, remaining)
    for run_dir in sorted(run_dirs):
        _rmdir_quiet(run_dir)
        _rmdir_quiet(os.path.dirname(run_dir))
    return returned


# ── the report ───────────────────────────────────────────────────────────────

def report(found: list[ArchiveFile], set_aside: list[ArchiveFile]) -> dict[str, object]:
    """The archive's account of this: the extra fields of `openclaw.Archive`."""
    out = {archive.path for archive in set_aside}
    carried = sorted(
        (a for a in found if a.path not in out and a.size >= LARGE_ARCHIVE_BYTES),
        key=lambda a: (-a.size, a.path),
    )
    return {
        "left_out_count": len(set_aside),
        "left_out_bytes": sum(a.size for a in set_aside),
        "large_archives": tuple((display_path(a.path), a.size) for a in carried[:LISTED_LARGE]),
        "large_archive_count": len(carried),
        "large_archive_bytes": sum(a.size for a in carried),
    }
