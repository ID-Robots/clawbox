#!/usr/bin/env bash
# Configure the Hermes dashboard's password (basic_auth) provider so the
# dashboard runs in gated cookie-auth mode and the reverse proxy can sign the
# ClawBox user in transparently (SSO). Idempotent — safe to re-run.
#
# Run as the CLAWBOX user (owns ~/.hermes/config.yaml). setup-hermes-edition.sh
# invokes it via `runuser -u clawbox`.
#
# Why a password provider at all: since the June 2026 Hermes hardening, a
# non-loopback dashboard bind ALWAYS requires an auth provider. We bind
# 127.0.0.2 (host-local, but non-loopback → gated mode), so we must configure
# one. The password lives ONLY server-side (data/.hermes-dashboard-pw, 0600);
# the proxy reads it to log in on the user's behalf. The customer never types
# it — their clawbox_session at the proxy is the real gate.
set -euo pipefail

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
HERMES_CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
PWFILE="$PROJECT_DIR/data/.hermes-dashboard-pw"
USERNAME="${HERMES_DASH_USERNAME:-clawbox}"

log() { echo "[hermes-dash-auth] $*"; }

# Already configured? (password file present AND a dashboard block in config.)
if [ -s "$PWFILE" ] && grep -qE '^dashboard:' "$HERMES_CONFIG" 2>/dev/null; then
  log "already configured — skipping"
  exit 0
fi

if [ ! -f "$HERMES_CONFIG" ]; then
  log "WARNING: $HERMES_CONFIG not found — is Hermes installed? Skipping (will retry on next run)."
  exit 0
fi

mkdir -p "$(dirname "$PWFILE")"

# Generate password + scrypt password_hash + token-signing secret. The hash
# format matches Hermes's plugins.dashboard_auth.basic.hash_password
# (scrypt$n$r$p$salt_b64$dk_b64) but uses only stdlib so we don't depend on the
# Hermes venv/plugin path.
GEN="$(python3 - <<'PY'
import secrets, base64, hashlib
pw = secrets.token_urlsafe(24)
salt = secrets.token_bytes(16)
dk = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32, maxmem=0)
h = "scrypt$%d$%d$%d$%s$%s" % (2**14, 8, 1, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())
print(pw)
print(h)
print(secrets.token_urlsafe(32))
PY
)"
PW="$(printf '%s\n' "$GEN" | sed -n '1p')"
HASH="$(printf '%s\n' "$GEN" | sed -n '2p')"
SECRET="$(printf '%s\n' "$GEN" | sed -n '3p')"

if [ -z "$PW" ] || [ -z "$HASH" ] || [ -z "$SECRET" ]; then
  log "ERROR: failed to generate credentials" >&2
  exit 1
fi

# Store the plaintext password for the proxy ONLY (clawbox-owned, 0600).
umask 077
printf '%s' "$PW" > "$PWFILE"
chmod 600 "$PWFILE"
log "wrote $PWFILE (0600)"

# Append the dashboard.basic_auth block (only if there's no dashboard: block).
if ! grep -qE '^dashboard:' "$HERMES_CONFIG" 2>/dev/null; then
  {
    echo ""
    echo "# ClawBox Hermes edition — dashboard password auth (SSO via reverse proxy)."
    echo "# The password lives in $PWFILE (0600); the proxy logs in on the user's"
    echo "# behalf. Do not remove — the dashboard requires an auth provider."
    echo "dashboard:"
    echo "  basic_auth:"
    echo "    username: $USERNAME"
    echo "    password_hash: \"$HASH\""
    echo "    secret: \"$SECRET\""
    echo "    session_ttl_seconds: 604800"
  } >> "$HERMES_CONFIG"
  log "wrote dashboard.basic_auth to $HERMES_CONFIG (username=$USERNAME, ttl=7d)"
else
  log "config already has a dashboard: block — left as-is"
fi

log "done"
