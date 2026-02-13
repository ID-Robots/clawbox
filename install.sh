#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/clawbox/clawbox"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo"
  exit 1
fi

echo "=== ClawBox Setup Installer ==="
echo ""

# 1. Set hostname
echo "[1/6] Setting hostname to 'clawbox'..."
hostnamectl set-hostname clawbox

# 2. Configure avahi for clawbox.local mDNS
echo "[2/6] Configuring avahi (clawbox.local)..."
AVAHI_CONF="/etc/avahi/avahi-daemon.conf"
if grep -q '^#host-name=' "$AVAHI_CONF"; then
  sed -i 's/^#host-name=.*/host-name=clawbox/' "$AVAHI_CONF"
elif grep -q '^host-name=' "$AVAHI_CONF"; then
  sed -i 's/^host-name=.*/host-name=clawbox/' "$AVAHI_CONF"
else
  sed -i '/^\[server\]/a host-name=clawbox' "$AVAHI_CONF"
fi
systemctl restart avahi-daemon

# 3. Install Node.js dependencies
echo "[3/6] Installing Node.js dependencies..."
cd "$PROJECT_DIR"
sudo -u clawbox npm install --production

# 4. Create data directory and set permissions
echo "[4/6] Setting up directories and permissions..."
mkdir -p "$PROJECT_DIR/data"
chown clawbox:clawbox "$PROJECT_DIR/data"
chmod +x "$PROJECT_DIR/scripts/"*.sh

# 5. Install systemd services
echo "[5/6] Installing systemd services..."
cp "$PROJECT_DIR/config/clawbox-ap.service" /etc/systemd/system/
cp "$PROJECT_DIR/config/clawbox-setup.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable clawbox-ap.service
systemctl enable clawbox-setup.service

# 6. Start services
echo "[6/6] Starting services..."
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
