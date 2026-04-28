from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import requests

from clawkeep import api


def _resp(status: int, body: dict | None = None) -> MagicMock:
    r = MagicMock(spec=requests.Response)
    r.status_code = status
    r.ok = 200 <= status < 300
    r.reason = "Reason"
    r.content = b"x" if body is not None else b""
    r.json.return_value = body or {}
    return r


CRED_OK = {
    "accessKeyId": "AKIA...",
    "secretAccessKey": "secret",
    "sessionToken": "session",
    "endpoint": "https://acct.r2.cloudflarestorage.com",
    "bucket": "clawkeep",
    "prefix": "users/u_x/repo/",
    "expiresAt": 1730000000000,
    "quotaBytes": 5_368_709_120,
    "cloudBytes": 1_234_567_890,
}


def test_mint_credentials_success() -> None:
    with patch("clawkeep.api.requests.post", return_value=_resp(200, CRED_OK)) as post:
        creds = api.mint_credentials("https://server", "claw_x")
    assert creds.accessKeyId == "AKIA..."
    assert creds.sessionToken == "session"
    assert creds.quotaBytes == 5_368_709_120
    # Request shape
    call = post.call_args
    assert call.args[0].endswith("/api/clawkeep/credentials")
    assert call.kwargs["headers"]["Authorization"] == "Bearer claw_x"
    assert call.kwargs["headers"]["User-Agent"].startswith("clawkeep/")


@pytest.mark.parametrize(
    "status,kind",
    [
        (401, "auth"),
        (402, "quota_full"),
        (403, "tier"),
        (500, "server"),
        (502, "server"),
        (418, "other"),
    ],
)
def test_mint_credentials_classifies_errors(status: int, kind: str) -> None:
    with patch("clawkeep.api.requests.post", return_value=_resp(status, {"error": "x"})):
        with pytest.raises(api.ApiError) as exc:
            api.mint_credentials("https://s", "claw_x")
    assert exc.value.kind == kind
    assert exc.value.status == status


def test_mint_credentials_network_error() -> None:
    with patch(
        "clawkeep.api.requests.post",
        side_effect=requests.ConnectionError("boom"),
    ):
        with pytest.raises(api.ApiError) as exc:
            api.mint_credentials("https://s", "claw_x")
    assert exc.value.kind == "network"


def test_mint_credentials_malformed_body() -> None:
    with patch("clawkeep.api.requests.post", return_value=_resp(200, {"unexpected": "shape"})):
        with pytest.raises(api.ApiError) as exc:
            api.mint_credentials("https://s", "claw_x")
    assert exc.value.kind == "other"


def test_heartbeat_serialises_optional_fields() -> None:
    captured: dict[str, Any] = {}

    def fake_post(url: str, json: dict | None = None, headers: dict | None = None, timeout: Any = None):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return _resp(200)

    with patch("clawkeep.api.requests.post", side_effect=fake_post):
        api.heartbeat(
            "https://s",
            "claw_x",
            status="ok",
            cloud_bytes=42,
            snapshot_count=7,
            last_backup_at=1730000000000,
        )
    assert captured["url"].endswith("/api/clawkeep/heartbeat")
    assert captured["json"] == {
        "status": "ok",
        "cloudBytes": 42,
        "snapshotCount": 7,
        "lastBackupAt": 1730000000000,
    }
    assert captured["headers"]["Authorization"] == "Bearer claw_x"


def test_heartbeat_truncates_long_error() -> None:
    captured: dict[str, Any] = {}

    def fake_post(url: str, json: dict | None = None, **kw: Any):
        captured["json"] = json
        return _resp(200)

    long_err = "x" * 2000
    with patch("clawkeep.api.requests.post", side_effect=fake_post):
        api.heartbeat("https://s", "claw_x", status="error", error=long_err)
    assert captured["json"]["status"] == "error"
    assert captured["json"]["error"] == "x" * 500


def test_heartbeat_minimal_payload() -> None:
    captured: dict[str, Any] = {}

    def fake_post(url: str, json: dict | None = None, **kw: Any):
        captured["json"] = json
        return _resp(200)

    with patch("clawkeep.api.requests.post", side_effect=fake_post):
        api.heartbeat("https://s", "claw_x", status="running")
    assert captured["json"] == {"status": "running"}


def test_heartbeat_propagates_auth_error() -> None:
    with patch("clawkeep.api.requests.post", return_value=_resp(401, {"error": "Token revoked"})):
        with pytest.raises(api.ApiError) as exc:
            api.heartbeat("https://s", "claw_x", status="idle")
    assert exc.value.kind == "auth"
