"""Runner tests focus on the failure-mode matrix from section 10:
auth/quota/tier/server/network errors must produce the right exit codes
and the right heartbeat payloads, without retrying things that need
human action.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from clawkeep import runner, state
from clawkeep.api import ApiError, Credentials
from clawkeep.config import Config, HeartbeatConfig, ResticConfig
from clawkeep.restic import BackupResult, ResticError, Stats


def _cfg(tmp_path: Path) -> Config:
    return Config(
        server="https://server",
        paths=["/home"],
        exclude=[],
        schedule="daily",
        restic=ResticConfig(binary="/usr/bin/restic"),
        heartbeat=HeartbeatConfig(idle_interval_hours=24),
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
    heartbeats: list[dict] = []

    def fake_hb(server: str, token: str, **kw: object) -> None:
        heartbeats.append(dict(kw))

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat", side_effect=fake_hb),
        patch("clawkeep.runner.restic.init"),
        patch(
            "clawkeep.runner.restic.backup",
            return_value=BackupResult(ok=True, last_line="", files_new=2, files_changed=0, bytes_added=512),
        ),
        patch(
            "clawkeep.runner.restic.stats",
            return_value=Stats(total_size=999_888, snapshot_count=5),
        ),
    ):
        rc = runner.run_once(cfg, "claw_x", "repo-pw")
    assert rc == runner.EXIT_OK
    statuses = [hb["status"] for hb in heartbeats]
    assert statuses == ["running", "ok"]
    final = heartbeats[-1]
    assert final["cloud_bytes"] == 999_888
    assert final["snapshot_count"] == 5
    assert "last_backup_at" in final


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
        rc = runner.run_once(cfg, "claw_x", "repo-pw")
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
        rc = runner.run_once(cfg, "claw_x", "repo-pw")
    assert rc == runner.EXIT_QUOTA_FULL
    hb.assert_called_once()
    assert hb.call_args.kwargs["status"] == "error"
    assert "quota" in hb.call_args.kwargs["error"].lower()


def test_credentials_retried_on_network_failure(isolate_state: Path, tmp_path: Path) -> None:
    """Network/server errors retry; auth/quota do not."""
    cfg = _cfg(tmp_path)
    side = [
        ApiError("network", "boom"),
        ApiError("network", "boom"),
        CREDS,
    ]

    def fake_mint(server: str, token: str):
        v = side.pop(0)
        if isinstance(v, ApiError):
            raise v
        return v

    with (
        patch("clawkeep.runner.api.mint_credentials", side_effect=fake_mint),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.time.sleep"),  # don't actually wait in tests
        patch("clawkeep.runner.restic.init"),
        patch(
            "clawkeep.runner.restic.backup",
            return_value=BackupResult(ok=True, last_line="", files_new=0, files_changed=0, bytes_added=0),
        ),
        patch(
            "clawkeep.runner.restic.stats",
            return_value=Stats(total_size=0, snapshot_count=1),
        ),
    ):
        rc = runner.run_once(cfg, "claw_x", "repo-pw")
    assert rc == runner.EXIT_OK


def test_credentials_not_retried_on_auth_error(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    calls: list[int] = []

    def mint_once(server: str, token: str):
        calls.append(1)
        raise ApiError("auth", "Token revoked", 401)

    with (
        patch("clawkeep.runner.api.mint_credentials", side_effect=mint_once),
        patch("clawkeep.runner.time.sleep"),
        patch("clawkeep.runner.api.heartbeat"),
    ):
        rc = runner.run_once(cfg, "claw_x", "repo-pw")
    assert rc == runner.EXIT_AUTH_REVOKED
    assert len(calls) == 1  # no retry


def test_restic_failure_reports_error(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    heartbeats: list[dict] = []

    def fake_hb(server: str, token: str, **kw: object) -> None:
        heartbeats.append(dict(kw))

    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat", side_effect=fake_hb),
        patch("clawkeep.runner.restic.init"),
        patch(
            "clawkeep.runner.restic.backup",
            return_value=BackupResult(ok=False, last_line="Fatal: disk full", files_new=0, files_changed=0, bytes_added=0),
        ),
    ):
        rc = runner.run_once(cfg, "claw_x", "repo-pw")
    assert rc == runner.EXIT_BACKUP_FAILED
    assert heartbeats[-1]["status"] == "error"
    assert "disk full" in heartbeats[-1]["error"]


def test_init_failure_does_not_attempt_backup(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    with (
        patch("clawkeep.runner.api.mint_credentials", return_value=CREDS),
        patch("clawkeep.runner.api.heartbeat"),
        patch("clawkeep.runner.restic.init", side_effect=ResticError("permission denied")),
        patch("clawkeep.runner.restic.backup") as backup_mock,
    ):
        rc = runner.run_once(cfg, "claw_x", "repo-pw")
    assert rc == runner.EXIT_RESTIC
    backup_mock.assert_not_called()


def test_idle_skips_when_recent_heartbeat(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    st = state.State(last_heartbeat_at_ms=10_000_000_000_000)  # very recent
    state.save(st, isolate_state)

    with patch("clawkeep.runner.api.heartbeat") as hb, patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_001):
        rc = runner.run_idle(cfg, "claw_x")
    assert rc == runner.EXIT_OK
    hb.assert_not_called()


def test_idle_sends_when_stale(isolate_state: Path, tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    state.save(state.State(last_heartbeat_at_ms=1_000), isolate_state)
    with patch("clawkeep.runner.api.heartbeat") as hb, patch("clawkeep.runner.api.now_ms", return_value=10_000_000_000_000):
        rc = runner.run_idle(cfg, "claw_x")
    assert rc == runner.EXIT_OK
    hb.assert_called_once()
    assert hb.call_args.kwargs["status"] == "idle"
