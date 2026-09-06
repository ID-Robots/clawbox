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
# The restart is the point of failure, so it is not cancelled — it is DEFERRED
# until a route is proven, or abandoned.
#
# WHAT THE HARNESS ALREADY DOES — asked of OpenClaw first, on the box,
# read-only, against the installed 2026.8.1:
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
#   * BUT the gateway ALSO runs its own channel health monitor on every start —
#     `[health-monitor] started (interval: 300s, startup-grace: 60s,
#     channel-connect-grace: 120s)`. For a stopped account
#     `evaluateChannelHealth` returns `not-running`,
#     `resolveChannelRestartReason` labels that `gave-up` once
#     reconnectAttempts >= 10, and the monitor restarts THAT ACCOUNT, bounded
#     by cooldownCycles and maxRestartsPerHour. Three `gateway.*` keys tune it
#     and ClawBox sets none of them.
#
# So "a fresh gateway process is the only way back" is TOO STRONG, and this
# script does not claim it. What the monitor does not do is act on the two
# reasons it skips outright — `terminal-disconnect` and `blocked` — and
# `evaluateChannelHealth` tests `terminalDisconnect` BEFORE `not-running`. GH
# #529's accounts stayed stopped until a human started them, with this monitor
# running, so one of those skips applied; which one is UNPROVEN, because
# establishing it means reproducing the outage on a box and losing its live
# channels.
#
# What this script fixes is narrower and certain: the dispatcher used to restart
# the gateway INTO A DEAD NETWORK, which is the sequence that suppressed the
# accounts in the first place. Held until it can succeed, or not done at all.
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
# What the last accepted restart request was for — see the coalescing section.
# In the same root-owned tmpfs, and cleared on boot, which is what this wants:
# the first event after a boot is never a repeat of one before it.
STAMP_FILE="$RUN_DIR/gateway-online-restart.stamp"

log() { logger -t "$LOG_TAG" -- "$*"; }

# Which unit, if any, this box's agent runs as.
#
# The Hermes SKU stops, disables and MASKS clawbox-gateway.service
# (install.sh's step_edition_gateway_state), and its own agent never has
# sockets to drop — so on that edition there is nothing here to do and a
# two-minute wait would be pure noise in the journal. Decided from the unit's
# own load state below: systemd's answer about the unit this script would act
# on, which needs no second source of truth about the edition.
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

  # Split on whitespace — the value is a LIST, like the updater's PING_TARGETS —
  # with `read -ra` and not a bare expansion, because an unquoted expansion is a
  # PATHNAME expansion too: a `*` in the value would turn a filename into a ping
  # destination. `read` takes one line, which is what a space-separated list is.
  local target
  local -a targets=()
  read -ra targets <<<"${CLAWBOX_PING_TARGETS:-8.8.8.8 1.1.1.1}"
  for target in "${targets[@]}"; do
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

# ONE RESTART PER ROUTE RECOVERY, not one per NetworkManager event.
#
# The flock below stops two waiters WAITING at once. It does nothing about
# waiters that run one after another, and that is what a recovery actually
# produces: measured on a box, `up`, `connectivity-change FULL` and
# `dhcp4-change` all arrived inside one second, NetworkManager ran the
# dispatchers serially, each waiter proved the same route in well under the time
# the next took to start, and each asked for its own restart — three requests
# with no "already pending" line anywhere, for a single recovery. A later boot
# of the same box produced two requests and one "already pending": the lock
# catches only the pair that happened to overlap. Every accepted request is a
# stop and a cold start of a unit that takes ~40 s to come up on this hardware,
# and each bounce drops the channel accounts the restart exists to revive.
#
# So a request is remembered, and a later one for the SAME recovery stands down.
# Standing down is the dangerous half — a swallowed restart IS GH #529 — so
# "the same recovery" has to be all three of these, and none of them alone:
#
#   * NO ABSENCE SEEN. A waiter that polled and found no route watched the
#     route go away; whatever returns is a new recovery however familiar it
#     looks. See saw_route_absent below. The dispatcher clears the stamp on a
#     `down` of ANY uplink this box routes through — Ethernet or the radio — for
#     the case where the flap finished before a waiter even started, which is
#     the one this cannot see. That clear can also land while `try-restart` is
#     still running, so the stamp is written BEFORE that call and never after
#     it; see record_restart_asked_for and its call site.
#   * THE SAME ROUTE, as the kernel selects it — see route_key. A failover to
#     WiFi, or a lease that moves the box's own address, is a new recovery and
#     owes its own restart: the sockets are bound to what just died.
#   * WITHIN THE WINDOW. A cable replugged an hour later comes back on the very
#     same lease and must still restart. The window covers the measured
#     one-second burst with room for a `dhcp4-change` or a connectivity check
#     landing seconds later, and nothing beyond that.
#
# The window is measured from BEFORE the restart, because that is when the stamp
# is written (see the call site), so the time left once the waiter releases the
# lock is the window MINUS however long the restart took. Said rather than
# hidden — and left that way on purpose: refreshing the timestamp after
# `try-restart` would mean writing the stamp again after the restart, which is
# exactly the write a carrier drop landing during it has to be able to win
# against. Erring short costs an extra restart; erring the other way costs a
# swallowed one, and the measured burst arrives inside a second, before the
# restart has even started.
COALESCE_WINDOW="$(positive_int "${CLAWBOX_RESTART_COALESCE:-}" 60)"

