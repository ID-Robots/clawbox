"""TASK-1000: the one SQLite repair ClawKeep owns — index-only damage, rebuilt
with a copy kept first — and every case where it must leave the file alone."""

from __future__ import annotations

import hashlib
import os
import sqlite3
from collections import namedtuple
from pathlib import Path

import pytest

from clawkeep import sqlite_recovery
from tests.test_backup_guard import _logs_db, _rows


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    state = tmp_path / "state"
    state.mkdir()
    return state, tmp_path / "recovery"


def test_diagnose_names_every_damaged_index(roots: tuple[Path, Path]) -> None:
    state, _ = roots
    db = state / "logs.sqlite"
    _logs_db(db)
    found = sqlite_recovery.diagnose(db)
    assert found.status == sqlite_recovery.STATUS_INDEX_ONLY
    assert found.indexes == ("idx_logs_level", "idx_logs_ts")


def test_index_only_damage_is_rebuilt_without_changing_a_row(roots: tuple[Path, Path]) -> None:
    state, recovery = roots
    db = state / "logs.sqlite"
    _logs_db(db)
    before = _rows(db)

    outcome = sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)

    assert outcome.status == sqlite_recovery.RECOVERY_REPAIRED
    assert outcome.indexes == ("idx_logs_level", "idx_logs_ts")
    assert _rows(db) == before
    assert sqlite_recovery.diagnose(db).status == sqlite_recovery.STATUS_HEALTHY
    assert outcome.preserved_copy is not None and outcome.preserved_copy.parent == recovery
    assert _rows(outcome.preserved_copy) == before
    assert oct(recovery.stat().st_mode & 0o777) == oct(0o700)


def test_a_healthy_database_is_left_alone(roots: tuple[Path, Path]) -> None:
    state, recovery = roots
    db = state / "ok.sqlite"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE t(x)")
    conn.commit()
    conn.close()
    digest = _sha(db)
    outcome = sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)
    assert outcome.status == sqlite_recovery.RECOVERY_HEALTHY
    assert _sha(db) == digest
    assert not recovery.exists()


def _corrupt_table_page(db: Path) -> None:
    """Scribble over the first table's leaf page: damage to DATA, which no
    index rebuild can put back."""
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, body TEXT)")
    conn.executemany("INSERT INTO t(body) VALUES (?)", [("x" * 200,) for _ in range(50)])
    conn.commit()
    page_size = conn.execute("PRAGMA page_size").fetchone()[0]
    root = conn.execute("SELECT rootpage FROM sqlite_master WHERE name = 't'").fetchone()[0]
    conn.close()
    with db.open("r+b") as fh:
        fh.seek((root - 1) * page_size + 8)
        fh.write(b"\xff" * 64)


@pytest.mark.parametrize("damage", ["table-page", "foreign-key"])
def test_data_damage_is_refused_and_the_file_is_not_written(
    roots: tuple[Path, Path], damage: str,
) -> None:
    state, recovery = roots
    db = state / "broken.sqlite"
    if damage == "table-page":
        _corrupt_table_page(db)
    else:
        conn = sqlite3.connect(db)
        conn.executescript(
            "CREATE TABLE p(id INTEGER PRIMARY KEY);"
            "CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id));"
            "INSERT INTO c(p) VALUES (7);",
        )
        conn.commit()
        conn.close()
    digest = _sha(db)

    outcome = sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)

    assert outcome.status == sqlite_recovery.RECOVERY_REFUSED
    assert outcome.problems, "the refusal must say what the check found"
    assert _sha(db) == digest
    assert not recovery.exists(), "nothing is copied for a database that is not repaired"


def test_a_database_outside_the_backup_roots_is_never_touched(
    roots: tuple[Path, Path], tmp_path: Path,
) -> None:
    state, recovery = roots
    elsewhere = tmp_path / "elsewhere" / "logs.sqlite"
    _logs_db(elsewhere)
    link = state / "logs.sqlite"
    link.symlink_to(elsewhere)
    digest = _sha(elsewhere)
    for candidate in (elsewhere, link):
        outcome = sqlite_recovery.recover(
            candidate, allowed_roots=[str(state)], recovery_dir=recovery,
        )
        assert outcome.status == sqlite_recovery.RECOVERY_REFUSED
        assert "not inside" in outcome.reason
    assert _sha(elsewhere) == digest


def test_no_room_for_the_copy_means_no_repair(
    roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    state, recovery = roots
    db = state / "logs.sqlite"
    _logs_db(db)
    digest = _sha(db)
    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(sqlite_recovery.shutil, "disk_usage", lambda p: usage(1, 1, 1024))
    outcome = sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)
    assert outcome.status == sqlite_recovery.RECOVERY_REFUSED
    assert "not enough free space" in outcome.reason
    assert _sha(db) == digest
    assert list(recovery.glob("*.sqlite")) == []


