#!/usr/bin/env bash
# Ensure gateway auth is disabled before OpenClaw gateway starts.
# On a local Jetson device there's no HTTPS for browser token exchange,
# so auth must be "none" with insecure/device-auth bypasses enabled.
set -euo pipefail

OPENCLAW_BIN="/home/clawbox/.npm-global/bin/openclaw"

if [ ! -x "$OPENCLAW_BIN" ]; then
  exit 0
fi

"$OPENCLAW_BIN" config set gateway.auth.mode none 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.controlUi.dangerouslyDisableDeviceAuth true --json 2>/dev/null || true
