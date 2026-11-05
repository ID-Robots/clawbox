#!/usr/bin/env bash
# timeout: 4200
# tier: long
# covers: src/lib/gateway-unit-job.ts config/clawbox-gateway-maintenance.sh
#
# The update's gateway stop survives another job taking its place (TASK-2200).
#
# systemd keeps one job per unit: a start or restart queued while
# `systemctl stop clawbox-gateway.service` runs replaces the stop, and the
# stop's client says "Job for clawbox-gateway.service canceled." That sentence
# ended "Applying system fixups" before it ran a fixup, on a box whose gateway
# was down a moment later all the same.
#
#   1. The race on this board's systemd (OpenClaw only): under the updater's
#      maintenance guard, a restart queued while the gateway is stopping
#      cancels the stop, and the unit still ends down — the guard's condition
#      skips the start that won. The gateway is started again after.
#   2. The update path, raced: a watcher queues `systemctl restart
#      clawbox-gateway.service` (the web server's own sudo grant) each time the
#      gateway is stopping under the guard — from now, and again from @reboot
#      after the update's reboot, which is where "Applying system fixups" runs.
#      An owner's update to NANO_BRANCH must end `completed` with that step
#      completed, on NANO_SHA, with the runtime settled. On Hermes nothing
#      stops the gateway; the fixups step must complete all the same.
#
# Skipped without NANO_BRANCH or NANO_SHA.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "${NANO_BRANCH:-}" ]; then
  skip "NANO_BRANCH is not set: the updater needs the branch the commit under test is on"
  finish
fi
if [ -z "${NANO_SHA:-}" ]; then
  skip "NANO_SHA is not set: nothing to check the update landed on"
  finish
fi

RUNTIME=$(board_runtime)
note "agent runtime: $RUNTIME"
RACE_DIR="/home/clawbox/.cache/nano-ci-race-$(printf '%s' "$NANO_RUN_ID" | tr -c 'A-Za-z0-9._-' '-')"
RACE_TAG=${RACE_DIR##*/}

# ---- 1. the race itself ------------------------------------------------------

# shellcheck disable=SC2016  # expanded on the board
RACE_ONCE='
gw() { systemctl show clawbox-gateway.service -p ActiveState --value 2>/dev/null; }
sudo -n /usr/local/libexec/clawbox/clawbox-gateway-maintenance.sh enter >/dev/null 2>&1 || { echo "guard=unavailable"; exit 0; }
# Never leave the guard up behind a dropped session: it holds the gateway down
# until a reboot. `leave` is idempotent, so the normal path running it too is fine.
trap "sudo -n /usr/local/libexec/clawbox/clawbox-gateway-maintenance.sh leave >/dev/null 2>&1" EXIT HUP INT TERM
echo "before=$(gw)"
out=$(mktemp)
( sudo -n /usr/bin/systemctl stop clawbox-gateway.service >"$out" 2>&1; echo "rc=$?" >>"$out" ) &
seen=
for _ in $(seq 1 600); do
  seen=$(gw)
  case "$seen" in deactivating|inactive|failed) break ;; esac
  sleep 0.02
done
echo "seen=$seen"
if [ "$seen" = deactivating ]; then
  r=$(sudo -n /usr/bin/systemctl restart clawbox-gateway.service 2>&1); echo "restart=rc $? $(tr "\n" " " <<<"$r")"
fi
wait
echo "stop=$(tr "\n" " " <"$out")"
rm -f "$out"
for _ in $(seq 1 360); do [ -z "$(systemctl show clawbox-gateway.service -p Job --value 2>/dev/null)" ] && break; sleep 1; done
echo "after=$(gw)"
sudo -n /usr/local/libexec/clawbox/clawbox-gateway-maintenance.sh leave >/dev/null 2>&1; echo "leave=$?"
sudo -n /usr/bin/systemctl reset-failed clawbox-gateway.service >/dev/null 2>&1
sudo -n /usr/bin/systemctl restart clawbox-gateway.service >/dev/null 2>&1; echo "start=$?"
'

field() { sed -n "s/^$1=//p" <<<"$2" | tail -n 1; }

if [ "$RUNTIME" = hermes ]; then
  skip "the race on systemd needs the OpenClaw gateway; this box runs Hermes, whose gateway is masked on purpose"
