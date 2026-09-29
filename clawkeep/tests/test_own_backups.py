"""TASK-1301: a snapshot must not carry the box's own backup archives.

Measured on the real OpenClaw 2026.9.4 against a scratch state dir: `backup
create` carries `<state>/backups/**` byte for byte, lists none of it as
skipped, and has no exclude option (no flag, no config key). The stand-in CLI
(`tests/fake_openclaw.py`) carries everything the same way, so each test below
reads the archive it built to see what went in.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import stat
from pathlib import Path

import pytest

from clawkeep import backup_guard, openclaw, own_backups, runner, state
from clawkeep.openclaw import OpenclawError
from clawkeep.own_backups import RULE_OPENCLAW_ARCHIVE, RULE_STATE_BACKUPS
from tests.test_backup_guard import _ap, _cfg, _names, box  # noqa: F401 — `box` is a fixture

OFFLINE = "2026-09-07T03-00-04.294+00-00-openclaw-backup.tar.gz.enc"


def _file(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _identity(path: Path) -> tuple[int, int, str]:
    """Inode, device and content: the SAME file, not a copy of it."""
    st = path.stat()
    return st.st_ino, st.st_dev, hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def own(box: dict[str, Path]) -> dict[str, Path]:  # noqa: F811 — the fixture above
    """The reporting box's shape: its own archives inside the state dir, next
    to files that are not archives or not the box's own."""
    state_dir = box["state"]
    nightly = state_dir / "backups" / "nightly"
    return {
        "nightly": _file(nightly / "workspace-20260920.tar.gz", b"n" * 700),
        "offline": _file(state_dir / "backups" / "openclaw-offline" / OFFLINE, b"o" * 1500),
        "core": _file(
            state_dir / "workspace" / "2026-09-01T02-00-00.000Z-openclaw-backup.tar.gz", b"c" * 300,
        ),
        "readme": _file(nightly / "README.txt", b"keep me"),
        "photos": _file(state_dir / "workspace" / "photos.zip", b"p" * 50),
    }


# ── the rule ────────────────────────────────────────────────────────────────

S = "/home/clawbox/.openclaw"


@pytest.mark.parametrize(
    ("path", "rule"),
    [
        (f"{S}/backups/nightly/workspace-20260920.tar.gz", RULE_STATE_BACKUPS),
        (f"{S}/backups/a/b/c/dump.ZIP", RULE_STATE_BACKUPS),
        (f"{S}/backups/x.tgz", RULE_STATE_BACKUPS),
        (f"{S}/backups/secrets.age", RULE_STATE_BACKUPS),
        (f"{S}/backups/openclaw-offline/{OFFLINE}", RULE_OPENCLAW_ARCHIVE),
        (f"{S}/2026-09-29T12-58-36.371+03-00-openclaw-backup.tar.gz", RULE_OPENCLAW_ARCHIVE),
        (f"{S}/workspace/2026-09-24T03-00-00.000Z-openclaw-backup.tar.gz", RULE_OPENCLAW_ARCHIVE),
        ("/srv/elsewhere/2026-09-24T03-00-00Z-openclaw-backup.tar.gz.enc", RULE_OPENCLAW_ARCHIVE),
        # Not an archive, or not in the state dir's own backups folder.
        (f"{S}/backups/nightly/README.txt", ""),
        (f"{S}/backups/state.sqlite", ""),
        (f"{S}/backups.tar.gz", ""),
        (f"{S}/backupsold/x.tar.gz", ""),
        (f"{S}/workspace/backups/x.tar.gz", ""),
        (f"{S}/workspace/dump.tar.gz", ""),
        (f"{S}/workspace/openclaw-backup.tar.gz", ""),
        (f"{S}/workspace/2026-09-24-openclaw-backup.tar.gz", ""),
    ],
)
def test_the_rule_reads_the_path_and_the_name_and_nothing_else(path: str, rule: str) -> None:
    assert own_backups.left_out_rule(path, S) == rule
    # Deterministic: the same answer every time, with nothing on disk.
    assert own_backups.left_out_rule(path, S) == rule


