#!/usr/bin/env bash
# NetworkManager dispatcher: when Ethernet drops, free the WiFi radio from the
# captive-portal AP and bring up a saved WiFi profile so the box keeps internet.
#
# Installed at /etc/NetworkManager/dispatcher.d/90-clawbox-failover by install.sh.
# Args: $1 = interface, $2 = action (up, down, pre-up, etc.)

set -u

NETWORK_READINESS_LIB="/usr/local/libexec/clawbox/network-readiness.sh"
IFACE="${1:-}"
ACTION="${2:-}"
WIFI_IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
AP_PROFILE="ClawBox-Setup"
LOG_TAG="clawbox-failover"

log() { logger -t "$LOG_TAG" -- "$*"; }

if [ ! -r "$NETWORK_READINESS_LIB" ]; then
  log "Network readiness helper is unavailable; leaving the Gateway unchanged"
  exit 0
fi

# NetworkManager runs this dispatcher as root. Never honor test overrides from
# its environment when selecting route/probe commands or destinations.
unset CLAWBOX_IP_BIN CLAWBOX_CURL_BIN CLAWBOX_NETWORK_PROBE_IP CLAWBOX_NETWORK_PROBE_URL
# shellcheck source=/usr/local/libexec/clawbox/network-readiness.sh
source "$NETWORK_READINESS_LIB"

schedule_channel_recovery() {
  systemctl restart clawbox-channel-recovery.timer >/dev/null 2>&1 || \
    log "Could not schedule channel recovery"
}

restart_gateway_on_ready_route() {
  if ! clawbox_network_ready; then
    log "Replacement public route is not ready; leaving clawbox-gateway running"
    return 1
  fi
  if systemctl is-active --quiet clawbox-gateway.service; then
    log "Public route ready — restarting clawbox-gateway to rebind sockets"
    systemctl restart clawbox-gateway.service >/dev/null 2>&1 || {
      log "Gateway restart failed"
      return 1
    }
  fi
  schedule_channel_recovery
}

# Only react to ethernet up/down events.
case "$IFACE" in
  eth*|en*) ;;
  *) exit 0 ;;
esac

# On ethernet UP, restart the gateway so it rebinds to the now-preferred
# interface. Existing sockets bound to the WiFi IP would otherwise be sent
# down Eth as asymmetric traffic and silently fail.
if [ "$ACTION" = "up" ]; then
  log "Ethernet '$IFACE' up — checking replacement route before Gateway restart"
  restart_gateway_on_ready_route || true
  exit 0
fi

# Below: handle ethernet DOWN — failover to WiFi and clear stale sockets.
[ "$ACTION" = "down" ] || exit 0

# Confirm there is no other ethernet still up before failing over.
if nmcli -t -f TYPE,STATE device status | grep -q '^ethernet:connected$'; then
  exit 0
fi

log "Ethernet '$IFACE' down — attempting WiFi failover"

# Do not restart the Gateway yet. Starting network-dependent providers without
# a replacement route can turn a short link outage into a process crash loop.

# If the AP is currently active on the WiFi radio, take it down so the radio is free.
if nmcli -t -f NAME,DEVICE connection show --active | grep -qE "^${AP_PROFILE}:${WIFI_IFACE}$"; then
  log "Bringing down AP profile '$AP_PROFILE' to free radio"
  nmcli connection down "$AP_PROFILE" >/dev/null 2>&1 || true
fi

# Already on a real WiFi network? Nothing more to do.
if nmcli -t -f TYPE,STATE,DEVICE device status | grep -qE "^wifi:connected:${WIFI_IFACE}$"; then
  active_wifi=$(nmcli -t -f NAME,TYPE,DEVICE connection show --active | awk -F: -v i="$WIFI_IFACE" -v ap="$AP_PROFILE" '$2=="802-11-wireless" && $3==i && $1!=ap {print $1; exit}')
  if [ -n "$active_wifi" ]; then
    log "Already on WiFi '$active_wifi' — rebinding Gateway on the proven route"
    restart_gateway_on_ready_route || true
    exit 0
  fi
fi

# Try saved WiFi profiles in priority order (skip the AP profile itself).
mapfile -t profiles < <(nmcli -t -f NAME,TYPE,AUTOCONNECT-PRIORITY connection show \
  | awk -F: -v ap="$AP_PROFILE" '$2=="802-11-wireless" && $1!=ap {print $3":"$1}' \
  | sort -t: -k1,1 -nr | cut -d: -f2-)

if [ "${#profiles[@]}" -eq 0 ]; then
  log "No saved WiFi profiles to fail over to"
  exit 0
fi

for profile in "${profiles[@]}"; do
  [ -z "$profile" ] && continue
  log "Trying WiFi profile '$profile'"
  if nmcli connection up "$profile" ifname "$WIFI_IFACE" >/dev/null 2>&1; then
    log "Connected to '$profile' — failover complete"
    restart_gateway_on_ready_route || true
    exit 0
  fi
done

log "Failover failed — no saved WiFi profile would connect; starting hotspot as recovery"

# Stranded recovery: no saved WiFi reachable, so bring the captive-portal
# hotspot back up. start-ap.sh honours the user's configured SSID/password
# and falls back to ClawBox-Setup if none is set.
START_AP="/home/clawbox/clawbox/scripts/start-ap.sh"
if [ -x "$START_AP" ]; then
  bash "$START_AP" >/dev/null 2>&1 &
  log "Recovery AP launch dispatched"
fi
exit 0
