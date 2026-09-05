#!/usr/bin/env bash
# NetworkManager dispatcher: when Ethernet drops, free the WiFi radio from the
# captive-portal AP and bring up a saved WiFi profile so the box keeps internet.
#
# Installed at /etc/NetworkManager/dispatcher.d/90-clawbox-failover by install.sh.
# Args: $1 = interface, $2 = action (up, down, pre-up, etc.)

set -u

IFACE="${1:-}"
ACTION="${2:-}"
WIFI_IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
AP_PROFILE="ClawBox-Setup"
LOG_TAG="clawbox-failover"
CLAWBOX_ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"

log() { logger -t "$LOG_TAG" -- "$*"; }

# Hand the gateway restart to the waiter, DETACHED.
#
# The restart is never immediate any more (GH #529): a gateway bounced into a
# network with no route loses its Telegram accounts to the account supervisor,
# which gives up after its restart budget and leaves them stopped for the life
# of the process — with no CLI verb to start them again. The waiter defers the
# restart until a public route is proven, and a restart that lands then is also
# what revives the suppressed accounts. See scripts/gateway-restart-when-online.sh.
#
# Detached because NetworkManager runs dispatcher scripts serially and kills a
# slow one: this script must return at once, and the waiting must not happen in
# it. The waiter takes its own lock, so overlapping events do not stack.
restart_gateway_when_online() {
  local waiter="$CLAWBOX_ROOT/scripts/gateway-restart-when-online.sh"
  if [ ! -x "$waiter" ]; then
    log "WARN: $waiter missing — gateway not restarted for: $1"
    return
  fi
  setsid nohup bash "$waiter" "$1" >/dev/null 2>&1 &
}

# React to ethernet up/down, and to the WiFi radio coming up.
#
# The WiFi arm is the recovery half: after a failover the box's route comes back
# on the wireless interface, and with only the ethernet arm nothing ever asked
# for the restart that revives the channel accounts.
case "$IFACE" in
  eth*|en*) ;;
  "$WIFI_IFACE")
    if [ "$ACTION" = "up" ]; then
      restart_gateway_when_online "WiFi '$IFACE' up"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac

# On ethernet UP, restart the gateway so it rebinds to the now-preferred
# interface. Existing sockets bound to the WiFi IP would otherwise be sent
# down Eth as asymmetric traffic and silently fail.
if [ "$ACTION" = "up" ]; then
  # Carrier is not a route: at `up` the interface may still be waiting on DHCP,
  # and a restart there is the same mistake as the one below.
  restart_gateway_when_online "Ethernet '$IFACE' up"
  exit 0
fi

# Below: handle ethernet DOWN — failover to WiFi and clear stale sockets.
[ "$ACTION" = "down" ] || exit 0

# Confirm there is no other ethernet still up before failing over.
if nmcli -t -f TYPE,STATE device status | grep -q '^ethernet:connected$'; then
  exit 0
fi

log "Ethernet '$IFACE' down — attempting WiFi failover"

# Kill TCP sockets the OpenClaw gateway holds bound to the now-dead interface
# IPs. HTTP/2 keep-alives to OpenAI/Anthropic/Telegram look ESTABLISHED but
# silently blackhole until TCP times out (~120s). A service restart drops them
# and forces fresh connections on the surviving interface.
#
# Requested here and performed only once a route exists. Those sockets are
# already dead either way, so nothing is lost by waiting — while restarting
# into a dead network costs both Telegram accounts until someone notices.
restart_gateway_when_online "Ethernet '$IFACE' down"

# If the AP is currently active on the WiFi radio, take it down so the radio is free.
if nmcli -t -f NAME,DEVICE connection show --active | grep -qE "^${AP_PROFILE}:${WIFI_IFACE}$"; then
  log "Bringing down AP profile '$AP_PROFILE' to free radio"
  nmcli connection down "$AP_PROFILE" >/dev/null 2>&1 || true
fi

# Already on a real WiFi network? Nothing more to do.
if nmcli -t -f TYPE,STATE,DEVICE device status | grep -qE "^wifi:connected:${WIFI_IFACE}$"; then
  active_wifi=$(nmcli -t -f NAME,TYPE,DEVICE connection show --active | awk -F: -v i="$WIFI_IFACE" -v ap="$AP_PROFILE" '$2=="802-11-wireless" && $3==i && $1!=ap {print $1; exit}')
  if [ -n "$active_wifi" ]; then
    log "Already on WiFi '$active_wifi' — no failover needed"
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
    exit 0
  fi
done

log "Failover failed — no saved WiFi profile would connect; starting hotspot as recovery"

# Stranded recovery: no saved WiFi reachable, so bring the captive-portal
# hotspot back up. start-ap.sh honours the user's configured SSID/password
# and falls back to ClawBox-Setup if none is set.
START_AP="$CLAWBOX_ROOT/scripts/start-ap.sh"
if [ -x "$START_AP" ]; then
  bash "$START_AP" >/dev/null 2>&1 &
  log "Recovery AP launch dispatched"
fi
exit 0
