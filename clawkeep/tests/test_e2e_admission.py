"""The admission check end to end: the real daemon against a local stand-in
for the portal and the storage (`tests/fake_cloud.py`).

Nothing between `clawkeepd`'s entry point and the wire is replaced. The run
takes the lock, reads its config, token and passphrase from a data dir, mints
credentials over HTTP, has the stand-in `openclaw` build a real archive
(`tests/fake_openclaw.py`), encrypts it with openssl, lists the prefix page by
page through boto3, uploads, annotates the manifest, prunes and heartbeats.
The unit suite proves each branch against mocks; this proves the branches are
wired to each other and to the wire the way the mocks assume.
"""

from __future__ import annotations

import json
import stat
import sys
import tarfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

pytest.importorskip("boto3")

from clawkeep import (  # noqa: E402 — must follow the importorskip guard
    agent,
    backup_guard,
    crypto,
    daemon,
    passphrase,
    runner,
    state,
)
from tests.conftest import REAL_PLAN  # noqa: E402
from tests.fake_cloud import TOKEN, FakeCloud  # noqa: E402

FAKE_CLI = Path(__file__).with_name("fake_openclaw.py")
PASSPHRASE = "correct horse battery staple"
DAY = timedelta(days=1)
LONG_AGO = datetime(2026, 1, 1, tzinfo=timezone.utc)

#: What an account with history holds: three ordinary snapshots and a locked
#: one that is older than all of them, 4,600 bytes in all.
SEEDED = {
    "2026-01-01-locked.tar.gz.enc": b"L" * 1000,
    "2026-01-02-oldest.tar.gz.enc": b"a" * 1100,
    "2026-01-03-older.tar.gz.enc": b"b" * 1200,
    "2026-01-04-newest.tar.gz.enc": b"c" * 1300,
}
SEEDED_MANIFEST = {
    "version": 1,
    "snapshots": {
        "2026-01-01-locked.tar.gz.enc": {"label": "before the move", "locked": True},
        "2026-01-02-oldest.tar.gz.enc": {"label": None, "locked": False},
        "2026-01-03-older.tar.gz.enc": {"label": None, "locked": False},
        "2026-01-04-newest.tar.gz.enc": {"label": "last good", "locked": False},
    },
}
SEEDED_BYTES = sum(len(body) for body in SEEDED.values())


class Box:
    """One device: an agent's state to back up, ClawKeep's data dir, a config
    pointing at the stand-in cloud, and the daemon's own entry point."""

    def __init__(self, tmp_path: Path, cloud: FakeCloud) -> None:
        self.cloud = cloud
        self.data = tmp_path / "clawkeep-data"
        self.staging = tmp_path / "staging"
        self.config = self.data / "config.toml"
        self.token = self.data / "token"

    def run(self, *extra: str) -> int:
        return daemon.main(
            ["--config", str(self.config), "--token-path", str(self.token), *extra],
        )

    def state(self) -> state.State:
        return state.load(self.data / "state.json")

    def left_in_staging(self) -> list[str]:
        return sorted(p.name for p in self.staging.iterdir()) if self.staging.exists() else []


@pytest.fixture
def cloud():
    with FakeCloud(quota_bytes=1024 * 1024) as running:
        yield running


@pytest.fixture
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cloud: FakeCloud) -> Box:
    home = tmp_path / "home" / ".openclaw"
    (home / "workspace").mkdir(parents=True)
    (home / "workspace" / "SOUL.md").write_text("the thing worth backing up\n" * 40)
    (home / "openclaw.json").write_text('{"agents": []}')

    cli = tmp_path / "bin" / "openclaw"
    cli.parent.mkdir()
    cli.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_CLI}" "$@"\n')
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR)

    box = Box(tmp_path, cloud)
    box.data.mkdir()
    monkeypatch.setenv("CLAWKEEP_DATA_DIR", str(box.data))
    monkeypatch.setenv("FAKE_OPENCLAW_STATE", str(home))
    # The stand-in cloud is on loopback; a proxy in the environment must not
    # be asked to reach it.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    # An OpenClaw box, whatever the machine running the suite is.
    edition = tmp_path / "edition.env"
    edition.write_text("CLAWBOX_EDITION=openclaw\n")
    monkeypatch.setattr(agent, "EDITION_FILE", str(edition))
    monkeypatch.delenv("CLAWBOX_EDITION", raising=False)
    monkeypatch.setattr(backup_guard, "_plan", REAL_PLAN)

    box.config.write_text(
        f'server = "{cloud.url}"\n'
        'schedule = "manual"\n'
        "[openclaw]\n"
        f'binary = "{cli}"\n'
        f'output_dir = "{box.staging}"\n'
    )
    box.token.write_text(TOKEN)
    box.token.chmod(0o600)
    passphrase.write(PASSPHRASE)
    (box.data / "schedule.json").write_text(json.dumps({"retentionKeepLast": 2}))
    return box


