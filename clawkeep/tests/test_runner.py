"""Runner tests focus on the failure-mode matrix from section 10:
auth/quota/tier/server/network errors must produce the right exit codes
and the right heartbeat payloads, without retrying things that need
human action.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from clawkeep import openclaw, runner, s3, state
from clawkeep.api import ApiError, Credentials
from clawkeep.config import Config, HeartbeatConfig, OpenclawConfig
from clawkeep.openclaw import Archive, OpenclawError
from clawkeep.s3 import CloudStats, S3Error


def _cfg(tmp_path: Path) -> Config:
    return Config(
        server="https://server",
        schedule="daily",
        openclaw=OpenclawConfig(
            binary="openclaw",
            output_dir=str(tmp_path / "staging"),
        ),
        heartbeat=HeartbeatConfig(idle_interval_hours=24),
    )


def _archive(tmp_path: Path) -> Archive:
    """A real on-disk file so the runner's `unlink(missing_ok=True)` cleanup
    is exercised — a bare dataclass with a fictitious path would still pass
    today, but masks regressions in the cleanup branch."""
    p = tmp_path / "staging" / "snap.tar.gz"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"fake archive")
    return Archive(
        path=p,
        archive_root="snap",
        created_at="2026-04-29T08:00:00.000Z",
        size_bytes=p.stat().st_size,
        asset_count=1,
    )


CREDS = Credentials(
    accessKeyId="AKIA",
    secretAccessKey="secret",
    sessionToken="session",
    endpoint="https://acct.r2.cloudflarestorage.com",
    bucket="clawkeep",
    prefix="users/u_x/repo/",
    expiresAt=9_999_999_999_999,
    quotaBytes=5_368_709_120,
    cloudBytes=1_234,
)


@pytest.fixture
def isolate_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point CLAWKEEP_DATA_DIR at a tmp dir so tests don't touch
    /var/lib/clawkeep or whatever the real device directory is.

    Also seeds a passphrase file under that dir — encryption is now
    mandatory in the runner, so tests need a passphrase to exercise the
    happy path. Tests that explicitly want the "no passphrase" branch
    can `passphrase.clear()` after the fixture runs.
    """
    monkeypatch.setenv("CLAWKEEP_DATA_DIR", str(tmp_path))
    from clawkeep import passphrase as passphrase_mod
    passphrase_mod.write("test-passphrase")
    yield tmp_path / "state.json"


@pytest.fixture(autouse=True)
def stub_manifest(monkeypatch: pytest.MonkeyPatch):
    """The happy-path backup now writes a sidecar manifest and runs retention
    after a successful upload. Stub the S3-backed manifest/list calls so the
    failure-matrix tests don't make real network calls on the post-upload
    path. Tests that exercise retention directly re-patch these inside a
    `with patch(...)` block, which transparently overrides these stubs.

    `stats` is stubbed for the same reason: a run now recounts the prefix
    before its first heartbeat as well as after the upload, so every test that
    gets as far as minting credentials would otherwise put a real
    list_objects_v2 on the wire."""
    monkeypatch.setattr(s3, "read_manifest", lambda creds: {"version": 1, "snapshots": {}})
    monkeypatch.setattr(s3, "write_manifest", lambda creds, manifest: None)
    monkeypatch.setattr(s3, "list_snapshots", lambda creds: [])
    monkeypatch.setattr(s3, "stats", lambda creds: CloudStats(cloud_bytes=0, snapshot_count=0))


def test_happy_path(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)
    heartbeats: list[dict] = []

    def fake_hb(server: str, token: str, **kw: object) -> None:
        heartbeats.append(dict(kw))

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat", side_effect=fake_hb),
        patch("clawkeep.runner.openclaw.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload", return_value="users/u_x/repo/snap.tar.gz") as upload,
        patch(
            "clawkeep.runner.s3.stats",
            return_value=CloudStats(cloud_bytes=999_888, snapshot_count=5),
        ),
    ):
        rc = runner.run_once(cfg, "claw_x")

    assert rc == runner.EXIT_OK
    statuses = [hb["status"] for hb in heartbeats]
    assert statuses == ["running", "ok"]
    final = heartbeats[-1]
    assert final["cloud_bytes"] == 999_888
    assert final["snapshot_count"] == 5
    assert "last_backup_at" in final
    upload.assert_called_once()
    # The runner must clean up the staging archive after upload — keeping a
    # 300MB tarball around per run would fill /home on a Jetson within days.
    assert not archive.path.exists()
    # On success the in-flight step is cleared so a reopened window doesn't
    # keep showing "Uploading…" after the run finishes.
    final_state = state.load(isolate_state)
    assert final_state.last_step == ""
    assert final_state.last_step_at_ms == 0
    assert final_state.last_heartbeat_status == "ok"


