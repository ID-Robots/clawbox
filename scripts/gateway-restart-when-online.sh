#!/usr/bin/env bash
# Restart the OpenClaw gateway once this box can actually reach the internet.
#
# WHY THIS EXISTS (GH #529). `nm-dispatcher-failover.sh` restarted the gateway
# the moment Ethernet carrier dropped, before anything had proven a replacement
# route existed. On a headless box with no other uplink the gateway came back
# into a dead network: Telegram's startup hit ENETUNREACH, the OpenClaw release
# died three times on the unhandled socket error, and the account supervisor
# gave up. The gateway kept running with BOTH Telegram accounts stopped, and
# when Ethernet and DHCP recovered they stayed stopped until someone started
# them by hand.
#
# The restart is the point of failure and also the only cure, so it is not
# cancelled — it is DEFERRED until a route is proven, or abandoned. Restarting
# into a dead network is what suppresses the accounts; restarting once the
# network is back is what un-suppresses them (see below).
#
# WHY A RESTART IS THE WAY TO REVIVE A SUPPRESSED ACCOUNT — asked of the harness
# first, on the box, read-only, against the installed OpenClaw 2026.8.1:
#
#   * `openclaw channels --help` offers add | capabilities | dead-letters |
#     list | login | logout | logs | remove | resolve | status. There is no
#     start, resume or restart verb: the CLI cannot revive a stopped account.
#   * the supervisor that stops it is a `RetrySupervisor(RESTART_POLICY,
#     MAX_RESTARTS)` held in a Map inside the gateway process
#     (`dist/server-channels-*.js`), and giving up sets runtime state —
#     `setRuntime(..., { restartPending: false, reconnectAttempts })` — not
#     configuration. Nothing on disk records it, so nothing on disk can clear
#     it.
#
# So a fresh gateway process is the supported way back, and this script is that
# restart, held until it can succeed. `gateway.channelMaxRestartsPerHour` is the
# only related knob and it tunes the budget, not the recovery.
#
# WHY A SEPARATE SCRIPT. NetworkManager runs dispatcher scripts serially and
# kills a slow one, so the dispatcher must return immediately. It launches this
# detached; the waiting happens here.
#
# Usage: gateway-restart-when-online.sh <reason>
set -u

REASON="${1:-network change}"
LOG_TAG="clawbox-failover"
UNIT="${CLAWBOX_GATEWAY_UNIT:-clawbox-gateway.service}"
CLAWBOX_ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"

# How long a recovering box is given before we stop waiting. Long enough for
# WiFi association plus DHCP plus a captive-portal-free DNS answer on a slow
# link; short enough that a genuinely unplugged box is not held for ever. The
# next NetworkManager event starts a fresh wait, so this is a bound on ONE
# attempt, not on recovery.
ONLINE_TIMEOUT="${CLAWBOX_ONLINE_TIMEOUT:-120}"
ONLINE_POLL="${CLAWBOX_ONLINE_POLL:-3}"
LOCK_FILE="${CLAWBOX_ONLINE_LOCK:-$CLAWBOX_ROOT/data/gateway-online-restart.lock}"

log() { logger -t "$LOG_TAG" -- "$*"; }

# Is there a route to the public internet, not merely a link?
#
# NetworkManager's own connectivity check is asked FIRST because it is the
# harness for this layer and it already distinguishes the case that matters:
# `portal` and `limited` are exactly the "carrier is up, the internet is not"
# states that make a restart harmful. It answers `unknown` when connectivity
# checking is disabled — common on an appliance image — so the fallback is the
# same probe the updater already trusts (`PING_TARGETS` in src/lib/updater.ts),
# gated on a default route so a box with no route at all does not spend four
# seconds proving it.
online() {
  local state
  state="$(nmcli -t networking connectivity check 2>/dev/null | tr -d '[:space:]')"
  case "$state" in
    full) return 0 ;;
    none|limited|portal) return 1 ;;
  esac

  ip route show default 2>/dev/null | grep -q . || return 1
  local target
  for target in ${CLAWBOX_PING_TARGETS:-8.8.8.8 1.1.1.1}; do
    ping -c 1 -W 2 "$target" >/dev/null 2>&1 && return 0
  done
  return 1
}

# One waiter at a time. Overlapping NetworkManager events — a carrier that
# flaps, or eth down followed by wifi up — would otherwise stack several waits
# and fire several restarts at the moment the route returned, which is its own
# way of tripping the supervisor.
mkdir -p "$(dirname "$LOCK_FILE")" 2>/dev/null || true
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE" || exit 0
  if ! flock -n 9; then
    log "Gateway restart already pending ($REASON) — leaving it to the waiter that has the lock"
    exit 0
  fi
fi

log "Deferring the gateway restart ($REASON) until a public route is proven, up to ${ONLINE_TIMEOUT}s"

deadline=$(( $(date +%s) + ONLINE_TIMEOUT ))
while :; do
  if online; then
    # A gateway that is not running is not ours to start: the owner may have
    # stopped it, and `restart` would start it behind their back.
    if systemctl is-active --quiet "$UNIT"; then
      log "Public route is up — restarting $UNIT ($REASON)"
      if systemctl restart "$UNIT" >/dev/null 2>&1; then
        # The restart is what revives channel accounts the supervisor gave up
        # on: their suppression lives in the process that just went away.
        log "Gateway restarted; suppressed channel accounts start again with it"
      else
        log "Gateway restart failed"
      fi
    else
      log "Public route is up but $UNIT is not running — leaving it stopped"
    fi
    exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep "$ONLINE_POLL"
done

# Deliberately NOT a restart. Bouncing the gateway into a network that still has
# no route is the exact sequence that suppressed the accounts in the first
# place, and the sockets it would drop are already dead. The next
# NetworkManager event — the one that brings a route back — starts a fresh wait
# and restarts then.
log "No public route after ${ONLINE_TIMEOUT}s ($REASON) — NOT restarting $UNIT; waiting for the next network event"
exit 0
