#!/usr/bin/env bash
# Restart the OpenClaw gateway once this box can actually reach the internet.
#
# Installed ROOT-OWNED at /usr/local/libexec/clawbox/gateway-restart-when-online.sh
# by install.sh::step_nm_dispatcher, and launched from
# /etc/NetworkManager/dispatcher.d/90-clawbox-failover. It must NOT be executed
# out of the checkout: NetworkManager runs dispatchers as root, and
# /home/clawbox/clawbox/scripts is clawbox-owned and group-writable, so root
# running a script from there is a one-step local root for anything with
# clawbox-level code execution. Same rule, and the same words, as
# install.sh's ROOT_LIBEXEC_DIR block (TASK-445).
#
# WHY THIS EXISTS (GH #529). The dispatcher restarted the gateway the moment
# Ethernet carrier dropped, before anything had proven a replacement route
# existed. On a headless box with no other uplink the gateway came back into a
# dead network: Telegram's startup hit ENETUNREACH, the OpenClaw release died
# three times on the unhandled socket error, and the account supervisor gave up.
# The gateway kept running with BOTH Telegram accounts stopped, and when
# Ethernet and DHCP recovered they stayed stopped until someone started them by
# hand.
#
# The restart is the point of failure and also the only cure, so it is not
# cancelled — it is DEFERRED until a route is proven, or abandoned.
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
# restart, held until it can succeed.
#
# WHY A SEPARATE SCRIPT. NetworkManager runs dispatcher scripts serially and
# kills a slow one, so the dispatcher must return immediately. It launches this
# detached; the waiting happens here.
#
# Usage: gateway-restart-when-online.sh <reason>
set -u

REASON="${1:-network change}"
LOG_TAG="clawbox-failover"

# Root-owned tmpfs, not the clawbox-writable data/ directory. This runs as root
# and opens the lock for writing, so a path the clawbox user can replace with a
# symlink is root truncating any file that user names. /run is also cleared on
# boot, which is what a lock wants anyway.
RUN_DIR="${CLAWBOX_RUN_DIR:-/run/clawbox}"
LOCK_FILE="$RUN_DIR/gateway-online-restart.lock"
# The dropped-request marker — see the lock section below.
REARM_FILE="$RUN_DIR/gateway-online-restart.rearm"

log() { logger -t "$LOG_TAG" -- "$*"; }

# Which unit, if any, this box's agent runs as.
#
# The Hermes SKU stops, disables and MASKS clawbox-gateway.service
# (install.sh's step_edition_gateway_state), and its own agent never has
# sockets to drop — so on that edition there is nothing here to do and a
# two-minute wait would be pure noise in the journal. Resolved from the
# root-owned edition lock, the same authority every other edition decision
# uses, with the unit's actual presence as the final word.
UNIT="${CLAWBOX_GATEWAY_UNIT:-clawbox-gateway.service}"

# `full` is NetworkManager's own verdict and the only authoritative yes. Every
# other value is NOT-YET-DECIDED rather than a no: connectivity checking is
# ENABLED on the Ubuntu/JetPack base this ships on
# (/usr/lib/NetworkManager/conf.d/20-connectivity-ubuntu.conf points at
# connectivity-check.ubuntu.com), so any customer LAN that blocks or hijacks
# that URL — a corporate egress filter, a Pi-hole, an ISP NXDOMAIN redirector —
# parks NM at `portal` or `limited` permanently while the box happily reaches
# Telegram and Anthropic. Treating that as offline would mean the gateway is
# never restarted again, which is GH #529 back through a different door.
#
# So anything short of `full` falls through to a probe of our own, and that
# probe is the updater's (`PING_TARGETS` and the HTTPS fallback in
# src/lib/updater.ts) rather than half of it: ICMP is blocked on plenty of real
# networks, which is exactly why the updater has the second half.
#
# `connectivity` and not `connectivity check`: the bare form reads the state NM
# already maintains, while `check` forces a fresh HTTP fetch on every poll —
# forty of them per event, each blocking for NM's probe timeout on a dead
# network, which would overrun the very budget this is meant to bound.
online() {
  local state
  state="$(nmcli -t networking connectivity 2>/dev/null | tr -d '[:space:]')"
  [ "$state" = "full" ] && return 0

  # No route at all is worth answering without spending four seconds on it.
  ip route show default 2>/dev/null | grep -q . || return 1

  local target
  for target in ${CLAWBOX_PING_TARGETS:-8.8.8.8 1.1.1.1}; do
    ping -c 1 -W 2 "$target" >/dev/null 2>&1 && return 0
  done
  # The updater's own reasoning, verbatim: ICMP is blocked on some networks
  # (hotel WiFi, corporate egress), and a box that can HEAD github.com is a box
  # whose gateway will reach its channels.
  command -v curl >/dev/null 2>&1 \
    && curl -fsS -I --max-time 8 -o /dev/null "${CLAWBOX_ONLINE_PROBE_URL:-https://github.com/}" 2>/dev/null
}