else
  if wait_gateway_settled 300; then ok "gateway settled before the race (${SETTLE_WAITED}s)"; else note "gateway not settled before the race: ${SETTLE_STATE:-unknown}"; fi
  raced=0
  for try in 1 2 3; do
    OUT=$(board "$RACE_ONCE")
    while IFS= read -r l; do note "race $try: $l"; done <<<"$OUT"
    [ "$(field guard "$OUT")" = unavailable ] && { not_ok "could not enter the maintenance guard through its sudo grant"; break; }
    if [ "$(field seen "$OUT")" = deactivating ] && grep -q 'Job for clawbox-gateway.service canceled' <<<"$(field stop "$OUT")"; then
      raced=1
      ok "a restart queued while the gateway was stopping canceled the stop: $(field stop "$OUT")"
      case "$(field after "$OUT")" in
        inactive|failed) ok "and under the guard the unit still ended $(field after "$OUT"): the start that won was skipped by its condition" ;;
        *) not_ok "under the guard the unit ended $(field after "$OUT") after its stop was canceled" ;;
      esac
    fi
    if [ "$(field leave "$OUT")" != 0 ] || [ "$(field start "$OUT")" != 0 ]; then
      not_ok "could not lift the guard (leave=$(field leave "$OUT")) or start the gateway again (start=$(field start "$OUT"))"
      finish
    fi
    if ! wait_gateway_settled 600; then
      not_ok "gateway not settled after the race: ${SETTLE_STATE:-unknown}"
      finish
    fi
    [ "$raced" = 1 ] && break
  done
  [ "$raced" = 1 ] || note "the gateway stopped before a restart could be queued in three tries; the race was not reproduced on systemd directly"
fi

# ---- 2. the update path, raced ----------------------------------------------

# The watcher. Runs as clawbox until $2 (epoch seconds), its pid in $3.
# shellcheck disable=SC2016  # expanded on the board
RACER='#!/usr/bin/env bash
log=$1 until=$2
echo $$ > "$3"
echo "$(date -Is) up boot=$(cut -c1-8 /proc/sys/kernel/random/boot_id)" >> "$log"
while [ "$(date +%s)" -lt "$until" ]; do
  if [ -d /run/clawbox-gateway-maintenance ]; then
    if [ "$(systemctl show clawbox-gateway.service -p ActiveState --value 2>/dev/null)" = deactivating ]; then
      echo "$(date -Is) race: the gateway is stopping under the guard; queueing a restart beside the stop" >> "$log"
      out=$(sudo -n /usr/bin/systemctl restart clawbox-gateway.service 2>&1); rc=$?
      echo "$(date -Is) race: restart rc=$rc $(tr "\n" " " <<<"$out")-> $(systemctl show clawbox-gateway.service -p ActiveState --value 2>/dev/null)" >> "$log"
      sleep 3
      continue
    fi
    sleep 0.02
  else
    sleep 0.2
  fi
done
echo "$(date -Is) done" >> "$log"
'

# shellcheck disable=SC2016  # expanded on the board
START_RACER='
dir=$1 tag=$2 until=$3 racer=$4
mkdir -p "$dir" && printf "%s" "$racer" > "$dir/race.sh" && : > "$dir/race.log" || exit 1
if command -v crontab >/dev/null 2>&1; then
  { crontab -l 2>/dev/null | grep -vF "$tag"; echo "@reboot /bin/bash $dir/race.sh $dir/race.log $until $dir/race.pid # $tag"; } | crontab - && echo cron=yes || echo cron=no
else
  echo cron=no
fi
setsid nohup /bin/bash "$dir/race.sh" "$dir/race.log" "$until" "$dir/race.pid" >/dev/null 2>&1 < /dev/null &
sleep 1
[ -s "$dir/race.pid" ] && kill -0 "$(cat "$dir/race.pid")" 2>/dev/null && echo racer=up || echo racer=down
'

# shellcheck disable=SC2016  # expanded on the board
STOP_RACER='
dir=$1 tag=$2
crontab -l 2>/dev/null | grep -vF "$tag" | crontab - 2>/dev/null
[ -s "$dir/race.pid" ] && kill "$(cat "$dir/race.pid")" 2>/dev/null
cat "$dir/race.log" 2>/dev/null
rm -rf -- "$dir"
'

# The racer ends itself at UNTIL; until then the test takes it down on every
# way out — finish, a failure, and the runner's SIGTERM at the deadline, which
# an EXIT trap alone does not see.
RACE_LOG=
stop_racer() {
  [ -n "$RACE_LOG" ] && return 0
  RACE_LOG=$(board "$STOP_RACER" "$RACE_DIR" "$RACE_TAG")
  RACE_LOG=${RACE_LOG:-(empty)}
}
trap stop_racer EXIT
trap 'stop_racer; exit 1' INT TERM HUP
UNTIL=$(( $(date +%s) + 3600 ))
OUT=$(board "$START_RACER" "$RACE_DIR" "$RACE_TAG" "$UNTIL" "$RACER")
if [ "$(field racer "$OUT")" = up ]; then
  ok "the restart racer runs on the board (and from @reboot: $(field cron "$OUT"))"
