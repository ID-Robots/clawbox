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
# Append-only record of every URL this box has published, newest last. Deliberately
# NOT removed by cleanup(): `tunnel.url` answers "what is the URL right now", and
# it is erased on every stop. This answers "which hostnames has this device ever
# been reachable on", which is the question a stray quick-tunnel URL raises — and
# with no HTTP access log and a volatile journal there was previously no way to
# answer it at all.
TUNNEL_URL_LOG="$TUNNEL_DIR/tunnel-url.log"
TUNNEL_URL_LOG_MAX=50
LOCAL_SERVICE_URL="${LOCAL_SERVICE_URL:-http://localhost:80}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"

mkdir -p "$TUNNEL_DIR"
rm -f "$TUNNEL_URL_FILE"

cleanup() {
  rm -f "$TUNNEL_URL_FILE"
}

# A stop is not a failure. systemd stops this unit with SIGTERM, which kills
# cloudflared in the control group; with `pipefail` the pipeline below then
# returned 143 and systemd logged `Failed with result 'exit-code'`, which the
# Remote Access panel renders as a red "Tunnel failed to start" alert — right
# after the user pressed Stop themselves.
SIGNALLED=0
on_signal() {
  SIGNALLED=1
}
trap cleanup EXIT
trap on_signal INT TERM

record_url() {
  local url="$1"
  printf '%s\n' "$url" > "$TUNNEL_URL_FILE"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$url" >> "$TUNNEL_URL_LOG"
  # Keep the history bounded — it is a diagnostic, not an archive.
  if [ "$(wc -l < "$TUNNEL_URL_LOG" 2>/dev/null || echo 0)" -gt "$TUNNEL_URL_LOG_MAX" ]; then
    tail -n "$TUNNEL_URL_LOG_MAX" "$TUNNEL_URL_LOG" > "$TUNNEL_URL_LOG.tmp" &&
      mv "$TUNNEL_URL_LOG.tmp" "$TUNNEL_URL_LOG"
  fi
  echo "[run-tunnel] captured URL: $url"
}

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
      record_url "$url"
    fi
  fi
done
STATUS=${PIPESTATUS[0]}

# 143 = 128+SIGTERM, 130 = 128+SIGINT. Either means "someone asked us to stop",
# and the honest exit status for that is 0.
if [ "$SIGNALLED" = "1" ] || [ "$STATUS" = "143" ] || [ "$STATUS" = "130" ]; then
  echo "[run-tunnel] stopped by signal — exiting cleanly"
  exit 0
fi
exit "$STATUS"
