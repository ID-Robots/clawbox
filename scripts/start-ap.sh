#!/usr/bin/env bash
set -euo pipefail

IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
CON_NAME="ClawBox-Setup"
SSID="ClawBox-Setup"
AP_IP="10.42.0.1"
IFACE_TIMEOUT="${IFACE_TIMEOUT:-10}"

wait_for_interface() {
  local elapsed=0
  while [ "$elapsed" -lt "$IFACE_TIMEOUT" ]; do
    if [ -e "/sys/class/net/$IFACE/operstate" ]; then
      local state
      state=$(cat "/sys/class/net/$IFACE/operstate")
      if [ "$state" = "up" ] || [ "$state" = "unknown" ]; then
        echo "[AP] Interface $IFACE is ready (state=$state)"
        return 0
      fi
      echo "[AP] Interface $IFACE state=$state (elapsed=${elapsed}s)"
    else
      echo "[AP] Interface $IFACE operstate file not found (elapsed=${elapsed}s)"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[AP] Warning: Interface $IFACE not ready after ${IFACE_TIMEOUT}s timeout"
  return 1
}

echo "[AP] Cleaning up any previous AP connection..."
nmcli connection down "$CON_NAME" 2>/dev/null || true
nmcli connection delete "$CON_NAME" 2>/dev/null || true

echo "[AP] Creating WiFi access point: $SSID"
nmcli connection add \
  type wifi \
  ifname "$IFACE" \
  con-name "$CON_NAME" \
  ssid "$SSID" \
  autoconnect no \
  wifi.mode ap \
  wifi.band bg \
  wifi.channel 6 \
  ipv4.method shared \
  ipv4.addresses "${AP_IP}/24"

# Remove any security settings to make it an open network
nmcli connection modify "$CON_NAME" remove 802-11-wireless-security 2>/dev/null || true

echo "[AP] Activating access point..."
nmcli connection up "$CON_NAME"

# Wait for interface readiness instead of fixed sleep
wait_for_interface || echo "[AP] Continuing despite interface timeout"

# DNS hijack is handled by NM's built-in dnsmasq via
# /etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf
# which resolves all queries to 10.42.0.1

echo "[AP] Setting up iptables captive portal rules..."
# Check if rule already exists before adding to avoid duplicates
if ! iptables -w 5 -t nat -C PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null; then
  iptables -w 5 -t nat -A PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80"
fi

echo "[AP] WiFi access point '$SSID' is running on $IFACE ($AP_IP)"
