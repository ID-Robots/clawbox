#!/usr/bin/env bash
# Supervised, coalesced by clawbox-wifi-failover.service, not the serial NM hook.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/wifi-radio.sh"
wifi_lock
wifi_recover || exit 1
WIFI_IFACE="$RADIO_IFACE"
AP_PROFILE=ClawBox-Setup
log() { echo "[WiFi-failover] $*"; }
# Events may have queued behind an AP startup. Recheck the live uplink.
if nmcli -t -f TYPE,STATE device status | grep -q '^ethernet:connected$'; then exit 0; fi

# One budget for everything done with the radio once it is owned: an
# activation already in flight, the AP release, every candidate and the settle
# after each. The unit's TimeoutStartSec covers lock + this + margin, and the
# lock is held no longer than before the settle existed.
deadline=$((SECONDS + 120))
# How long one observation waits for NetworkManager to settle an activation.
SETTLE_S=15

# UUIDs are machine identity; connection.id can contain colons, newlines,
# duplicate names or another profile's UUID. Never use it as a selector.
is_uuid() {
  local u="$1" hex
  [ "${#u}" -eq 36 ] || return 1
  [ "${u:8:1}${u:13:1}${u:18:1}${u:23:1}" = "----" ] || return 1
  hex="${u//-/}"
  [ "${#hex}" -eq 32 ] && [[ "$hex" =~ ^[0-9A-Fa-f]+$ ]]
}

# Sets radio_kind, radio_uuid and radio_state (the numeric device state, ""
# when unreadable). Unknown/transitioning means DEFER, never permission to
# activate something over a connection we failed to identify.
read_radio() {
  local state rows uuid type device mode
  radio_kind=unknown; radio_uuid=""; radio_state=""
  state="$(nmcli -g GENERAL.STATE device show "$WIFI_IFACE" 2>/dev/null)" || return
  radio_state="${state%% *}"
  case "$radio_state" in
    30|120) radio_kind=idle; return ;;
    100) ;;
    *) return ;;
  esac
  rows="$(nmcli -t -f UUID,TYPE,DEVICE connection show --active 2>/dev/null)" || return
  while IFS=: read -r uuid type device; do
    [ "$device" = "$WIFI_IFACE" ] || continue
    is_uuid "$uuid" || continue
    case "$type" in wifi|802-11-wireless) ;; *) continue ;; esac
    mode="$(nmcli -g 802-11-wireless.mode connection show uuid "$uuid" </dev/null 2>/dev/null)" || return
    radio_uuid="$uuid"
    case "$mode" in
      ap) radio_kind=ap ;;
      infrastructure|"") radio_kind=client ;;
    esac
    return
  done <<< "$rows"
}
# `nmcli --wait` gives up while NetworkManager carries the activation on, and
# nothing re-runs this worker when it ends (the dispatcher starts it on
# Ethernet down only). So an activation in flight is watched until it settles,
# within SETTLE_S and the budget: a client is kept, an idle radio carries on.
# Still in flight after that — or unknown for any other reason — defers.
keep_client_or_defer() {
  local waited=0
  while :; do
    read_radio || true
    [ "$radio_kind" = unknown ] || break
    case "$radio_state" in 40|50|60|70|80|90|110) ;; *) break ;; esac
    [ "$waited" -lt "$SETTLE_S" ] && [ "$SECONDS" -lt "$deadline" ] || break
    sleep 1
    waited=$((waited + 1))
  done
  case "$radio_kind" in
    client) log "Already on WiFi UUID $radio_uuid — no failover needed"; exit 0 ;;
    unknown) log "WiFi identity/state uncertain (state ${radio_state:-unreadable}) — deferring failover"; exit 1 ;;
  esac
}

keep_client_or_defer
# Only the AP actually on this radio, addressed unambiguously. No blanket down.
if [ "$radio_kind" = ap ]; then
  if [ "$(nmcli -g connection.id connection show uuid "$radio_uuid" 2>/dev/null)" != "$AP_PROFILE" ]; then
    log "Unrelated or unidentified AP on the radio — deferring failover"
    exit 1
  fi
  log "Bringing down active AP UUID $radio_uuid to free radio"
  nmcli --wait 10 connection down uuid "$radio_uuid" >/dev/null 2>&1 || exit 1
fi

# Names are deliberately absent from these rows. Stable numeric sort preserves
# listing order for ties. An unset mode is NM's default infrastructure mode.
mapfile -t profiles < <(
  nmcli -t -f UUID,TYPE,AUTOCONNECT-PRIORITY,TIMESTAMP connection show |
    while IFS=: read -r uuid type priority timestamp; do
      is_uuid "$uuid" || continue
      case "$type" in wifi|802-11-wireless) ;; *) continue ;; esac
      mode="$(nmcli -g 802-11-wireless.mode connection show uuid "$uuid" </dev/null 2>/dev/null)" || continue
      case "$mode" in infrastructure|"") ;; *) continue ;; esac
      [[ "$priority" =~ ^-?[0-9]+$ ]] || priority=0
      [[ "$timestamp" =~ ^[0-9]+$ ]] || timestamp=0
      printf '%s:%s:%s\n' "$priority" "$timestamp" "$uuid"
    done | LC_ALL=C sort -s -t: -k1,1nr -k2,2nr | cut -d: -f3
)

# One traversal, a positive per-attempt wait, each attempt's settle held in
# reserve inside the budget. NM may continue an activation after a timeout:
# re-observe before any next action.
for uuid in "${profiles[@]}"; do
  keep_client_or_defer
  remaining=$((deadline - SETTLE_S - SECONDS))
  [ "$remaining" -gt 0 ] || break
  wait_s=45; [ "$remaining" -lt "$wait_s" ] && wait_s="$remaining"
  log "Trying WiFi UUID $uuid"
  nmcli --wait "$wait_s" connection up uuid "$uuid" ifname "$WIFI_IFACE" >/dev/null 2>&1 || true
  keep_client_or_defer
done
keep_client_or_defer

log "Failover failed — no saved WiFi profile would connect; starting hotspot as recovery"

# Service ownership, never a detached root shell or checkout execution.
systemctl --no-block restart clawbox-ap.service
