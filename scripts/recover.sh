#!/usr/bin/env bash
set -euo pipefail

echo "[Recovery] Starting ClawBox recovery..."

# Restart the WiFi access point
echo "[Recovery] Restarting WiFi hotspot..."
bash /home/clawbox/clawbox/scripts/start-ap.sh

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
