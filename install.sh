#!/usr/bin/env bash
# ClawBox Installer — sets up everything from a fresh NVIDIA Jetson to a
# working setup wizard accessible at http://clawbox.local/ via WiFi hotspot.
#
# Usage: sudo bash install.sh
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/ID-Robots/clawbox.git"
REPO_BRANCH="main"
PROJECT_DIR="/home/clawbox/clawbox"
CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/clawbox"
BUN="$CLAWBOX_HOME/.bun/bin/bun"
NPM_PREFIX="$CLAWBOX_HOME/.npm-global"
OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"
GATEWAY_DIST="$NPM_PREFIX/lib/node_modules/openclaw/dist"
DNSMASQ_DIR="/etc/NetworkManager/dnsmasq-shared.d"
AVAHI_CONF="/etc/avahi/avahi-daemon.conf"
TOTAL_STEPS=14

step=0
log() {
  step=$((step + 1))
  echo ""
  echo "[$step/$TOTAL_STEPS] $1"
}

# ── Step 1: Root check ──────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo"
  exit 1
fi

echo "=== ClawBox Installer ==="

# ── Step 2: Verify clawbox user ─────────────────────────────────────────────

log "Verifying clawbox user..."
if ! id -u "$CLAWBOX_USER" &>/dev/null; then
  echo "Error: System user '$CLAWBOX_USER' does not exist."
  echo "The default Jetson user should be 'clawbox'. Create it first or rename the default user."
  exit 1
fi
echo "  User '$CLAWBOX_USER' exists (uid=$(id -u "$CLAWBOX_USER"))"

# ── Step 3: System packages ─────────────────────────────────────────────────

log "Installing system packages..."
apt-get update -qq

# Core packages
apt-get install -y -qq git curl network-manager avahi-daemon iptables

# Node.js 22 (required for production server — bun doesn't fire upgrade events)
if node --version 2>/dev/null | grep -q '^v2[2-9]\|^v[3-9]'; then
  echo "  Node.js $(node --version) already installed"
else
  echo "  Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
  echo "  Node.js $(node --version) installed"
fi

# ── Step 4: Hostname + mDNS ─────────────────────────────────────────────────

log "Configuring hostname and mDNS..."
hostnamectl set-hostname clawbox

if [ -f "$AVAHI_CONF" ]; then
  cp -n "$AVAHI_CONF" "${AVAHI_CONF}.bak" 2>/dev/null || true
  if grep -q '^#host-name=' "$AVAHI_CONF"; then
    sed -i 's/^#host-name=.*/host-name=clawbox/' "$AVAHI_CONF"
  elif grep -q '^host-name=' "$AVAHI_CONF"; then
    sed -i 's/^host-name=.*/host-name=clawbox/' "$AVAHI_CONF"
  elif grep -q '^\[server\]' "$AVAHI_CONF"; then
    sed -i '/^\[server\]/a host-name=clawbox' "$AVAHI_CONF"
  else
    printf '\n[server]\nhost-name=clawbox\n' >> "$AVAHI_CONF"
  fi
  systemctl restart avahi-daemon
  echo "  Hostname set to 'clawbox', avahi restarted"
else
  echo "  Warning: $AVAHI_CONF not found, skipping avahi configuration"
fi

# ── Step 5: Clone or update repository ───────────────────────────────────────

log "Setting up ClawBox repository..."
if [ ! -d "$PROJECT_DIR/.git" ]; then
  echo "  Cloning from $REPO_URL (branch: $REPO_BRANCH)..."
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
else
  echo "  Repository exists, pulling latest..."
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" fetch origin
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$REPO_BRANCH" 2>/dev/null || true
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" pull --ff-only || echo "  Warning: pull failed (local changes?), continuing with current code"
fi

# ── Step 6: Install bun ─────────────────────────────────────────────────────

log "Ensuring bun is installed..."
if [ -x "$BUN" ]; then
  echo "  Bun already installed at $BUN"
else
  echo "  Installing bun..."
  sudo -u "$CLAWBOX_USER" bash -o pipefail -c 'curl -fsSL https://bun.sh/install | bash' || {
    echo "Error: Bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash"
    exit 1
  }
fi

# ── Step 7: Build ClawBox ───────────────────────────────────────────────────

log "Building ClawBox..."
cd "$PROJECT_DIR"
sudo -u "$CLAWBOX_USER" "$BUN" install
sudo -u "$CLAWBOX_USER" "$BUN" run build

if [ ! -f "$PROJECT_DIR/.next/standalone/server.js" ]; then
  echo "Error: Build failed — .next/standalone/server.js not found"
  exit 1
fi
echo "  Build complete"

# ── Step 8: Install OpenClaw ────────────────────────────────────────────────

log "Installing OpenClaw..."
mkdir -p "$NPM_PREFIX"
chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$NPM_PREFIX"
npm install -g openclaw --prefix "$NPM_PREFIX"