@pytest.fixture
def history(cloud: FakeCloud) -> dict:
    """Seed the account and hand back exactly what it holds, to compare to."""
    for age, (name, body) in enumerate(SEEDED.items()):
        cloud.seed(name, body, modified=LONG_AGO + age * DAY)
    cloud.seed("manifest.json", json.dumps(SEEDED_MANIFEST).encode(), modified=LONG_AGO)
    return cloud.contents()


def _decrypted_names(box: Box, tmp_path: Path, ciphertext: bytes) -> list[str]:
    sealed, opened = tmp_path / "pulled.tar.gz.enc", tmp_path / "pulled.tar.gz"
    sealed.write_bytes(ciphertext)
    crypto.decrypt_file(
        ciphertext_path=sealed, plaintext_path=opened,
        password_file=passphrase.default_passphrase_path(),
    )
    with tarfile.open(opened, "r:gz") as tf:
        return tf.getnames()


def test_a_backup_under_quota_uploads_and_prunes(
    box: Box, cloud: FakeCloud, history: dict, tmp_path: Path,
) -> None:
    assert box.run("--label", "nightly") == runner.EXIT_OK

    after = cloud.snapshots()
    (uploaded,) = set(after) - set(SEEDED)
    assert uploaded.endswith(".tar.gz.enc")
    # What landed is the archive itself, sealed with the device passphrase.
    assert any(
        name.endswith("workspace/SOUL.md")
        for name in _decrypted_names(box, tmp_path, after[uploaded])
    )

    # Retention ran AFTER the upload and for it: of the four unlocked snapshots
    # the newest two stay, and the locked one is not counted or touched.
    assert set(after) == {
        "2026-01-01-locked.tar.gz.enc", "2026-01-04-newest.tar.gz.enc", uploaded,
    }
    writes = cloud.writes()
    assert writes[0] == ("PUT", uploaded)
    assert sorted(w for w in writes if w[0] == "DELETE") == [
        ("DELETE", "2026-01-02-oldest.tar.gz.enc"),
        ("DELETE", "2026-01-03-older.tar.gz.enc"),
    ]
    assert after["2026-01-01-locked.tar.gz.enc"] == SEEDED["2026-01-01-locked.tar.gz.enc"]

    entries = cloud.manifest()["snapshots"]
    assert set(entries) == set(after)
    assert entries[uploaded]["label"] == "nightly"
    assert entries[uploaded]["locked"] is False
    assert entries["2026-01-01-locked.tar.gz.enc"] == {"label": "before the move", "locked": True}
    assert entries["2026-01-04-newest.tar.gz.enc"]["label"] == "last good"

    # Usage was counted from the listing — five keys, two a page, so only a
    # client that follows continuation tokens gets these numbers right.
    assert any(token for verb, token in cloud.requests if verb == "LIST")
    running, done = cloud.heartbeats
    assert (running["status"], running["cloudBytes"], running["snapshotCount"]) == (
        "running", SEEDED_BYTES, 4,
    )
    assert (done["status"], done["cloudBytes"], done["snapshotCount"]) == (
        "ok", cloud.used_bytes(), 3,
    )
    assert done["lastBackupAt"] > 0
    assert cloud.used_bytes() <= cloud.quota_bytes

    final = box.state()
    assert final.last_heartbeat_status == "ok"
    assert final.last_backup_at_ms == done["lastBackupAt"]
    assert final.last_cloud_bytes == cloud.used_bytes()
    assert final.last_snapshot_count == 3
    assert final.last_step == ""
    assert final.last_refusal == ""
    assert box.left_in_staging() == []


def test_the_first_backup_into_an_empty_account(box: Box, cloud: FakeCloud) -> None:
    """No snapshots and no manifest yet: nothing to count, nothing to prune."""
    assert box.run() == runner.EXIT_OK
    (uploaded,) = cloud.snapshots()
    assert cloud.writes() == [("PUT", uploaded), ("PUT", "manifest.json")]
    assert set(cloud.manifest()["snapshots"]) == {uploaded}
    running, done = cloud.heartbeats
    assert (running["cloudBytes"], running["snapshotCount"]) == (0, 0)
    assert (done["status"], done["snapshotCount"]) == ("ok", 1)
    assert box.left_in_staging() == []


