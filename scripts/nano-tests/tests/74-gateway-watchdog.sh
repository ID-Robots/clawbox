#!/usr/bin/env bash
# timeout: 2400
# tier: long
# covers: scripts/gateway-watchdog.sh scripts/gateway-unit-guard.sh config/clawbox-gateway-watchdog.*
#
# The gateway liveness watchdog (TASK-2490): an OpenClaw gateway whose process
# is alive but no longer answers HTTP is restarted, and only after a sustained
# outage; a slow-but-alive one never is.
#
# On OpenClaw:
#   1. clawbox-gateway-watchdog.timer is enabled and active, and the root-owned
#      /usr/local/libexec/clawbox/gateway-watchdog.sh (and the guard it sources)
#      is byte-identical to the checkout's — what install.sh put there.
#   2. Alive but slow: a real agent turn is in flight while the gateway is
#      SIGSTOPped for 150 s — shorter than the watchdog's four-minute window —
#      and SIGCONTed. Six and a half minutes after the stall began the gateway
#      must still be the same invocation and the same process: no restart.
#   3. Hung: the gateway's main process is SIGSTOPped and left stopped. The
#      watchdog must restart the unit (a new InvocationID) no sooner than its
#      four-minute window and within 15 minutes, log the decision to the
#      journal, and the gateway must come back healthy and settled.
#   Cleanup, always: SIGCONT the stopped process if it still exists, and
#   restart the gateway if it is not running.
#
# On Hermes: the watchdog must be absent (no timer, no libexec script), the
# gateway unit masked, and the box's agent runtime settled — nothing broken.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

LIBEXEC=/usr/local/libexec/clawbox
RUNTIME=$(board_runtime)
note "agent runtime: $RUNTIME"

if [ "$RUNTIME" = hermes ]; then
  # shellcheck disable=SC2016  # expanded on the board
  STATE=$(board '
    echo "timer_load=$(systemctl show -p LoadState --value clawbox-gateway-watchdog.timer 2>/dev/null)"
    echo "timer_active=$(systemctl is-active clawbox-gateway-watchdog.timer 2>/dev/null)"
    echo "service_load=$(systemctl show -p LoadState --value clawbox-gateway-watchdog.service 2>/dev/null)"
    echo "script=$([ -e "$1/gateway-watchdog.sh" ] && echo present || echo absent)"
    echo "gateway_load=$(systemctl show -p LoadState --value clawbox-gateway.service 2>/dev/null)"
    echo "failed=$(systemctl list-units --failed --plain --no-legend "clawbox*" 2>/dev/null | awk "{print \$1}" | paste -sd, -)"
  ' "$LIBEXEC")
  while IFS= read -r l; do note "$l"; done <<<"$STATE"
  val() { sed -n "s/^$1=//p" <<<"$STATE" | head -n1; }
  case "$(val timer_load)" in
    not-found|masked) ok "no gateway watchdog timer on the Hermes box ($(val timer_load))" ;;
    *) not_ok "the gateway watchdog timer is $(val timer_load)/$(val timer_active) on a Hermes box" ;;
  esac
  [ "$(val timer_active)" != active ] && ok "the watchdog timer is not running" || not_ok "the watchdog timer is active on a Hermes box"
  [ "$(val script)" = absent ] && ok "$LIBEXEC/gateway-watchdog.sh is not installed" || not_ok "$LIBEXEC/gateway-watchdog.sh is still installed"
  [ "$(val gateway_load)" = masked ] && ok "clawbox-gateway.service is masked, as the Hermes edition leaves it" \
    || not_ok "clawbox-gateway.service is $(val gateway_load) on a Hermes box"
  [ -z "$(val failed)" ] && ok "no clawbox unit failed" || not_ok "failed units: $(val failed)"
  if wait_runtime_settled 300; then
    ok "the Hermes runtime is settled"
  else
    not_ok "the Hermes runtime did not settle: ${SETTLE_STATE:-unknown}"
  fi
  finish
fi

# ---- 1. installed -------------------------------------------------------------

