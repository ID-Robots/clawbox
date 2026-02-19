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

# Configure dnsmasq upstream DNS before activating AP
# (NetworkManager's shared mode starts dnsmasq which reads this config)
rm -f "$CAPTIVE_CONF" 2>/dev/null || true
if [ -w "$DNSMASQ_SHARED" ]; then
  cat > "$DNSMASQ_SHARED/upstream-dns.conf" <<DNSEOF
# Forward DNS queries to public resolvers
server=8.8.8.8
server=8.8.4.4
server=1.1.1.1
# Resolve clawbox.local to AP IP (mDNS doesn't work on hotspot)
address=/clawbox.local/${AP_IP}
DNSEOF
  echo "[AP] Upstream DNS forwarding configured"
else
  echo "[AP] Note: dnsmasq config not writable (run install.sh to fix DNS)"
fi

echo "[AP] Activating access point..."
nmcli connection up "$CON_NAME"

# Wait for interface readiness instead of fixed sleep
wait_for_interface || echo "[AP] Continuing despite interface timeout"

# Remove any leftover captive portal iptables redirect
iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null || true

# Enable IP forwarding and NAT masquerade for internet sharing
sysctl -w net.ipv4.ip_forward=1 >/dev/null

# Find the WAN interface (first connected ethernet)
WAN_IFACE=$(nmcli -t -f DEVICE,TYPE,STATE device status | awk -F: '/ethernet:connected/{print $1; exit}')
if [ -n "$WAN_IFACE" ]; then
  # Ensure MASQUERADE rule exists for hotspot -> internet NAT
  if ! iptables -t nat -C POSTROUTING -o "$WAN_IFACE" -j MASQUERADE 2>/dev/null; then
    iptables -t nat -A POSTROUTING -o "$WAN_IFACE" -j MASQUERADE
  fi
  # Allow forwarding between hotspot and WAN
  if ! iptables -C FORWARD -i "$IFACE" -o "$WAN_IFACE" -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -i "$IFACE" -o "$WAN_IFACE" -j ACCEPT
  fi
  if ! iptables -C FORWARD -i "$WAN_IFACE" -o "$IFACE" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -i "$WAN_IFACE" -o "$IFACE" -m state --state RELATED,ESTABLISHED -j ACCEPT
  fi
  echo "[AP] NAT masquerade enabled ($IFACE -> $WAN_IFACE)"
else
  echo "[AP] Warning: no WAN interface found, internet sharing unavailable"
fi

echo "[AP] Internet sharing active — access setup at http://${AP_IP}/setup"

echo "[AP] WiFi access point '$SSID' is running on $IFACE ($AP_IP)"