if [ ! -x "$OPENCLAW_BIN" ]; then
  echo "Error: OpenClaw installation failed — $OPENCLAW_BIN not found"
  exit 1
fi
echo "  OpenClaw installed: $($OPENCLAW_BIN --version 2>/dev/null || echo 'unknown version')"

# ── Step 9: Patch OpenClaw gateway ──────────────────────────────────────────

log "Patching OpenClaw gateway for ClawBox..."

# 9a. Enable insecure auth so Control UI works over plain HTTP
sudo -u "$CLAWBOX_USER" "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json
echo "  allowInsecureAuth enabled"

# 9b. Patch gateway JS to preserve operator scopes for token-only auth
# Use whitespace-tolerant regex to handle formatting variations
SCOPE_FILES=$(grep -Prl 'if\s*\(\s*scopes\.length\s*>\s*0\s*\)\s*\{' "$GATEWAY_DIST" 2>/dev/null || true)
if [ -n "$SCOPE_FILES" ]; then
  for file in $SCOPE_FILES; do
    sed -i -E 's/if[[:space:]]*\([[:space:]]*scopes\.length[[:space:]]*>[[:space:]]*0[[:space:]]*\)[[:space:]]*\{/if (scopes.length > 0 \&\& !(isControlUi \&\& allowControlUiBypass)) {/g' "$file"
  done
  echo "  Gateway scope patch applied"
  # Verify the patch was applied correctly
  VERIFY=$(grep -rl 'if (scopes.length > 0 && !(isControlUi && allowControlUiBypass)) {' "$GATEWAY_DIST" 2>/dev/null || true)
  if [ -z "$VERIFY" ]; then
    echo "Error: Gateway scope patch verification failed — patched pattern not found in any file"
    exit 1
  fi
  echo "  Gateway scope patch verified"
else
  # Check if already patched
  ALREADY_PATCHED=$(grep -rl 'isControlUi && allowControlUiBypass' "$GATEWAY_DIST" 2>/dev/null || true)
  if [ -n "$ALREADY_PATCHED" ]; then
    echo "  Gateway scope patch: already applied"
  else
    echo "Error: Gateway scope patch: pattern not found and patch not already applied"
    exit 1
  fi
fi

# Fix ownership of openclaw config files
chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.openclaw" 2>/dev/null || true

# ── Step 10: Captive portal DNS ─────────────────────────────────────────────

log "Configuring captive portal DNS..."
mkdir -p "$DNSMASQ_DIR"
cp "$PROJECT_DIR/config/dnsmasq-captive.conf" "$DNSMASQ_DIR/captive-portal.conf"
echo "  Installed $DNSMASQ_DIR/captive-portal.conf"

# ── Step 11: Directories + permissions ──────────────────────────────────────

log "Setting up directories and permissions..."
mkdir -p "$PROJECT_DIR/data"
chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data"
find "$PROJECT_DIR/scripts" -name "*.sh" -exec chmod +x {} +
echo "  Done"

# ── Step 12: Systemd services ───────────────────────────────────────────────

log "Installing systemd services..."
for svc in clawbox-ap.service clawbox-setup.service clawbox-gateway.service "clawbox-root-update@.service"; do
  src="$PROJECT_DIR/config/$svc"
  if [ ! -f "$src" ]; then
    echo "Error: Service file not found: $src"
    exit 1
  fi
  cp "$src" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable clawbox-ap.service
systemctl enable clawbox-setup.service
systemctl enable clawbox-gateway.service
echo "  Services installed and enabled"

# ── Step 13: Polkit rules for root updates ──────────────────────────────────

log "Installing polkit rules..."
# polkit 0.105 uses .pkla files in localauthority, not JavaScript .rules
POLKIT_PKLA_DIR="/etc/polkit-1/localauthority/50-local.d"
mkdir -p "$POLKIT_PKLA_DIR"
cp "$PROJECT_DIR/config/49-clawbox-updates.pkla" "$POLKIT_PKLA_DIR/"
# Clean up old .rules file if present (wrong format for polkit 0.105)
rm -f /etc/polkit-1/rules.d/49-clawbox-updates.rules
echo "  Polkit rule installed (allows clawbox to trigger root update steps)"

# ── Step 14: Start services ─────────────────────────────────────────────────

log "Starting services..."
systemctl restart clawbox-ap.service 2>/dev/null || systemctl start clawbox-ap.service
systemctl restart clawbox-setup.service 2>/dev/null || systemctl start clawbox-setup.service
systemctl restart clawbox-gateway.service 2>/dev/null || systemctl start clawbox-gateway.service
echo "  Services started"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "=== ClawBox Setup Complete ==="
echo ""
echo "  WiFi AP:    ClawBox-Setup (open network)"
echo "  Dashboard:  http://clawbox.local  or  http://10.42.0.1"
echo ""
echo "  Services:"
echo "    systemctl status clawbox-ap"
echo "    systemctl status clawbox-setup"
echo ""
