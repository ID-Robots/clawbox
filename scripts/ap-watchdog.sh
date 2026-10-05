#!/usr/bin/env bash
# Self-heal the setup hotspot.
#
# While first-boot setup is not complete the box MUST stay reachable over WiFi
# without a cable. But the ClawBox-Setup connection is autoconnect=no (so it
# doesn't fight the deliberate client-connect handoff), which means ANYTHING
# that downs it — a stray `nmcli connection down`, a driver hiccup, or a failed
# client-connect whose AP restore didn't finish — leaves the radio dark with
# nothing to bring it back. The hotspot then "removes itself" and the box is
# unreachable until a manual `systemctl restart clawbox-ap.service`.
#
# This watchdog (run every ~20s by clawbox-ap-watchdog.timer) brings the AP back
# whenever it's down and setup isn't finished — UNLESS a deliberate WiFi handoff
# is in progress, in which case the web server holds a lock while it owns the
# radio to join the home network and we leave it alone, or UNLESS the owner has
# switched the hotspot off (TASK-507).
#
# THE DIFFERENCE BETWEEN A DROP AND A DECISION is the whole job of this script.
# Healing an AP that fell over is why it exists. Resurrecting one the owner
# deliberately turned off is not healing, it is overruling — and it is how a box
# came out of setup broadcasting an open, unpassworded network after its owner
# had switched that network off and been told "Hotspot will not start
# automatically."
set -uo pipefail

IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
# $ROOT names the files this script READS — parsed with read_env_value or
# grep, never sourced — and nothing it executes.
ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
CONFIG_FILE="$ROOT/data/config.json"
CONNECT_LOCK="$ROOT/data/wifi-connecting.lock"
HOTSPOT_ENV="$ROOT/data/hotspot.env"
# Startup is requested from systemd; this watchdog never executes AP code.
# A connect (with retries) + AP restore can legitimately take a couple of
# minutes; ignore a lock older than this so a web-server crash mid-handoff can't
# wedge the watchdog off forever.
LOCK_MAX_AGE="${WIFI_CONNECT_LOCK_MAX_AGE:-180}"

# Read here; acted on below, once a deferred failover has had its look.
setup_complete=false
if [ -f "$CONFIG_FILE" ] && grep -E -q '"setup_complete":[[:space:]]*true' "$CONFIG_FILE" 2>/dev/null; then
  setup_complete=true
fi

# The owner switched the hotspot off. Do not bring it back.
#
# `HOTSPOT_DISABLED=1` is written by POST /setup-api/system/hotspot the moment
# the switch is turned off, and that handler also stops the AP — successfully.
# Twenty seconds later this watchdog used to undo it, because the only thing it
# looked at was whether setup had finished, and at the Security step it has not:
# the customer still has AI Provider and Telegram to go. start-ap.sh gates its
# own HOTSPOT_DISABLED check behind `setup_complete = true` for the same reason,
# so the flag was ignored on both sides of the loop and the AP came straight
# back up. It then stayed up until the next reboot, when setup_complete was
# finally true and start-ap.sh skipped correctly.
#
# PARSED, never sourced.
#
# This used to be `. "$HOTSPOT_ENV"` in a subshell — the subshell protected this
# script's variables and nothing else. clawbox-ap-watchdog.service carries no
# `User=`, so this runs as ROOT on a timer, while $ROOT/data is written by the
# web server as the clawbox user. Sourcing it was therefore arbitrary root code
# execution on a schedule for anything that could already run code as clawbox:
# plant the payload, wait twenty seconds. TASK-445.
#
# The parse keeps the property the sourcing was chosen for — a quoted SSID with
# a `#` in it cannot be misread, because only the named key's own line is read
# and one layer of quotes is stripped. Missing file, unset flag, or anything
# other than 1 all still mean "not disabled": the failure direction that keeps a
# box reachable.
read_env_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 0
  [ -L "$file" ] && return 0
  line="$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null)" || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

hotspot_disabled="$(read_env_value "$HOTSPOT_ENV" HOTSPOT_DISABLED)"

