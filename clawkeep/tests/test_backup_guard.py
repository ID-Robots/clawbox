"""TASK-1000: the OpenClaw backup failures field boxes hit on 2026.9.4, each
reproduced against a stand-in CLI that applies the core's own rules
(`tests/fake_openclaw.py`), and ClawKeep's boundary around them.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
import sys
import tarfile
from pathlib import Path

import pytest

from clawkeep import backup_guard, openclaw, sqlite_recovery
from clawkeep.config import Config, HeartbeatConfig, OpenclawConfig
from clawkeep.openclaw import (
    FAILURE_DUPLICATE,
    FAILURE_OTHER,
    FAILURE_RACE,
    FAILURE_SQLITE,
    FAILURE_SYMLINK,
    FAILURE_VANISHED,
    BackupPlan,
    OpenclawError,
    PlannedAsset,
)
from tests.conftest import REAL_PLAN, cli_failure

FAKE_CLI = Path(__file__).with_name("fake_openclaw.py")
ROOT = "2026-09-24T03-00-00.000Z-openclaw-backup"


def _ap(source: str | Path) -> str:
    return f"{ROOT}/payload/posix/{str(source).lstrip('/')}"


# ── the CLI's sentences, verbatim ────────────────────────────────────────────

ABSOLUTE_LINK = (
    "Backup archive write failed: Archive symbolic link target must be relative: "
    f"{_ap('/home/clawbox/.openclaw/.openclaw/plugin-skills/browser-automation')} -> "
    "/home/clawbox/.npm-global/lib/node_modules/openclaw/dist/extensions/browser/skills/"
    "browser-automation (after 1 attempt)"
)
RELATIVE_LINK = (
    "Backup archive write failed: Archive symbolic link is outside the declared backup assets: "
    f"{_ap('/home/clawbox/.openclaw/.openclaw/plugin-skills/browser-automation')} -> "
    "../../../.npm-global/lib/node_modules/openclaw/dist/extensions/browser/skills/"
    "browser-automation (after 1 attempt)"
)
DUPLICATE = (
    "Backup archive verification failed: /tmp/clawkeep-x/a.tar.gz. Archive contains duplicate "
    f"entry path: {_ap('/home/clawbox/.openclaw/state/openclaw.sqlite')}"
)
COLLISION = (
    "Backup archive verification failed: /tmp/clawkeep-x/a.tar.gz. Archive contains a portable "
    f"path collision: {_ap('/home/clawbox/.openclaw/workspace/MEMORY.md')} and "
    f"{_ap('/home/clawbox/.openclaw/workspace/memory.md')}"
)
SQLITE = (
    "SQLite database cannot be compacted safely for backup: "
    "/home/clawbox/.openclaw/logs/logs.sqlite. SQLite integrity_check failed for "
    "/home/clawbox/.openclaw/logs/logs.sqlite: row 6 missing from "
    "index idx_logs_level; row 6 missing from index idx_logs_ts; wrong # of entries in index "
    "idx_logs_ts. The source must pass full integrity checks, online SQLite backup, and offline "
    "compaction with its required SQLite capabilities; a direct file copy was refused because it "
    "can retain deleted data."
)
VANISHED = (
    "Backup archive write failed: ENOENT: no such file or directory, open "
    "'/home/clawbox/.openclaw/agents/main/sessions/4f1c.jsonl.reset.2026-09-20T01-02-03.456Z' "
    "(after 1 attempt)"
)


@pytest.mark.parametrize(
    ("message", "kind", "paths", "transient"),
    [
        (
            ABSOLUTE_LINK, FAILURE_SYMLINK,
            (_ap("/home/clawbox/.openclaw/.openclaw/plugin-skills/browser-automation"),
             "/home/clawbox/.npm-global/lib/node_modules/openclaw/dist/extensions/browser/skills/"
             "browser-automation"),
            False,
        ),
        (
            RELATIVE_LINK, FAILURE_SYMLINK,
            (_ap("/home/clawbox/.openclaw/.openclaw/plugin-skills/browser-automation"),
             "../../../.npm-global/lib/node_modules/openclaw/dist/extensions/browser/skills/"
             "browser-automation"),
            False,
        ),
        (
            DUPLICATE, FAILURE_DUPLICATE,
            (_ap("/home/clawbox/.openclaw/state/openclaw.sqlite"),), False,
        ),
        (
            COLLISION, FAILURE_DUPLICATE,
            (_ap("/home/clawbox/.openclaw/workspace/MEMORY.md"),
             _ap("/home/clawbox/.openclaw/workspace/memory.md")),
            False,
        ),
        (SQLITE, FAILURE_SQLITE, ("/home/clawbox/.openclaw/logs/logs.sqlite",), False),
        (
            VANISHED, FAILURE_VANISHED,
            ("/home/clawbox/.openclaw/agents/main/sessions/4f1c.jsonl.reset.2026-09-20T01-02-03.456Z",),
            True,
        ),
        (
            "SQLite state appeared after snapshot discovery: /s/x.sqlite. Retry backup so it can "
            "be snapshotted.", FAILURE_RACE, ("/s/x.sqlite",), True,
        ),
        (
            "Backup archive write failed: did not encounter expected EOF (last offending path: "
            "/s/a.log, after 3 attempts)", FAILURE_RACE, (), True,
        ),
        ("permission denied", FAILURE_OTHER, (), False),
        # The exec failure names a missing FILE too — it is not a race.
        ("could not exec openclaw: [Errno 2] No such file or directory: 'openclaw'",
         FAILURE_OTHER, (), False),
    ],
)
def test_classify_failure_reads_the_clis_own_sentences(
    message: str, kind: str, paths: tuple[str, ...], transient: bool,
) -> None:
    failure = openclaw.classify_failure(message)
    assert (failure.kind, failure.paths, failure.transient) == (kind, paths, transient)


def test_archive_source_path_maps_an_entry_back_to_the_box() -> None:
    source = "/home/x/.openclaw/a b.json"
    assert openclaw.archive_source_path(_ap(source)) == source
    assert openclaw.archive_source_path(f"{ROOT}/manifest.json") is None


def test_create_archive_keeps_the_whole_sentence_of_a_long_failure(tmp_path: Path) -> None:
    """The SQLite refusal names its database at the START of a long sentence;
    the old 500-character tail of stderr+stdout cut exactly that off."""
    padded = SQLITE.replace("row 6 missing", "; ".join(["row 6 missing"] * 40))
    from unittest.mock import patch

    with patch("clawkeep.openclaw.subprocess.run", return_value=cli_failure(padded)):
        with pytest.raises(OpenclawError) as info:
            openclaw.create_archive("/usr/bin/openclaw", output_dir=tmp_path)
    failure = openclaw.failure_of(info.value)
    assert failure.kind == FAILURE_SQLITE
    assert failure.paths == ("/home/clawbox/.openclaw/logs/logs.sqlite",)


# ── fixtures: a state tree and the stand-in CLI ─────────────────────────────

@pytest.fixture
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """A state dir, a global npm prefix outside it, ClawKeep's data dir and a
    stand-in `openclaw` wired to them."""
    state = tmp_path / "home" / ".openclaw"
    (state / "workspace").mkdir(parents=True)
    (state / "workspace" / "SOUL.md").write_text("soul")
    (state / "openclaw.json").write_text("{}")
    global_openclaw = tmp_path / "npm-global" / "lib" / "node_modules" / "openclaw"
    skill = global_openclaw / "dist" / "extensions" / "browser" / "skills" / "browser-automation"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("skill")
    (global_openclaw / "package.json").write_text("{}")

    data = tmp_path / "clawkeep-data"
    data.mkdir()
    monkeypatch.setenv("CLAWKEEP_DATA_DIR", str(data))
    monkeypatch.setenv("FAKE_OPENCLAW_STATE", str(state))
    calls = tmp_path / "calls.jsonl"
    monkeypatch.setenv("FAKE_OPENCLAW_CALLS", str(calls))
    failures = tmp_path / "failures.txt"
    monkeypatch.setenv("FAKE_OPENCLAW_FAILURES", str(failures))

    cli = tmp_path / "bin" / "openclaw"
    cli.parent.mkdir()
    cli.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_CLI}" "$@"\n')
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(backup_guard, "_plan", REAL_PLAN)
    return {
        "state": state, "global": global_openclaw, "skill": skill, "data": data,
        "cli": cli, "calls": calls, "failures": failures, "out": tmp_path / "out",
    }


def _cfg(cli: Path) -> Config:
    return Config(
        server="https://server",
        schedule="daily",
        openclaw=OpenclawConfig(binary=str(cli)),
        heartbeat=HeartbeatConfig(idle_interval_hours=24),
    )


def _creates(calls: Path) -> int:
    if not calls.exists():
        return 0
    return sum(1 for line in calls.read_text().splitlines() if "--dry-run" not in json.loads(line))


def _names(archive: Path) -> list[str]:
    with tarfile.open(archive, "r:gz") as tf:
        return tf.getnames()


# ── managed links ───────────────────────────────────────────────────────────

def test_openclaws_own_plugin_skill_link_fails_the_bare_cli(box: dict[str, Path]) -> None:
    """The field failure, reproduced: OpenClaw's `plugin-skills/<skill>` link
    to its global package, in a nested `.openclaw` tree the core does not skip."""
    link = box["state"] / ".openclaw" / "plugin-skills" / "browser-automation"
    link.parent.mkdir(parents=True)
    link.symlink_to(box["skill"])
    with pytest.raises(OpenclawError) as info:
        openclaw.create_archive(str(box["cli"]), output_dir=box["out"])
    assert openclaw.failure_of(info.value).kind == FAILURE_SYMLINK
    assert "must be relative" in str(info.value)


def test_a_relative_plugin_link_is_refused_as_outside_the_assets(box: dict[str, Path]) -> None:
    link = box["state"] / ".openclaw" / "plugin-skills" / "browser-automation"
    link.parent.mkdir(parents=True)
    link.symlink_to(os.path.relpath(box["skill"], link.parent))
    with pytest.raises(OpenclawError) as info:
        openclaw.create_archive(str(box["cli"]), output_dir=box["out"])
    assert "outside the declared backup assets" in str(info.value)


def test_managed_links_are_omitted_from_the_archive_and_put_back(box: dict[str, Path]) -> None:
    state = box["state"]
    links = {
        # OpenClaw's own plugin-skill link, in the stray nested state tree
        state / ".openclaw" / "plugin-skills" / "browser-automation": str(box["skill"]),
        # the peer link the plugin installer writes, in a legacy runtime-deps cache
        state / "plugin-runtime-deps" / "openclaw-2026.7.1" / "node_modules" / "openclaw":
            str(box["global"]),
        # the Coding Agent's worktree dependency link
        state / "workspace" / "proj" / "node_modules": str(box["global"].parent),
        # a relative one, inside a node_modules tree
        state / "workspace" / "app" / "node_modules" / "left-pad":
            os.path.relpath(box["global"], state / "workspace" / "app" / "node_modules"),
    }
    for link, target in links.items():
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target)

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    names = _names(made.path)
    for link in links:
        assert _ap(link) not in names, f"{link} should have been omitted"
    assert _ap(state / "workspace" / "SOUL.md") in names
    # Every link is back, exactly as it was, and no journal is left.
    for link, target in links.items():
        assert os.readlink(link) == target
    assert not (box["data"] / backup_guard.JOURNAL_NAME).exists()


def test_a_foreign_link_is_never_followed_or_touched_and_the_failure_names_it(
    box: dict[str, Path], tmp_path: Path,
) -> None:
    outside = tmp_path / "usb"
    (outside / "photos").mkdir(parents=True)
    (outside / "photos" / "a.jpg").write_bytes(b"jpg")
    link = box["state"] / "workspace" / "photos"
    link.symlink_to(outside / "photos")

    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    failure = openclaw.failure_of(info.value)
    assert failure.kind == FAILURE_SYMLINK
    assert failure.paths == (str(link), str(outside / "photos"))
    assert "does not carry or follow a link out of the backup" in str(info.value)
    assert os.readlink(link) == str(outside / "photos")
    # No half-built archive left in the output dir.
    assert not any(p.name.endswith(".tar.gz") for p in box["out"].iterdir())


def test_find_refused_links_applies_the_cores_rules_and_the_omission_rule(
    box: dict[str, Path], tmp_path: Path,
) -> None:
    state = box["state"]
    ws = state / "workspace"

    def make(link: Path, target: str | Path) -> Path:
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target)
        return link

    inside_abs = make(ws / "abs-inside", ws / "SOUL.md")                 # remapped by the core
    inside_rel = make(ws / "rel-inside", "SOUL.md")                      # fine
    escape = make(ws / "escape", "../../../../../../etc")                # refused, foreign
    etc = make(ws / "etc", "/etc")                                       # refused, foreign
    cache = make(ws / "codex-home" / ".cache" / "uv" / "x" / "bin" / "python", "/usr/bin/python3")
    store = make(ws / "h" / ".local" / "share" / "pnpm" / "store" / "v10" / "projects" / "a",
                 "../../../../../../../../../../tmp/proj")
    stale = make(ws / "h" / ".config" / "chrome" / "SingletonSocket", tmp_path / "gone" / "sock")
    (tmp_path / "live").mkdir()
    (tmp_path / "live" / "sock").write_text("")
    live = make(ws / "h2" / ".config" / "chrome" / "SingletonSocket", tmp_path / "live" / "sock")
    volatile = make(state / "browser" / "p" / "user-data" / "SingletonSocket", "/tmp/x/sock")
    regenerable = make(state / "npm" / "node_modules" / "@openclaw" / "codex" / "node_modules"
                       / "openclaw", box["global"])
    # A foreign link to a DIRECTORY holding a link: never descended into.
    (tmp_path / "far").mkdir()
    (tmp_path / "far" / "inner").symlink_to("/etc")
    far = make(ws / "far", tmp_path / "far")

    plan = openclaw.plan_backup(str(box["cli"]))
    found = {Path(r.path): r for r in backup_guard.find_refused_links(plan)}

    for fine in (inside_abs, inside_rel, volatile, regenerable):
        assert fine not in found
    assert tmp_path / "far" / "inner" not in found
    assert {p: found[p].rule for p in (escape, etc, live, far)} == dict.fromkeys(
        (escape, etc, live, far), "",
    )
    assert found[cache].rule == backup_guard.RULE_CACHE
    assert found[store].rule == backup_guard.RULE_PACKAGES
    assert found[stale].rule == backup_guard.RULE_STALE_LOCK


def test_links_detached_by_a_killed_run_are_put_back_by_the_next(
    box: dict[str, Path],
) -> None:
    link = box["state"] / ".openclaw" / "plugin-skills" / "browser-automation"
    link.parent.mkdir(parents=True)
    link.symlink_to(box["skill"])
    journal = box["data"] / backup_guard.JOURNAL_NAME
    plan = openclaw.plan_backup(str(box["cli"]))

    backup_guard.detach_links(backup_guard.find_refused_links(plan), journal)
    # SIGKILL here: the link is out, the journal says where it goes.
    assert not os.path.lexists(link)
    written = json.loads(journal.read_text())["links"]
    assert written == [{"path": str(link), "target": str(box["skill"])}]
    assert stat.S_IMODE(journal.stat().st_mode) == 0o600

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
    assert made.path.is_file()
    assert os.readlink(link) == str(box["skill"])
    assert not journal.exists()


def test_reattach_leaves_a_recreated_path_alone_and_ignores_a_garbled_journal(
    tmp_path: Path,
) -> None:
    journal = tmp_path / "detached-links.json"
    recreated = tmp_path / "node_modules" / "openclaw"
    recreated.mkdir(parents=True)
    journal.write_text(json.dumps({"links": [
        {"path": str(recreated), "target": "/somewhere"},
        {"path": "relative/link", "target": "/etc"},
        {"path": str(tmp_path / "a" / ".." / "b"), "target": "/etc"},
    ]}))
    assert backup_guard.reattach_links(journal) == []
    assert recreated.is_dir() and not recreated.is_symlink()
    assert not (tmp_path / "b").exists()
    assert not journal.exists()


def test_detach_skips_a_link_that_changed_after_the_scan(tmp_path: Path) -> None:
    link = tmp_path / "node_modules" / "openclaw"
    link.parent.mkdir()
    link.symlink_to("/new/target")
    journal = tmp_path / "j.json"
    scanned = backup_guard.RefusedLink(str(link), "/old/target", backup_guard.RULE_PACKAGES)
    assert backup_guard.detach_links([scanned], journal) == []
    assert os.readlink(link) == "/new/target"
    assert not journal.exists()


# ── duplicate logical paths ─────────────────────────────────────────────────

def test_two_sources_for_one_archive_path_are_refused_before_the_archiver_runs(
    box: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    nested = box["state"] / "workspace"
    monkeypatch.setenv("FAKE_OPENCLAW_EXTRA_ASSETS", json.dumps([
        {"kind": "workspace", "sourcePath": str(nested), "archivePath": _ap(nested)},
    ]))
    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
    failure = openclaw.failure_of(info.value)
    assert failure.kind == FAILURE_DUPLICATE
    assert failure.paths == (str(box["state"]), str(nested))
    assert _creates(box["calls"]) == 0, "the archiver must not have been invoked"


@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("/home/c/.openclaw/ws", "/home/c/.openclaw/ws"),
        ("/home/c/Work", "/home/c/work"),
    ],
)
def test_duplicate_check_reports_the_conflicting_sources(first: str, second: str) -> None:
    plan = BackupPlan(ROOT, (
        PlannedAsset("workspace", second, _ap(second)),
        PlannedAsset("state", "/home/c/.openclaw-state", _ap("/home/c/.openclaw-state")),
        PlannedAsset("agent", first, _ap(first)),
    ), ())
    with pytest.raises(OpenclawError) as info:
        backup_guard.assert_no_duplicate_paths(plan)
    assert set(openclaw.failure_of(info.value).paths) == {first, second}


def test_a_duplicate_the_archiver_finds_is_mapped_back_to_its_source_and_the_leftover_removed(
    box: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = box["state"] / "state" / "openclaw.sqlite"
    box["failures"].write_text(
        "Backup archive verification failed: /x.tar.gz. Archive contains duplicate entry path: "
        f"{_ap(db)}\n",
    )
    monkeypatch.setenv("FAKE_OPENCLAW_LEAVE", "1")
    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
    failure = openclaw.failure_of(info.value)
    assert failure.kind == FAILURE_DUPLICATE
    assert failure.paths == (str(db),)
    assert f"inside state {str(box['state'])!r}" in str(info.value)
    # The core had PUBLISHED the plaintext archive before verify refused it.
    assert list(box["out"].iterdir()) == []


# ── files that vanish mid-walk ──────────────────────────────────────────────

def test_a_vanished_path_outside_the_backup_is_not_a_race(
    box: dict[str, Path],
) -> None:
    box["failures"].write_text(
        "Backup archive write failed: ENOENT: no such file or directory, open "
        "'/usr/lib/node_modules/openclaw/dist/x.mjs' (after 1 attempt)\n",
    )
    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
    assert openclaw.failure_of(info.value).transient is False


def test_a_vanished_file_inside_the_backup_stays_a_race(box: dict[str, Path]) -> None:
    gone = box["state"] / "agents" / "main" / "sessions" / "a.jsonl.reset.2026-09-20"
    box["failures"].write_text(
        f"Backup archive write failed: ENOENT: no such file or directory, open '{gone}' "
        "(after 1 attempt)\n",
    )
    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
    failure = openclaw.failure_of(info.value)
    assert failure.kind == FAILURE_VANISHED
    assert (failure.transient, failure.paths) == (True, (str(gone),))


# ── SQLite integrity ────────────────────────────────────────────────────────

def _logs_db(path: Path) -> None:
    """A database with rows missing from two `idx_logs_*` indexes — the v4.0
    box's damage, made deterministically: the indexes are narrowed to match
    nothing while rows are added, then given their definitions back."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, "
        "msg TEXT);"
        "CREATE INDEX idx_logs_ts ON logs(ts);"
        "CREATE INDEX idx_logs_level ON logs(level, ts);",
    )
    conn.executemany("INSERT INTO logs(ts, level, msg) VALUES (?, ?, ?)",
                     [(1000 + i, "info", f"m{i}") for i in range(5)])
    conn.commit()
    definitions = {
        "idx_logs_ts": "CREATE INDEX idx_logs_ts ON logs(ts)",
        "idx_logs_level": "CREATE INDEX idx_logs_level ON logs(level, ts)",
    }
    conn.execute("PRAGMA writable_schema = ON")
    for name, sql in definitions.items():
        conn.execute("UPDATE sqlite_master SET sql = ? WHERE name = ?", (f"{sql} WHERE 0", name))
    conn.commit()
    conn.close()
    conn = sqlite3.connect(path)
    conn.executemany("INSERT INTO logs(ts, level, msg) VALUES (?, ?, ?)",
                     [(2000 + i, "warn", f"n{i}") for i in range(3)])
    conn.commit()
    conn.execute("PRAGMA writable_schema = ON")
    for name, sql in definitions.items():
        conn.execute("UPDATE sqlite_master SET sql = ? WHERE name = ?", (sql, name))
    conn.commit()
    conn.close()


