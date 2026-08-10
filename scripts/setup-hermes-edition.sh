#!/usr/bin/env bash
# Provision the Hermes side of this device. Idempotent — safe to re-run.
# Run as root (install.sh calls it via step_hermes_edition; or `sudo bash`
# standalone).
#
# It does NOT install the Hermes agent itself — Hermes (`~/.local/bin/hermes`)
# is installed by install.sh's step_hermes_install (or provisioned by the
# image). This script wires the edition lock, the shared-identity bridge, the
# dashboard auth provider, and the dashboard + auth-proxy services.
#
# Applies to BOTH editions that run Hermes: `hermes` (Hermes only — the OpenClaw
# gateway is removed) and `dual` (both harnesses, premium). The distinction
# matters: on `dual` the gateway must be left alone.
set -euo pipefail

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
CLAWBOX_USER="${CLAWBOX_USER:-clawbox}"
CLAWBOX_HOME="$(getent passwd "$CLAWBOX_USER" | cut -d: -f6)"
CLAWBOX_HOME="${CLAWBOX_HOME:-/home/$CLAWBOX_USER}"
HERMES_BIN="${HERMES_BIN:-$CLAWBOX_HOME/.local/bin/hermes}"
EDITION_FILE="/etc/clawbox/edition.env"
EDITION_DROPIN="/etc/systemd/system/clawbox-setup.service.d/edition.conf"

log() { echo "[hermes-edition] $*"; }

# Every failure is recorded rather than swallowed. Previously every step here
# degraded to a WARNING and install.sh wrapped the whole script in
# `|| echo "non-fatal"`, so a box could finish "successfully" with no dashboard
# auth provider at all and nothing ever retried. Warnings still don't abort
# mid-script (a later step may repair an earlier one), but the script now EXITS
# NON-ZERO so the caller — and `--step hermes_edition` — reports failure.
FAILURES=0
fail() { FAILURES=$((FAILURES + 1)); log "ERROR: $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  echo "[hermes-edition] must run as root" >&2
  exit 1
fi

# ── 0. Which edition are we? ────────────────────────────────────────────────
# The root-owned lock file is the authority; $CLAWBOX_EDITION (passed by
# install.sh) is honoured for the first-flash case where the file doesn't exist
# yet. Standalone runs with neither default to `hermes`, which is what this
# script has always been used for.
EDITION="${CLAWBOX_EDITION:-}"
if [ -z "$EDITION" ] && [ -f "$EDITION_FILE" ]; then
  EDITION="$(sed -n 's/^[[:space:]]*CLAWBOX_EDITION[[:space:]]*=[[:space:]]*//p' "$EDITION_FILE" 2>/dev/null | tail -n 1 | tr -d '"'\'' ')"
fi
EDITION="$(printf '%s' "${EDITION:-hermes}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
case "$EDITION" in
  hermes|dual) ;;
  *)
    log "edition is '$EDITION' — this device does not run Hermes; nothing to do."
    exit 0
    ;;
esac
log "edition: $EDITION"

# ── 1. Sanity: Hermes must be present (this edition runs on it). ────────────
if [ ! -x "$HERMES_BIN" ]; then
  fail "Hermes binary not found/executable at $HERMES_BIN — run: sudo bash $PROJECT_DIR/install.sh --step hermes_install"
fi

# ── 2. Shared-identity bridge ───────────────────────────────────────────────
# (canonical ~/.clawbox/agent-identity → both harnesses)
if [ -f "$PROJECT_DIR/scripts/setup-shared-identity.sh" ]; then
  log "seeding shared identity"
  runuser -u "$CLAWBOX_USER" -- bash "$PROJECT_DIR/scripts/setup-shared-identity.sh" \
    || fail "shared-identity setup returned non-zero"
fi

# ── 2b. Dashboard password provider (gated-mode auth) ───────────────────────
# Runs as the clawbox user (owns ~/.hermes/config.yaml). The dashboard binds a
# non-loopback host (127.0.0.2) and therefore REQUIRES an auth provider; the
# proxy uses this password to sign the user in transparently.
if [ -f "$PROJECT_DIR/scripts/setup-hermes-dashboard-auth.sh" ]; then
  log "configuring dashboard password auth"
  runuser -u "$CLAWBOX_USER" -- env CLAWBOX_ROOT="$PROJECT_DIR" \
    bash "$PROJECT_DIR/scripts/setup-hermes-dashboard-auth.sh" \
    || fail "dashboard auth setup returned non-zero — the dashboard will refuse to start without an auth provider"
else
  fail "$PROJECT_DIR/scripts/setup-hermes-dashboard-auth.sh missing"
fi

