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

from clawkeep import backup_guard, openclaw, own_backups, sqlite_recovery
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


def test_a_foreign_link_is_skipped_never_followed_and_named(
    box: dict[str, Path], tmp_path: Path,
) -> None:
    """TASK-1304: a link to a folder kept outside the backup used to fail the
    whole run, after the long archive step. It is skipped now: the snapshot
    does not carry it, nothing it points at goes in, it is back on the box
    exactly as it was, and the archive names it."""
    outside = tmp_path / "usb"
    (outside / "photos").mkdir(parents=True)
    (outside / "photos" / "a.jpg").write_bytes(b"jpg")
    link = box["state"] / "workspace" / "photos"
    link.symlink_to(outside / "photos")

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    names = _names(made.path)
    assert _ap(link) not in names
    assert not any("a.jpg" in name for name in names), "a skipped link is never followed"
    assert _ap(box["state"] / "workspace" / "SOUL.md") in names
    assert os.readlink(link) == str(outside / "photos")
    assert not (box["data"] / backup_guard.JOURNAL_NAME).exists()
    assert made.skipped_link_count == 1
    assert made.skipped_links == ((own_backups.display_path(str(link)), str(outside / "photos")),)
    assert _creates(box["calls"]) == 1


def test_without_a_dry_run_a_refused_link_still_fails_by_name(
    box: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No plan, no walk and no net: there is no declared asset list to hold a
    link against. The archiver's refusal then stands, and says which link."""
    monkeypatch.setattr(backup_guard, "_plan", lambda cfg: None)
    outside = tmp_path / "usb"
    outside.mkdir()
    link = box["state"] / "workspace" / "usb"
    link.symlink_to(outside)

    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    failure = openclaw.failure_of(info.value)
    assert failure.kind == FAILURE_SYMLINK
    assert failure.paths == (str(link), str(outside))
    assert "could not leave it out of this run" in str(info.value)
    assert "does not carry or follow a link out of the backup" in str(info.value)
    assert os.readlink(link) == str(outside)
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
    assert "still failed after its indexes were rebuilt" in str(info.value)
    assert _creates(box["calls"]) == 2


def test_a_database_the_core_refuses_though_it_checks_healthy_is_named_as_such(
    box: dict[str, Path],
) -> None:
    """The core also refuses on grounds ClawKeep's check cannot see (a newer
    SQLite, its own schema checks): one second look, then a plain answer."""
    db = box["state"] / "state" / "openclaw.sqlite"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE t(x)")
    conn.commit()
    conn.close()
    digest = _sha(db)
    refusal = SQLITE.replace("/home/clawbox/.openclaw/logs/logs.sqlite", str(db))
    box["failures"].write_text(f"{refusal}\n" * 2)
    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
    assert "found nothing it may repair, and the archiver refused it again" in str(info.value)
    assert _sha(db) == digest
    assert _creates(box["calls"]) == 2


def test_an_unreadable_journal_is_kept_and_nothing_new_is_detached(tmp_path: Path) -> None:
    journal = tmp_path / "detached-links.json"
    journal.write_text("{not json")
    link = tmp_path / "node_modules" / "openclaw"
    link.parent.mkdir()
    link.symlink_to("/opt/openclaw")
    found = backup_guard.RefusedLink(str(link), "/opt/openclaw", backup_guard.RULE_PACKAGES)

    assert backup_guard.reattach_links(journal) == []
    assert backup_guard.detach_links([found], journal) == []
    assert journal.read_text() == "{not json"
    assert os.readlink(link) == "/opt/openclaw"


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


def test_a_detach_that_fails_part_way_still_puts_the_links_back(
    box: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The second journal write is the one that fails on a full disk — and by
    then the links are already out of the tree. The put-back has to run in THIS
    backup; waiting for the next one leaves the box without its package links
    until tomorrow."""
    state = box["state"]
    link = state / "workspace" / "proj" / "node_modules"
    link.parent.mkdir(parents=True)
    link.symlink_to(box["global"].parent)

    real_write = backup_guard._write_journal
    writes: list[Path] = []

    def full_disk(journal: Path, entries: list[dict[str, str]]) -> None:
        writes.append(journal)
        if len(writes) == 2:  # after the unlink, before the build
            raise OSError(28, "No space left on device")
        real_write(journal, entries)

    monkeypatch.setattr(backup_guard, "_write_journal", full_disk)

    with pytest.raises(OSError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert info.value.errno == 28
    assert os.readlink(link) == str(box["global"].parent), "the link never came back"
    assert not (box["data"] / backup_guard.JOURNAL_NAME).exists()
    assert _creates(box["calls"]) == 0, "no archive was ever built"


def test_a_link_whose_target_is_inside_the_backup_is_never_detached(
    box: dict[str, Path],
) -> None:
    """The blast radius of detaching: only a link the archiver would REFUSE.
    A worktree whose `node_modules` points at a project the backup also covers
    keeps its link for the whole build, so a coding run working in it never
    sees the path go missing."""
    state = box["state"]
    ws = state / "workspace"
    (ws / "proj" / "node_modules" / "left-pad").mkdir(parents=True)
    live = ws / "proj" / ".clawbox" / "worktrees" / "run-1" / "node_modules"
    live.parent.mkdir(parents=True)
    live.symlink_to(ws / "proj" / "node_modules")

    plan = openclaw.plan_backup(str(box["cli"]))
    assert not [r for r in backup_guard.find_refused_links(plan) if r.path == str(live)]

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert os.readlink(live) == str(ws / "proj" / "node_modules")
    assert _ap(live) in _names(made.path), "the link belongs in the archive"


# ── TASK-1304: absolute links never fail a backup ───────────────────────────

SHAPES = ("absolute-inside", "absolute-outside-dir", "absolute-dangling", "relative-outside")


def _link_shapes(
    state: Path, tmp_path: Path, only: str | None = None,
) -> dict[str, tuple[Path, str]]:
    """The four link shapes the card names, in a sales project of the
    workspace, as {shape: (link, its text)}:

      (a) an absolute link to a file INSIDE the backup,
      (b) an absolute link to a directory outside it,
      (c) an absolute link to nothing,
      (d) a relative link that climbs out of it.
    """
    ws = state / "workspace"
    (ws / "orders").mkdir(parents=True, exist_ok=True)
    (ws / "orders" / "order-form-2026.pdf").write_bytes(b"%PDF inside")
    shared = tmp_path / "Shared" / "Exports" / "catalogue"
    shared.mkdir(parents=True, exist_ok=True)
    (shared / "edition.pdf").write_bytes(b"%PDF outside")
    (tmp_path / "Shared" / "notes.txt").write_text("outside")
    docs = ws / "projects" / "sales" / "documents"
    docs.mkdir(parents=True, exist_ok=True)
    shapes = {
        "absolute-inside": (docs / "order-form.pdf", str(ws / "orders" / "order-form-2026.pdf")),
        "absolute-outside-dir": (docs / "catalogue", str(shared)),
        "absolute-dangling": (docs / "old-catalogue.pdf", str(tmp_path / "Shared" / "gone.pdf")),
        "relative-outside": (
            docs / "notes.txt", os.path.relpath(tmp_path / "Shared" / "notes.txt", docs),
        ),
    }
    if only is not None:
        shapes = {only: shapes[only]}
    for link, text in shapes.values():
        link.symlink_to(text)
    return shapes


def _member(archive: Path, name: str) -> tarfile.TarInfo:
    with tarfile.open(archive, "r:gz") as tf:
        return tf.getmember(name)


@pytest.mark.parametrize("shape", SHAPES)
def test_each_link_shape_ends_in_a_finished_backup(
    box: dict[str, Path], tmp_path: Path, shape: str,
) -> None:
    shapes = _link_shapes(box["state"], tmp_path, only=shape)
    link, text = shapes[shape]

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert made.path.is_file()
    assert _creates(box["calls"]) == 1, "one build, no failed one before it"
    names = _names(made.path)
    assert _ap(box["state"] / "workspace" / "SOUL.md") in names
    assert not any("/Shared/" in n for n in names), "nothing outside the backup is archived"
    # Whatever happened to it in the build, the link is back as it was.
    assert os.readlink(link) == text
    assert not (box["data"] / backup_guard.JOURNAL_NAME).exists()
    if shape == "absolute-inside":
        # Carried — as the relative link to the same file, which is in there too.
        member = _member(made.path, _ap(link))
        assert member.issym() and not os.path.isabs(member.linkname)
        landed = os.path.normpath(os.path.join(os.path.dirname(_ap(link)), member.linkname))
        assert landed == _ap(text)
        assert landed in names
        assert (made.skipped_link_count, made.skipped_links) == (0, ())
    else:
        assert _ap(link) not in names
        assert made.skipped_link_count == 1
        assert made.skipped_links == ((own_backups.display_path(str(link)), text),)


def test_every_refused_link_is_handled_in_one_pass_before_the_one_build(
    box: dict[str, Path], tmp_path: Path,
) -> None:
    """The pre-flight's one walk finds every link the archiver would refuse
    and takes them all out together: no second build after the first one
    stops on the second link."""
    shapes = _link_shapes(box["state"], tmp_path)
    for i in range(3):
        extra = box["state"] / "workspace" / "projects" / f"p{i}" / "export"
        extra.parent.mkdir(parents=True)
        extra.symlink_to(tmp_path / "Shared" / "Exports")

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert _creates(box["calls"]) == 1
    skipped = [link for shape, (link, _) in shapes.items() if shape != "absolute-inside"]
    skipped += [box["state"] / "workspace" / "projects" / f"p{i}" / "export" for i in range(3)]
    assert made.skipped_link_count == len(skipped) == 6
    assert [path for path, _ in made.skipped_links] == sorted(
        own_backups.display_path(str(p)) for p in skipped
    )
    for link, text in shapes.values():
        assert os.readlink(link) == text


def test_the_report_names_the_first_links_and_counts_them_all(
    box: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(backup_guard, "LISTED_SKIPPED_LINKS", 2)
    ws = box["state"] / "workspace"
    for name in ("c", "a", "b"):
        (ws / name).symlink_to(tmp_path / "Shared" / name)

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert made.skipped_link_count == 3
    assert made.skipped_links == tuple(
        (own_backups.display_path(str(ws / name)), str(tmp_path / "Shared" / name))
        for name in ("a", "b")
    )


def test_managed_links_are_left_out_but_not_reported_as_skipped(box: dict[str, Path]) -> None:
    link = box["state"] / "workspace" / "proj" / "node_modules"
    link.parent.mkdir(parents=True)
    link.symlink_to(box["global"].parent)

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert _ap(link) not in _names(made.path)
    assert (made.skipped_link_count, made.skipped_links) == (0, ())


def test_a_stricter_core_costs_one_rebuild_not_one_per_link(
    box: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pre-flight mirrors the archiver's rule; a core that refuses even
    an absolute link INSIDE the backup does not fail the run. The link it
    names goes out, with every absolute link like it, and one rebuild runs."""
    monkeypatch.setenv("FAKE_OPENCLAW_NO_ABSOLUTE", "1")
    ws = box["state"] / "workspace"
    inside = [ws / "a-link", ws / "deep" / "b-link"]
    for link in inside:
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(ws / "SOUL.md")
    relative = ws / "rel-link"
    relative.symlink_to("SOUL.md")

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert _creates(box["calls"]) == 2
    names = _names(made.path)
    assert all(_ap(link) not in names for link in inside)
    assert _ap(relative) in names, "a link the stricter core still takes stays in"
    assert made.skipped_link_count == 2
    assert {path for path, _ in made.skipped_links} == {
        own_backups.display_path(str(link)) for link in inside
    }
    for link in inside:
        assert os.readlink(link) == str(ws / "SOUL.md")


def test_the_rebuilds_for_links_the_rule_missed_are_bounded(box: dict[str, Path]) -> None:
    ws = box["state"] / "workspace"
    a, b, d = ws / "a", ws / "b", ws / "d"
    a.symlink_to(ws / "SOUL.md")
    b.symlink_to("SOUL.md")
    d.symlink_to("SOUL.md")
    box["failures"].write_text(
        "Backup archive write failed: Archive symbolic link target must be relative: "
        f"{_ap(a)} -> {ws / 'SOUL.md'} (after 1 attempt)\n"
        + "".join(
            "Backup archive write failed: Archive symbolic link is outside the declared backup "
            f"assets: {_ap(link)} -> SOUL.md (after 1 attempt)\n"
            for link in (b, d)
        ),
    )

    with pytest.raises(OpenclawError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert _creates(box["calls"]) == 1 + backup_guard.MAX_LINK_REBUILDS
    failure = openclaw.failure_of(info.value)
    assert (failure.kind, failure.paths) == (FAILURE_SYMLINK, (str(d), "SOUL.md"))
    assert "could not leave it out of this run" in str(info.value)
    assert os.readlink(a) == str(ws / "SOUL.md")
    assert os.readlink(b) == os.readlink(d) == "SOUL.md"
    assert not (box["data"] / backup_guard.JOURNAL_NAME).exists()


def test_the_net_never_takes_out_what_is_not_a_link_inside_the_backup(
    box: dict[str, Path], tmp_path: Path,
) -> None:
    outside = tmp_path / "elsewhere"
    outside.symlink_to("/etc")
    box["failures"].write_text(
        "Backup archive write failed: Archive symbolic link target must be relative: "
        f"{_ap(outside)} -> /etc (after 1 attempt)\n",
    )
    with pytest.raises(OpenclawError):
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])
    assert _creates(box["calls"]) == 1
    assert os.readlink(outside) == "/etc"


def test_the_stricter_readings(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "dir").mkdir(parents=True)
    (root / "file").write_text("x")
    (tmp_path / "out").mkdir()
    (root / "via").symlink_to(tmp_path / "out")
    roots = [str(root)]
    at = str(root / "dir" / "link")

    # The archiver's rule: an absolute link inside is fine, so are these two.
    assert not backup_guard._link_refused(at, str(root / "file"), roots)
    assert not backup_guard._link_refused(at, "../gone", roots)
    assert not backup_guard._link_refused(at, "../via/x", roots)
    # Stricter for absolute links: none at all.
    assert backup_guard._absolute_refused(at, str(root / "file"), roots)
    assert not backup_guard._absolute_refused(at, "../file", roots)
    # Stricter for relative links: the REAL target, which must exist.
    assert backup_guard._relative_refused(at, "../gone", roots)
    (tmp_path / "out" / "x").write_text("x")
    assert backup_guard._relative_refused(at, "../via/x", roots)
    assert not backup_guard._relative_refused(at, "../file", roots)


def test_a_backup_with_skipped_links_finishes_end_to_end_and_says_so(
    box: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole run, through the real pre-flight and the stand-in core: the
    four shapes back up, the heartbeats say running then ok — never error —
    state.json names the skipped links, and the snapshot's record in the
    plaintext manifest carries their names SEALED."""
    from unittest.mock import patch

    from clawkeep import agent, crypto, passphrase, runner, s3, state
    from clawkeep.api import Credentials
    from clawkeep.s3 import CloudStats

    monkeypatch.setattr(agent, "device_agent", lambda: agent.AGENT_OPENCLAW)
    passphrase.write("test-passphrase")
    shapes = _link_shapes(box["state"], tmp_path)
    creds = Credentials(
        accessKeyId="AKIA", secretAccessKey="secret", sessionToken="session",
        endpoint="https://acct.r2.cloudflarestorage.com", bucket="clawkeep",
        prefix="users/u_x/repo/", expiresAt=9_999_999_999_999, quotaBytes=5_368_709_120,
        cloudBytes=0,
    )
    heartbeats: list[dict[str, object]] = []
    written: list[dict] = []
    uploaded: list[str] = []

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=creds),
        patch("clawkeep.runner.api.heartbeat",
              side_effect=lambda server, token, **kw: heartbeats.append(kw)),
        patch("clawkeep.runner.s3.upload",
              side_effect=lambda c, *, archive_path, object_name, progress_cb=None:
              uploaded.append(object_name)),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
        patch("clawkeep.runner.s3.read_manifest", return_value={"version": 1, "snapshots": {}}),
        patch("clawkeep.runner.s3.write_manifest",
              side_effect=lambda c, manifest: written.append(json.loads(json.dumps(manifest)))),
        patch("clawkeep.runner.s3.list_snapshots", return_value=[]),
    ):
        rc = runner.run_once(_cfg(box["cli"]), "claw_x")

    assert rc == runner.EXIT_OK
    assert [hb["status"] for hb in heartbeats] == ["running", "ok"]
    assert all("error" not in hb for hb in heartbeats)
    expected = sorted(
        (own_backups.display_path(str(link)), text)
        for shape, (link, text) in shapes.items() if shape != "absolute-inside"
    )
    st = state.load()
    assert st.last_heartbeat_status == "ok"
    assert st.last_backup_at_ms > 0
    assert st.last_skipped_link_count == 3
    assert st.last_skipped_links == [{"path": p, "target": t} for p, t in expected]
    for link, text in shapes.values():
        assert os.readlink(link) == text

    # The annotate write; retention's own rewrite comes after it.
    annotated = written[0]
    record = annotated["snapshots"][uploaded[0]]
    assert record[s3.RECORD_SKIPPED_LINK_COUNT] == 3
    assert "sales" not in json.dumps(annotated), "no file name in the plaintext manifest"
    opened = crypto.open_sealed(
        record[s3.RECORD_SKIPPED_LINKS], password_file=passphrase.default_passphrase_path(),
    )
    assert json.loads(opened) == [{"path": p, "target": t} for p, t in expected]
