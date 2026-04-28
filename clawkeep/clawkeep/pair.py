"""`clawkeep pair` — one-shot CLI that performs the OAuth2 authorization-code
flow against the portal at /portal/connect (section 4 of clawkeep-plan.md).

Headless devices:  the redirect target is 127.0.0.1:8765 *on the device*, so
SSH users must forward that port back to their laptop with `ssh -L 8765:127.0.0.1:8765`
before clicking through the portal. We print this hint up front.
"""

from __future__ import annotations

import json
import secrets
import socket
import socketserver
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

import requests

from . import api, token

PAIR_PORT = 8765
PAIR_BIND = "127.0.0.1"
PAIR_PATH = "/auth"
PAIR_TIMEOUT_SEC = 600  # user has 10 minutes to complete the flow


class _PairHandler(BaseHTTPRequestHandler):
    received: dict[str, Any] | None = None
    expected_state: str = ""

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        # Quiet the default access log; we print our own status updates.
        return

    def do_GET(self) -> None:  # noqa: N802 - stdlib signature
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != PAIR_PATH:
            self._respond(404, "Not found")
            return

        query = dict(urllib.parse.parse_qsl(parsed.query))
        if query.get("state") != _PairHandler.expected_state:
            self._respond(400, "State mismatch — possible CSRF, abort.")
            return

        if "error" in query:
            self._respond(400, f"Authorization denied: {query['error']}")
            _PairHandler.received = {"error": query["error"]}
            return

        code = query.get("code")
        if not code:
            self._respond(400, "Missing code in redirect")
            return

        _PairHandler.received = {"code": code, "state": query["state"]}
        html = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<title>ClawKeep paired</title>"
            "<style>body{font-family:system-ui;background:#0b0e14;color:#e5e7eb;"
            "display:flex;align-items:center;justify-content:center;height:100vh;margin:0}"
            ".c{text-align:center;max-width:420px;padding:24px}"
            "h1{color:#f97316;margin:0 0 12px}p{color:#9ca3af;line-height:1.5}</style>"
            "</head><body><div class='c'>"
            "<h1>✓ ClawKeep paired</h1>"
            "<p>You can close this tab and return to the device terminal.</p>"
            "</div></body></html>"
        )
        self._respond(200, html, content_type="text/html; charset=utf-8")

    def _respond(self, status: int, body: str, content_type: str = "text/plain; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        encoded = body.encode("utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class _OneShotServer(socketserver.TCPServer):
    allow_reuse_address = True


def _exchange(server: str, code: str, state: str, device_id: str) -> str:
    url = f"{server}/api/portal/connect/exchange"
    try:
        resp = requests.post(
            url,
            json={"code": code, "state": state, "device_id": device_id},
            timeout=(5, 30),
            headers={"User-Agent": api.USER_AGENT},
        )
    except requests.RequestException as e:
        raise SystemExit(f"Failed to reach {url}: {e}") from e

    if not resp.ok:
        try:
            body = resp.json()
        except ValueError:
            body = {"error": resp.text[:200]}
        raise SystemExit(f"Token exchange failed ({resp.status_code}): {body.get('error', resp.reason)}")

    try:
        body = resp.json()
    except ValueError as e:
        raise SystemExit(f"Token exchange returned non-JSON: {e}") from e
    access_token = body.get("access_token")
    if not isinstance(access_token, str) or not access_token.startswith("claw_"):
        raise SystemExit(f"Token exchange returned unexpected body: {json.dumps(body)[:200]}")
    return access_token


def run_pair(
    server: str,
    *,
    device_name: str | None = None,
    token_path: Path | None = None,
    port: int = PAIR_PORT,
) -> str:
    """Run the pairing flow. Returns the obtained token. Side effects: writes
    token file to disk."""
    server = server.rstrip("/")
    device_name = device_name or socket.gethostname()
    state = secrets.token_urlsafe(24)
    _PairHandler.expected_state = state
    _PairHandler.received = None

    redirect_uri = f"http://{PAIR_BIND}:{port}{PAIR_PATH}"
    qs = urllib.parse.urlencode(
        {
            "state": state,
            "redirect_uri": redirect_uri,
            "device_name": device_name,
        }
    )
    auth_url = f"{server}/portal/connect?{qs}"

    print("─" * 60)
    print("ClawKeep pairing")
    print("─" * 60)
    print(f"Device name:  {device_name}")
    print(f"Server:       {server}")
    print()
    print("Open this URL in a browser to authorize the device:")
    print(f"  {auth_url}")
    print()
    print("If you SSH'd into this device from a laptop, forward the")
    print("listener back first so the redirect can land:")
    print(f"  ssh -L {port}:127.0.0.1:{port} <user>@<this-device>")
    print()
    print("Waiting for authorization…")

    try:
        with _OneShotServer((PAIR_BIND, port), _PairHandler) as srv:
            srv.timeout = PAIR_TIMEOUT_SEC
            srv.handle_request()
    except OSError as e:
        raise SystemExit(f"Could not bind {PAIR_BIND}:{port}: {e}") from e

    received = _PairHandler.received
    if not received:
        raise SystemExit(f"Timed out after {PAIR_TIMEOUT_SEC}s waiting for redirect.")
    if "error" in received:
        raise SystemExit(f"Authorization denied: {received['error']}")

    access_token = _exchange(
        server,
        code=received["code"],
        state=received["state"],
        device_id=device_name,
    )

    target = token_path or token.default_token_path()
    token.write_token(access_token, target)
    print(f"✓ Paired. Token written to {target} (mode 0600).")
    return access_token


def main(argv: list[str] | None = None) -> int:
    """Entry: `clawkeep pair [--server URL] [--device-name NAME] [--token-path PATH] [--port N]`."""
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep pair")
    parser.add_argument("--server", default="https://openclawhardware.dev")
    parser.add_argument("--device-name", default=None)
    parser.add_argument("--token-path", default=None, type=Path)
    parser.add_argument("--port", default=PAIR_PORT, type=int)
    args = parser.parse_args(argv)

    try:
        run_pair(
            args.server,
            device_name=args.device_name,
            token_path=args.token_path,
            port=args.port,
        )
    except SystemExit as e:
        if e.code:
            print(str(e), file=sys.stderr)
        return int(e.code) if isinstance(e.code, int) else 1
    return 0