# ── 2c. Register the ClawBox MCP server with Hermes. ────────────────────────
# Without this the agent on a Hermes box has no device tools at all: the only
# thing that ever registered the MCP was scripts/gateway-pre-start.sh, an
# ExecStartPre of the gateway unit this SKU masks in §4b below. Runs as the
# clawbox user, which owns ~/.hermes/config.yaml (0600).
#
# production-server.js runs the same script on every web-server boot, so a
# device also repairs itself after a restart or an update without a reinstall.
# Both paths are idempotent.
if [ -f "$PROJECT_DIR/scripts/register-mcp.sh" ]; then
  log "registering the ClawBox MCP server with Hermes"
  runuser -u "$CLAWBOX_USER" -- env CLAWBOX_ROOT="$PROJECT_DIR" CLAWBOX_EDITION="$EDITION" \
    bash "$PROJECT_DIR/scripts/register-mcp.sh" \
    || fail "MCP registration returned non-zero — the agent will have no device tools"
else
  fail "$PROJECT_DIR/scripts/register-mcp.sh missing"
fi

# ── 3. Install + enable the Hermes dashboard + auth-proxy services. ─────────
for unit in clawbox-hermes-dashboard clawbox-hermes-dashboard-proxy; do
  src="$PROJECT_DIR/config/$unit.service"
  if [ -f "$src" ]; then
    install -m 644 -o root -g root "$src" "/etc/systemd/system/$unit.service"
    log "installed $unit.service"
  else
    fail "$src missing"
  fi
done

# ── 4. Bake the edition lock into ROOT-OWNED records. ───────────────────────
# /etc/clawbox/edition.env is the authority (clawbox-setup.service loads it as
# its LAST EnvironmentFile so it beats the clawbox-writable .env, and
# clawbox-root-update@.service loads it so the in-app updater sees the SKU).
# The systemd drop-in is kept in sync for boxes/tooling that still read it.
#
# Note this writes $EDITION, not a hardcoded "hermes": doing the latter on a
# dual box would silently downgrade the premium SKU.
install -d -o root -g root -m 0755 /etc/clawbox
printf '# ClawBox edition lock — written by setup-hermes-edition.sh.\n# Root-owned on purpose: this is the authority for the device SKU.\nCLAWBOX_EDITION=%s\n' \
  "$EDITION" > "$EDITION_FILE"
chown root:root "$EDITION_FILE"
chmod 0644 "$EDITION_FILE"
mkdir -p /etc/systemd/system/clawbox-setup.service.d
printf '[Service]\nEnvironment=CLAWBOX_EDITION=%s\n' "$EDITION" > "$EDITION_DROPIN"
log "wrote edition lock (CLAWBOX_EDITION=$EDITION)"

systemctl daemon-reload

# ── 4b. Hermes SKU only: remove the OpenClaw gateway. ───────────────────────
# It is an UNAUTHENTICATED agent control surface on 0.0.0.0:18789 and has no
# role on this SKU. Disable alone is not enough — config/clawbox-sudoers grants
# the clawbox user NOPASSWD `systemctl start clawbox-gateway`, reachable from
# the in-UI terminal, SSH and the agent's run_command — so mask it too. `mask`
# refuses while a real unit file exists in /etc/systemd/system, hence the rm
# first. All steps tolerate the unit never having been installed (fresh flash).
if [ "$EDITION" = "hermes" ]; then
  systemctl stop clawbox-gateway.service >/dev/null 2>&1 || true
  systemctl disable clawbox-gateway.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/clawbox-gateway.service
  rm -rf /etc/systemd/system/clawbox-gateway.service.d
  systemctl daemon-reload
  systemctl mask clawbox-gateway.service >/dev/null 2>&1 || true
  if [ "$(systemctl is-active clawbox-gateway.service 2>/dev/null || true)" = "active" ]; then
    fail "clawbox-gateway.service is still ACTIVE after disable+mask"
  else
    log "clawbox-gateway.service stopped, disabled and masked"
  fi
fi

# ── 5. (Re)start the Hermes services. ───────────────────────────────────────
systemctl enable clawbox-hermes-dashboard.service clawbox-hermes-dashboard-proxy.service >/dev/null 2>&1 \
  || fail "could not enable the Hermes dashboard units"
systemctl restart clawbox-hermes-dashboard.service || fail "dashboard start failed"
systemctl restart clawbox-hermes-dashboard-proxy.service || fail "proxy start failed"
# Deliberately NOT restarting clawbox-setup here. The web server resolves the
# edition per request straight from /etc/clawbox/edition.env
# (src/lib/edition-source.ts, mtime-cached), so the lock written above is live
# the moment this script finishes — while a restart would be actively harmful
# when this runs from install.sh's post_update: it would kill the very web
# server the in-app updater is polling for progress, mid-update.

if [ "$FAILURES" -gt 0 ]; then
  log "FINISHED WITH $FAILURES ERROR(S) — Hermes is not fully provisioned."
  log "Re-run:  sudo bash $PROJECT_DIR/install.sh --step hermes_edition"
  exit 1
fi

log "done — device is provisioned for the $EDITION edition"