# Seconds since boot, and NOT `date +%s`: these boards have no RTC, so
# systemd-timesyncd steps the clock the moment a route comes up — inside the
# very burst this has to survive. Measured with a stepped clock, a wall-clock
# window collapses three restarts to two instead of to one. /run is cleared on
# boot, so the stamp and this counter share a lifetime by construction.
# Empty (no /proc/uptime) means there is no monotonic clock to compare against.
monotonic_seconds() {
  local up=""
  read -r up _ < /proc/uptime 2>/dev/null || return 1
  case "$up" in ''|*[!0-9.]*) return 1 ;; esac
  printf '%s' "${up%%.*}"
}

# The wait's own clock. A bound on ONE wait is sound on either clock, so this
# falls back rather than refusing to wait; both ends of every comparison come
# from this one function, so they can never be read off two different clocks.
now_seconds() { monotonic_seconds || date +%s; }

# Which recovery this is — asked of the KERNEL rather than parsed out of the
# routing table. `ip route get` answers with the route it would actually select
# for that destination and the source address it would use: the interface, the
# gateway and the local address, which is exactly what the gateway's sockets are
# bound to. Reading `ip route show default` instead was wrong twice over — a
# second, higher-metric default route (any box with a saved WiFi profile) read
# as a new recovery though the traffic path had not moved, and a DHCP NAK that
# moved only the box's own address read as the same one though every socket had
# just died.
#
# An unanswerable key (no route at all, `ip` missing, a non-IP probe target)
# is never equal to a recorded one, so it stands down from nothing: this
# degrades to the unfixed behaviour rather than to a blanket cooldown.
route_key() {
  local dest
  # Same target the probe above uses, so the key describes the path that was
  # actually proven — and split the same glob-free way, for the same reason: a
  # `*` reaching `ip route get` as a filename would key the recovery on a route
  # to something that is not the probe destination at all.
  local -a targets=()
  read -ra targets <<<"${CLAWBOX_PING_TARGETS:-8.8.8.8}"
  dest="${targets[0]:-}"
  [ -n "$dest" ] || return 0
  ip -o route get "$dest" 2>/dev/null | awk '
    {
      dev = ""; gw = ""; src = "";
      for (i = 1; i < NF; i++) {
        if ($i == "via") gw = $(i + 1);
        if ($i == "dev") dev = $(i + 1);
        if ($i == "src") src = $(i + 1);
      }
      if (dev != "") print dev "/" gw "/" src;
      exit
    }'
}

restart_already_asked_for() {
  local key="${1:-}" when="" rest="" now=""
  [ -n "$key" ] || return 1
  [ -r "$STAMP_FILE" ] || return 1
  now="$(monotonic_seconds)" || return 1
  read -r when rest < "$STAMP_FILE" 2>/dev/null || true
  case "$when" in ''|*[!0-9]*) return 1 ;; esac
  [ "$rest" = "$key" ] || return 1
  local age=$(( now - when ))
  # A stamp from the future is a stamp this boot cannot reason about; treat it
  # as unusable rather than authoritative and let the restart through, which is
  # what the unfixed script does on every event anyway.
  [ "$age" -ge 0 ] && [ "$age" -lt "$COALESCE_WINDOW" ]
}

