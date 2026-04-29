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
    /var/lib/clawkeep or whatever the real device directory is."""
    monkeypatch.setenv("CLAWKEEP_DATA_DIR", str(tmp_path))
    yield tmp_path / "state.json"


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


def test_step_is_persisted_until_failure(isolate_state: Path, tmp_path: Path) -> None:
    """A reopened window mid-upload should see `last_step == "uploading"`."""
    cfg = _cfg(tmp_path)
    archive = _archive(tmp_path)

    captured_steps: list[str] = []

    def upload_that_records_state(creds, *, archive_path, object_name):
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


def test_step_cleared_on_error(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch(
            "clawkeep.runner.openclaw.create_archive",
            side_effect=__import__("clawkeep.openclaw", fromlist=["OpenclawError"]).OpenclawError("boom"),
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
        patch("clawkeep.runner.s3.stats") as stats_mock,
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_UPLOAD
    stats_mock.assert_not_called()
    assert heartbeats[-1]["status"] == "error"
    assert "AccessDenied" in heartbeats[-1]["error"]
    # Cleanup must still run on the upload failure path — a half-finished
    # tarball left in staging would re-fill the disk on the next attempt.
    assert not archive.path.exists()


def test_stats_failure_does_not_fail_run(isolate_state: Path, tmp_path: Path) -> None:
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
        patch("clawkeep.runner.s3.stats", side_effect=S3Error("ListBucket forbidden")),
    ):
        rc = runner.run_once(cfg, "claw_x")
    assert rc == runner.EXIT_OK
    final = heartbeats[-1]
    assert final["status"] == "ok"
    assert final["cloud_bytes"] is None
    assert final["snapshot_count"] is None


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
    ):
        rc = runner.run_idle(cfg, "claw_x")
    assert rc == runner.EXIT_OK
    hb.assert_called_once()
    assert hb.call_args.kwargs["status"] == "idle"
