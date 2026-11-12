#!/usr/bin/env bash
# Restart an OpenClaw gateway that is alive but has stopped answering HTTP.
#
# Installed ROOT-OWNED at /usr/local/libexec/clawbox/gateway-watchdog.sh by
# install.sh and run once a minute by clawbox-gateway-watchdog.timer (TASK-2490).
# Root runs it, so it must never be executed out of the clawbox-writable
# checkout — the same rule, and the same reason, as every file in that
# directory (TASK-445).
#
# WHY THIS EXISTS. A customer box (v4.3.0, OpenClaw 2026.10.9) showed "OpenClaw
# is not running" in Settings > Harness for more than seven hours, and nothing
# recovered it until a manual reboot. The gateway's log shows the process never
# exited: it stopped answering HTTP and stayed that way. `Restart=always` on
# clawbox-gateway.service only acts when the process EXITS, so systemd had
# nothing to catch, and the UI's probe (harnessHealthy in src/lib/harness.ts) can
# only report, not repair.
#
# THE PROBE is harnessHealthy's: a GET of the gateway's base URL on 127.0.0.1,
# where ANY HTTP answer — whatever its status — means the server is up, retried
# a few times with a short gap so one slow answer under load is not a failure.
# Only a refused, reset, empty or timed-out connection counts; a probe that
# could not run at all (no curl) counts for nothing. The per-attempt timeout
# is longer than the UI's (5 s against 2.5 s): this probe's verdict restarts
# something, the UI's only paints a badge.
#
# WHAT IT NEVER RESTARTS. Slow model calls do not reach this probe: a turn waits
# on its provider asynchronously, and the gateway's HTTP server keeps answering
# while DeepSeek takes 48 s to fail or llama.cpp generates on the CPU. Even so a
# restart needs a SUSTAINED outage — FAILURES consecutive failed runs, a minute
# apart, spanning at least MIN_OUTAGE seconds — and a fresh gateway gets
# STARTUP_GRACE seconds before it is probed at all. One answered probe clears
# the record. On top of that a cap: at most MAX_RESTARTS restarts in any
# RESTART_WINDOW, so a gateway that hangs again the moment it is back is
# restarted twice an hour, not sixty times.
#
# AND IT STANDS DOWN — clearing whatever it had counted — whenever the gateway
# is not this watchdog's to judge:
#
#   * the unit is not `loaded` (the Hermes edition MASKS it; an edition not yet
#     chosen has none). The same question the NetworkManager waiter asks (#1111),
#     answered by the same function in gateway-unit-guard.sh;
#   * the unit is not active+running: stopped by the owner, by the updater, by a
#     reset or `doctor --fix` (every ClawBox path that takes the gateway down does
#     it with `systemctl stop`), still in its ExecStartPre, restarting, frozen, or
#     with a job queued on it. The restart is `try-restart` with
#     `--job-mode=fail`, so even a stop that lands between the look and the act
#     is never replaced by a start (TASK-2200's "Job canceled" shape);
#   * setup is not complete (data/config.json `setup_complete`);
#   * an update owns the box (data/config.json `update_in_progress`, the flag the
#     updater keeps for the middleware, with its heartbeat) or any
#     clawbox-root-update@ step is running — post_update, a rebuild, the harness
#     swap and the edition choice all run as one of those;
#   * a harness swap or edition choice was requested in the last hour
#     (data/harness-swap.env, data/edition-select.env);
#   * the gateway maintenance guard is up (/run/clawbox-gateway-maintenance,
#     config/clawbox-gateway-maintenance.sh).
#
# Every restart decision — a failed probe counted, a restart asked for, one
# refused by the cap or by systemd, an outage that cleared on its own — is one
# line in the journal under the tag clawbox-gateway-watchdog, and so is each
# stand-down: once when its reason begins (and whenever it clears a count), and
# once when the watchdog judges again. A healthy box writes nothing.
#
# State is kept in the root-owned tmpfs (/run/clawbox), never in the
# clawbox-writable data/ directory: this runs as root and writes there, and /run
# is cleared on boot, which a count of consecutive failures wants anyway.
#
# Exit status is always 0: a watchdog that fails its own unit every minute is
# noise in `systemctl --failed`, and every outcome is in the journal.
set -u