# A budget that is not a number must not become an unset `deadline` and a
# `set -u` death three lines later, with only "Deferring…" in the journal.
positive_int() {
  case "${1:-}" in
    ''|*[!0-9]*) printf '%s' "$2" ;;
    *) [ "$1" -gt 0 ] 2>/dev/null && printf '%s' "$1" || printf '%s' "$2" ;;
  esac
}

# How long a recovering box is given before we stop waiting. Long enough for
# WiFi association plus DHCP on a slow link; short enough that a genuinely
# unplugged box is not held for ever. This is a bound on ONE attempt: the
# dispatcher's connectivity-change and dhcp4-change arms, and the re-arm marker
# below, are what cover recovery beyond it.
ONLINE_TIMEOUT="$(positive_int "${CLAWBOX_ONLINE_TIMEOUT:-}" 120)"
ONLINE_POLL="$(positive_int "${CLAWBOX_ONLINE_POLL:-}" 3)"

if [ "${CLAWBOX_SKIP_UNIT_CHECK:-0}" != "1" ] \
   && ! systemctl list-unit-files "$UNIT" >/dev/null 2>&1; then
  # Not an error and not worth a journal line per network event: this edition
  # simply has no such unit.
  exit 0
fi

mkdir -p "$RUN_DIR" 2>/dev/null || true

# One waiter at a time. Overlapping NetworkManager events — a carrier that
# flaps, or eth down followed by wifi up — would otherwise stack several waits
# and fire several restarts at the moment the route returned, which is its own
# way of tripping the account supervisor.
#
# But `flock -n` alone LOSES the dropped request: the holder can time out one
# second before the route lands, having ignored the very event that would have
# succeeded. So a loser leaves a marker, and the holder re-arms its deadline
# when it finds one rather than exiting on a request it swallowed.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE" || exit 0
  if ! flock -n 9; then
    : > "$REARM_FILE" 2>/dev/null || true
    log "Gateway restart already pending ($REASON) — handed to the waiter holding the lock"
    exit 0
  fi
else
  # Without flock there is no mutual exclusion at all, and two waiters could
  # both restart. Said out loud rather than assumed away.
  log "WARN: flock unavailable — running without the single-waiter guard"
fi
rm -f "$REARM_FILE" 2>/dev/null || true

log "Deferring the gateway restart ($REASON) until a public route is proven, up to ${ONLINE_TIMEOUT}s"

deadline=$(( $(date +%s) + ONLINE_TIMEOUT ))
while :; do
  if online; then
    # try-restart, not restart. The probe and the action are two commands and
    # the gap here is a whole wait long: a unit that is stopped — deliberately
    # by the owner, or masked by the Hermes edition — must not be STARTED by
    # this. install.sh states the same rule for the same unit, in the same
    # words, and `is-active` would be wrong twice over: it also reports
    # non-zero for `activating`, and this unit's own RestartSec plus a
    # cold-Jetson TimeoutStartSec make that window minutes long.
    if systemctl try-restart "$UNIT" >/dev/null 2>&1; then
      # Asked, not "restarted": try-restart's exit code says the request was
      # accepted, not that the gateway came back — and certainly not what
      # OpenClaw did with its channel accounts afterwards.
      log "Public route is up — asked systemd to restart $UNIT ($REASON); a fresh gateway starts the channel accounts its supervisor gave up on"
    else
      log "Public route is up but the restart request for $UNIT failed"
    fi
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    # A request that arrived while this waiter held the lock is not lost: take
    # it now and go round again, once per marker.
    if [ -e "$REARM_FILE" ]; then
      rm -f "$REARM_FILE" 2>/dev/null || true
      deadline=$(( $(date +%s) + ONLINE_TIMEOUT ))
      log "A further network event arrived while waiting — extending the wait ${ONLINE_TIMEOUT}s"
      continue
    fi
    break
  fi
  sleep "$ONLINE_POLL"
done

# Deliberately NOT a restart. Bouncing the gateway into a network that still has
# no route is the exact sequence that suppressed the accounts in the first
# place, and the sockets it would drop are already dead. The next
# NetworkManager event — up, dhcp4-change or connectivity-change — starts a
# fresh wait and restarts then.
log "No public route after ${ONLINE_TIMEOUT}s ($REASON) — NOT restarting $UNIT; waiting for the next network event"
exit 0