def _rows(path: Path) -> list[tuple]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return conn.execute("SELECT * FROM logs ORDER BY id").fetchall()
    finally:
        conn.close()


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_index_only_damage_is_rebuilt_and_the_backup_completes(box: dict[str, Path]) -> None:
    db = box["state"] / "logs" / "logs.sqlite"
    _logs_db(db)
    before = _rows(db)
    # Reproduced: the bare CLI refuses it, naming the indexes.
    with pytest.raises(OpenclawError) as info:
        openclaw.create_archive(str(box["cli"]), output_dir=box["out"])
    assert "row 6 missing from index idx_logs_" in str(info.value)

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert _ap(db) in _names(made.path)
    assert _rows(db) == before, "a rebuild must not change a single row"
    assert sqlite_recovery.diagnose(db).status == sqlite_recovery.STATUS_HEALTHY
    recovery = box["data"] / backup_guard.SQLITE_RECOVERY_DIRNAME
    copies = list(recovery.glob("logs-*.pre-reindex.sqlite"))
    assert len(copies) == 1
    assert stat.S_IMODE(copies[0].stat().st_mode) == 0o600
    # The copy is the database AS FOUND — still damaged, every row there.
    assert sqlite_recovery.diagnose(copies[0]).status == sqlite_recovery.STATUS_INDEX_ONLY
    assert _rows(copies[0]) == before


