#!/usr/bin/env bash
# Trigger the updater's persisted post-reboot continuation without requiring
# an operator to reopen the browser. Safe on every clawbox-setup start: it
# exits immediately unless config.json contains update_needs_continuation.
set -euo pipefail

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
CONFIG_FILE="$PROJECT_DIR/data/config.json"
TOKEN_FILE="$PROJECT_DIR/data/.mcp-token"

if [ ! -r "$CONFIG_FILE" ] || [ ! -r "$TOKEN_FILE" ]; then
  exit 0
fi

if ! /usr/bin/node -e '
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.exit(cfg.update_needs_continuation ? 0 : 1);
' "$CONFIG_FILE"; then
  exit 0
fi

TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
AUTH_HEADER_FILE="$(mktemp)"
chmod 600 "$AUTH_HEADER_FILE"
trap 'rm -f "$AUTH_HEADER_FILE"' EXIT
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$AUTH_HEADER_FILE"
unset TOKEN
for _attempt in $(seq 1 20); do
  if curl -fsS --max-time 2 \
    -H "@$AUTH_HEADER_FILE" \
    -H "Accept: application/json" \
    "http://127.0.0.1/setup-api/update/status" >/dev/null; then
    exit 0
  fi
  sleep 1
done

echo "[update-continuation] updater API did not accept the persisted continuation" >&2
exit 1
