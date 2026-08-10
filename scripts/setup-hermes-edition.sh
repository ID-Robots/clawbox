#!/usr/bin/env bash
# Turn this device into a locked, single-harness HERMES edition. Idempotent —
# safe to re-run. Run as root (install.sh calls it; or `sudo bash` standalone).
#
# It does NOT install the Hermes agent itself — Hermes (`~/.local/bin/hermes`)
# is expected to already be present (provisioned by the image / out-of-band).
# It wires the edition lock, the shared-identity bridge, and the dashboard +
# auth-proxy services, and reloads the web server so the lock takes effect.
set -euo pipefail

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
CLAWBOX_USER="${CLAWBOX_USER:-clawbox}"
CLAWBOX_HOME="$(getent passwd "$CLAWBOX_USER" | cut -d: -f6)"
CLAWBOX_HOME="${CLAWBOX_HOME:-/home/$CLAWBOX_USER}"
HERMES_BIN="${HERMES_BIN:-$CLAWBOX_HOME/.local/bin/hermes}"

log() { echo "[hermes-edition] $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "[hermes-edition] must run as root" >&2
  exit 1
fi

# 1. Sanity: Hermes must be present (this edition runs on it).
if [ ! -x "$HERMES_BIN" ]; then
  log "WARNING: Hermes binary not found/executable at $HERMES_BIN — install Hermes before this edition will work."
fi

# 2. Shared-identity bridge (canonical ~/.clawbox/agent-identity → both harnesses).
if [ -f "$PROJECT_DIR/scripts/setup-shared-identity.sh" ]; then
  log "seeding shared identity"
  runuser -u "$CLAWBOX_USER" -- bash "$PROJECT_DIR/scripts/setup-shared-identity.sh" \
    || log "WARNING: shared-identity setup returned non-zero (non-fatal)"
fi

# 3. Install + enable the Hermes dashboard + auth-proxy services.
for unit in clawbox-hermes-dashboard clawbox-hermes-dashboard-proxy; do
  src="$PROJECT_DIR/config/$unit.service"
  if [ -f "$src" ]; then
    install -m 644 "$src" "/etc/systemd/system/$unit.service"
    log "installed $unit.service"
  else
    log "WARNING: $src missing"
  fi
done

# 4. Bake the edition lock into a root-owned drop-in (NOT the user-editable
#    config.json), so a customer can't flip the harness.
mkdir -p /etc/systemd/system/clawbox-setup.service.d
cat > /etc/systemd/system/clawbox-setup.service.d/edition.conf <<'CONF'
[Service]
Environment=CLAWBOX_EDITION=hermes
CONF
log "wrote edition lock (CLAWBOX_EDITION=hermes)"

# 5. Reload + (re)start everything so the lock + services take effect.
systemctl daemon-reload
systemctl enable clawbox-hermes-dashboard.service clawbox-hermes-dashboard-proxy.service >/dev/null 2>&1 || true
systemctl restart clawbox-hermes-dashboard.service || log "WARNING: dashboard start failed"
systemctl restart clawbox-hermes-dashboard-proxy.service || log "WARNING: proxy start failed"
systemctl restart clawbox-setup.service || log "WARNING: clawbox-setup restart failed"

log "done — device is locked to the Hermes edition"