LOG_TAG="clawbox-gateway-watchdog"
log() { logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true; }

UNIT="${CLAWBOX_GATEWAY_UNIT:-clawbox-gateway.service}"
ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
RUN_DIR="${CLAWBOX_RUN_DIR:-/run/clawbox}"
STATE_FILE="$RUN_DIR/gateway-watchdog.state"
RESTARTS_FILE="$RUN_DIR/gateway-watchdog.restarts"
# Why the last run stood down, so each reason is said once when it starts and
# once when it ends, not once a minute.
STANDDOWN_FILE="$RUN_DIR/gateway-watchdog.standdown"
# When this boot first saw an update flag it could not date (see below).
UPDATE_SEEN_FILE="$RUN_DIR/gateway-watchdog.update-seen"
MAINTENANCE_GUARD="${CLAWBOX_GATEWAY_MAINTENANCE_GUARD:-/run/clawbox-gateway-maintenance}"

GUARD="${CLAWBOX_GATEWAY_GUARD:-$(dirname "${BASH_SOURCE[0]}")/gateway-unit-guard.sh}"
# shellcheck source=scripts/gateway-unit-guard.sh
if ! { [ -f "$GUARD" ] && . "$GUARD"; }; then
  log "ERROR: $GUARD missing or unreadable — cannot judge $UNIT; not probing"
  exit 0
fi

# The port the gateway listens on is the one its own unit gives it: harness.ts
# reads GATEWAY_PORT from the web server's environment, and a unit that sets it
# (install-x64.sh's does) sets the gateway's OPENCLAW_GATEWAY_PORT beside it. A
# root oneshot inherits neither, so it asks the unit; 18789 otherwise, which is
# what the Jetson unit runs on. An explicit GATEWAY_PORT (the tests) wins.
unit_port() {
  local env word
  env="$(systemctl show -p Environment --value "$UNIT" 2>/dev/null)" || return 0
  for word in $env; do
    case "$word" in
      OPENCLAW_GATEWAY_PORT=*|GATEWAY_PORT=*) printf '%s' "${word#*=}"; return 0 ;;
    esac
  done
}
PORT="$(positive_int "${GATEWAY_PORT:-$(unit_port)}" 18789)"
PROBE_URL="http://127.0.0.1:${PORT}/"
PROBE_TIMEOUT="$(positive_int "${CLAWBOX_WATCHDOG_PROBE_TIMEOUT:-}" 5)"
PROBE_ATTEMPTS="$(positive_int "${CLAWBOX_WATCHDOG_PROBE_ATTEMPTS:-}" 3)"
FAILURES="$(positive_int "${CLAWBOX_WATCHDOG_FAILURES:-}" 5)"
MIN_OUTAGE="$(positive_int "${CLAWBOX_WATCHDOG_MIN_OUTAGE:-}" 240)"
# A record whose last failure is older than this is not part of the same run of
# failures: the timer was held (an update, a stop) or the box was suspended.
STALE_AFTER="$(positive_int "${CLAWBOX_WATCHDOG_STALE_AFTER:-}" 300)"
# A cold Jetson's gateway answers HTTP a minute or more after its ExecStart;
# a restart's own start must never read as the outage continuing.
STARTUP_GRACE="$(positive_int "${CLAWBOX_WATCHDOG_STARTUP_GRACE:-}" 300)"
MAX_RESTARTS="$(positive_int "${CLAWBOX_WATCHDOG_MAX_RESTARTS:-}" 2)"
RESTART_WINDOW="$(positive_int "${CLAWBOX_WATCHDOG_RESTART_WINDOW:-}" 3600)"
# The updater refreshes its lock at every step boundary (src/lib/update-lock.ts,
# a 20-minute heartbeat; a llama.cpp compile can hold one step for ~20 more). A
# lock older than this belongs to a run that died, and the boot-time check will
# release it — it must not switch this watchdog off until then.
UPDATE_LOCK_MAX_AGE="$(positive_int "${CLAWBOX_WATCHDOG_UPDATE_LOCK_MAX_AGE:-}" 7200)"
# The harness-swap route's request is an intent with a time on it; install.sh
# reads one older than an hour as stale, and so does this.
REQUEST_MAX_AGE=3600