def test_the_links_the_archive_skipped_are_on_disk_before_the_upload_and_the_run_is_ok(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """TASK-1304: a backup that skipped links is a FINISHED backup — the
    heartbeats say running then ok, never error, the portal gets its
    `lastBackupAt` — and state.json names the links while the upload runs."""
    import dataclasses

    cfg = _cfg(tmp_path)
    links = (
        ("~/.openclaw/workspace/docs/catalogue", "/home/clawbox/Shared/Exports/catalogue"),
        ("~/.openclaw/workspace/docs/notes.txt", "../../../../Shared/notes.txt"),
    )
    archive = dataclasses.replace(
        _archive(tmp_path), skipped_links=links, skipped_link_count=7,
    )
    during: list[state.State] = []
    heartbeats: list[dict] = []
    written: list[dict] = []

    def upload(creds, *, archive_path, object_name, progress_cb=None):
        during.append(state.load(isolate_state))

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat",
              side_effect=lambda server, token, **kw: heartbeats.append(kw)),
        patch("clawkeep.runner.agent.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload", side_effect=upload),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
        patch("clawkeep.runner.s3.write_manifest",
              side_effect=lambda creds, manifest: written.append(manifest)),
    ):
        assert runner.run_once(cfg, "claw_x") == runner.EXIT_OK

    assert [hb["status"] for hb in heartbeats] == ["running", "ok"]
    assert "error" not in heartbeats[-1] and "last_backup_at" in heartbeats[-1]
    for st in (during[0], state.load(isolate_state)):
        assert st.last_skipped_link_count == 7
        assert st.last_skipped_links == [{"path": p, "target": t} for p, t in links]
    final = state.load(isolate_state)
    assert final.last_heartbeat_status == "ok" and final.last_backup_at_ms > 0
    record = written[0]["snapshots"]["snap.tar.gz.enc"]
    assert record[s3.RECORD_SKIPPED_LINK_COUNT] == 7
    assert "Shared" not in str(written[0]), "the names go into the manifest sealed"


def test_a_seal_that_fails_keeps_the_count_and_the_backup(
    isolate_state: Path, tmp_path: Path,
) -> None:
    import dataclasses

    from clawkeep import crypto

    archive = dataclasses.replace(
        _archive(tmp_path), skipped_links=(("~/x", "/y"),), skipped_link_count=1,
    )
    written: list[dict] = []
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.agent.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload"),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
        patch("clawkeep.runner.s3.write_manifest",
              side_effect=lambda creds, manifest: written.append(manifest)),
        patch("clawkeep.runner.crypto.seal_text", side_effect=crypto.CryptoError("no openssl")),
    ):
        assert runner.run_once(_cfg(tmp_path), "claw_x") == runner.EXIT_OK
    record = written[0]["snapshots"]["snap.tar.gz.enc"]
    assert record[s3.RECORD_SKIPPED_LINK_COUNT] == 1
    assert s3.RECORD_SKIPPED_LINKS not in record


def test_a_backup_that_skipped_nothing_writes_the_record_it_always_did(
    isolate_state: Path, tmp_path: Path,
) -> None:
    written: list[dict] = []
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.agent.create_archive", return_value=_archive(tmp_path)),
        patch("clawkeep.runner.s3.upload"),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
        patch("clawkeep.runner.s3.write_manifest",
              side_effect=lambda creds, manifest: written.append(manifest)),
    ):
        assert runner.run_once(_cfg(tmp_path), "claw_x", label="nightly") == runner.EXIT_OK
    record = written[0]["snapshots"]["snap.tar.gz.enc"]
    assert set(record) == {"label", "locked", "createdAt"}
    st = state.load(isolate_state)
    assert (st.last_skipped_link_count, st.last_skipped_links) == (0, [])


def test_state_reads_back_a_garbled_skipped_link_list_as_what_still_reads(
    tmp_path: Path,
) -> None:
    import json

    path = tmp_path / "state.json"
    path.write_text(json.dumps({
        "last_skipped_links": [
            {"path": "~/a", "target": "/b"}, {"path": 7, "target": "/c"}, "x",
            {"path": "~/d"},
        ],
        "last_skipped_link_count": "lots",
    }))
    st = state.load(path)
    assert st.last_skipped_links == [{"path": "~/a", "target": "/b"}]
    assert st.last_skipped_link_count == 0
    path.write_text(json.dumps({"last_skipped_links": {"path": "~/a"}}))
    assert state.load(path).last_skipped_links == []


def test_step_is_persisted_until_failure(isolate_state: Path, tmp_path: Path) -> None:
    """A reopened window mid-upload should see `last_step == "uploading"`."""
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)

    captured_steps: list[str] = []

    def upload_that_records_state(creds, *, archive_path, object_name, progress_cb=None):
        # By the time the upload is invoked, the runner should already have
        # stamped the "uploading" step. Read state.json from disk to verify
        # the persistence path (not just in-memory state).
        captured_steps.append(state.load(isolate_state).last_step)

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.openclaw.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload", side_effect=upload_that_records_state),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
    ):
        runner.run_once(cfg, "claw_x")

    assert captured_steps == ["uploading"]