def test_a_backup_over_quota_is_refused_and_touches_nothing(
    box: Box, cloud: FakeCloud, history: dict,
) -> None:
    # Ten bytes free: less than any archive, and pruning WOULD have made room.
    cloud.quota_bytes = SEEDED_BYTES + 10

    assert box.run() == runner.EXIT_QUOTA_FULL

    # Byte for byte and stamp for stamp what was there: every snapshot, and
    # the manifest that says which of them is locked.
    assert cloud.contents() == history
    assert cloud.writes() == []

    running, refused = cloud.heartbeats
    assert running["status"] == "running"
    assert refused["status"] == "error"
    assert refused["error"].startswith("quota full: ")
    assert "10 B of 4.5 KB is free (4.5 KB used)" in refused["error"]
    assert "Nothing was uploaded or removed" in refused["error"]
    assert (refused["cloudBytes"], refused["snapshotCount"]) == (SEEDED_BYTES, 4)
    assert "lastBackupAt" not in refused

    final = box.state()
    assert final.last_heartbeat_status == "error"
    assert final.last_backup_at_ms == 0
    assert final.last_step == ""
    assert final.last_refusal == state.REFUSAL_QUOTA_FULL
    assert final.last_refusal_needed_bytes > 10
    assert final.last_refusal_used_bytes == SEEDED_BYTES
    assert final.last_refusal_quota_bytes == SEEDED_BYTES + 10
    assert final.quota_full_since_ms == 0
    assert box.left_in_staging() == []

    # The owner buys room for it; the next run is an ordinary backup.
    cloud.quota_bytes = SEEDED_BYTES + final.last_refusal_needed_bytes + 4096
    assert box.run() == runner.EXIT_OK
    assert len(set(cloud.snapshots()) - set(SEEDED)) == 1
    assert cloud.heartbeats[-1]["status"] == "ok"
    assert box.state().last_refusal == ""
    assert box.state().last_heartbeat_status == "ok"


def test_a_backup_is_refused_when_the_listing_is_unavailable(
    box: Box, cloud: FakeCloud, history: dict, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The run's own waits between attempts, and botocore's inside each one.
    monkeypatch.setattr(time, "sleep", lambda seconds: None)
    cloud.fail_listing = True

    assert box.run() == runner.EXIT_NETWORK

    assert cloud.contents() == history
    assert cloud.writes() == []
    # Asked more than once before giving up, and never told a number.
    assert cloud.count("LIST") >= 1 + runner.ADMISSION_LIST_ATTEMPTS
    running, refused = cloud.heartbeats
    assert running["status"] == "running"
    assert "cloudBytes" not in running
    assert refused["status"] == "error"
    assert refused["error"].startswith("quota check unavailable: ")
    assert "cloudBytes" not in refused

    final = box.state()
    assert final.last_heartbeat_status == "error"
    assert final.last_backup_at_ms == 0
    assert final.last_step == ""
    assert final.last_refusal == state.REFUSAL_USAGE_UNVERIFIED
    assert final.last_refusal_needed_bytes > 0
    assert final.last_refusal_quota_bytes == cloud.quota_bytes
    assert box.left_in_staging() == []

    # The storage answers again; the next run is an ordinary backup.
    cloud.fail_listing = False
    assert box.run() == runner.EXIT_OK
    assert len(set(cloud.snapshots()) - set(SEEDED)) == 1
    assert box.state().last_refusal == ""
    assert box.state().last_heartbeat_status == "ok"


def test_a_second_run_during_an_upload_leaves_the_first_alone(
    box: Box, cloud: FakeCloud, history: dict,
) -> None:
    """The scheduled slot coming round while "Back up now" is still uploading."""
    cloud.hold_uploads = threading.Event()
    results: list[int] = []
    first = threading.Thread(target=lambda: results.append(box.run()))
    first.start()
    try:
        assert cloud.upload_arrived.wait(60)
        seen = (box.data / "state.json").read_bytes()
        beats = len(cloud.heartbeats)

        assert box.run() == runner.EXIT_ALREADY_RUNNING

        assert (box.data / "state.json").read_bytes() == seen
        assert len(cloud.heartbeats) == beats
        assert box.state().last_step == runner.STEP_UPLOADING
    finally:
        cloud.hold_uploads.set()
        first.join(60)
    assert results == [runner.EXIT_OK]
    assert cloud.count("CREDENTIALS") == 1
    assert [w for w in cloud.writes() if w[0] == "PUT" and w[1] != "manifest.json"] == [
        ("PUT", next(iter(set(cloud.snapshots()) - set(SEEDED)))),
    ]