# The monotonic clock, overridable only so the tests can move time.
now_mono() {
  if [ -n "${CLAWBOX_WATCHDOG_CLOCK:-}" ]; then
    printf '%s' "$CLAWBOX_WATCHDOG_CLOCK"
    return 0
  fi
  monotonic_seconds
}

NOW="$(now_mono)" || NOW=""
case "$NOW" in
  ''|*[!0-9]*)
    log "ERROR: no monotonic clock (/proc/uptime) — cannot measure an outage; not probing"
    exit 0
    ;;
esac

mkdir -p "$RUN_DIR" 2>/dev/null || true

# ── the record ──────────────────────────────────────────────────────────────
# One line: <invocation id> <first failure> <last failure> <count> <cap said>
# Staged and renamed, so a half-written line never reads as a count.
REC_INVOCATION="" REC_FIRST="" REC_LAST="" REC_COUNT=0 REC_CAPPED=0
read_record() {
  REC_INVOCATION="" REC_FIRST="" REC_LAST="" REC_COUNT=0 REC_CAPPED=0
  [ -f "$STATE_FILE" ] || return 1
  read -r REC_INVOCATION REC_FIRST REC_LAST REC_COUNT REC_CAPPED _ < "$STATE_FILE" 2>/dev/null || true
  case "$REC_FIRST$REC_LAST$REC_COUNT$REC_CAPPED" in
    ''|*[!0-9]*) REC_INVOCATION="" REC_FIRST="" REC_LAST="" REC_COUNT=0 REC_CAPPED=0; return 1 ;;
  esac
  [ -n "$REC_INVOCATION" ]
}
write_record() {
  if ! { printf '%s %s %s %s %s\n' "$1" "$2" "$3" "$4" "$5" > "$STATE_FILE.new" 2>/dev/null \
         && mv -f "$STATE_FILE.new" "$STATE_FILE" 2>/dev/null; }; then
    rm -f "$STATE_FILE.new" 2>/dev/null || true
    log "WARN: could not record the failed probe in $STATE_FILE — the outage cannot be counted, so it will not be restarted"
  fi
}

# Stand down: stand_down KEY MESSAGE. A count in progress is cleared, because a
# deliberate stop, an update or a swap in the middle of an outage is a different
# story from the outage carrying on. Said in the journal when it clears a count,
# and otherwise once per reason (KEY) — when it begins, not every minute it lasts;
# the run that judges again says that too.
stand_down() {
  local key="$1" msg="$2" last=""
  read -r last _ < "$STANDDOWN_FILE" 2>/dev/null || true
  if read_record; then
    log "Not judging $UNIT: $msg — cleared ${REC_COUNT} failed probe(s) counted since $(( NOW - REC_FIRST ))s ago"
  elif [ "$last" != "$key" ]; then
    log "Not judging $UNIT: $msg"
  fi
  [ "$last" = "$key" ] || printf '%s\n' "$key" > "$STANDDOWN_FILE" 2>/dev/null || true
  rm -f "$STATE_FILE" 2>/dev/null || true
  exit 0
}

# ── whose gateway is it right now ───────────────────────────────────────────
load_rc=0
gateway_unit_load_state "$UNIT" >/dev/null || load_rc=$?
case "$load_rc" in
  0) ;;
  # Hermes, or no gateway installed: nothing here, every minute, so silent.
  1) rm -f "$STATE_FILE" "$STANDDOWN_FILE" 2>/dev/null || true; exit 0 ;;
  *) stand_down no-systemd "systemctl did not answer for its load state" ;;
esac