# shellcheck disable=SC2016  # expanded on the board
STATE=$(board '
  echo "timer_enabled=$(systemctl is-enabled clawbox-gateway-watchdog.timer 2>/dev/null)"
  echo "timer_active=$(systemctl is-active clawbox-gateway-watchdog.timer 2>/dev/null)"
  echo "service_load=$(systemctl show -p LoadState --value clawbox-gateway-watchdog.service 2>/dev/null)"
  for f in gateway-watchdog.sh gateway-unit-guard.sh; do
    if cmp -s "$REPO/scripts/$f" "$1/$f"; then s=current; elif [ -e "$1/$f" ]; then s=stale; else s=absent; fi
    echo "$f=$s owner=$(stat -c %U "$1/$f" 2>/dev/null)"
  done
' "$LIBEXEC")
while IFS= read -r l; do note "$l"; done <<<"$STATE"
val() { sed -n "s/^$1=//p" <<<"$STATE" | head -n1; }
if [ "$(val timer_enabled)" = enabled ] && [ "$(val timer_active)" = active ]; then
  ok "clawbox-gateway-watchdog.timer is enabled and active"
else
  not_ok "clawbox-gateway-watchdog.timer is $(val timer_enabled)/$(val timer_active)"
fi
[ "$(val service_load)" = loaded ] && ok "clawbox-gateway-watchdog.service is installed" || not_ok "clawbox-gateway-watchdog.service is $(val service_load)"
for f in gateway-watchdog.sh gateway-unit-guard.sh; do
  case "$(val "$f")" in
    "current owner=root") ok "$LIBEXEC/$f is root-owned and matches the checkout" ;;
    *) not_ok "$LIBEXEC/$f: $(val "$f")" ;;
  esac
done
if [ "$NANO_TEST_FAILED" != 0 ]; then
  note "the watchdog is not installed as expected; not hanging a gateway nothing would restart"
  finish
fi

# ---- helpers ------------------------------------------------------------------

# "<invocation> <main pid> <active>/<sub> <seconds up>"
unit_now() {
  # shellcheck disable=SC2016  # expanded on the board
  board '
    p=$(systemctl show -p InvocationID -p MainPID -p ActiveState -p SubState -p ActiveEnterTimestampMonotonic clawbox-gateway.service 2>/dev/null)
    g() { printf "%s\n" "$p" | sed -n "s/^$1=//p"; }
    read -r up _ < /proc/uptime
    entered=$(g ActiveEnterTimestampMonotonic)
    echo "$(g InvocationID) $(g MainPID) $(g ActiveState)/$(g SubState) $(( ${up%%.*} - ${entered:-0} / 1000000 ))"
  ' | tail -n 1
}

STOPPED_PID=
cleanup() {
  if [ -n "$STOPPED_PID" ]; then
    # shellcheck disable=SC2016  # expanded on the board
    board 'kill -CONT "$1" 2>/dev/null || true' "$STOPPED_PID" >/dev/null
  fi
  # shellcheck disable=SC2016  # expanded on the board
  board '
    case "$(systemctl is-active clawbox-gateway.service 2>/dev/null)" in
      active|activating) ;;
      *) sudo -n /usr/bin/systemctl restart clawbox-gateway.service >/dev/null 2>&1 || true ;;
    esac
  ' >/dev/null
}
trap cleanup EXIT

watchdog_journal() {
  # shellcheck disable=SC2016  # expanded on the board
  board 'journalctl -t clawbox-gateway-watchdog --since "@$1" --no-pager -o cat 2>/dev/null | tail -n 20' "$1" \
    | while IFS= read -r l; do note "watchdog: $l"; done
}

# A gateway past the watchdog's 300 s start-up grace, so its clock is running.
wait_past_grace() {
  local deadline=$(( $(date +%s) + 900 )) up
  while [ "$(date +%s)" -lt "$deadline" ]; do
    read -r _ _ state up <<<"$(unit_now)"
    if [ "$state" = active/running ] && [ "${up:-0}" -ge 330 ] 2>/dev/null; then return 0; fi
    sleep 20
  done
  return 1
}

if ! wait_gateway_settled 600; then
  not_ok "the gateway did not settle before the test: ${SETTLE_STATE:-unknown}"
  finish
fi
if ! wait_past_grace; then
  not_ok "the gateway did not stay up past the watchdog's start-up grace: $(unit_now)"
  finish
fi

# ---- 2. slow but alive: never restarted ---------------------------------------

read -r INV0 PID0 STATE0 UP0 <<<"$(unit_now)"
note "before the stall: invocation $INV0, main pid $PID0, $STATE0, up ${UP0}s"
STALL_AT=$(board 'date +%s' | tail -n 1)
TURN_OUT="/tmp/nano-ci-watchdog-turn-$(printf '%s' "$NANO_RUN_ID" | tr -c 'A-Za-z0-9._-' '-')"
# A real agent turn, in flight across the stall: a long answer asked for, with
# its own session so it never lands in the board's main chat.
# shellcheck disable=SC2016  # expanded on the board
board '
  rm -f "$2"
  setsid nohup timeout 420 "$1" agent --agent main --session-key "nano-ci-watchdog-$3" \
    -m "Write a detailed 1500-word essay about lighthouses, then end with the word DONE." \
    --json --timeout 400 >"$2" 2>&1 </dev/null &
