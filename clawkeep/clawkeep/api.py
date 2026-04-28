"""HTTP client for the portal endpoints documented in section 3 of
clawkeep-plan.md: /api/clawkeep/credentials and /api/clawkeep/heartbeat."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

import requests

from . import __version__

USER_AGENT = f"clawkeep/{__version__}"
DEFAULT_TIMEOUT = (5, 30)  # (connect, read) seconds


HeartbeatStatus = Literal["ok", "error", "running", "idle"]


@dataclass(frozen=True)
class Credentials:
    accessKeyId: str
    secretAccessKey: str
    sessionToken: str
    endpoint: str
    bucket: str
    prefix: str
    expiresAt: int  # unix ms
    quotaBytes: int
    cloudBytes: int


class ApiError(Exception):
    """Server returned a non-2xx, OR the network failed.

    `kind` lets the runner branch on the kinds documented in section 10
    without parsing English error strings.
    """

    def __init__(
        self,
        kind: Literal[
            "auth",          # 401
            "quota_full",    # 402
            "tier",          # 403
            "server",        # 5xx
            "network",       # connection refused, timeout, DNS, etc.
            "other",         # anything else (4xx that isn't above, malformed JSON)
        ],
        message: str,
        status: int | None = None,
    ):
        super().__init__(message)
        self.kind = kind
        self.status = status


def _classify(resp: requests.Response, body: object | None) -> ApiError:
    msg: str = resp.reason or "request failed"
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, str) and err:
            msg = err
    if resp.status_code == 401:
        return ApiError("auth", msg, resp.status_code)
    if resp.status_code == 402:
        return ApiError("quota_full", msg, resp.status_code)
    if resp.status_code == 403:
        return ApiError("tier", msg, resp.status_code)
    if 500 <= resp.status_code < 600:
        return ApiError("server", msg, resp.status_code)
    return ApiError("other", msg, resp.status_code)


def _post(server: str, path: str, token: str, json_body: dict | None = None) -> dict:
    url = f"{server}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": USER_AGENT,
    }
    try:
        resp = requests.post(
            url,
            json=json_body,
            headers=headers,
            timeout=DEFAULT_TIMEOUT,
        )
    except requests.RequestException as e:
        raise ApiError("network", str(e)) from e

    body: object | None = None
    if resp.content:
        try:
            body = resp.json()
        except ValueError:
            body = None

    if not resp.ok:
        raise _classify(resp, body)

    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ApiError("other", f"expected JSON object, got {type(body).__name__}")
    return body


def mint_credentials(server: str, token: str) -> Credentials:
    """POST /api/clawkeep/credentials. Server caches creds ~1h per user; do
    not cache on the device — the server is the source of truth."""
    body = _post(server, "/api/clawkeep/credentials", token, json_body={})
    try:
        return Credentials(
            accessKeyId=body["accessKeyId"],
            secretAccessKey=body["secretAccessKey"],
            sessionToken=body["sessionToken"],
            endpoint=body["endpoint"],
            bucket=body["bucket"],
            prefix=body["prefix"],
            expiresAt=int(body["expiresAt"]),
            quotaBytes=int(body["quotaBytes"]),
            cloudBytes=int(body["cloudBytes"]),
        )
    except (KeyError, TypeError, ValueError) as e:
        raise ApiError("other", f"malformed /credentials response: {e}") from e


def heartbeat(
    server: str,
    token: str,
    *,
    status: HeartbeatStatus,
    error: str | None = None,
    cloud_bytes: int | None = None,
    snapshot_count: int | None = None,
    last_backup_at: int | None = None,
) -> None:
    """POST /api/clawkeep/heartbeat.

    Section 9: don't retry aggressively. If it fails, log and move on; the
    next run catches up.
    """
    body: dict[str, object] = {"status": status}
    if error is not None:
        body["error"] = error[:500]
    if cloud_bytes is not None:
        body["cloudBytes"] = int(cloud_bytes)
    if snapshot_count is not None:
        body["snapshotCount"] = int(snapshot_count)
    if last_backup_at is not None:
        body["lastBackupAt"] = int(last_backup_at)
    _post(server, "/api/clawkeep/heartbeat", token, json_body=body)


def now_ms() -> int:
    return int(time.time() * 1000)