# A failover worker that had to leave a WiFi activation in flight left this
# marker (wifi-failover.sh): NetworkManager dispatches nothing if that
# activation then fails, so nothing else would run the worker again. Once the
# radio has settled — never while still in flight or unreadable, never during
# a deliberate client-connect — start the supervised worker: it re-decides
# everything under the radio lock and ends or renews the marker, capped per
# episode. Pre-setup as after, and nothing else in that tick: restoring the AP
# is then the worker's call. Never pre-setup with the hotspot switched off:
# the worker's recovery restarts clawbox-ap.service, and start-ap.sh honours
# that switch only after setup — the marker is left to age out. Otherwise the
# rules below apply unchanged. An episode nobody finished (a worker that never
# got the radio lock) is dropped after FAILOVER_PENDING_MAX_AGE. The name is
# wifi-radio.sh's, checked alike.
RADIO_DIR="${CLAWBOX_RADIO_RUN_DIR:-/run/clawbox-radio}"
FAILOVER_PENDING="$RADIO_DIR/$IFACE.failover-pending"
FAILOVER_PENDING_MAX_AGE=900
if { [ "$setup_complete" = true ] || [ "$hotspot_disabled" != "1" ]; } &&
   [[ "$IFACE" =~ ^[A-Za-z0-9_.-]+$ ]] && [ ! -L "$RADIO_DIR" ] &&
   [ -f "$FAILOVER_PENDING" ] && [ ! -L "$FAILOVER_PENDING" ]; then
  now="$(date +%s)"
  age=$(( now - $(stat -c %Y "$FAILOVER_PENDING" 2>/dev/null || echo 0) ))
  lock_age=$(( now - $(stat -c %Y "$CONNECT_LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 0 ] || [ "$age" -ge "$FAILOVER_PENDING_MAX_AGE" ]; then
    rm -f -- "$FAILOVER_PENDING"
  elif ! { [ -f "$CONNECT_LOCK" ] && [ "$lock_age" -ge 0 ] && [ "$lock_age" -lt "$LOCK_MAX_AGE" ]; }; then
    radio="$(nmcli -g GENERAL.STATE device show "$IFACE" 2>/dev/null)" || radio=""
    case "${radio%% *}" in
      ""|40|50|60|70|80|90|110) ;;
      *)
        echo "[AP-watchdog] $IFACE settled (${radio%% *}) after a deferred failover — re-running it"
        systemctl --no-block start clawbox-wifi-failover.service ||
          echo "[AP-watchdog] could not start the deferred failover re-check" >&2
        exit 0 ;;
    esac
  fi
fi

# Post-setup the hotspot is owned by the normal flow (saved WiFi / desktop) —
# don't fight it.
if [ "$setup_complete" = true ]; then
  exit 0
fi

if [ "$hotspot_disabled" = "1" ]; then
  exit 0
fi

# A deliberate client-connect owns the radio right now — leave it alone so we
# don't yank the AP back up mid-handoff. A stale lock (crashed mid-connect) is
# ignored once it ages out.
if [ -f "$CONNECT_LOCK" ]; then
  now="$(date +%s)"
  mtime="$(stat -c %Y "$CONNECT_LOCK" 2>/dev/null || echo 0)"
  age=$(( now - mtime ))
  if [ "$age" -ge 0 ] && [ "$age" -lt "$LOCK_MAX_AGE" ]; then
    exit 0
  fi
fi

# If the radio is connected to ANYTHING, leave it alone:
#  - "connected" while hosting the AP (ClawBox-Setup is up — nothing to heal), or
#  - "connected" as a client after a successful setup connect (the box joined the
#    home network on purpose; the AP is meant to be down now).
# We only step in when the radio is idle/disconnected — the failure state where
# the hotspot was torn down with nothing to bring it back.
STATE="$(nmcli -t -f DEVICE,STATE device status 2>/dev/null | awk -F: -v ifc="$IFACE" '$1==ifc{print $2}')"
case "$STATE" in
  connected*|connecting) exit 0 ;;
esac

echo "[AP-watchdog] $IFACE is '${STATE:-unknown}' (not connected) and setup is incomplete — restoring hotspot"
# A service owns every AP startup, including timeout/SIGKILL recovery.
# Do not cancel an AP start already in progress when the timer fires again.
systemctl --job-mode=fail --no-block restart clawbox-ap.service