' "$OPENCLAW_BIN" "$TURN_OUT" "$NANO_RUN_ID" >/dev/null
sleep 10
# shellcheck disable=SC2016  # expanded on the board
board 'kill -STOP "$1"' "$PID0" >/dev/null
STOPPED_PID=$PID0
note "gateway pid $PID0 stopped for 150 s (the watchdog restarts only after 240 s and five failed probes)"
sleep 150
# shellcheck disable=SC2016  # expanded on the board
board 'kill -CONT "$1"' "$PID0" >/dev/null
STOPPED_PID=
gateway_probe /
note "after SIGCONT the gateway answers HTTP $PROBE_STATUS"
# Long enough after the stall began for a restart to have happened had the
# watchdog counted the stall as an outage: 150 s stalled + 240 s more.
sleep 240
read -r INV1 PID1 STATE1 _ <<<"$(unit_now)"
if [ "$INV1" = "$INV0" ] && [ "$PID1" = "$PID0" ] && [ "$STATE1" = active/running ]; then
  ok "a 150 s stall is not restarted: same invocation and process 6.5 min later"
else
  not_ok "the gateway changed across a short stall: $INV0/$PID0 -> $INV1/$PID1 ($STATE1)"
fi
# shellcheck disable=SC2016  # expanded on the board
TURN=$(board 'tail -c 2000 "$1" 2>/dev/null | tr "\n" " " | tail -c 300; rm -f "$1"' "$TURN_OUT" | tail -n 1)
note "the in-flight agent turn: ${TURN:-<no output>}"
SAID=$(board 'journalctl -t clawbox-gateway-watchdog --since "@$1" --no-pager -o cat 2>/dev/null' "$STALL_AT")
if grep -q '^RESTARTING' <<<"$SAID"; then
  not_ok "the watchdog asked for a restart during the short stall"
else
  ok "the watchdog asked for no restart during the short stall"
fi
grep -q 'did not answer HTTP' <<<"$SAID" && note "it counted the stall's failed probes, as it should" || note "no failed probe fell inside the stall"
watchdog_journal "$STALL_AT"

# ---- 3. hung: restarted within the window ------------------------------------

if ! wait_gateway_settled 300; then
  note "the gateway is degraded after the stall: ${SETTLE_STATE:-unknown}"
fi
read -r INV0 PID0 STATE0 UP0 <<<"$(unit_now)"
if [ "${UP0:-0}" -lt 330 ] 2>/dev/null; then wait_past_grace || true; read -r INV0 PID0 STATE0 UP0 <<<"$(unit_now)"; fi
HANG_AT=$(board 'date +%s' | tail -n 1)
# shellcheck disable=SC2016  # expanded on the board
board 'kill -STOP "$1"' "$PID0" >/dev/null
STOPPED_PID=$PID0
note "gateway pid $PID0 (invocation $INV0, up ${UP0}s) stopped and left stopped at $HANG_AT"

RESTARTED_AFTER=
deadline=$(( $(date +%s) + 900 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 15
  read -r INV1 PID1 STATE1 _ <<<"$(unit_now)"
  if [ -n "$INV1" ] && [ "$INV1" != "$INV0" ]; then
    RESTARTED_AFTER=$(( $(board 'date +%s' | tail -n 1) - HANG_AT ))
    break
  fi
done
STOPPED_PID=
if [ -z "$RESTARTED_AFTER" ]; then
  not_ok "the hung gateway was not restarted within 15 minutes (still $INV1/$PID1, $STATE1)"
else
  note "new invocation $INV1 ($STATE1) ${RESTARTED_AFTER}s after the hang"
  if [ "$RESTARTED_AFTER" -ge 230 ]; then
    ok "the hung gateway was restarted after ${RESTARTED_AFTER}s, not before the sustained window"
  else
    not_ok "the hung gateway was restarted after only ${RESTARTED_AFTER}s, inside the watchdog's 240 s window"
  fi
fi
SAID=$(board 'journalctl -t clawbox-gateway-watchdog --since "@$1" --no-pager -o cat 2>/dev/null' "$HANG_AT")
if grep -q '^RESTARTING clawbox-gateway.service' <<<"$SAID"; then
  ok "the restart decision is in the journal"
else
  not_ok "no RESTARTING line from clawbox-gateway-watchdog in the journal"
fi
watchdog_journal "$HANG_AT"
# shellcheck disable=SC2016  # expanded on the board
GONE=$(board 'if kill -0 "$1" 2>/dev/null; then echo alive; else echo gone; fi' "$PID0" | tail -n 1)
[ "$GONE" = gone ] && ok "the hung process $PID0 is gone" || not_ok "the hung process $PID0 is still there"

if wait_gateway_health 600 && wait_gateway_settled 600; then
  ok "the gateway is back and settled after the watchdog's restart"
else
  not_ok "the gateway did not come back after the watchdog's restart: ${SETTLE_STATE:-health ${API_STATUS}}"
fi
finish
