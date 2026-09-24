"""Recover an OpenClaw SQLite database whose ONLY damage is in its indexes.

OpenClaw 2026.9.4 snapshots every `*.sqlite` under the state directory and the
agent roots through `createVerifiedSqliteSnapshot`: a full `integrity_check`
and `foreign_key_check` of the source, SQLite's online backup, then `VACUUM`.
A database that fails the check is refused outright — "a direct file copy was
refused because it can retain deleted data" — and the whole backup exits 1. A
v4.0 box was stuck there on rows missing from several `idx_logs_*` indexes.

That gate is right and ClawKeep does not go round it. What ClawKeep CAN own is
the one repair that loses nothing: an index holds no data of its own, only a
sorted copy of columns its table already has, so `REINDEX` rebuilds it from the
table and every row stays exactly as it was. This module does that repair and
nothing wider:

  * only when EVERY line `integrity_check` reports is index bookkeeping
    ("row N missing from index X", "wrong # of entries in index X",
    "non-unique entry in index X") naming an index the schema really has.
    Anything about pages, trees, cells, NOT NULL, CHECK or foreign keys is
    damage to DATA, and no rebuild can put that back — the database is left
    exactly as found and the backup stops with a sentence saying so;
  * only on a file inside a root the backup plan owns (the state directory,
    an agent root), resolved through symlinks first, ending in `.sqlite`;
  * only after a copy of the database AS FOUND has been written through
    SQLite's online-backup API (never a byte copy of a live file) into
    ClawKeep's own 0700 directory — and only if there is room for it;
  * inside one `BEGIN IMMEDIATE` transaction, so a busy or failing rebuild
    rolls back to the file it started from;
  * and it is proven afterwards: a repair counts only when a fresh full
    `integrity_check` answers `ok` and `foreign_key_check` answers nothing.

The upstream gate then runs again, unchanged, on the next attempt.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

#: `integrity_check` lines that are index bookkeeping and nothing else. Worded
#: the same by every SQLite from 3.7 to 3.46.
_INDEX_ONLY_RES = (
    re.compile(r"^row \d+ missing from index (?P<index>.+)$"),
    re.compile(r"^wrong # of entries in index (?P<index>.+)$"),
    re.compile(r"^non-unique entry in index (?P<index>.+)$"),
)

#: How many `integrity_check` lines to ask for. Past the default 100 so a
#: large logs table still reports all of it; a rebuild is only started when
#: every line reported is index-only.
_CHECK_LIMIT = 10_000

#: Seconds to wait for the gateway's own writes before giving up.
_BUSY_TIMEOUT_S = 30.0

#: Room kept free beyond the copy itself, so keeping a copy can never be what
#: fills the disk the box runs on.
_FREE_SPACE_MARGIN = 256 * 1024 * 1024

#: Copies of one database kept in the recovery directory. A box whose indexes
#: break every night keeps the newest few, not one per night.
_KEEP_COPIES = 3

STATUS_HEALTHY = "healthy"
STATUS_INDEX_ONLY = "index_only"
STATUS_DAMAGED = "damaged"
STATUS_UNREADABLE = "unreadable"

RECOVERY_REPAIRED = "repaired"
RECOVERY_HEALTHY = "healthy"
RECOVERY_REFUSED = "refused"


@dataclass(frozen=True)
class Diagnosis:
    status: str
    #: The indexes an `index_only` database needs rebuilt, sorted.
    indexes: tuple[str, ...] = ()
    #: The first few lines the checks reported, for the log and the sentence.
    problems: tuple[str, ...] = ()


@dataclass(frozen=True)
class Recovery:
    status: str
    #: Why a `refused` database was left alone, in words for a person.
    reason: str = ""
    indexes: tuple[str, ...] = ()
    preserved_copy: Path | None = None
    problems: tuple[str, ...] = ()


def _read_only_uri(path: Path) -> str:
    # `as_uri` percent-encodes, so a path with `?` or `#` in it cannot turn
    # into URI parameters.
    return f"{path.as_uri()}?mode=ro"


def _connect_read_only(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(_read_only_uri(path), uri=True, timeout=_BUSY_TIMEOUT_S)
    conn.execute(f"PRAGMA busy_timeout = {int(_BUSY_TIMEOUT_S * 1000)}")
    return conn


def _index_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
        if isinstance(row[0], str)
    }


def _checks(conn: sqlite3.Connection) -> tuple[list[str], list[str]]:
    integrity = [str(row[0]) for row in conn.execute(f"PRAGMA integrity_check({_CHECK_LIMIT})")]
    foreign = [
        f"foreign key violation in {row[0]} (rowid {row[1]}) -> {row[2]}"
        for row in conn.execute("PRAGMA foreign_key_check").fetchmany(5)
    ]
    return integrity, foreign


def diagnose(path: Path) -> Diagnosis:
    """Read-only look at one database. Never writes, never copies."""
    try:
        conn = _connect_read_only(path)
    except sqlite3.Error as e:
        return Diagnosis(STATUS_UNREADABLE, problems=(f"could not open: {e}",))
    try:
        integrity, foreign = _checks(conn)
        known = _index_names(conn)
    except sqlite3.Error as e:
        return Diagnosis(STATUS_UNREADABLE, problems=(f"could not check: {e}",))
    finally:
        conn.close()

    if integrity == ["ok"]:
        if foreign:
            return Diagnosis(STATUS_DAMAGED, problems=tuple(foreign))
        return Diagnosis(STATUS_HEALTHY)

    indexes: set[str] = set()
    for line in integrity:
        match = next((m for m in (r.match(line) for r in _INDEX_ONLY_RES) if m), None)
        if match is None or match.group("index") not in known:
            return Diagnosis(STATUS_DAMAGED, problems=tuple(integrity[:5]))
        indexes.add(match.group("index"))
    # Foreign keys are NOT judged here: a parent-key lookup reads the parent's
    # index, and that index is exactly what is broken, so the answer would be
    # the broken index talking. They are judged after the rebuild instead.
    return Diagnosis(
        STATUS_INDEX_ONLY, indexes=tuple(sorted(indexes)), problems=tuple(integrity[:5]),
    )


def _inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def _vet(path: Path, allowed_roots: Iterable[str]) -> tuple[Path | None, str]:
    """The canonical file a repair may touch, or `None` and why not."""
    try:
        real = Path(os.path.realpath(path, strict=True))
    except OSError as e:
        return None, f"it could not be resolved ({e})"
    if real.suffix != ".sqlite":
        return None, "it is not an OpenClaw `.sqlite` database"
    roots = []
    for root in allowed_roots:
        try:
            roots.append(os.path.realpath(root, strict=True))
        except OSError:
            continue
    if not any(_inside(str(real), root) for root in roots):
        return None, "it is not inside the OpenClaw state this backup covers"
    if not real.is_file():
        return None, "it is not a regular file"
    return real, ""


def _database_bytes(path: Path) -> int:
    total = 0
    for candidate in (path, Path(f"{path}-wal")):
        try:
            total += candidate.stat().st_size
        except OSError:
            pass
    return total


def _preserve(path: Path, recovery_dir: Path) -> Path:
    """Copy the database AS FOUND through the online-backup API."""
    recovery_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(recovery_dir, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    copy = recovery_dir / f"{path.stem}-{stamp}-{os.getpid()}.pre-reindex.sqlite"
    source = _connect_read_only(path)
    try:
        # Created 0600 before a byte of the database lands in it: it holds
        # whatever the database holds.
        fd = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        target = sqlite3.connect(copy)
        try:
            source.backup(target)
        finally:
            target.close()
    except BaseException:
        copy.unlink(missing_ok=True)
        raise
    finally:
        source.close()
    return copy


def _prune_copies(recovery_dir: Path, stem: str) -> None:
    copies = sorted(
        recovery_dir.glob(f"{stem}-*.pre-reindex.sqlite"),
        key=lambda p: p.stat().st_mtime if p.exists() else 0,
        reverse=True,
    )
    for old in copies[_KEEP_COPIES:]:
        try:
            old.unlink()
        except OSError as e:
            log.warning("could not remove old recovery copy %s: %s", old, e)


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _reindex(path: Path, indexes: tuple[str, ...]) -> None:
    conn = sqlite3.connect(path, timeout=_BUSY_TIMEOUT_S, isolation_level=None)
    try:
        conn.execute(f"PRAGMA busy_timeout = {int(_BUSY_TIMEOUT_S * 1000)}")
        conn.execute("BEGIN IMMEDIATE")
        try:
            for name in indexes:
                conn.execute(f"REINDEX {_quote(name)}")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def recover(path: Path, *, allowed_roots: Iterable[str], recovery_dir: Path) -> Recovery:
    """Repair `path` if and only if its damage is index-only. See the module
    docstring for every condition; a `refused` answer means the file was not
    written to."""
    real, why = _vet(path, allowed_roots)
    if real is None:
        return Recovery(RECOVERY_REFUSED, reason=f"ClawKeep left it alone: {why}")

    found = diagnose(real)
    if found.status == STATUS_HEALTHY:
        return Recovery(RECOVERY_HEALTHY)
    if found.status == STATUS_UNREADABLE:
        return Recovery(
            RECOVERY_REFUSED,
            reason="ClawKeep could not read it to check it",
            problems=found.problems,
        )
    if found.status == STATUS_DAMAGED:
        return Recovery(
            RECOVERY_REFUSED,
            reason=(
                "the damage is in its data, not only its indexes, so rebuilding cannot repair it"
            ),
            problems=found.problems,
        )

    needed = _database_bytes(real)
    try:
        recovery_dir.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(recovery_dir).free
    except OSError as e:
        return Recovery(RECOVERY_REFUSED, reason=f"there is nowhere to keep a copy first ({e})",
                        problems=found.problems)
    if free < needed + _FREE_SPACE_MARGIN:
        return Recovery(
            RECOVERY_REFUSED,
            reason=(
                "there is not enough free space to keep a copy of it before rebuilding its "
                "indexes"
            ),
            problems=found.problems,
        )

    try:
        copy = _preserve(real, recovery_dir)
    except (OSError, sqlite3.Error) as e:
        return Recovery(RECOVERY_REFUSED, reason=f"a copy could not be kept first ({e})",
                        problems=found.problems)

    try:
        _reindex(real, found.indexes)
    except sqlite3.Error as e:
        return Recovery(
            RECOVERY_REFUSED,
            reason=f"rebuilding its indexes failed and was rolled back ({e})",
            indexes=found.indexes,
            preserved_copy=copy,
            problems=found.problems,
        )

    after = diagnose(real)
    if after.status != STATUS_HEALTHY:
        return Recovery(
            RECOVERY_REFUSED,
            reason="it still fails its integrity check after its indexes were rebuilt",
            indexes=found.indexes,
            preserved_copy=copy,
            problems=after.problems or found.problems,
        )

    _prune_copies(recovery_dir, real.stem)
    log.warning(
        "rebuilt damaged SQLite indexes in %s (%s); the database as found is kept at %s",
        real, ", ".join(found.indexes), copy,
    )
    return Recovery(RECOVERY_REPAIRED, indexes=found.indexes, preserved_copy=copy,
                    problems=found.problems)
