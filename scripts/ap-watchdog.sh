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
# radio to join the home network and we leave it alone.
set -uo pipefail

IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
CONFIG_FILE="$ROOT/data/config.json"
CONNECT_LOCK="$ROOT/data/wifi-connecting.lock"
START_AP="$ROOT/scripts/start-ap.sh"
# A connect (with retries) + AP restore can legitimately take a couple of
# minutes; ignore a lock older than this so a web-server crash mid-handoff can't
# wedge the watchdog off forever.
LOCK_MAX_AGE="${WIFI_CONNECT_LOCK_MAX_AGE:-180}"

# Post-setup the hotspot is owned by the normal flow (saved WiFi / desktop) —
# don't fight it.
if [ -f "$CONFIG_FILE" ] && grep -E -q '"setup_complete":[[:space:]]*true' "$CONFIG_FILE" 2>/dev/null; then
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
# SKIP_PRESCAN: we only need the hotspot back, not a fresh network scan.
SKIP_PRESCAN=1 bash "$START_AP"
