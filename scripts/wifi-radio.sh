#!/usr/bin/env bash
# Shared radio ownership. Root services source this installed sibling; the web
# account executes --nmcli/--iw-scan AS ITSELF (no new sudo grant).
# All overrides are root-service inputs or unprivileged test seams, never data/.
export LC_ALL=C
RADIO_IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
[ "${#RADIO_IFACE}" -le 15 ] && [[ "$RADIO_IFACE" =~ ^[A-Za-z0-9_.-]+$ ]] || exit 1
RADIO_DIR="${CLAWBOX_RADIO_RUN_DIR:-/run/clawbox-radio}"
RADIO_SNAPSHOT="$RADIO_DIR/$RADIO_IFACE.policy"

wifi_is_uuid() {
  local u="$1" hex
  [ "${#u}" -eq 36 ] || return 1
  [ "${u:8:1}${u:13:1}${u:18:1}${u:23:1}" = "----" ] || return 1
  hex="${u//-/}"
  [ "${#hex}" -eq 32 ] && [[ "$hex" =~ ^[0-9A-Fa-f]+$ ]]
}

wifi_lock() {
  # Directory entries are root-owned; readers can lock but cannot replace the
  # inode or write recovery state. flock works on a read-only fd on Linux.
  if [ ! -d "$RADIO_DIR" ]; then
    mkdir -m 0755 "$RADIO_DIR" 2>/dev/null || [ -d "$RADIO_DIR" ] || return 1
  fi
  [ ! -L "$RADIO_DIR" ] || return 1
  if [ "$EUID" -eq 0 ]; then
    [ "$(stat -c %u "$RADIO_DIR")" = 0 ] || return 1
    [ "$(stat -c %a "$RADIO_DIR")" = 755 ] || return 1
  fi
  local lock="$RADIO_DIR/$RADIO_IFACE.lock"
  if [ ! -e "$lock" ]; then
    (umask 022; set -C; : > "$lock") 2>/dev/null || [ -f "$lock" ] || return 1
  fi
  [ -f "$lock" ] && [ ! -L "$lock" ] || return 1
  exec 9< "$lock" || return 1
  flock -x -w 180 9 || { echo '[WiFi] Radio ownership timed out' >&2; return 1; }
}

wifi_recover() {
  [ -e "$RADIO_SNAPSHOT" ] || return 0
  local original
  [ -f "$RADIO_SNAPSHOT" ] && [ ! -L "$RADIO_SNAPSHOT" ] || return 1
  original="$(cat "$RADIO_SNAPSHOT")" || return 1
  case "$original" in yes|no) ;; *) echo '[WiFi] Invalid recovery snapshot' >&2; return 1 ;; esac
  if ! nmcli --wait 5 device set "$RADIO_IFACE" autoconnect "$original" ||
     [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$RADIO_IFACE")" != "$original" ]; then
    echo "[WiFi] ERROR: recovery failed (autoconnect=$original); snapshot retained" >&2
    return 1
  fi
  rm -- "$RADIO_SNAPSHOT"
}

wifi_inhibit() {
  # A trap alone cannot survive SIGKILL. Only supervised production callers
  # may create this mutation; ExecStopPost recovers even a killed cgroup.
  [ "${CLAWBOX_AP_SUPERVISED:-}" = 1 ] || {
    echo '[WiFi] Refusing unsupervised autoconnect inhibition' >&2; return 1;
  }
  if [ ! -e "$RADIO_SNAPSHOT" ]; then
    local original temporary="$RADIO_SNAPSHOT.$$"
    original="$(nmcli -g GENERAL.AUTOCONNECT device show "$RADIO_IFACE")" || return 1
    case "$original" in yes|no) ;; *) echo '[WiFi] Unknown device policy' >&2; return 1 ;; esac
    # Publish BEFORE mutation. Never overwrite an abandoned owner's snapshot.
    (umask 077; set -C; printf '%s\n' "$original" > "$temporary") || return 1
    mv -- "$temporary" "$RADIO_SNAPSHOT" || return 1
  fi
  nmcli --wait 5 device set "$RADIO_IFACE" autoconnect no || return 1
  [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$RADIO_IFACE")" = no ] || {
    echo '[WiFi] Inhibition readback failed' >&2; return 1;
  }
}

# A display name alone never establishes AP ownership. Refuse ambiguous APs
# before any deletion; an infrastructure profile with that name is not ours.
wifi_ap_uuid() {
  local rows uuid name mode device found=""
  rows="$(nmcli -g UUID connection show)" || return 1
  while IFS= read -r uuid; do
    wifi_is_uuid "$uuid" || continue
    name="$(nmcli -g connection.id connection show uuid "$uuid" </dev/null)" || return 1
    [ "$name" = ClawBox-Setup ] || continue
    mode="$(nmcli -g 802-11-wireless.mode connection show uuid "$uuid" </dev/null)" || return 1
    [ "$mode" = ap ] || continue
    device="$(nmcli -g connection.interface-name connection show uuid "$uuid" </dev/null)" || return 1
    [ "$device" = "$RADIO_IFACE" ] || continue
    [ -z "$found" ] || { echo '[WiFi] Ambiguous owned AP profiles; refusing mutation' >&2; return 1; }
    found="$uuid"
  done <<< "$rows"
  printf '%s' "$found"
}

wifi_stop_ap() {
  local uuid
  uuid="$(wifi_ap_uuid)" || return 1
  [ -n "$uuid" ] || return 0
  nmcli --wait 10 connection down uuid "$uuid" || true
  nmcli connection delete uuid "$uuid"
}

# The saved-network web route accepts a display ID. Resolve it under the same
# lock, and never let nmcli interpret an ID as some other connection's UUID.
wifi_client_uuid() {
  local wanted="$1" rows uuid name mode found=""
  rows="$(nmcli -g UUID connection show)" || return 1
  while IFS= read -r uuid; do
    wifi_is_uuid "$uuid" || continue
    name="$(nmcli -e no -g connection.id connection show uuid "$uuid" </dev/null)" || return 1
    [ "$name" = "$wanted" ] || continue
    mode="$(nmcli -g 802-11-wireless.mode connection show uuid "$uuid" </dev/null)" || return 1
    case "$mode" in infrastructure|"") ;; *) continue ;; esac
    [ -z "$found" ] || { echo '[WiFi] Ambiguous client profile ID' >&2; return 1; }
    found="$uuid"
  done <<< "$rows"
  [ -n "$found" ] || { echo '[WiFi] No matching client profile' >&2; return 1; }
  printf '%s' "$found"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  wifi_lock
  case "${1:-}" in
    --recover) wifi_recover ;;
    --nmcli|--iw-scan)
      # A worker may have died before its service cleanup acquires the lock.
      # Unprivileged writers cannot restore root state; fail closed until it does.
      [ ! -e "$RADIO_SNAPSHOT" ] || { echo '[WiFi] Recovery pending' >&2; exit 1; }
      if [ "$1" = --iw-scan ]; then exec /usr/sbin/iw dev "$RADIO_IFACE" scan; fi
      shift
      if [ "${1:-}" = connection ]; then
        case "${2:-}" in
          up|modify|delete)
            uuid="$(wifi_client_uuid "${3:-}")" || exit 1
            if [ "$2" = up ]; then
              exec nmcli connection up uuid "$uuid" ifname "$RADIO_IFACE"
            fi
            exec nmcli connection "$2" uuid "$uuid" "${@:4}" ;;
        esac
      fi
      exec nmcli "$@" ;;
    *) exit 2 ;;
  esac
fi
