#!/usr/bin/env bash
set -euo pipefail

echo "[Recovery] Starting ClawBox recovery..."

# Restart the WiFi access point.
#
# This runs as root (it is the operator's console recovery), so it prefers the
# root-owned copy install_root_libexec installs — the tree under
# /home/clawbox/clawbox is clawbox-writable. The tree copy is the fallback ONLY
# when the libexec one is absent: recovery has to work on a box mid-migration
# that has the new tree and not yet the new root step, and a box that cannot
# raise its hotspot is a box nobody can reach. Security scan #21.
echo "[Recovery] Restarting WiFi hotspot..."
START_AP="/usr/local/libexec/clawbox/start-ap.sh"
if [ ! -x "$START_AP" ]; then
  echo "[Recovery] $START_AP missing — falling back to the tree copy (run 'sudo bash /home/clawbox/clawbox/install.sh --step systemd_services' to install it)"
  START_AP="/home/clawbox/clawbox/scripts/start-ap.sh"
fi
bash "$START_AP"

# Restart the web server
echo "[Recovery] Restarting web server..."
systemctl restart clawbox-setup.service

# Verify
sleep 2
AP_STATE=$(iw dev "${NETWORK_INTERFACE:-wlP1p1s0}" info 2>/dev/null | grep "type AP" && echo "UP" || echo "DOWN")
WEB_STATE=$(systemctl is-active clawbox-setup.service 2>/dev/null || echo "inactive")

echo ""
echo "[Recovery] Status:"
echo "  Hotspot: $AP_STATE"
echo "  Web server: $WEB_STATE"

if [ "$AP_STATE" = "UP" ] && [ "$WEB_STATE" = "active" ]; then
  echo "[Recovery] All systems recovered."
else
  echo "[Recovery] Warning: some services may not have started correctly."
fi