def test_what_the_archive_left_out_is_on_disk_before_the_upload(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """The box's own backups the archive left out, and the snapshot-sized
    archives it carries, are in state.json while the upload runs — the app
    and `backup_status` read them from there — and stay after it."""
    import dataclasses

    cfg = _cfg(tmp_path)
    archive = dataclasses.replace(
        _archive(tmp_path),
        left_out_count=3,
        left_out_bytes=20_000_000_000,
        large_archives=(("~/.openclaw/workspace/dump.tar.gz", 1_900_000_000),),
        large_archive_count=1,
        large_archive_bytes=1_900_000_000,
    )
    during: list[state.State] = []

    def upload(creds, *, archive_path, object_name, progress_cb=None):
        during.append(state.load(isolate_state))

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        # One level above the core: the account is the guard's to give.
        patch("clawkeep.runner.agent.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload", side_effect=upload),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
    ):
        assert runner.run_once(cfg, "claw_x") == runner.EXIT_OK

    for st in (during[0], state.load(isolate_state)):
        assert st.last_left_out_count == 3
        assert st.last_left_out_bytes == 20_000_000_000
        assert st.last_large_archives == [
            {"path": "~/.openclaw/workspace/dump.tar.gz", "bytes": 1_900_000_000},
        ]
        assert st.last_large_archive_count == 1
        assert st.last_large_archive_bytes == 1_900_000_000