[ -e "$MAINTENANCE_GUARD" ] && stand_down maintenance "the gateway maintenance guard is up ($MAINTENANCE_GUARD)"

# Any root step in flight: post_update, a rebuild, harness_swap, edition_select,
# gateway_setup… all run as clawbox-root-update@<step>.service, a oneshot that is
# `activating` for exactly as long as it works.
busy_steps="$(systemctl list-units --plain --no-legend --no-pager --all \
  --state=activating,deactivating,reloading,active 'clawbox-root-update@*' 2>/dev/null \
  | awk 'NF { print $1 }' | paste -sd' ' -)"
[ -n "$busy_steps" ] && stand_down root-step "a root step is running ($busy_steps)"

# data/config.json, read by a parser and never sourced: it is written by the
# web server, i.e. by the clawbox user, and this runs as root. A link, a
# directory or a FIFO in its place is not the store the web server writes.
config_facts() {
  local cfg="$ROOT/data/config.json"
  if [ -L "$cfg" ] || [ ! -f "$cfg" ]; then
    printf 'unknown'
    return 0
  fi
  timeout 10 python3 -I - "$cfg" <<'PY' 2>/dev/null || printf 'unknown'
import datetime, json, sys, time
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        cfg = json.load(fh)
    if not isinstance(cfg, dict):
        raise ValueError
except Exception:
    print("unknown")
    sys.exit(0)
setup = cfg.get("setup_complete") is True
updating = cfg.get("update_in_progress") is True
age = "-"
if updating:
    holder = cfg.get("update_lock_holder")
    at = holder.get("at") if isinstance(holder, dict) else None
    try:
        when = datetime.datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        if when.tzinfo is None:
            when = when.replace(tzinfo=datetime.timezone.utc)
        age = str(int(time.time() - when.timestamp()))
    except Exception:
        age = "-"
print("%d %d %s" % (setup, updating, age))
PY
}
facts="$(config_facts)"
case "$facts" in
  unknown|'') stand_down no-config "data/config.json could not be read, so setup cannot be shown complete" ;;
esac
read -r setup_done updating lock_age _ <<<"$facts"
[ "$setup_done" = "1" ] || stand_down setup "setup is not complete"
# The updater's flag. Its holder record says when the run last moved; a record
# younger than UPDATE_LOCK_MAX_AGE is an update in progress. A flag this cannot
# date — no holder (a build that predates it), no parseable time, or one dated
# more than five minutes ahead — is timed from when THIS boot first saw it, so a
# flag a dead run left behind still stops silencing the watchdog after the same
# two hours instead of never.
if [ "$updating" = "1" ]; then
  dated=1
  case "$lock_age" in ''|-|*[!0-9-]*) dated=0 ;; esac
  if [ "$dated" = 1 ] && [ "$lock_age" -lt -300 ]; then dated=0; fi
  if [ "$dated" = 1 ]; then
    rm -f "$UPDATE_SEEN_FILE" 2>/dev/null || true
    [ "$lock_age" -le "$UPDATE_LOCK_MAX_AGE" ] \
      && stand_down update "an update is in progress (lock refreshed ${lock_age}s ago)"
  else
    seen=""
    read -r seen _ < "$UPDATE_SEEN_FILE" 2>/dev/null || true
    case "$seen" in
      ''|*[!0-9]*) seen="$NOW"; printf '%s\n' "$NOW" > "$UPDATE_SEEN_FILE" 2>/dev/null || true ;;
    esac
    [ "$seen" -gt "$NOW" ] && { seen="$NOW"; printf '%s\n' "$NOW" > "$UPDATE_SEEN_FILE" 2>/dev/null || true; }
    lock_age="$(( NOW - seen ))"
    [ "$lock_age" -le "$UPDATE_LOCK_MAX_AGE" ] \
      && stand_down update-undated "an update is in progress (its lock carries no usable time; seen for ${lock_age}s)"
  fi
  # Older than any step: a run that died. Said once per run of failures below,
  # by the probe line, and judged as a box that is not updating.