# Recorded for a request about to be made, and withdrawn by the caller if
# systemd rejects it — `try-restart` also answers 0 for a unit that was
# inactive, where it deliberately did nothing, so this says "asked", never
# "restarted", exactly like the journal line beside it.
#
# Staged and renamed, not truncated in place: without flock two waiters can be
# here at once, and a half-written line is a guard that quietly is not there.
# A write that fails is SAID, for the same reason the missing lock is.
record_restart_asked_for() {
  local key="${1:-}" now=""
  [ -n "$key" ] || return 0
  now="$(monotonic_seconds)" || {
    log "WARN: no monotonic clock (/proc/uptime) — cannot coalesce, a further network event will restart again"
    return 0
  }
  if ! { printf '%s %s\n' "$now" "$key" > "$STAMP_FILE.new" 2>/dev/null \
         && mv -f "$STAMP_FILE.new" "$STAMP_FILE" 2>/dev/null; }; then
    rm -f "$STAMP_FILE.new" 2>/dev/null || true
    log "WARN: could not record the restart request in $STAMP_FILE — a further network event will restart again"
  fi
}

# `list-unit-files` is the wrong question: it LISTS a masked unit, so it answers
# "present" on the one edition this guard exists for. Measured read-only on the
# Hermes box: `clawbox-gateway.service masked enabled`, exit 0.
#
# LoadState is the answer that separates them: `loaded` for a unit systemd would
# act on, `masked` for the Hermes edition's, `not-found` where it was never
# installed. Anything but `loaded` means there is nothing here to restart — not
# an error, and not worth a journal line per network event. An EMPTY answer is a
# different thing again and is handled separately below.
if [ "${CLAWBOX_SKIP_UNIT_CHECK:-0}" != "1" ]; then
  unit_load_state="$(systemctl show -p LoadState --value "$UNIT" 2>/dev/null)"
  if [ -z "$unit_load_state" ]; then
    # systemctl did not answer at all — a `daemon-reexec` (install.sh and the
    # updater both trigger one), a bus hiccup, or no systemd here. That is NOT
    # evidence that this edition has no gateway, and exiting silently on it
    # would drop a network event with no trace anywhere. Say so once, then
    # stand down: a systemctl that cannot answer cannot restart anything
    # either, and the next network event starts a fresh wait.
    # src/lib/gateway-health.ts states the same rule for the same property:
    # "null means systemctl did not answer, which is not evidence either way."
    log "WARN: could not read $UNIT load state — standing down for: $REASON"
    exit 0
  fi
  # `loaded` is the only state describing a unit systemd would act on.
  [ "$unit_load_state" = "loaded" ] || exit 0
fi

mkdir -p "$RUN_DIR" 2>/dev/null || true

# One waiter at a time. Overlapping NetworkManager events — a carrier that
# flaps, or eth down followed by wifi up — would otherwise stack several
# concurrent waits, each holding the box's fate for two minutes.
#
# This is CONCURRENCY only, and it was once claimed to be more: events that do
# not overlap take the lock one after another and every one of them reached the
# restart. Collapsing those is the coalescing window above, not this.
#
# But `flock -n` alone LOSES the dropped request: the holder can time out one
# second before the route lands, having ignored the very event that would have
# succeeded. So a loser leaves a marker, and the holder re-arms its deadline
# when it finds one rather than exiting on a request it swallowed.
# The lock file is OPENED before `exec` is asked to take the descriptor: a failed
# redirection on `exec` kills a non-interactive bash outright, so `exec 9>… ||
# exit 0` cannot even reach its fallback — the event would vanish with nothing in
# the journal, which is the silent-drop shape this script keeps guarding against.
# `>>` so probing never truncates a lock somebody else holds.
if command -v flock >/dev/null 2>&1 && : >>"$LOCK_FILE" 2>/dev/null; then
  exec 9>>"$LOCK_FILE"
  if ! flock -n 9; then
    : > "$REARM_FILE" 2>/dev/null || true
    log "Gateway restart already pending ($REASON) — handed to the waiter holding the lock"
    exit 0
  fi
else
  # Without the lock there is no mutual exclusion at all, and two waiters could
  # both restart. Said out loud rather than assumed away — and the wait still
  # happens, because dropping the event is the worse of the two failures.
  log "WARN: no single-waiter guard (flock or $LOCK_FILE unavailable) — a concurrent network event could restart twice"
fi
rm -f "$REARM_FILE" 2>/dev/null || true