def test_without_a_state_dir_only_openclaws_own_archive_name_is_left_out() -> None:
    assert own_backups.left_out_rule(f"{S}/backups/x.tar.gz", None) == ""
    assert own_backups.left_out_rule(f"{S}/backups/{OFFLINE}", None) == RULE_OPENCLAW_ARCHIVE


def test_display_path_says_home_as_a_tilde(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", "/home/clawbox")
    assert own_backups.display_path("/home/clawbox/.openclaw/x.zip") == "~/.openclaw/x.zip"
    assert own_backups.display_path("/home/clawboxer/x.zip") == "/home/clawboxer/x.zip"
    assert own_backups.display_path("/srv/x.zip") == "/srv/x.zip"


# ── end to end, through the stand-in core ───────────────────────────────────

def test_the_boxs_own_archives_are_left_out_and_put_back_as_the_same_files(
    box: dict[str, Path], own: dict[str, Path],  # noqa: F811
) -> None:
    before = {name: _identity(path) for name, path in own.items()}

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    names = _names(made.path)
    for left_out in ("nightly", "offline", "core"):
        assert _ap(own[left_out]) not in names, f"{left_out} went into the snapshot"
    for kept in ("readme", "photos"):
        assert _ap(own[kept]) in names, f"{kept} is not the box's own backup and belongs in it"
    assert _ap(box["state"] / "workspace" / "SOUL.md") in names
    # Every file is back as the SAME inode on the same disk: renamed, never
    # copied, never rewritten.
    assert {name: _identity(path) for name, path in own.items()} == before
    assert made.left_out_count == 3
    assert made.left_out_bytes == 700 + 1500 + 300
    assert not (box["data"] / own_backups.JOURNAL_NAME).exists()
    assert not (box["data"] / own_backups.HOLD_DIRNAME).exists()


def test_while_the_core_builds_the_files_are_held_on_the_same_disk_and_journalled(
    box: dict[str, Path], own: dict[str, Path], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
) -> None:
    real_create = openclaw.create_archive
    seen: dict[str, object] = {}

    def create(*args: object, **kwargs: object) -> openclaw.Archive:
        journal = box["data"] / own_backups.JOURNAL_NAME
        seen["mode"] = stat.S_IMODE(journal.stat().st_mode)
        seen["entries"] = json.loads(journal.read_text())["files"]
        seen["present"] = [p.exists() for p in own.values()]
        return real_create(*args, **kwargs)

    monkeypatch.setattr(openclaw, "create_archive", create)
    backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert seen["mode"] == 0o600
    entries = {e["path"]: e for e in seen["entries"]}
    assert set(entries) == {str(own[k]) for k in ("nightly", "offline", "core")}
    for entry in entries.values():
        held = Path(entry["held"])
        assert held.parent.parent == box["data"] / own_backups.HOLD_DIRNAME
        assert held.parent.name.startswith("run-")
    assert entries[str(own["offline"])]["bytes"] == 1500
    assert seen["present"] == [False, False, False, True, True]


def test_a_failed_build_puts_every_file_back(
    box: dict[str, Path], own: dict[str, Path],  # noqa: F811
) -> None:
    before = {name: _identity(path) for name, path in own.items()}
    box["failures"].write_text("permission denied\n")

    with pytest.raises(OpenclawError):
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert {name: _identity(path) for name, path in own.items()} == before
    assert not (box["data"] / own_backups.JOURNAL_NAME).exists()


def test_a_set_aside_that_fails_part_way_still_puts_the_files_back(
    box: dict[str, Path], own: dict[str, Path], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
) -> None:
    """The second journal write — after the renames — is the one a full disk
    breaks. The files are out of the tree by then; they come back in THIS run."""
    real_write = own_backups._write_journal
    writes: list[int] = []

    def full_disk(journal: Path, entries: list[dict[str, object]]) -> None:
        writes.append(len(entries))
        if len(writes) == 2:
            raise OSError(28, "No space left on device")
        real_write(journal, entries)

    monkeypatch.setattr(own_backups, "_write_journal", full_disk)
    with pytest.raises(OSError) as info:
        backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert info.value.errno == 28
    for path in own.values():
        assert path.is_file(), f"{path} never came back"
    assert not (box["data"] / own_backups.JOURNAL_NAME).exists()


def test_files_a_killed_run_set_aside_are_put_back_by_the_next(
    box: dict[str, Path], own: dict[str, Path],  # noqa: F811
) -> None:
    journal = box["data"] / own_backups.JOURNAL_NAME
    plan = openclaw.plan_backup(str(box["cli"]))
    found = backup_guard.scan(plan).archives
    before = _identity(own["offline"])

    moved = own_backups.set_aside(found, [str(box["state"])], journal, box["data"])
    # SIGKILL here: the files are out, the journal says where they went.
    assert {m.path for m in moved} == {str(own[k]) for k in ("nightly", "offline", "core")}
    assert not own["offline"].exists()

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert _identity(own["offline"]) == before
    assert _ap(own["offline"]) not in _names(made.path)
    assert made.left_out_count == 3
    assert not journal.exists()


def test_the_idle_tick_puts_back_what_a_killed_run_set_aside_but_never_mid_build(
    box: dict[str, Path], own: dict[str, Path],  # noqa: F811
) -> None:
    journal = box["data"] / own_backups.JOURNAL_NAME
    found = backup_guard.scan(openclaw.plan_backup(str(box["cli"]))).archives
    own_backups.set_aside(found, [str(box["state"])], journal, box["data"])
    assert not own["nightly"].exists()

    # A build holds the lock: its files are its own to put back.
    with backup_guard.exclusive(box["data"] / backup_guard.LOCK_NAME):
        backup_guard.put_back_interrupted()
        assert not own["nightly"].exists()

    backup_guard.put_back_interrupted()
    assert own["nightly"].is_file() and own["offline"].is_file() and own["core"].is_file()
    assert not journal.exists()


def test_a_file_on_another_filesystem_stays_in_the_snapshot_and_is_never_copied(
    box: dict[str, Path], own: dict[str, Path], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
) -> None:
    """No hold directory shares the file's disk: moving it would mean copying
    gigabytes, so it stays — carried, and named as a snapshot-sized archive."""
    monkeypatch.setattr(own_backups, "LARGE_ARCHIVE_BYTES", 1000)
    nightly_dir = str(own["nightly"].parent)
    real_device = own_backups._device
    monkeypatch.setattr(
        own_backups, "_device",
        lambda path: 4242 if str(path) == nightly_dir else real_device(path),
    )
    big = _file(own["nightly"].parent / "workspace-20260921.tar.gz", b"b" * 2000)
    before = _identity(big)

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    names = _names(made.path)
    assert _ap(big) in names and _ap(own["nightly"]) in names
    assert _ap(own["offline"]) not in names
    assert _identity(big) == before
    assert made.left_out_count == 2
    # The 1500-byte offline archive was held; the 2000-byte one on the "other
    # disk" was carried, and is what the warning names.
    assert made.large_archive_count == 1
    assert made.large_archives == ((own_backups.display_path(str(big)), 2000),)
    assert not (box["data"] / own_backups.HOLD_DIRNAME).exists()


def test_a_rename_the_kernel_refuses_leaves_the_file_where_it_is(
    box: dict[str, Path], own: dict[str, Path], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
) -> None:
    real_rename = os.rename

    def cross_device(src: str, dst: str) -> None:
        if src == str(own["offline"]):
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        real_rename(src, dst)

    monkeypatch.setattr(own_backups.os, "rename", cross_device)
    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert _ap(own["offline"]) in _names(made.path)
    assert own["offline"].read_bytes() == b"o" * 1500
    assert made.left_out_count == 2
    assert not (box["data"] / own_backups.JOURNAL_NAME).exists()


def test_a_data_dir_inside_the_backup_holds_nothing_and_the_sibling_is_used(
    box: dict[str, Path], own: dict[str, Path], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
) -> None:
    """Holding a file inside a folder the backup covers would carry it anyway."""
    data = box["state"] / "clawkeep-data"
    data.mkdir()
    monkeypatch.setenv("CLAWKEEP_DATA_DIR", str(data))
    sibling = box["state"].parent / own_backups.SIBLING_HOLD_NAME
    seen: list[bool] = []
    real_create = openclaw.create_archive

    def create(*args: object, **kwargs: object) -> openclaw.Archive:
        seen.append(any(sibling.rglob("*.tar.gz*")))
        return real_create(*args, **kwargs)

    monkeypatch.setattr(openclaw, "create_archive", create)
    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    assert seen == [True]
    assert made.left_out_count == 3
    hold = _ap(data / own_backups.HOLD_DIRNAME)
    assert not any(n == hold or n.startswith(hold + "/") for n in _names(made.path))
    assert own["offline"].is_file()
    assert not sibling.exists(), "the hold directory beside the state dir is removed when empty"


def test_snapshot_sized_archives_the_snapshot_carries_are_counted_and_the_largest_named(
    box: dict[str, Path], own: dict[str, Path], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
) -> None:
    monkeypatch.setattr(own_backups, "LARGE_ARCHIVE_BYTES", 100)
    ws = box["state"] / "workspace"
    sizes = {f"export-{i}.zip": 100 + i for i in range(7)}
    for name, size in sizes.items():
        _file(ws / "exports" / name, b"z" * size)
    _file(ws / "small.tar.gz", b"s" * 99)

    made = backup_guard.create_archive(_cfg(box["cli"]), output_dir=box["out"])

    # The box's own archives (700, 1500 and 300 bytes) are left out, so they
    # are not warned about; photos.zip (50) and small.tar.gz (99) are under
    # the threshold. The seven exports are counted, the five largest named.
    assert made.left_out_count == 3
    assert made.large_archive_count == 7
    assert made.large_archive_bytes == sum(sizes.values())
    assert made.large_archives == tuple(
        (own_backups.display_path(str(ws / "exports" / f"export-{i}.zip")), 100 + i)
        for i in (6, 5, 4, 3, 2)
    )


def test_the_scan_skips_what_the_core_skips_and_never_takes_a_link_for_an_archive(
    box: dict[str, Path], tmp_path: Path,  # noqa: F811
) -> None:
    state_dir = box["state"]
    kept = _file(state_dir / "backups" / "nightly" / "a.tar.gz", b"a")
    regenerable = _file(state_dir / "npm" / "cache" / "pkg.tgz", b"r")
    volatile = _file(state_dir / "cache" / "control-ui-assets" / "app.js.gz", b"v")
    link = state_dir / "backups" / "latest.tar.gz"
    link.symlink_to(kept)

    plan = openclaw.plan_backup(str(box["cli"]))
    found = {Path(a.path): a for a in backup_guard.scan(plan).archives}

    assert found[kept].rule == RULE_STATE_BACKUPS and found[kept].size == 1
    assert found[kept].asset_root == str(state_dir)
    for skipped in (regenerable, volatile, link):
        assert skipped not in found
    # find_refused_links is the same walk's other half, unchanged.
    assert backup_guard.find_refused_links(plan) == backup_guard.scan(plan).links


# ── putting back, case by case ──────────────────────────────────────────────

@pytest.fixture
def held(tmp_path: Path) -> dict[str, Path]:
    """A journal naming one file held in a run directory, as a killed build
    leaves it."""
    home = tmp_path / "home" / ".openclaw" / "backups" / "nightly"
    home.mkdir(parents=True)
    run_dir = tmp_path / "data" / own_backups.HOLD_DIRNAME / "run-abc"
    run_dir.mkdir(parents=True)
    original = home / "workspace-20260920.tar.gz"
    hold = _file(run_dir / "0001-workspace-20260920.tar.gz", b"ours")
    journal = tmp_path / "data" / own_backups.JOURNAL_NAME
    journal.write_text(json.dumps({"files": [
        {"path": str(original), "held": str(hold), "bytes": 4},
    ]}))
    return {"original": original, "hold": hold, "journal": journal, "run_dir": run_dir}


def test_put_back_renames_a_held_file_home(held: dict[str, Path]) -> None:
    inode = held["hold"].stat().st_ino
    assert own_backups.put_back(held["journal"]) == [str(held["original"])]
    assert held["original"].read_bytes() == b"ours"
    assert held["original"].stat().st_ino == inode
    assert not held["journal"].exists()
    assert not held["run_dir"].exists() and not held["run_dir"].parent.exists()


def test_put_back_after_a_crash_before_the_rename_drops_the_entry(held: dict[str, Path]) -> None:
    held["hold"].rename(held["original"])  # the rename never happened: it is still home
    assert own_backups.put_back(held["journal"]) == []
    assert held["original"].read_bytes() == b"ours"
    assert not held["journal"].exists()


def test_put_back_cut_short_between_link_and_unlink_drops_the_hold_name(
    held: dict[str, Path],
) -> None:
    os.link(held["hold"], held["original"])
    assert own_backups.put_back(held["journal"]) == [str(held["original"])]
    assert held["original"].read_bytes() == b"ours"
    assert not held["hold"].exists()


def test_put_back_never_overwrites_a_new_file_of_the_same_name(held: dict[str, Path]) -> None:
    held["original"].write_bytes(b"theirs")
    returned = held["original"].with_name(held["original"].name + own_backups.RETURNED_SUFFIX)
    assert own_backups.put_back(held["journal"]) == [str(returned)]
    assert held["original"].read_bytes() == b"theirs"
    assert returned.read_bytes() == b"ours"

    # And again: the next free name, never a replacement.
    hold2 = _file(held["run_dir"] / "0002-x", b"ours again")
    held["journal"].write_text(json.dumps({"files": [
        {"path": str(held["original"]), "held": str(hold2), "bytes": 10},
    ]}))
    assert own_backups.put_back(held["journal"]) == [f"{returned}-2"]
    assert Path(f"{returned}-2").read_bytes() == b"ours again"
    assert returned.read_bytes() == b"ours"


def test_put_back_without_hard_links_still_never_overwrites(
    held: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_links(*args: object, **kwargs: object) -> None:
        raise OSError(errno.EPERM, "Operation not permitted")

    monkeypatch.setattr(own_backups.os, "link", no_links)
    held["original"].write_bytes(b"theirs")
    own_backups.put_back(held["journal"])
    assert held["original"].read_bytes() == b"theirs"
    assert Path(str(held["original"]) + own_backups.RETURNED_SUFFIX).read_bytes() == b"ours"


def test_put_back_recreates_a_folder_that_went_away(held: dict[str, Path]) -> None:
    folder = held["original"].parent
    folder.rmdir()
    folder.parent.rmdir()  # backups/ itself is gone too
    assert own_backups.put_back(held["journal"]) == [str(held["original"])]
    assert held["original"].read_bytes() == b"ours"


def test_put_back_never_goes_through_a_folder_that_became_a_link(
    held: dict[str, Path], tmp_path: Path,
) -> None:
    folder = held["original"].parent
    elsewhere = tmp_path / "usb"
    elsewhere.mkdir()
    folder.rmdir()
    folder.symlink_to(elsewhere)

    assert own_backups.put_back(held["journal"]) == []
    assert held["hold"].read_bytes() == b"ours", "kept in the hold dir, never lost"
    assert not any(elsewhere.iterdir())
    entries = json.loads(held["journal"].read_text())["files"]
    assert [e["path"] for e in entries] == [str(held["original"])]

    # Once the folder is a folder again, the next put-back brings it home.
    folder.unlink()
    folder.mkdir()
    assert own_backups.put_back(held["journal"]) == [str(held["original"])]
    assert not held["journal"].exists()


def test_put_back_reports_a_file_gone_from_both_places_and_moves_on(
    held: dict[str, Path], caplog: pytest.LogCaptureFixture,
) -> None:
    held["hold"].unlink()
    assert own_backups.put_back(held["journal"]) == []
    assert "neither at" in caplog.text
    assert not held["journal"].exists()


def test_a_garbled_journal_entry_never_becomes_a_rename(tmp_path: Path) -> None:
    victim = _file(tmp_path / "etc" / "passwd", b"root")
    run_dir = tmp_path / own_backups.HOLD_DIRNAME / "run-a"
    journal = tmp_path / own_backups.JOURNAL_NAME
    journal.write_text(json.dumps({"files": [
        {"path": str(tmp_path / "home" / "x.tar.gz"), "held": str(victim)},  # not a hold path
        {"path": "relative/x.tar.gz", "held": str(run_dir / "x")},
        {"path": str(tmp_path / "a" / ".." / "b"), "held": str(run_dir / "y")},
        "not an entry",
    ]}))
    assert own_backups.put_back(journal) == []
    assert victim.read_bytes() == b"root"
    assert not (tmp_path / "home").exists()
    assert not journal.exists()


def test_an_unreadable_journal_is_kept_and_nothing_new_is_set_aside(tmp_path: Path) -> None:
    journal = tmp_path / own_backups.JOURNAL_NAME
    journal.write_text("{not json")
    archive = _file(tmp_path / "state" / "backups" / "x.tar.gz", b"x")
    found = [own_backups.ArchiveFile(str(archive), 1, RULE_STATE_BACKUPS, str(tmp_path / "state"))]

    assert own_backups.put_back(journal) == []
    assert own_backups.set_aside(found, [str(tmp_path / "state")], journal, tmp_path) == []
    assert journal.read_text() == "{not json"
    assert archive.read_bytes() == b"x"


# ── the run's record ────────────────────────────────────────────────────────

def test_state_round_trips_the_record_and_survives_a_garbled_one(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    st = state.State(
        last_left_out_count=3,
        last_left_out_bytes=20_000_000_000,
        last_large_archives=[{"path": "~/.openclaw/workspace/x.zip", "bytes": 300_000_000}],
        last_large_archive_count=1,
        last_large_archive_bytes=300_000_000,
    )
    state.save(st, path)
    assert state.load(path) == st

    path.write_text(json.dumps({
        "last_left_out_count": "lots",
        "last_large_archives": [{"path": 7}, "x", {"path": "~/a.zip", "bytes": "12"}],
    }))
    loaded = state.load(path)
    assert loaded.last_left_out_count == 0
    assert loaded.last_large_archives == [{"path": "~/a.zip", "bytes": 12}]
    path.write_text(json.dumps({"last_large_archives": {"path": "~/a.zip"}}))
    assert state.load(path).last_large_archives == []


def test_the_idle_run_puts_back_before_anything_else(
    held: dict[str, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    from unittest.mock import patch

    from clawkeep.config import Config, HeartbeatConfig, OpenclawConfig

    monkeypatch.setenv("CLAWKEEP_DATA_DIR", str(held["journal"].parent))
    cfg = Config(
        server="https://server", schedule="daily", openclaw=OpenclawConfig(),
        heartbeat=HeartbeatConfig(idle_interval_hours=24),
    )
    # A heartbeat so recent the tick sends nothing — the put-back runs anyway.
    state.save(state.State(last_heartbeat_at_ms=runner.api.now_ms()))
    with patch("clawkeep.runner.api.heartbeat") as heartbeat:
        assert runner.run_idle(cfg, "claw_x") == runner.EXIT_OK
    heartbeat.assert_not_called()
    assert held["original"].read_bytes() == b"ours"
    assert not held["journal"].exists()