else
  rm -f "$UPDATE_SEEN_FILE" 2>/dev/null || true
fi

# A request file the swap / edition routes write, with REQUESTED_AT inside the
# last hour (five minutes forward is clock skew). Parsed, never sourced.
fresh_request() {
  local req="$1" line at now
  [ -f "$req" ] && [ ! -L "$req" ] || return 1
  # Bounded: the shape checks above leave a moment for a FIFO to be swapped in.
  line="$(timeout 5 grep -m1 -E '^[[:space:]]*(export[[:space:]]+)?REQUESTED_AT=' "$req" 2>/dev/null)" || return 1
  at="${line#*=}"
  at="${at//\"/}"
  at="${at//\'/}"
  case "$at" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#at}" -le 12 ] || return 1
  now="$(date +%s)"
  [ "$at" -le $(( now + 300 )) ] && [ "$at" -ge $(( now - REQUEST_MAX_AGE )) ]
}
for req in harness-swap.env edition-select.env; do
  fresh_request "$ROOT/data/$req" && stand_down "request-$req" "a harness change was requested (data/$req)"
done

# The unit itself. Only a unit that is up, running and has nothing queued is
# one whose silence means something.
unit_props="$(systemctl show -p ActiveState -p SubState -p MainPID -p InvocationID \
  -p ActiveEnterTimestampMonotonic -p FreezerState "$UNIT" 2>/dev/null)"
prop() { printf '%s\n' "$unit_props" | sed -n "s/^$1=//p" | head -n 1; }
active_state="$(prop ActiveState)"
sub_state="$(prop SubState)"
main_pid="$(prop MainPID)"
invocation="$(prop InvocationID)"
entered_us="$(prop ActiveEnterTimestampMonotonic)"
freezer="$(prop FreezerState)"

[ "$active_state" = "active" ] && [ "$sub_state" = "running" ] \
  || stand_down "state-${active_state:-unknown}" "it is ${active_state:-unknown}/${sub_state:-unknown}, not running — stopped on purpose, starting or restarting"
case "$freezer" in ''|running) ;; *) stand_down frozen "its cgroup is $freezer" ;; esac
case "$main_pid" in ''|0|*[!0-9]*) stand_down no-pid "it has no main process" ;; esac
[ -n "$invocation" ] || stand_down no-invocation "systemctl did not name its invocation"
unit_jobs() { systemctl list-jobs --plain --no-legend --no-pager "$UNIT" 2>/dev/null | awk 'NF'; }
if [ -n "$(unit_jobs)" ]; then
  stand_down job "a job is already queued for it"
fi

# A fresh gateway is still binding its port. ActiveEnterTimestampMonotonic is
# CLOCK_MONOTONIC in microseconds, /proc/uptime is CLOCK_BOOTTIME: the same
# count on a box that has never suspended (an appliance does not), and after a
# suspend boot time runs ahead, so the grace ends early by the time slept — which
# only starts the count sooner; a restart still needs the sustained window.
case "$entered_us" in
  ''|*[!0-9]*) stand_down no-start-time "systemctl did not say when it started" ;;
esac
up_for=$(( NOW - entered_us / 1000000 ))
if [ "$up_for" -lt "$STARTUP_GRACE" ]; then
  # Nothing to clear when this invocation never failed; a record from the one
  # before it is stale by construction (the invocation id moved).
  read_record && [ "$REC_INVOCATION" != "$invocation" ] && rm -f "$STATE_FILE" 2>/dev/null
  exit 0
fi

