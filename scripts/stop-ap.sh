#!/usr/bin/env bash
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/wifi-radio.sh"
if ! wifi_lock; then
  # The web account runs this script too (Settings -> hotspot off, the WiFi
  # connect) and cannot create root's radio directory or the lock inside it.
  # That only matters when there is an access point to take down: with none
  # there is nothing to protect and nothing to do. Anything else - an AP that
  # needs stopping, nmcli unable to say, a root caller that cannot take the
  # lock, a lock that is there but unusable - stays a failure, with its reason.
  if [ "$WIFI_LOCK_ABSENT" = 1 ]; then
    lock="$RADIO_DIR/$RADIO_IFACE.lock"
    if [ "$EUID" -eq 0 ]; then
      echo "[AP] Cannot stop the access point: could not create the radio lock $lock" >&2
    elif ap_uuid="$(wifi_ap_uuid)"; then
      [ -n "$ap_uuid" ] || { echo "[AP] No access point running."; exit 0; }
      echo "[AP] Cannot stop the access point: the radio lock $lock does not exist and only root can create it" >&2
    else
      echo "[AP] Cannot stop the access point: the radio lock $lock does not exist and nmcli could not say whether one is running" >&2
    fi
  fi
  exit 1
fi
# Never race the root service's abandoned snapshot from an unprivileged caller.
if [ "$EUID" -eq 0 ]; then
  wifi_recover
elif [ -e "$RADIO_SNAPSHOT" ]; then
  echo "[AP] Cannot stop the access point: a root radio recovery is pending ($RADIO_SNAPSHOT)" >&2
  exit 1
fi
IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
AP_IP="10.42.0.1"

echo "[AP] Removing iptables captive portal rules..."
iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null || true

echo "[AP] Bringing down access point..."
wifi_stop_ap

echo "[AP] Access point stopped."
