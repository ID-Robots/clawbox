#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/clawbox/clawbox"
BUN="/home/clawbox/.bun/bin/bun"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo"
  exit 1
fi

# Verify project directory exists
if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: Project directory '$PROJECT_DIR' does not exist"
  exit 1
fi

echo "=== ClawBox Setup Installer ==="
echo ""

# 1. Set hostname
echo "[1/7] Setting hostname to 'clawbox'..."
hostnamectl set-hostname clawbox

# 2. Configure avahi for clawbox.local mDNS
echo "[2/7] Configuring avahi (clawbox.local)..."
AVAHI_CONF="/etc/avahi/avahi-daemon.conf"
if [ -f "$AVAHI_CONF" ]; then
  cp "$AVAHI_CONF" "${AVAHI_CONF}.bak"
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
else
  echo "Warning: $AVAHI_CONF not found, skipping avahi configuration"
fi

# 3. Install bun if not present
echo "[3/7] Ensuring bun is installed..."
if ! command -v "$BUN" &>/dev/null; then
  # Note: fetches and runs remote installer script. Accepted risk for initial setup.
  sudo -u clawbox bash -c 'curl -fsSL https://bun.sh/install | bash' || {
    echo "Warning: Bun installation failed. Please install manually."
    exit 1
  }
fi

# 4. Install dependencies and build
echo "[4/7] Installing dependencies and building..."
cd "$PROJECT_DIR"
sudo -u clawbox "$BUN" install
sudo -u clawbox "$BUN" run build

# 5. Create data directory and set permissions
echo "[5/7] Setting up directories and permissions..."
mkdir -p "$PROJECT_DIR/data"
chown clawbox:clawbox "$PROJECT_DIR/data"
find "$PROJECT_DIR/scripts" -name "*.sh" -exec chmod +x {} +

# 6. Install systemd services
echo "[6/7] Installing systemd services..."
for svc in clawbox-ap.service clawbox-setup.service; do
  src="$PROJECT_DIR/config/$svc"
  if [ ! -f "$src" ]; then
    echo "Error: Service file not found: $src"
    exit 1
  fi
  cp "$src" /etc/systemd/system/ || { echo "Error: Failed to copy $svc"; exit 1; }
done
systemctl daemon-reload
systemctl enable clawbox-ap.service || { echo "Error: Failed to enable clawbox-ap.service"; exit 1; }
systemctl enable clawbox-setup.service || { echo "Error: Failed to enable clawbox-setup.service"; exit 1; }

# 7. Start services
echo "[7/7] Starting services..."
systemctl start clawbox-ap.service
systemctl start clawbox-setup.service

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