# ── the probe ───────────────────────────────────────────────────────────────
# curl without -f exits 0 for ANY HTTP answer, which is harnessHealthy's rule:
# a 401, a 404 or a 500 is a server that is up. 7 is refused, 28 a timeout,
# 52 an empty reply, 56 a reset.
probe_rc=0
probe() {
  local attempt=1 rc=0
  while :; do
    rc=0
    curl -sS -o /dev/null --max-time "$PROBE_TIMEOUT" "$PROBE_URL" >/dev/null 2>&1 || rc=$?
    [ "$rc" -eq 0 ] && return 0
    probe_rc="$rc"
    # Only a server that refused, reset, timed out or hung up on us is evidence
    # about the gateway. curl missing (127), a bad URL, a failed write… say
    # nothing about it, and must never add up to a restart.
    case "$rc" in 7|28|52|56) ;; *) return 2 ;; esac
    [ "$attempt" -ge "$PROBE_ATTEMPTS" ] && return 1
    attempt=$(( attempt + 1 ))
    sleep 0.25
  done
}
describe_rc() {
  case "$1" in
    7) printf 'connection refused' ;;
    28) printf 'no answer within %ss' "$PROBE_TIMEOUT" ;;
    52) printf 'empty reply' ;;
    56) printf 'connection reset' ;;
    *) printf 'curl exit %s' "$1" ;;
  esac
}
# What the kernel says the main process is doing: R running, S sleeping,
# D in uninterruptible I/O, T stopped, Z zombie. Diagnostics for the journal.
proc_state() {
  local stat
  stat="$(cat "/proc/$main_pid/stat" 2>/dev/null)" || { printf '?'; return 0; }
  stat="${stat##*) }"
  printf '%s' "${stat%% *}"
}

probe_verdict=0
probe || probe_verdict=$?
if [ "$probe_verdict" -eq 2 ]; then
  stand_down "probe-error-$probe_rc" "the probe itself could not run (curl exit $probe_rc), which says nothing about the gateway"
fi
# Judging again after a stand-down: said once.
if [ -f "$STANDDOWN_FILE" ]; then
  read -r was _ < "$STANDDOWN_FILE" 2>/dev/null || was=""
  rm -f "$STANDDOWN_FILE" 2>/dev/null || true
  log "Judging $UNIT again (stood down for: ${was:-unknown})"
fi
if [ "$probe_verdict" -eq 0 ]; then
  if read_record; then
    log "$UNIT answers HTTP again on port $PORT after ${REC_COUNT} failed probe(s) over $(( NOW - REC_FIRST ))s — not restarting"
  fi
  rm -f "$STATE_FILE" 2>/dev/null || true
  exit 0
fi

# A failed probe. Counted on this invocation's record; a record from another
# invocation (the gateway restarted meanwhile), or one whose last failure is too
# old to be part of the same run, starts over.
first="$NOW" count=1 capped=0
if read_record && [ "$REC_INVOCATION" = "$invocation" ] && [ $(( NOW - REC_LAST )) -le "$STALE_AFTER" ] \
   && [ "$REC_FIRST" -le "$NOW" ]; then
  first="$REC_FIRST" count=$(( REC_COUNT + 1 )) capped="$REC_CAPPED"
fi
outage=$(( NOW - first ))
why="$(describe_rc "$probe_rc"), main process $main_pid state $(proc_state)"
if [ "$updating" = "1" ] && [ "$count" -eq 1 ]; then
  log "WARN: data/config.json says an update is in progress, but its lock was last refreshed ${lock_age}s ago — a run that died; judging $UNIT anyway"
fi

if [ "$count" -lt "$FAILURES" ] || [ "$outage" -lt "$MIN_OUTAGE" ]; then
  write_record "$invocation" "$first" "$NOW" "$count" "$capped"
  log "$UNIT did not answer HTTP on port $PORT ($why) — failed probe $count, unresponsive for ${outage}s; a restart needs $FAILURES over at least ${MIN_OUTAGE}s"
  exit 0
fi

# Sustained. The cap first: restarts asked for in the last RESTART_WINDOW.
recent=0 kept=""
if [ -f "$RESTARTS_FILE" ]; then
  while read -r at _; do
    case "$at" in ''|*[!0-9]*) continue ;; esac
    [ "$at" -le "$NOW" ] || continue
    if [ $(( NOW - at )) -lt "$RESTART_WINDOW" ]; then
      recent=$(( recent + 1 ))
      kept="${kept}${at}"$'\n'
    fi
  done < "$RESTARTS_FILE"
