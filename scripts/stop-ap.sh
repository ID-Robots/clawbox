#!/usr/bin/env bash
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/wifi-radio.sh"
wifi_lock
# Never race the root service's abandoned snapshot from an unprivileged caller.
if [ "$EUID" -eq 0 ]; then wifi_recover; else [ ! -e "$RADIO_SNAPSHOT" ]; fi
IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
AP_IP="10.42.0.1"

echo "[AP] Removing iptables captive portal rules..."
iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null || true

echo "[AP] Bringing down access point..."
wifi_stop_ap

echo "[AP] Access point stopped."
