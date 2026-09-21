#!/usr/bin/env bash
# Runs the Cloudflare tunnel that makes the local ClawBox web UI reachable from
# outside, and writes the URL it is reachable on to a file the UI and the portal
# heartbeat read.
#
# Two tunnels, tried in this order:
#
#   NAMED  When the portal has provisioned this box, the heartbeat stored a
#          credential in data/cloudflared/named-tunnel (hostname + run token,
#          0600, see src/lib/named-tunnel.ts). We run
#            TUNNEL_TOKEN=<token> cloudflared tunnel --no-autoupdate run --url <local>
#          and publish https://<boxHandle>.clawbox.tech — a URL that never
#          changes. The token is passed in the environment, never on argv
#          (`ps` shows argv to every local user), and is scrubbed from every
#          line of cloudflared's output before it reaches the journal.
#   QUICK  Otherwise — or when the named run is refused, or dies within its
#          first NAMED_EARLY_EXIT_SECS seconds — the quick tunnel exactly as it
#          always ran: cloudflared prints a fresh *.trycloudflare.com URL to
#          stderr once on startup and we capture it. This fallback is what keeps
#          a box that fails to provision from losing remote access.
#
# Which one is running is written to data/cloudflared/tunnel.mode.
#
# cloudflared's output goes through a while-read loop that both forwards lines
# to stdout (so systemd journals them) and extracts the URL.
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
NAMED_CRED_FILE="$TUNNEL_DIR/named-tunnel"
TUNNEL_MODE_FILE="$TUNNEL_DIR/tunnel.mode"
# sha256 of a token cloudflared refused. The heartbeat will not store that
# token again, so a dead credential cannot bounce the tunnel every beat.
NAMED_REFUSED_FILE="$TUNNEL_DIR/named-refused"
NAMED_REFUSAL_SEEN="$TUNNEL_DIR/.named-refusal-seen"
NAMED_EARLY_EXIT_SECS="${NAMED_EARLY_EXIT_SECS:-60}"
# What cloudflared says when Cloudflare will not run this tunnel with this
# token: a malformed token, a deleted tunnel, a rotated secret.
NAMED_REFUSAL_RE='Tunnel token is not valid|Tunnel not found|[Ii]nvalid tunnel secret'
# Same rules as src/lib/named-tunnel.ts.
NAMED_HOST_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.clawbox\.tech$'
NAMED_TOKEN_RE='^[A-Za-z0-9+/_=-]{32,4096}$'

# Nothing inherited may pose as the credential; the named run sets its own.
unset TUNNEL_TOKEN

mkdir -p "$TUNNEL_DIR"
rm -f "$TUNNEL_URL_FILE" "$TUNNEL_MODE_FILE" "$NAMED_REFUSAL_SEEN"

cleanup() {
  rm -f "$TUNNEL_URL_FILE" "$TUNNEL_MODE_FILE" "$NAMED_REFUSAL_SEEN"
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

# Parse the credential line by line — never `source` it. Sets NAMED_HOSTNAME
# and NAMED_TOKEN; fails when the file is absent, empty or malformed.
NAMED_HOSTNAME=""
NAMED_TOKEN=""
read_named_credential() {
  NAMED_HOSTNAME=""
  NAMED_TOKEN=""
  [ -s "$NAMED_CRED_FILE" ] || return 1
  local line host="" token=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      hostname=*) host="${line#hostname=}" ;;
      token=*) token="${line#token=}" ;;
    esac
  done < "$NAMED_CRED_FILE"
  [[ "$host" =~ $NAMED_HOST_RE ]] || return 1
  [[ "$token" =~ $NAMED_TOKEN_RE ]] || return 1
  NAMED_HOSTNAME="$host"
  NAMED_TOKEN="$token"
}

stopped_by_signal() {
  # 143 = 128+SIGTERM, 130 = 128+SIGINT. Either means "someone asked us to
  # stop", and the honest exit status for that is 0.
  [ "$SIGNALLED" = "1" ] || [ "$1" = "143" ] || [ "$1" = "130" ]
}

if [ ! -x "$CLOUDFLARED_BIN" ]; then
  echo "[run-tunnel] cloudflared not found at $CLOUDFLARED_BIN" >&2
  exit 1
fi

if read_named_credential; then
  printf '%s\n' named > "$TUNNEL_MODE_FILE"
  echo "[run-tunnel] named tunnel -> $LOCAL_SERVICE_URL (credential on file, token not shown)"
  STARTED_AT=$SECONDS
  # The token reaches cloudflared through its environment only. Every line is
  # scrubbed of it before it is forwarded, whatever cloudflared decides to log.
  TUNNEL_TOKEN="$NAMED_TOKEN" "$CLOUDFLARED_BIN" tunnel --no-autoupdate run --url "$LOCAL_SERVICE_URL" 2>&1 | \
  while IFS= read -r line; do
    line="${line//"$NAMED_TOKEN"/[redacted]}"
    printf '%s\n' "$line"
    # The hostname is published once Cloudflare has accepted a connection,
    # not before: until then nothing answers on it.
    if [ ! -s "$TUNNEL_URL_FILE" ] && [[ "$line" == *"Registered tunnel connection"* ]]; then
      record_url "https://$NAMED_HOSTNAME"
    fi
    if [[ "$line" =~ $NAMED_REFUSAL_RE ]]; then
      : > "$NAMED_REFUSAL_SEEN"
    fi
  done
  STATUS=${PIPESTATUS[0]}
  ELAPSED=$((SECONDS - STARTED_AT))

  if stopped_by_signal "$STATUS"; then
    echo "[run-tunnel] stopped by signal — exiting cleanly"
    exit 0
  fi

  if [ -e "$NAMED_REFUSAL_SEEN" ]; then
    # Cloudflare refused this credential. Forget it (the heartbeat asks the
    # portal for a fresh one) and remember which token it was.
    ( umask 077 && printf '%s' "$NAMED_TOKEN" | sha256sum | cut -d' ' -f1 > "$NAMED_REFUSED_FILE" )
    rm -f "$NAMED_CRED_FILE" "$NAMED_REFUSAL_SEEN"
    echo "[run-tunnel] Cloudflare refused the named tunnel credential; removed it, falling back to the quick tunnel"
  elif [ "$STATUS" != "0" ] && [ "$ELAPSED" -lt "$NAMED_EARLY_EXIT_SECS" ]; then
    echo "[run-tunnel] named tunnel exited after ${ELAPSED}s (status $STATUS); falling back to the quick tunnel"
  else
    # It ran, then ended. systemd restarts the unit, which tries named again.
    echo "[run-tunnel] named tunnel exited (status $STATUS)"
    exit "$STATUS"
  fi
  NAMED_TOKEN=""
  rm -f "$TUNNEL_URL_FILE"
fi

printf '%s\n' quick > "$TUNNEL_MODE_FILE"
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

if stopped_by_signal "$STATUS"; then
  echo "[run-tunnel] stopped by signal — exiting cleanly"
  exit 0
fi
exit "$STATUS"
