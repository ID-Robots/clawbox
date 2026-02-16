#!/usr/bin/env bash
set -euo pipefail

IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
AP_IP="10.42.0.1"
IFACE_TIMEOUT="${IFACE_TIMEOUT:-10}"
CONFIG_FILE="/home/clawbox/clawbox/data/config.json"
DNSMASQ_SHARED="/etc/NetworkManager/dnsmasq-shared.d"
CAPTIVE_CONF="$DNSMASQ_SHARED/captive-portal.conf"

# Read hotspot config if available
HOTSPOT_ENV="/home/clawbox/clawbox/data/hotspot.env"
if [ -f "$HOTSPOT_ENV" ]; then
  # shellcheck source=/dev/null
  source "$HOTSPOT_ENV"
fi
SSID="${HOTSPOT_SSID:-ClawBox-Setup}"
CON_NAME="ClawBox-Setup"

# Check if setup is complete (phone should get internet, not captive portal)
setup_complete=false
if [ -f "$CONFIG_FILE" ] && command -v node &>/dev/null; then
  if node -e "process.exit(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).setup_complete?0:1)" 2>/dev/null; then
    setup_complete=true
  fi
fi

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

# Configure security: WPA-PSK if password set, open network otherwise
if [ -n "${HOTSPOT_PASSWORD:-}" ]; then
  nmcli connection modify "$CON_NAME" \
    802-11-wireless-security.key-mgmt wpa-psk \
    802-11-wireless-security.psk "$HOTSPOT_PASSWORD"
  echo "[AP] WPA-PSK security enabled"
else
  nmcli connection modify "$CON_NAME" remove 802-11-wireless-security 2>/dev/null || true
  echo "[AP] Open network (no password)"
fi

echo "[AP] Activating access point..."
nmcli connection up "$CON_NAME"

# Wait for interface readiness instead of fixed sleep
wait_for_interface || echo "[AP] Continuing despite interface timeout"

if [ "$setup_complete" = true ]; then
  # ── Internet-sharing mode ────────────────────────────────────────────────
  # Remove captive portal DNS hijack so phones can resolve real domains
  rm -f "$CAPTIVE_CONF"
  echo "[AP] Captive portal DNS removed (internet-sharing mode)"

  # Remove any leftover captive portal iptables redirect
  iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null || true

  # Enable IP forwarding (ipv4.method shared usually handles this, but be explicit)
  sysctl -w net.ipv4.ip_forward=1 >/dev/null

  echo "[AP] Internet sharing active — phones will get internet via NAT"
else
  # ── Captive portal mode ──────────────────────────────────────────────────
  # Install DNS hijack so all queries resolve to the setup wizard
  mkdir -p "$DNSMASQ_SHARED"
  echo "address=/#/${AP_IP}" > "$CAPTIVE_CONF"
  echo "[AP] Captive portal DNS installed"

  # Redirect HTTP to the setup wizard
  if ! iptables -w 5 -t nat -C PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null; then
    iptables -w 5 -t nat -A PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80"
  fi
  echo "[AP] Captive portal iptables rules active"
fi

echo "[AP] WiFi access point '$SSID' is running on $IFACE ($AP_IP)"