def test_a_rebuild_that_fails_rolls_back_to_the_file_it_started_from(
    roots: tuple[Path, Path],
) -> None:
    """A UNIQUE index whose table really holds duplicates: the rebuild itself
    fails, the transaction rolls back, and every row is still there."""
    state, recovery = roots
    db = state / "u.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(
        "CREATE TABLE u(id INTEGER PRIMARY KEY, k TEXT); CREATE UNIQUE INDEX idx_u ON u(k);",
    )
    conn.execute("INSERT INTO u(k) VALUES ('a')")
    conn.commit()
    conn.execute("PRAGMA writable_schema = ON")
    conn.execute(
        "UPDATE sqlite_master SET sql = 'CREATE UNIQUE INDEX idx_u ON u(k) WHERE 0' "
        "WHERE name = 'idx_u'",
    )
    conn.commit()
    conn.close()
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO u(k) VALUES ('a')")
    conn.commit()
    conn.execute("PRAGMA writable_schema = ON")
    conn.execute(
        "UPDATE sqlite_master SET sql = 'CREATE UNIQUE INDEX idx_u ON u(k)' WHERE name = 'idx_u'",
    )
    conn.commit()
    conn.close()
    before = sqlite3.connect(db).execute("SELECT * FROM u ORDER BY id").fetchall()

    outcome = sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)

    assert outcome.status == sqlite_recovery.RECOVERY_REFUSED
    assert "rolled back" in outcome.reason
    assert sqlite3.connect(db).execute("SELECT * FROM u ORDER BY id").fetchall() == before
    assert outcome.preserved_copy is not None and outcome.preserved_copy.exists()


def test_only_the_newest_copies_of_one_database_are_kept(roots: tuple[Path, Path]) -> None:
    state, recovery = roots
    db = state / "logs.sqlite"
    recovery.mkdir()
    prefix = sqlite_recovery._copy_prefix(db.resolve())
    for i in range(5):
        old = recovery / f"{prefix}-2026090{i}T000000Z-x.pre-reindex.sqlite"
        old.write_bytes(b"old")
        os.utime(old, (1_000_000 + i, 1_000_000 + i))
    _logs_db(db)
    sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)
    kept = sorted(recovery.glob("logs-*.pre-reindex.sqlite"))
    assert len(kept) == 3


def test_copies_of_one_database_never_prune_another_databases_copy(tmp_path: Path) -> None:
    """Every agent's database is `openclaw-agent.sqlite`, and a stem glob for
    `openclaw` also matches `openclaw-agent-…`: pruning by stem deleted the
    only copy kept of a DIFFERENT database."""
    state = tmp_path / "state"
    recovery = tmp_path / "recovery"
    agent_a = state / "agents" / "a" / "agent" / "openclaw-agent.sqlite"
    agent_b = state / "agents" / "b" / "agent" / "openclaw-agent.sqlite"
    global_db = state / "openclaw.sqlite"

    _logs_db(agent_a)
    first = sqlite_recovery.recover(agent_a, allowed_roots=[str(state)], recovery_dir=recovery)
    assert first.preserved_copy is not None
    for db in [agent_b] * 4 + [global_db] * 4:
        db.unlink(missing_ok=True)
        _logs_db(db)
        outcome = sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)
        assert outcome.status == sqlite_recovery.RECOVERY_REPAIRED

    assert first.preserved_copy.exists(), "agent a's only copy was pruned by another database"
    assert _rows(first.preserved_copy) == _rows(agent_a)


def test_a_truncated_integrity_report_is_damage_and_never_a_rebuild(
    roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`integrity_check(N)` stops after N problems. A report that REACHES the
    limit is cut off, so whatever it did not reach is unknown — and a rebuild
    is only ever started when EVERY line is index bookkeeping. A box whose
    first 10,000 lines are all index-only must still be left exactly as found."""
    state, recovery = roots
    db = state / "logs.sqlite"
    _logs_db(db)
    before = _sha(db)
    lines = [
        f"row {n} missing from index idx_logs_ts"
        for n in range(sqlite_recovery._CHECK_LIMIT)
    ]
    monkeypatch.setattr(sqlite_recovery, "_checks", lambda conn: (list(lines), []))

    found = sqlite_recovery.diagnose(db)
    assert found.status == sqlite_recovery.STATUS_DAMAGED
    assert found.indexes == ()
    assert found.problems == tuple(lines[:5])

    outcome = sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)
    assert outcome.status == sqlite_recovery.RECOVERY_REFUSED
    assert _sha(db) == before, "the database was written to"
    assert not recovery.exists(), "nothing was copied for a repair that never starts"
    # The sentence a person reads must say what was actually found. The usual
    # one for damage asserts the DATA is broken; here nobody knows that.
    assert "stopped after" in outcome.reason and "never reported" in outcome.reason
    assert "the damage is in its data" not in outcome.reason


def test_real_data_damage_still_says_the_data_is_damaged(
    roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The truncated report's own sentence must not have replaced the one for
    a database whose data really is broken."""
    state, recovery = roots
    db = state / "logs.sqlite"
    _logs_db(db)
    monkeypatch.setattr(
        sqlite_recovery, "_checks", lambda conn: (["row 3 missing from page 4"], []),
    )

    outcome = sqlite_recovery.recover(db, allowed_roots=[str(state)], recovery_dir=recovery)
    assert outcome.status == sqlite_recovery.RECOVERY_REFUSED
    assert "the damage is in its data" in outcome.reason


def test_index_only_damage_below_the_limit_is_still_rebuilt(
    roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The limit is the only thing that changes the answer: one line short of
    it, a report of nothing but index bookkeeping is still a rebuild."""
    state, _ = roots
    db = state / "logs.sqlite"
    _logs_db(db)
    lines = [
        f"row {n} missing from index idx_logs_ts"
        for n in range(sqlite_recovery._CHECK_LIMIT - 1)
    ]
    monkeypatch.setattr(sqlite_recovery, "_checks", lambda conn: (list(lines), []))

    found = sqlite_recovery.diagnose(db)
    assert found.status == sqlite_recovery.STATUS_INDEX_ONLY
    assert found.indexes == ("idx_logs_ts",)
