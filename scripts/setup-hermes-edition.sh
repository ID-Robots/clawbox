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
# Lower-case, and strip the quotes and whitespace an EnvironmentFile value may
# carry, so a lock reading `CLAWBOX_EDITION="Hermes"` compares equal to `hermes`.
_norm() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d "[:space:]\"'"; }

# An unrecognised RECORDED value describes an openclaw device everywhere else
# (install.sh's _normalise_edition applies exactly this rule), so map it the same
# way. Treating it as *absent* instead would be the dangerous reading: it would
# clear the refusal and let a typo'd lock be provisioned straight over.
_norm_recorded() {
  local v
  v="$(_norm "${1:-}")"
  case "$v" in
    openclaw|hermes|dual|"") printf '%s' "$v" ;;
    *) printf 'openclaw' ;;
  esac
}

# Read `CLAWBOX_EDITION=x` from an EnvironmentFile or `Environment=CLAWBOX_EDITION=x`
# from a systemd drop-in — same two shapes install.sh's _read_edition_from_file
# accepts.
_read_edition_file() {
  [ -f "$1" ] || return 0
  sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\(Environment=\)\{0,1\}"\{0,1\}CLAWBOX_EDITION[[:space:]]*=[[:space:]]*//p' \
    "$1" 2>/dev/null | tail -n 1
}

# Root-owned records, in authority order. The legacy drop-in matters: on a device
# provisioned before /etc/clawbox/edition.env existed it is the ONLY durable
# record, so reading just the new file would leave that whole part of the fleet
# able to bypass the refusal below.
_recorded_raw="$(_read_edition_file "$EDITION_FILE")"
if [ -z "$_recorded_raw" ]; then
  _recorded_raw="$(_read_edition_file "$EDITION_DROPIN")"
fi
RECORDED_EDITION="$(_norm_recorded "$_recorded_raw")"
REQUESTED_EDITION="$(_norm "${CLAWBOX_EDITION:-}")"

# This script is the OTHER writer of the edition lock (§4 below rewrites both
# /etc/clawbox/edition.env and the legacy drop-in). install.sh refuses to change
# a provisioned device's edition; without the same refusal here, `sudo
# CLAWBOX_EDITION=dual bash scripts/setup-hermes-edition.sh` would rewrite the
# lock on a hermes box and a later plain `install.sh` would then see recorded ==
# requested, find no mismatch, and unmask and start the OpenClaw gateway on what
# the customer bought as a Hermes appliance. Refusing at BOTH writers is what
# makes the lock mean anything.
#
# Only a genuine disagreement is refused: no lock yet (first flash) or no
# CLAWBOX_EDITION passed (the normal standalone repair run) are untouched, and
# so is install.sh's own call — it runs step_edition_lock before
# step_hermes_edition, so the two always agree by then.
if [ -n "$RECORDED_EDITION" ] && [ -n "$REQUESTED_EDITION" ] \
   && [ "$RECORDED_EDITION" != "$REQUESTED_EDITION" ]; then
  if [ "${CLAWBOX_ALLOW_EDITION_CHANGE:-0}" = "1" ]; then
    log "WARNING: CLAWBOX_ALLOW_EDITION_CHANGE=1 — provisioning '$REQUESTED_EDITION' over '$RECORDED_EDITION'."
    log "         The '$RECORDED_EDITION' harness is NOT torn down and credentials are not migrated."
  else
    cat >&2 <<EOF
[hermes-edition] ERROR: this device is already installed as the '$RECORDED_EDITION' edition.

         Recorded edition:  $RECORDED_EDITION   ($EDITION_FILE)
         Requested edition: $REQUESTED_EDITION

       Provisioning would rewrite the edition lock, and neither this script nor
       install.sh migrates a device between editions — the harness being left
       behind keeps running and the AI provider sign-in does not move with it.
       Changing a device's edition requires a reflash.
       See https://docs.clawbox.com/editions/overview

       Nothing has been changed. Drop CLAWBOX_EDITION to provision the edition
       this device already is, or pass CLAWBOX_EDITION=$RECORDED_EDITION.
       To overwrite it anyway, re-run with CLAWBOX_ALLOW_EDITION_CHANGE=1.
EOF
    exit 1
  fi
fi

# An explicit request wins once it agrees with the lock (or the escape hatch was
# used); otherwise fall back to the lock, then to this script's historical
# default.
EDITION="$REQUESTED_EDITION"
[ -n "$EDITION" ] || EDITION="$RECORDED_EDITION"
[ -n "$EDITION" ] || EDITION="hermes"
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
# HOME is passed EXPLICITLY to every runuser call below, and must stay that way.
# All three scripts resolve their state from `$HOME` (`${HOME:-/home/clawbox}`),
# so the user they run as is not enough — the variable has to be right too.
# `runuser` does reset HOME for the target user today, but that is a property of
# util-linux we would be silently depending on: this script runs as root from
# install.sh (HOME=/root), and if HOME ever survived, setup-hermes-dashboard-auth
# would look for /root/.hermes/config.yaml, find no credentials to verify, and
# mint a fresh password — desyncing it from the one the proxy already holds.
# Passing HOME makes that impossible rather than merely unlikely.
if [ -f "$PROJECT_DIR/scripts/setup-shared-identity.sh" ]; then
  log "seeding shared identity"
  runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" \
    bash "$PROJECT_DIR/scripts/setup-shared-identity.sh" \
    || fail "shared-identity setup returned non-zero"
fi

# ── 2b. Dashboard password provider (gated-mode auth) ───────────────────────
# Runs as the clawbox user (owns ~/.hermes/config.yaml). The dashboard binds a
# non-loopback host (127.0.0.2) and therefore REQUIRES an auth provider; the
# proxy uses this password to sign the user in transparently.
if [ -f "$PROJECT_DIR/scripts/setup-hermes-dashboard-auth.sh" ]; then
  log "configuring dashboard password auth"
  runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" CLAWBOX_ROOT="$PROJECT_DIR" \
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
  runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" CLAWBOX_ROOT="$PROJECT_DIR" \
    CLAWBOX_EDITION="$EDITION" \
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