def test_data_damage_stops_the_backup_and_leaves_the_database_untouched(
    box: dict[str, Path],
) -> None:
    db = box["state"] / "agents" / "main" / "agent" / "extra.sqlite"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(db)
    conn.executescript(
        "CREATE TABLE parent(id INTEGER PRIMARY KEY);"
        "CREATE TABLE child(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id));"
        "INSERT INTO child(p) VALUES (42);",
    )
    conn.commit()
    conn.close()
    digest = _sha(db)

    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    failure = openclaw.failure_of(info.value)
    assert (failure.kind, failure.paths) == (FAILURE_SQLITE, (str(db),))
    message = str(info.value)
    assert "fails its SQLite integrity check" in message
    assert "did not back it up, skip it, or copy it" in message
    assert _sha(db) == digest, "the database must not have been written to"
    assert not (box["data"] / backup_guard.SQLITE_RECOVERY_DIRNAME).exists()
    assert list(box["out"].iterdir()) == []


def test_a_database_repaired_once_is_not_repaired_again_in_the_same_run(
    box: dict[str, Path],
) -> None:
    db = box["state"] / "logs" / "logs.sqlite"
    _logs_db(db)
    # The core keeps refusing it even after the rebuild: ClawKeep stops, once.
    refusal = SQLITE.replace("/home/clawbox/.openclaw/logs/logs.sqlite", str(db))
    box["failures"].write_text(f"{refusal}\n" * 3)
    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
    assert openclaw.failure_of(info.value).kind == FAILURE_SQLITE
    assert _creates(box["calls"]) == 2


def test_a_second_build_waits_for_the_first_to_put_its_links_back(box: dict[str, Path]) -> None:
    """A scheduled run and "Back up now" can overlap; one run's put-back must
    not land in the middle of the other's build."""
    import threading

    lock = box["data"] / backup_guard.LOCK_NAME
    done = threading.Event()

    def second() -> None:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
        done.set()

    with backup_guard.exclusive(lock):
        worker = threading.Thread(target=second, daemon=True)
        worker.start()
        assert not done.wait(1.0), "the second build must wait for the lock"
    worker.join(30)
    assert done.is_set()
    assert stat.S_IMODE(lock.stat().st_mode) == 0o600
