#!/usr/bin/env bash
set -euo pipefail

IFACE="wlP1p1s0"
CON_NAME="ClawBox-Setup"
AP_IP="10.42.0.1"

echo "[AP] Removing iptables captive portal rules..."
iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null || true

echo "[AP] Bringing down access point..."
nmcli connection down "$CON_NAME" 2>/dev/null || true
nmcli connection delete "$CON_NAME" 2>/dev/null || true

echo "[AP] Access point stopped."
