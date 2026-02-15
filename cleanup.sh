#!/bin/bash
# ClawBox cleanup script — removes all installed components except hostname/avahi.
# Usage: sudo bash cleanup.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo"
  exit 1
fi

echo "=== ClawBox Cleanup ==="

# 1. Stop and disable systemd services
echo ""
echo "[1/7] Stopping and disabling systemd services..."
for svc in clawbox-setup.service clawbox-gateway.service clawbox-ap.service; do
  systemctl stop "$svc" 2>/dev/null || true
  systemctl disable "$svc" 2>/dev/null || true
done
rm -f /etc/systemd/system/clawbox-setup.service \
      /etc/systemd/system/clawbox-ap.service \
      /etc/systemd/system/clawbox-gateway.service
# Keep clawbox-root-update@.service — factory reset runs via this service
# and removing it mid-run causes systemd to kill the process with a short timeout.
# install.sh will reinstall it anyway.
systemctl daemon-reload
echo "  Done"

# 2. Remove polkit rules
echo ""
echo "[2/7] Removing polkit rules..."
rm -f /etc/polkit-1/rules.d/49-clawbox-updates.rules
# Keep polkit pkla — needed by the running root-update service and install.sh
# install.sh will reinstall it anyway.
echo "  Done"

# 3. Remove dnsmasq captive portal config
echo ""
echo "[3/7] Removing captive portal DNS config..."
rm -f /etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf
echo "  Done"

# 4. Remove OpenClaw installation
echo ""
echo "[4/7] Removing OpenClaw (~/.npm-global)..."
rm -rf /home/clawbox/.npm-global
echo "  Done"

# 5. Remove OpenClaw config
echo ""
echo "[5/7] Removing OpenClaw config (~/.openclaw)..."
rm -rf /home/clawbox/.openclaw
echo "  Done"

# 6. Remove ClawBox build artifacts and data
echo ""
echo "[6/7] Removing build artifacts and data..."
rm -rf /home/clawbox/clawbox/.next
rm -rf /home/clawbox/clawbox/node_modules
rm -rf /home/clawbox/clawbox/data
echo "  Done"

# 7. Remove bun
echo ""
echo "[7/7] Removing bun (~/.bun)..."
rm -rf /home/clawbox/.bun
echo "  Done"

echo ""
echo "=== Cleanup Complete ==="
echo ""
echo "  Kept: hostname (clawbox), avahi/mDNS config, git repo source code"
echo "  To reinstall: sudo bash install.sh"
echo ""