fi
if [ "$recent" -ge "$MAX_RESTARTS" ]; then
  # Said once per run of failures, not once a minute.
  if [ "$capped" != "1" ]; then
    log "NOT restarting $UNIT although it has not answered HTTP for ${outage}s ($why): it was already restarted $recent time(s) in the last ${RESTART_WINDOW}s, the most allowed — waiting for that window to pass"
  fi
  write_record "$invocation" "$first" "$NOW" "$count" 1
  exit 0
fi

# Recorded BEFORE the request, so a restart is never asked for twice by two
# runs that both read an old count; withdrawn below if systemd refuses it.
if ! { printf '%s' "$kept" > "$RESTARTS_FILE.new" 2>/dev/null \
       && printf '%s\n' "$NOW" >> "$RESTARTS_FILE.new" 2>/dev/null \
       && mv -f "$RESTARTS_FILE.new" "$RESTARTS_FILE" 2>/dev/null; }; then
  rm -f "$RESTARTS_FILE.new" 2>/dev/null || true
  log "NOT restarting $UNIT although it has not answered HTTP for ${outage}s ($why): the restart could not be recorded in $RESTARTS_FILE, so the hourly cap could not hold"
  write_record "$invocation" "$first" "$NOW" "$count" "$capped"
  exit 0
fi

# try-restart: never STARTS a unit that went down meanwhile. --job-mode=fail: a
# stop or start already queued (the updater, the owner) wins, and this request
# is refused rather than replacing it. --no-block: the stop can take
# TimeoutStopSec and the start its whole ExecStartPre; the next run sees the unit
# activating and stands down until the new gateway is past its grace.
#
# try-restart also answers 0 for a unit that went down between the look above
# and this call, having done nothing. So the request counts only once systemd
# shows it working: a job queued on the unit, the unit stopping or starting, or
# a new invocation already. Anything else was no restart, and is not recorded
# as one.
restart_rc=0
systemctl --no-block --job-mode=fail try-restart "$UNIT" >/dev/null 2>&1 || restart_rc=$?
restart_seen=0
if [ "$restart_rc" -eq 0 ]; then
  after="$(systemctl show -p ActiveState -p InvocationID "$UNIT" 2>/dev/null)"
  after_state="$(printf '%s\n' "$after" | sed -n 's/^ActiveState=//p' | head -n 1)"
  after_inv="$(printf '%s\n' "$after" | sed -n 's/^InvocationID=//p' | head -n 1)"
  if [ -n "$(unit_jobs)" ] || [ "$after_inv" != "$invocation" ]; then
    restart_seen=1
  else
    case "$after_state" in deactivating|activating|reloading) restart_seen=1 ;; esac
  fi
fi
if [ "$restart_seen" -eq 1 ]; then
  rm -f "$STATE_FILE" 2>/dev/null || true
  log "RESTARTING $UNIT: no HTTP answer on port $PORT for ${outage}s across $count consecutive probes ($why) — asked systemd for a restart ($(( recent + 1 )) of at most $MAX_RESTARTS per ${RESTART_WINDOW}s)"
else
  printf '%s' "$kept" > "$RESTARTS_FILE.new" 2>/dev/null && mv -f "$RESTARTS_FILE.new" "$RESTARTS_FILE" 2>/dev/null \
    || rm -f "$RESTARTS_FILE.new" 2>/dev/null || true
  if [ "$restart_rc" -ne 0 ]; then
    write_record "$invocation" "$first" "$NOW" "$count" "$capped"
    log "Wanted to restart $UNIT (no HTTP answer for ${outage}s, $why) but systemd refused the request — another job for the unit, or it stopped meanwhile; trying again next run"
  else
    rm -f "$STATE_FILE" 2>/dev/null || true
    log "Wanted to restart $UNIT (no HTTP answer for ${outage}s, $why) but nothing was restarted: it is ${after_state:-unknown} with no job queued — stopped meanwhile, on purpose; not counted"
  fi
fi
exit 0