def test_step_cleared_on_error(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch(
            "clawkeep.runner.openclaw.create_archive",
            side_effect=OpenclawError("boom"),
        ),
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_OPENCLAW
    final = state.load(isolate_state)
    assert final.last_heartbeat_status == "error"
    assert final.last_step == ""


def test_auth_revoked_skips_heartbeat(isolate_state: Path, tmp_path: Path) -> None:
    """Section 10: 401 → no heartbeat (we can't auth) → exit code surfaces re-pair need."""
    cfg = _cfg(tmp_path)
    with (
        patch(
            "clawkeep.runner.api.mint_credentials",
            side_effect=ApiError("auth", "Token revoked", 401),
        ),
        patch("clawkeep.runner.api.heartbeat") as hb,
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_AUTH_REVOKED
    hb.assert_not_called()


def test_quota_full_heartbeats_and_exits(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    with (
        patch(
            "clawkeep.runner.api.mint_credentials",
            side_effect=ApiError("quota_full", "quota full", 402),
        ),
        patch("clawkeep.runner.api.heartbeat") as hb,
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_QUOTA_FULL
    hb.assert_called_once()
    assert hb.call_args.kwargs["status"] == "error"
    assert "quota" in hb.call_args.kwargs["error"].lower()


def test_quota_full_is_recorded_once_and_kept_across_repeats(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """TASK-1211: the bridge re-arms a schedule that was switched off while the
    account was full, and it needs the daemon's word that it WAS full — and
    since when, so a nightly repeat does not keep moving the start."""
    cfg = _cfg(tmp_path)
    refused = ApiError("quota_full", "quota full", 402)
    with (
        patch("clawkeep.runner.api.mint_credentials", side_effect=refused),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.api.now_ms", return_value=1_000),
    ):
        assert runner.run_once(cfg, "claw_x") == runner.EXIT_QUOTA_FULL
    assert state.load(isolate_state).quota_full_since_ms == 1_000

    with (
        patch("clawkeep.runner.api.mint_credentials", side_effect=refused),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.api.now_ms", return_value=2_000),
    ):
        assert runner.run_once(cfg, "claw_x") == runner.EXIT_QUOTA_FULL
    assert state.load(isolate_state).quota_full_since_ms == 1_000


def test_minted_credentials_clear_the_quota_record(isolate_state: Path, tmp_path: Path) -> None:
    """The moment the portal mints credentials again the refusal is over — even
    if the run then fails somewhere else, which is no longer a quota problem."""
    cfg = _cfg(tmp_path)
    state.save(state.State(quota_full_since_ms=1_000), isolate_state)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.s3.stats", side_effect=S3Error("list refused")),
        patch("clawkeep.runner.openclaw.create_archive", side_effect=OpenclawError("boom")),
    ):
        assert runner.run_once(cfg, "claw_x") == runner.EXIT_OPENCLAW
    assert state.load(isolate_state).quota_full_since_ms == 0


def test_other_refusals_say_nothing_about_quota(isolate_state: Path, tmp_path: Path) -> None:
    """Offline is not "no longer full": a network refusal leaves the record as it was."""
    cfg = _cfg(tmp_path)
    state.save(state.State(quota_full_since_ms=1_000), isolate_state)
    with (
        patch(
            "clawkeep.runner.api.mint_credentials",
            side_effect=ApiError("network", "offline"),
        ),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.time.sleep"),
    ):
        assert runner.run_once(cfg, "claw_x") == runner.EXIT_NETWORK
    assert state.load(isolate_state).quota_full_since_ms == 1_000


def test_credentials_retried_on_network_failure(isolate_state: Path, tmp_path: Path) -> None:
    """Network/server errors retry; auth/quota do not."""
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)
    side: list[ApiError | Credentials] = [
        ApiError("network", "boom"),
        ApiError("network", "boom"),
        CREDS,
    ]

    def fake_mint(server: str, token: str) -> Credentials:
        v = side.pop(0)
        if isinstance(v, ApiError):
            raise v
        return v

    with (
        patch("clawkeep.runner.api.mint_credentials", side_effect=fake_mint),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.time.sleep"),  # don't actually wait in tests
        patch("clawkeep.runner.openclaw.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload"),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_OK


def test_credentials_not_retried_on_auth_error(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    calls: list[int] = []

    def mint_once(server: str, token: str) -> Credentials:
        calls.append(1)
        raise ApiError("auth", "Token revoked", 401)

    with (
        patch("clawkeep.runner.api.mint_credentials", side_effect=mint_once),
        patch("clawkeep.runner.time.sleep"),
        patch("clawkeep.runner.api.heartbeat"),
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_AUTH_REVOKED
    assert len(calls) == 1  # no retry


def test_openclaw_failure_reports_error(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    heartbeats: list[dict] = []

    def fake_hb(server: str, token: str, **kw: object) -> None:
        heartbeats.append(dict(kw))

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat", side_effect=fake_hb),
        patch(
            "clawkeep.runner.openclaw.create_archive",
            side_effect=OpenclawError("disk full"),
        ),
        patch("clawkeep.runner.s3.upload") as upload,
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_OPENCLAW
    upload.assert_not_called()
    assert heartbeats[-1]["status"] == "error"
    assert "disk full" in heartbeats[-1]["error"]


def test_archive_session_race_retries_then_succeeds(
    isolate_state: Path, tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch(
            "clawkeep.runner.agent.create_archive",
            side_effect=[
                OpenclawError("ENOENT: lstat session.trajectory.jsonl"),
                archive,
            ],
        ) as create,
        patch("clawkeep.runner.time.sleep") as sleep,
        patch("clawkeep.runner.s3.upload"),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
    ):
        rc = runner.run_once(cfg, "claw_x")

    assert rc == runner.EXIT_OK
    assert create.call_count == 2
    sleep.assert_called_once_with(1.0)


def test_archive_non_race_error_is_not_retried(
    isolate_state: Path, tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch(
            "clawkeep.runner.agent.create_archive",
            side_effect=OpenclawError("permission denied"),
        ) as create,
        patch("clawkeep.runner.time.sleep") as sleep,
    ):
        rc = runner.run_once(cfg, "claw_x")

    assert rc == runner.EXIT_OPENCLAW
    create.assert_called_once()
    sleep.assert_not_called()


def test_upload_failure_reports_error(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)
    heartbeats: list[dict] = []

    def fake_hb(server: str, token: str, **kw: object) -> None:
        heartbeats.append(dict(kw))

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat", side_effect=fake_hb),
        patch("clawkeep.runner.openclaw.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload", side_effect=S3Error("AccessDenied")),
        patch(
            "clawkeep.runner.s3.stats",
            return_value=CloudStats(cloud_bytes=0, snapshot_count=0),
        ) as stats_mock,
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_UPLOAD
    # Opening recount plus fresh pre-upload admission.
    # The post-upload recount is not reached — there was no upload to count,
    # and the error heartbeat below is the run's last word.
    assert stats_mock.call_count == 2
    assert heartbeats[-1]["status"] == "error"
    assert "AccessDenied" in heartbeats[-1]["error"]
    # Cleanup must still run on the upload failure path — a half-finished
    # tarball left in staging would re-fill the disk on the next attempt.
    assert not archive.path.exists()


def test_closing_stats_failure_does_not_fail_run(isolate_state: Path, tmp_path: Path) -> None:
    """Stats is best-effort: a list-objects failure after a successful upload
    must NOT mark the backup as failed — but it must also NOT clobber the
    portal's last-known cloudBytes/snapshotCount with zeros."""
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)
    heartbeats: list[dict] = []

    def fake_hb(server: str, token: str, **kw: object) -> None:
        heartbeats.append(dict(kw))

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat", side_effect=fake_hb),
        patch("clawkeep.runner.openclaw.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload"),
        patch("clawkeep.runner.s3.stats", side_effect=[CloudStats(0, 0), CloudStats(0, 0), S3Error("ListBucket forbidden")]),
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_OK
    final = heartbeats[-1]
    assert final["status"] == "ok"
    assert final["cloud_bytes"] is None
    assert final["snapshot_count"] is None


# ── Retention / auto-cleanup ──────────────────────────────────────────────


def _snap(name: str, *, locked: bool = False, ms: int = 0) -> s3.Snapshot:
    return s3.Snapshot(name=name, size_bytes=1, last_modified_ms=ms, locked=locked)


def test_apply_retention_keeps_newest_and_exempts_locked() -> None:
    # newest-first, as list_snapshots returns them. s4 is locked.
    snaps = [
        _snap("s5", ms=5),
        _snap("s4", ms=4, locked=True),
        _snap("s3", ms=3),
        _snap("s2", ms=2),
        _snap("s1", ms=1),
    ]
    deleted: list[str] = []
    with (
        patch("clawkeep.runner.s3.list_snapshots", return_value=snaps),
        patch(
            "clawkeep.runner.s3.delete_snapshot",
            side_effect=lambda creds, name: deleted.append(name),
        ),
        patch("clawkeep.runner.s3.read_manifest", return_value={"version": 1, "snapshots": {}}),
        patch("clawkeep.runner.s3.write_manifest"),
    ):
        result = runner.apply_retention(CREDS, keep_last=2)
    # Unlocked newest-first: s5, s3, s2, s1. Keep 2 (s5, s3) → delete s2, s1.
    # The locked s4 is kept and never counts toward the "2".
    assert set(result) == {"s2", "s1"}
    assert "s4" not in deleted
    assert "s5" not in deleted and "s3" not in deleted


def test_apply_retention_boundary_keeps_all_when_at_limit() -> None:
    snaps = [_snap("s3", ms=3), _snap("s2", ms=2), _snap("s1", ms=1)]
    deleted: list[str] = []
    with (
        patch("clawkeep.runner.s3.list_snapshots", return_value=snaps),
        patch(
            "clawkeep.runner.s3.delete_snapshot",
            side_effect=lambda creds, name: deleted.append(name),
        ),
        patch("clawkeep.runner.s3.read_manifest", return_value={"version": 1, "snapshots": {}}),
        patch("clawkeep.runner.s3.write_manifest"),
    ):
        result = runner.apply_retention(CREDS, keep_last=3)
    assert result == []
    assert deleted == []


def test_apply_retention_disabled_when_keep_last_zero() -> None:
    with (
        patch("clawkeep.runner.s3.list_snapshots") as ls,
        patch("clawkeep.runner.s3.delete_snapshot") as ds,
    ):
        result = runner.apply_retention(CREDS, keep_last=0)
    assert result == []
    ls.assert_not_called()
    ds.assert_not_called()


def test_apply_retention_gcs_stale_manifest_entries() -> None:
    # Only s2/s1 exist now; the manifest still references a long-gone object.
    snaps = [_snap("s2", ms=2), _snap("s1", ms=1)]
    manifest = {
        "version": 1,
        "snapshots": {
            "s2": {"label": "keep", "locked": False, "createdAt": 2},
            "ghost": {"label": "deleted ages ago", "locked": False, "createdAt": 0},
        },
    }
    written: list[dict] = []
    with (
        patch("clawkeep.runner.s3.list_snapshots", return_value=snaps),
        patch("clawkeep.runner.s3.delete_snapshot"),
        patch("clawkeep.runner.s3.read_manifest", return_value=manifest),
        patch(
            "clawkeep.runner.s3.write_manifest",
            side_effect=lambda creds, m: written.append(m),
        ),
    ):
        runner.apply_retention(CREDS, keep_last=10)
    assert len(written) == 1
    snaps_out = written[0]["snapshots"]
    assert "ghost" not in snaps_out  # lazily GC'd
    assert "s2" in snaps_out


def test_idle_skips_when_recent_heartbeat(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    st = state.State(last_heartbeat_at_ms=10_000_000_000_000)  # very recent
    state.save(st, isolate_state)

    with (
        patch("clawkeep.runner.api.heartbeat") as hb,
        patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_001),
    ):
        rc = runner.run_idle(cfg, "claw_x")
    assert rc == runner.EXIT_OK
    hb.assert_not_called()


def test_idle_sends_when_stale(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    state.save(state.State(last_heartbeat_at_ms=1_000), isolate_state)
    with (
        patch("clawkeep.runner.api.heartbeat") as hb,
        patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_000),
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
    ):
        rc = runner.run_idle(cfg, "claw_x")
    assert rc == runner.EXIT_OK
    hb.assert_called_once()
    assert hb.call_args.kwargs["status"] == "idle"


# ── Usage is recounted from the bucket, never taken from the counter ───────
#
# TASK-1025. The portal's `cloudBytes` is an accumulator that heartbeats
# write; it is wrong the moment an object is removed by anything other than
# this daemon. A box that believed it showed "9.8 GB used, 2 snapshots" over a
# prefix the portal's own page reported as empty — and because the portal
# answers 402 to POST /credentials while that counter is over quota, the
# counter being too high blocked the run that would have corrected it.


def test_idle_recounts_the_prefix_and_reports_what_it_found(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """The idle tick is the only thing that runs on a box that isn't backing
    up, so it is where a drifted number has to be put right — in the heartbeat
    the portal stores AND in the state.json the panel reads."""
    cfg = _cfg(tmp_path)
    # What the box last recorded; since then the snapshots were freed.
    state.save(
        state.State(
            last_heartbeat_at_ms=1_000,
            last_cloud_bytes=9_800_000_000,
            last_snapshot_count=2,
        ),
        isolate_state,
    )
    with (
        patch("clawkeep.runner.api.heartbeat") as hb,
        patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_000),
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch(
            "clawkeep.runner.s3.stats",
            return_value=CloudStats(cloud_bytes=0, snapshot_count=0),
        ),
    ):
        rc = runner.run_idle(cfg, "claw_x")

    assert rc == runner.EXIT_OK
    kwargs = hb.call_args.kwargs
    assert kwargs["status"] == "idle"
    assert kwargs["cloud_bytes"] == 0
    assert kwargs["snapshot_count"] == 0
    final = state.load(isolate_state)
    assert final.last_cloud_bytes == 0
    assert final.last_snapshot_count == 0


def test_idle_still_heartbeats_when_credentials_are_refused(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """Over quota, offline, revoked: no credentials means no recount, but the
    device still owes the portal a "last seen". The recount is an addition to
    the idle tick, not a new way for it to fail."""
    cfg = _cfg(tmp_path)
    state.save(
        state.State(last_heartbeat_at_ms=1_000, last_cloud_bytes=9_800_000_000),
        isolate_state,
    )
    with (
        patch("clawkeep.runner.api.heartbeat") as hb,
        patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_000),
        patch(
            "clawkeep.runner.api.mint_credentials",
            side_effect=ApiError("quota_full", "quota full", 402),
        ),
        patch("clawkeep.runner.s3.stats") as stats,
    ):
        rc = runner.run_idle(cfg, "claw_x")

    assert rc == runner.EXIT_OK
    stats.assert_not_called()
    kwargs = hb.call_args.kwargs
    assert kwargs["status"] == "idle"
    # Unsent rather than zeroed — the box has nothing true to say about usage
    # here, and saying "0 B" would be a guess the portal would then store.
    assert kwargs["cloud_bytes"] is None
    assert kwargs["snapshot_count"] is None
    assert state.load(isolate_state).last_cloud_bytes == 9_800_000_000


def test_idle_records_a_quota_refusal_even_when_the_heartbeat_fails(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """The idle tick is the only thing that mints credentials on a box whose
    schedule is off, so it is where "the account is full" gets recorded — and
    kept, whether or not the portal then took the heartbeat."""
    cfg = _cfg(tmp_path)
    state.save(state.State(last_heartbeat_at_ms=1_000), isolate_state)
    with (
        patch("clawkeep.runner.api.heartbeat", side_effect=ApiError("network", "offline")),
        patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_000),
        patch(
            "clawkeep.runner.api.mint_credentials",
            side_effect=ApiError("quota_full", "quota full", 402),
        ),
    ):
        runner.run_idle(cfg, "claw_x")
    assert state.load(isolate_state).quota_full_since_ms == 10_000_000_000_000


def test_idle_clears_the_quota_record_when_credentials_mint(
    isolate_state: Path, tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path)
    state.save(state.State(last_heartbeat_at_ms=1_000, quota_full_since_ms=5), isolate_state)
    with (
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_000),
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch(
            "clawkeep.runner.s3.stats",
            return_value=CloudStats(cloud_bytes=512, snapshot_count=1),
        ),
    ):
        assert runner.run_idle(cfg, "claw_x") == runner.EXIT_OK
    assert state.load(isolate_state).quota_full_since_ms == 0


def test_idle_keeps_a_recount_the_portal_never_heard(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """A recount is true for this box whether or not the heartbeat landed, so
    the panel stops lying even while the portal is unreachable."""
    cfg = _cfg(tmp_path)
    state.save(
        state.State(last_heartbeat_at_ms=1_000, last_cloud_bytes=9_800_000_000),
        isolate_state,
    )
    with (
        patch(
            "clawkeep.runner.api.heartbeat",
            side_effect=ApiError("network", "connection refused"),
        ),
        patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_000),
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch(
            "clawkeep.runner.s3.stats",
            return_value=CloudStats(cloud_bytes=512, snapshot_count=1),
        ),
    ):
        rc = runner.run_idle(cfg, "claw_x")

    assert rc == runner.EXIT_NETWORK
    final = state.load(isolate_state)
    assert final.last_cloud_bytes == 512
    assert final.last_snapshot_count == 1
    # The heartbeat never landed, so "last seen" must NOT be stamped as fresh.
    assert final.last_heartbeat_at_ms == 1_000


def test_idle_recount_failure_does_not_cost_the_heartbeat(
    isolate_state: Path, tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path)
    state.save(
        state.State(last_heartbeat_at_ms=1_000, last_cloud_bytes=9_800_000_000),
        isolate_state,
    )
    with (
        patch("clawkeep.runner.api.heartbeat") as hb,
        patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_000),
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.s3.stats", side_effect=S3Error("ListBucket forbidden")),
    ):
        rc = runner.run_idle(cfg, "claw_x")

    assert rc == runner.EXIT_OK
    assert hb.call_args.kwargs["status"] == "idle"
    assert hb.call_args.kwargs["cloud_bytes"] is None
    # Untouched rather than zeroed: a failed LIST is not evidence of an empty
    # bucket.
    assert state.load(isolate_state).last_cloud_bytes == 9_800_000_000


def test_run_opens_with_a_recount_not_the_counter(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """The run's first heartbeat carries what the prefix holds *before* this
    backup adds to it, so the portal is corrected even by a run that goes on
    to fail — the shape of run an account at its limit produces."""
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)
    heartbeats: list[dict] = []

    def fake_hb(server: str, token: str, **kw: object) -> None:
        heartbeats.append(dict(kw))

    state.save(state.State(last_cloud_bytes=9_800_000_000, last_snapshot_count=2), isolate_state)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat", side_effect=fake_hb),
        patch("clawkeep.runner.openclaw.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.upload"),
        patch(
            "clawkeep.runner.s3.stats",
            side_effect=[
                CloudStats(cloud_bytes=0, snapshot_count=0),        # before upload
                CloudStats(cloud_bytes=0, snapshot_count=0),        # admission
                CloudStats(cloud_bytes=12, snapshot_count=1),       # after upload
            ],
        ),
    ):
        rc = runner.run_once(cfg, "claw_x")

    assert rc == runner.EXIT_OK
    opening = heartbeats[0]
    assert opening["status"] == "running"
    # CREDS.cloudBytes is 1_234 and state said 9.8 GB — neither is the answer.
    assert opening["cloud_bytes"] == 0
    assert opening["snapshot_count"] == 0
    assert heartbeats[-1]["cloud_bytes"] == 12


def test_failed_run_still_corrects_usage(isolate_state: Path, tmp_path: Path) -> None:
    """A box whose backups fail is exactly the box whose usage looks full.
    The opening recount lands in state.json regardless of how the run ends."""
    cfg = _cfg(tmp_path)
    heartbeats: list[dict] = []

    def fake_hb(server: str, token: str, **kw: object) -> None:
        heartbeats.append(dict(kw))

    state.save(state.State(last_cloud_bytes=9_800_000_000, last_snapshot_count=2), isolate_state)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat", side_effect=fake_hb),
        patch(
            "clawkeep.runner.openclaw.create_archive",
            side_effect=OpenclawError("disk full"),
        ),
        patch(
            "clawkeep.runner.s3.stats",
            return_value=CloudStats(cloud_bytes=0, snapshot_count=0),
        ),
    ):
        rc = runner.run_once(cfg, "claw_x")

    assert rc == runner.EXIT_OPENCLAW
    assert heartbeats[0]["cloud_bytes"] == 0
    final = state.load(isolate_state)
    assert final.last_cloud_bytes == 0
    assert final.last_snapshot_count == 0


# ── TASK-1000: archive failures that have a remedy of their own ─────────────

def _run_with_archive_error(tmp_path: Path, error: Exception) -> tuple[int, list[dict], object]:
    cfg = _cfg(tmp_path)
    heartbeats: list[dict] = []
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch(
            "clawkeep.runner.api.heartbeat",
            side_effect=lambda s, t, **kw: heartbeats.append(kw),
        ),
        patch("clawkeep.runner.agent.create_archive", side_effect=error) as create,
        patch("clawkeep.runner.time.sleep"),
        patch("clawkeep.runner.s3.upload") as upload,
    ):
        rc = runner.run_once(cfg, "claw_x")
    upload.assert_not_called()
    return rc, heartbeats, create


@pytest.mark.parametrize(
    ("failure", "exit_code"),
    [
        (
            openclaw.Failure(openclaw.FAILURE_SQLITE, ("/s/logs.sqlite",)),
            runner.EXIT_ARCHIVE_DB_DAMAGED,
        ),
        (
            openclaw.Failure(openclaw.FAILURE_SYMLINK, ("/s/a", "/elsewhere")),
            runner.EXIT_ARCHIVE_CONFLICT,
        ),
        (
            openclaw.Failure(openclaw.FAILURE_DUPLICATE, ("/s/a", "/s/A")),
            runner.EXIT_ARCHIVE_CONFLICT,
        ),
        (openclaw.Failure(openclaw.FAILURE_OTHER), runner.EXIT_OPENCLAW),
    ],
)
def test_archive_failures_get_their_own_exit_code(
    isolate_state: Path, tmp_path: Path, failure: openclaw.Failure, exit_code: int,
) -> None:
    rc, heartbeats, create = _run_with_archive_error(
        tmp_path, OpenclawError("the sentence", failure=failure),
    )
    assert rc == exit_code
    create.assert_called_once()
    assert heartbeats[-1]["status"] == "error"
    assert "the sentence" in heartbeats[-1]["error"]


def test_the_sentence_of_the_real_cli_is_enough_for_the_exit_code(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """A plain `OpenclawError` carrying only the CLI's English still maps."""
    rc, _, _ = _run_with_archive_error(tmp_path, OpenclawError(
        "openclaw backup create failed (rc=1): SQLite database cannot be compacted safely for "
        "backup: /home/clawbox/.openclaw/logs/logs.sqlite. SQLite integrity_check failed …",
    ))
    assert rc == runner.EXIT_ARCHIVE_DB_DAMAGED


def test_a_file_that_vanishes_on_every_walk_is_a_bounded_race(
    isolate_state: Path, tmp_path: Path,
) -> None:
    """Any path, not a suffix list: this one is a rotated transcript the old
    `.jsonl`-only rule happened to catch — and a workspace file it did not."""
    cfg = _cfg(tmp_path)
    race = OpenclawError(
        "Backup archive write failed: ENOENT: no such file or directory, open "
        "'/home/clawbox/.openclaw/workspace/notes/today.md.tmp-swap' (after 1 attempt)",
    )
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.agent.create_archive", side_effect=race) as create,
        patch("clawkeep.runner.time.sleep") as sleep,
        patch("clawkeep.runner.s3.upload") as upload,
    ):
        rc = runner.run_once(cfg, "claw_x")

    assert rc == runner.EXIT_ARCHIVE_BUSY
    assert create.call_count == runner.ARCHIVE_RACE_ATTEMPTS
    assert [c.args[0] for c in sleep.call_args_list] == list(runner.ARCHIVE_RACE_DELAYS)
    upload.assert_not_called()


def test_a_race_that_clears_on_a_later_walk_backs_up(
    isolate_state: Path, tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)
    race = OpenclawError(
        "x", failure=openclaw.Failure(openclaw.FAILURE_VANISHED, ("/s/a",), transient=True),
    )
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.agent.create_archive", side_effect=[race, race, archive]) as create,
        patch("clawkeep.runner.time.sleep"),
        patch("clawkeep.runner.s3.upload"),
        patch("clawkeep.runner.s3.stats", return_value=CloudStats(0, 1)),
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_OK
    assert create.call_count == 3


def test_a_vanished_path_the_guard_ruled_out_is_not_retried(
    isolate_state: Path, tmp_path: Path,
) -> None:
    rc, _, create = _run_with_archive_error(tmp_path, OpenclawError(
        "ENOENT: no such file or directory, open '/usr/lib/x.mjs'",
        failure=openclaw.Failure(openclaw.FAILURE_VANISHED, ("/usr/lib/x.mjs",)),
    ))
    assert rc == runner.EXIT_OPENCLAW
    create.assert_called_once()


@pytest.mark.parametrize("used,size,quota,allowed", [
    (60, 39, 100, True),
    (60, 40, 100, True),
    (60, 41, 100, False),
    (0, 101, 100, False),
    (101, 1, 100, False),
])
def test_encrypted_size_admission_preserves_snapshots(
    isolate_state: Path, tmp_path: Path, used: int, size: int, quota: int, allowed: bool,
) -> None:
    from dataclasses import replace

    archive = _archive(tmp_path)
    existing = {"locked.tar.gz.enc": b"locked", "old.tar.gz.enc": b"last good backup"}
    before = existing.copy()
    events = []

    def encrypt(**kw):
        kw["ciphertext_path"].write_bytes(b"x" * size)

    def upload(creds, *, archive_path, object_name, progress_cb):
        events.append("upload")
        existing[object_name] = archive_path.read_bytes()

    with (
        patch("clawkeep.runner.api.mint_credentials",
              return_value=replace(CREDS, quotaBytes=quota, cloudBytes=0)),
        patch("clawkeep.runner.api.heartbeat") as heartbeat,
        patch("clawkeep.runner.agent.create_archive", return_value=archive),
        patch("clawkeep.runner.crypto.encrypt_file", side_effect=encrypt),
        patch("clawkeep.runner.s3.stats", side_effect=[
            CloudStats(0, 0), CloudStats(used, 2), CloudStats(used + size, 3),
        ]),
        patch("clawkeep.runner.s3.upload", side_effect=upload) as put,
        patch("clawkeep.runner.apply_retention",
              side_effect=lambda *a: events.append("retention")) as retention,
        patch("clawkeep.runner.s3.delete_snapshot") as delete,
        patch("clawkeep.runner.s3.write_manifest") as manifest,
    ):
        result = runner.run_once(_cfg(tmp_path), "claw_x")
    assert {key: existing[key] for key in before} == before
    delete.assert_not_called()
    assert not archive.path.exists()
    assert not archive.path.with_suffix(".gz.enc").exists()
    final = state.load(isolate_state)
    assert final.last_step == ""
    assert final.upload_bytes_total == 0
    if allowed:
        assert result == runner.EXIT_OK
        assert events == ["upload", "retention"]
        assert used + size <= quota
        assert final.last_backup_at_ms > 0
    else:
        assert result == runner.EXIT_QUOTA_FULL
        put.assert_not_called()
        retention.assert_not_called()
        manifest.assert_not_called()
        assert existing == before
        assert final.last_backup_at_ms == 0
        assert final.quota_full_since_ms > 0
        error = heartbeat.call_args.kwargs
        assert error["cloud_bytes"] == used
        assert f"needs {size} bytes" in error["error"]
        assert "Nothing was uploaded or removed" in error["error"]


def test_admission_fails_closed_when_fresh_listing_fails(isolate_state, tmp_path):
    archive = _archive(tmp_path)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat") as heartbeat,
        patch("clawkeep.runner.agent.create_archive", return_value=archive),
        patch("clawkeep.runner.s3.stats", side_effect=[CloudStats(0, 2), S3Error("offline")]),
        patch("clawkeep.runner.s3.upload") as upload,
        patch("clawkeep.runner.apply_retention") as retention,
        patch("clawkeep.runner.s3.write_manifest") as manifest,
    ):
        assert runner.run_once(_cfg(tmp_path), "claw_x") == runner.EXIT_NETWORK
    upload.assert_not_called()
    retention.assert_not_called()
    manifest.assert_not_called()
    assert "Check connectivity and retry" in heartbeat.call_args.kwargs["error"]
    assert state.load(isolate_state).last_snapshot_count == 2


def test_competing_run_does_not_admit_or_mutate_active_run(isolate_state, tmp_path):
    import threading

    entered = threading.Event()
    release = threading.Event()
    results = []

    def active(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return runner.EXIT_OK

    state.save(state.State(last_heartbeat_status="running", last_cloud_bytes=75), isolate_state)
    before = isolate_state.read_bytes()
    with (
        patch("clawkeep.runner._run_once_locked", side_effect=active) as cycle,
        patch("clawkeep.runner.api.heartbeat") as heartbeat,
    ):
        first = threading.Thread(target=lambda: results.append(runner.run_once(_cfg(tmp_path), "x")))
        first.start()
        try:
            assert entered.wait(5)
            assert runner.run_once(_cfg(tmp_path), "x") == runner.EXIT_BACKUP_FAILED
            assert cycle.call_count == 1
            assert isolate_state.read_bytes() == before
            heartbeat.assert_not_called()
        finally:
            release.set()
            first.join(5)
        assert not first.is_alive()
        assert results == [runner.EXIT_OK]
        assert runner.run_once(_cfg(tmp_path), "x") == runner.EXIT_OK
        assert cycle.call_count == 2
