#!/usr/bin/env bash
# Runs a Cloudflare Quick Tunnel pointing at the local ClawBox web UI and
# writes the auto-generated *.trycloudflare.com URL to a file so the UI can
# display it for the user to paste into the portal's "Add Device" dialog.
#
# cloudflared prints the URL to stderr once on startup. We tee all output
# through a while-read loop that both forwards lines to stdout (so systemd
# journals them) and extracts the first trycloudflare URL it sees.
set -uo pipefail

DATA_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}/data"
TUNNEL_DIR="$DATA_DIR/cloudflared"
TUNNEL_URL_FILE="$TUNNEL_DIR/tunnel.url"
LOCAL_SERVICE_URL="${LOCAL_SERVICE_URL:-http://localhost:80}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"

mkdir -p "$TUNNEL_DIR"
rm -f "$TUNNEL_URL_FILE"

cleanup() {
  rm -f "$TUNNEL_URL_FILE"
}
trap cleanup EXIT INT TERM

if [ ! -x "$CLOUDFLARED_BIN" ]; then
  echo "[run-tunnel] cloudflared not found at $CLOUDFLARED_BIN" >&2
  exit 1
fi

echo "[run-tunnel] forwarding tunnel -> $LOCAL_SERVICE_URL"

# Combine stdout+stderr, pipe through the URL extractor. `exec` swaps the
# shell for cloudflared so signals (SIGTERM from systemd) reach it directly.
# But we need the pipe, so run it as a subprocess and wait.
"$CLOUDFLARED_BIN" tunnel --no-autoupdate --url "$LOCAL_SERVICE_URL" 2>&1 | \
while IFS= read -r line; do
  # Forward to stdout so systemd journals it.
  printf '%s\n' "$line"
  if [ ! -s "$TUNNEL_URL_FILE" ]; then
    url=$(printf '%s\n' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -n 1 || true)
    if [ -n "${url:-}" ]; then
      printf '%s\n' "$url" > "$TUNNEL_URL_FILE"
      echo "[run-tunnel] captured URL: $url"
    fi
  fi
done