log "Deferring the gateway restart ($REASON) until a public route is proven, up to ${ONLINE_TIMEOUT}s"

# Did THIS waiter watch the route go away? A waiter that polled and found no
# route has proven an absence between the last restart and now, so whatever
# comes back is a new recovery however familiar it looks — a cable pulled and
# replugged returns on the very same lease, and the sockets it killed are just
# as dead as ones on a different address. Only a waiter that never saw an
# absence may stand down.
saw_route_absent=0

deadline=$(( $(now_seconds) + ONLINE_TIMEOUT ))
while :; do
  if online; then
    recovery="$(route_key)"
    if [ "$saw_route_absent" -eq 0 ] && restart_already_asked_for "$recovery"; then
      # Not a failure and not a dropped event: the restart this one would ask
      # for has already been asked for, by a sibling NetworkManager event
      # describing the same recovery.
      log "Gateway restart already asked for this route recovery within ${COALESCE_WINDOW}s ($REASON) — standing down"
      exit 0
    fi
    # try-restart, not restart. The probe and the action are two commands and
    # the gap here is a whole wait long: a unit that is stopped — deliberately
    # by the owner, or masked by the Hermes edition — must not be STARTED by
    # this. install.sh states the same rule for the same unit, in the same
    # words, and `is-active` would be wrong twice over: it also reports
    # non-zero for `activating`, and this unit's own RestartSec plus a
    # cold-Jetson TimeoutStartSec make that window minutes long.
    #
    # RECORDED BEFORE THE CALL, and withdrawn below if systemd rejects it.
    #
    # `try-restart` BLOCKS until the restart job completes, and this unit's cold
    # start is ~40 s on this hardware — so on a running box that is a wide
    # window. (At boot it is not: the unit is inactive, `try-restart` is a no-op
    # on an inactive unit and returns at once, which is why the device journal
    # shows the whole waiter run in under a tenth of a second.) The record used
    # to be written after that call returned, keyed on the route read before it,
    # so a carrier drop inside the window was cleared by the dispatcher and then
    # put straight back here, stamped for a route that had already died, and the
    # next recovery stood down on it: GH #529 again, through the mitigation
    # meant to prevent it. Nothing else could notice — the waiter that drop
    # dispatches is turned away by the flock this one holds, so no poll ever
    # proves the absence.
    #
    # Writing first inverts it: a clear that lands during the restart is the
    # last word ON THE RECORD, because nothing here writes again afterwards.
    # (It is not the last word on the restart: that job is already running, and
    # this has never been able to recall one.) The dispatcher's clear is a plain
    # `rm -f` and deliberately takes no lock, so it is never queued behind this
    # call.
    record_restart_asked_for "$recovery"
    if systemctl try-restart "$UNIT" >/dev/null 2>&1; then
      # Asked, not "restarted": try-restart's exit code says the request was
      # accepted, not that the gateway came back — and certainly not what
      # OpenClaw did with its channel accounts afterwards.
      log "Public route is up — asked systemd to restart $UNIT ($REASON); a fresh gateway starts the channel accounts its supervisor gave up on"
    else
      # Nothing was restarted, so nothing may stand down against it. Withdrawing
      # the record is the safe direction: the worst it costs is one more restart
      # request, while a record for a restart that never happened is a swallowed
      # one.
      #
      # Only when there was a record to withdraw. An unanswerable route key
      # records nothing (see record_restart_asked_for), and removing the file on
      # that path would throw away an EARLIER waiter's good record instead. With
      # the lock held nothing else can be in here, so a stamp that is still
      # present now is this waiter's own; without it — the WARN path above —
      # a sibling's record can still be taken, which costs one extra restart and
      # never a swallowed one.
      if [ -n "$recovery" ]; then
        rm -f "$STAMP_FILE" 2>/dev/null || true
      fi
      log "Public route is up but the restart request for $UNIT failed"
    fi
    exit 0
  fi
  # Reached only when the route is not up: this waiter has now proven an
  # absence, and no later event may be coalesced away against a restart that
  # was asked for before it.
  saw_route_absent=1
  if [ "$(now_seconds)" -ge "$deadline" ]; then
    # A request that arrived while this waiter held the lock is not lost: take
    # it now and go round again, once per marker.
    if [ -e "$REARM_FILE" ]; then
      rm -f "$REARM_FILE" 2>/dev/null || true
      deadline=$(( $(now_seconds) + ONLINE_TIMEOUT ))
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