else
  not_ok "the restart racer did not start: $(tr '\n' ' ' <<<"$OUT" | cut -c1-200)"
  finish
fi

START=$(date +%s)
if start_app_update "$NANO_BRANCH"; then
  ok "update to $NANO_BRANCH started through /setup-api/update/run"
else
  not_ok "the update did not start: $(api_error)"
  finish
fi
wait_app_update 3000
case "$UPDATE_PHASE" in
  completed) ok "the update completed in $(( $(date +%s) - START ))s" ;;
  failed) not_ok "the update failed: ${UPDATE_ERROR:-no reason given}" ;;
  *) not_ok "the update did not end within 50 min" ;;
esac

API_MAX_TIME=20 board_api GET /setup-api/update/status
FIXUPS=$(api_json -r '[.steps[]? | select(.id == "post_update")] | first // empty | "\(.status) \(.error // "")"')
case "$FIXUPS" in
  "completed "*) ok "\"Applying system fixups\" completed" ;;
  "") not_ok "the update's status names no post_update step (HTTP $API_STATUS)" ;;
  *) not_ok "\"Applying system fixups\" is ${FIXUPS}" ;;
esac
while IFS= read -r l; do [ -n "$l" ] && note "step: $l"; done < <(api_json -r '.steps[]? | "\(.id) \(.status)\(if .error then ": " + (.error | tostring | .[0:160]) else "" end)"')

stop_racer
while IFS= read -r l; do note "racer: $l"; done <<<"$RACE_LOG"
BOOTS=$(grep -c ' up boot=' <<<"$RACE_LOG")
# The races after the racer's last start: the update's reboot puts post_update
# there. Without a reboot every race counts.
AFTER_BOOT=$(awk '/ up boot=/ { n = 0 } / race: the gateway is stopping/ { n++ } END { print n + 0 }' <<<"$RACE_LOG")
if [ "$RUNTIME" = hermes ]; then
  note "Hermes: $(grep -c ' race: the gateway is stopping' <<<"$RACE_LOG") races fired; the gateway is absent and the updater stops nothing"
elif [ "$AFTER_BOOT" -ge 1 ]; then
  ok "the update's gateway stop was raced $AFTER_BOOT time(s) after the racer's last start ($BOOTS start(s) in all)"
else
  not_ok "no restart was raced against the update's gateway stop after the racer's last start ($BOOTS start(s)): the fixups ran unraced"
fi

# The updater's own account, when the journal is readable as clawbox: which
# step's stop another job replaced. The race log above cannot say whose stop it
# raced; the updater's step lines around its own "replaced" line can.
# shellcheck disable=SC2016  # expanded on the board
SAID=$(board 'journalctl -u clawbox-setup.service --since "@$1" --no-pager -o cat 2>/dev/null | grep -E "\[Updater\] (Running step: |Completed: )|replaced the update.s stop|canceled the update.s stop|did not stop" | tail -n 60' "$START")
while IFS= read -r l; do
  case "$l" in *"Running step: "*|*"Completed: "*) ;; *) [ -n "$l" ] && note "updater: $l" ;; esac
done <<<"$SAID"
RACED_IN=$(awk '/\[Updater\] Running step: / { sub(/.*Running step: /, ""); step = $0 }
                /replaced the update.s stop/ { print step }' <<<"$SAID" | sort -u | paste -sd, -)
if [ -z "$SAID" ]; then
  note "the clawbox-setup journal is not readable here: the race is shown by the racer's log only"
elif [ -n "$RACED_IN" ]; then
  note "the updater says another job replaced its stop during: $RACED_IN"
  if [ "$RUNTIME" != hermes ]; then
    case ",$RACED_IN," in
      *",Applying system fixups,"*) ok "the stop another job replaced was the fixups step's own, and the step still completed" ;;
      *) note "no replaced stop fell inside \"Applying system fixups\" this time" ;;
    esac
  fi
fi

HEAD1=$(board_head)
if [ "$HEAD1" = "$NANO_SHA" ]; then
  ok "the board runs the commit under test ${NANO_SHA:0:12}"
else
  not_ok "the board is at ${HEAD1:-nothing}, expected $NANO_SHA"
fi
runtime_settled_line "after the update"
runtime_kept
finish
