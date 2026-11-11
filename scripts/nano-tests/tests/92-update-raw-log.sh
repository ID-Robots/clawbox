#!/usr/bin/env bash
# timeout: 4500
# tier: long
# covers: src/lib/update-raw-log.ts src/app/setup-api/update/log/* src/components/UpdateRawLog.tsx src/lib/xterm-setup.ts
# covers: scripts/nano-tests/board/update-raw-log.*
#
# The update screen's raw log (TASK-2428) is the update's real output, on the
# real board, under the agent runtime the board runs:
#
#   1. A background reader on the board follows GET /setup-api/update/log the
#      way a browser's EventSource does — reconnecting with Last-Event-ID —
#      for the whole of an owner's update to NANO_BRANCH, the web server's
#      restart by the rebuild included.
#   2. Twice while the update runs (on a root step before the restart, and on
#      one after it): the stream is the start of the log file byte for byte;
#      the log's section for the unit running now is that unit's journal
#      (`journalctl -u <unit> --since <dispatch> -o cat`) line for line; and
#      the update screen, loaded fresh in a headless Chromium of the test's
#      own with the terminal button pressed, shows rows that are lines of the
#      log file.
#   3. After the update (completed or failed: the log must outlive both): the
#      log is marked finished; the stream from byte 0, the download and the
#      background reader each hold exactly the file; every unit section of the
#      log is that unit's journal; the screen after a reload shows the log.
#
# Each panel check leaves a picture: the update screen's steps panel with the
# raw log open, beside the journalctl lines and the log-file lines it shows.
# They are printed as `# SHOT <name> <sha256> <jpeg as hex>` lines everywhere
# but GitHub Actions, whose artifacts are public: the picture shows the box's
# own output, which the text redactor of this suite never reads. There they
# stay on the board (under the box account's ~/.cache) until the test removes them.
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
RUN_TAG=$(printf '%s' "${NANO_RUN_ID:-local}" | tr -c 'A-Za-z0-9._-' '-')
SHOTS=1
[ "${GITHUB_ACTIONS:-}" = true ] && SHOTS=0

# shellcheck disable=SC2016  # expanded on the board
FLOW='SHOTS=$1 DRIVER_TIMEOUT_S=$5 bash "$REPO/scripts/nano-tests/board/update-raw-log.sh" "$2" "$3" "$4"'

# raw_log MODE LABEL [TIMEOUT_S] — run a board check and relay its lines.
# Returns 1 when it only said "not yet" (or nothing), so the caller asks again.
# A check that ended badly is a failure whatever it printed first: the board
# wrapper reports the driver's own exit status (DRIVER_EXIT, 124 when it timed
# out), and no such line means the hop to the board failed. PANEL_OK says
# whether it checked the panel.
PANEL_OK=0
raw_log() {
  local out rc line said=0 later=0 driver=""
  PANEL_OK=0
  out=$(board "$FLOW" "$SHOTS" "$1" "$RUN_TAG" "$2" "${3:-600}")
  rc=$?
  while IFS= read -r line; do
    case "$line" in
      "DRIVER_EXIT "*) driver=${line#DRIVER_EXIT } ;;
      "RESULT ok - "*"rows the panel shows"*) ok "[$RUNTIME] ${line#RESULT ok - }"; said=1; PANEL_OK=1 ;;
      "RESULT ok - "*) ok "[$RUNTIME] ${line#RESULT ok - }"; said=1 ;;
      "RESULT not ok - "*) not_ok "[$RUNTIME] ${line#RESULT not ok - }"; said=1 ;;
      "RESULT skip - not yet"*) later=1 ;;
      "RESULT skip - "*) skip "[$RUNTIME] ${line#RESULT skip - }"; said=1 ;;
      "NOTE "*) note "${line#NOTE }" ;;
      "SHOT "*) note "$line" ;;
      "") ;;
      *) note "$line" ;;
    esac
  done <<<"$out"
  if [ -z "$driver" ] || [ "$rc" -ne 0 ]; then
    # A hop that failed (no DRIVER_EXIT, or the hop itself ended badly) while
    # the web server restarts is "ask again" for a live check; for any other
    # it is a failure.
    if [ "$1" = live ]; then return 1; fi
    not_ok "[$RUNTIME] the $1 check never reached its end on the board (hop status $rc)"
    return 0
  fi
  if [ "$driver" != 0 ]; then
    not_ok "[$RUNTIME] the $1 check's driver ended with status $driver"
    return 0
  fi
  [ "$said" = 1 ] && [ "$later" = 0 ]
}

# latest_run — the id of the update log the box started last, after a
# "POINTER" marker so a read that failed (no marker) is told apart from a box
# with no pointer yet (an empty id). Returns 1 when it could not be read.
latest_run() {
  local out
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board 'printf "POINTER %s\n" "$(cat "$REPO/data/update-logs/latest" 2>/dev/null | tr -d "[:space:]")"' | grep '^POINTER' | tail -n 1)
  [ -n "$out" ] || return 1
  printf '%s' "${out#POINTER }" | tr -d '[:space:]'
}

# new_run_finished — the box started an update log after this test read
# BEFORE_RUN, and that run is marked finished: the completion is this test's
# run, not a previous update's synthesised "completed". By run identity, never
# by comparing two machines' clocks.
new_run_finished() {
  local id finished
  id=$(latest_run) || return 1
  [ -n "$id" ] && [ "$id" != "$BEFORE_RUN" ] || return 1
  # shellcheck disable=SC2016  # expanded on the board
  finished=$(board 'python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(\"finished\") is True)" "$REPO/data/update-logs/$1.json" 2>/dev/null' "$id" | tail -n 1)
  [ "$finished" = True ]
}

# The board is left as it was found: the reader stopped, its folder gone. Run
# once at the end, and from the EXIT trap when the test stops early.
CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  # shellcheck disable=SC2016  # expanded on the board
  board 'd=$HOME/.cache/nano-update-raw-log-$1; [ -s "$d/reader.pid" ] && kill "$(cat "$d/reader.pid")" 2>/dev/null; rm -rf -- "$d"' "$RUN_TAG" >/dev/null 2>&1
}
trap cleanup EXIT

raw_log reader-start reader 60 || { not_ok "[$RUNTIME] the background log reader did not start"; finish; }

# The run before this test's, read for certain: a failed read must not leave
# an empty baseline that makes the previous run look new.
BEFORE_READ=0
for _ in 1 2 3; do
  if BEFORE_RUN=$(latest_run); then BEFORE_READ=1; break; fi
  sleep 5
done
if [ "$BEFORE_READ" != 1 ]; then
  not_ok "[$RUNTIME] could not read the box's latest update log before the update"
  finish
fi
START=$(date +%s)
if start_app_update "$NANO_BRANCH"; then
  ok "[$RUNTIME] the owner's update to $NANO_BRANCH started"
else
  not_ok "[$RUNTIME] the update did not start: $API_STATUS $(printf '%s' "$API_BODY" | head -c 300)"
  finish
fi

# Every few seconds until the run ends: the update's status, and — once
# before the web server's restart and once after it — the live checks. A
# Hermes box goes through its root steps in seconds, so the checks ask the
# log rather than the step list where the update is; each answers "not yet"
# until it can say something. (wait_app_update polls every 15 s, which a fast
# box outruns.)
# LIVE_*: that check has answered (a panel check, or "too late" for it);
# LIVE_*_PANEL: it checked the panel, which is what the test is for.
LIVE_BEFORE=0 LIVE_BEFORE_PANEL=0
LIVE_AFTER=0 LIVE_AFTER_PANEL=0
follow_update() {
  local deadline=$(( $(date +%s) + $1 )) phase step seen_running=0 last=""
  UPDATE_PHASE=timeout UPDATE_ERROR=
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$LIVE_BEFORE" = 0 ] && raw_log live before-restart; then LIVE_BEFORE=1 LIVE_BEFORE_PANEL=$PANEL_OK; fi
    if [ "$LIVE_AFTER" = 0 ] && raw_log live after-restart; then LIVE_AFTER=1 LIVE_AFTER_PANEL=$PANEL_OK; fi
    API_MAX_TIME=20 board_api GET /setup-api/update/status
    if [ "$API_STATUS" = 200 ]; then
      phase=$(api_json '.phase // empty')
      step=$(api_json '[.steps[]? | select(.status == "running") | .id] | first // empty')
      if [ "$phase/$step" != "$last" ]; then note "update: $phase${step:+ ($step)}"; last="$phase/$step"; fi
      case "$phase" in
        running) seen_running=1 ;;
        completed|failed)
          # A completion this test never saw running is still this run's
          # when the box started a new update log since the test began.
          if [ "$seen_running" = 1 ] || [ "$phase" = failed ] || new_run_finished; then
            UPDATE_PHASE=$phase
            UPDATE_ERROR=$(api_json '(.error // ([.steps[]? | select(.status == "failed") | .error] | first) // "") | tostring | .[0:300]')
            return 0
          fi
          ;;
      esac
    fi
    sleep 4
  done
  return 1
}
follow_update 3600
note "update took $(( $(date +%s) - START ))s and ended: $UPDATE_PHASE${UPDATE_ERROR:+ ($UPDATE_ERROR)}"
case "$UPDATE_PHASE" in
  completed) ok "[$RUNTIME] the update completed" ;;
  failed) not_ok "[$RUNTIME] the update failed: $UPDATE_ERROR (its log is checked all the same)" ;;
  *) not_ok "[$RUNTIME] the update did not end within 60 minutes"; finish ;;
esac
# The panel while the log is still being written is what this test is for: a
# phase whose check never ran is a failure, not a footnote.
[ "$LIVE_BEFORE_PANEL" = 1 ] || not_ok "[$RUNTIME] no live panel check ran before the web server's restart"
[ "$LIVE_AFTER_PANEL" = 1 ] || not_ok "[$RUNTIME] no live panel check ran after the web server's restart"

if [ "$(board_head)" = "$NANO_SHA" ]; then ok "[$RUNTIME] the board is on ${NANO_SHA:0:12} after the update"; else not_ok "[$RUNTIME] the board is on $(board_head | cut -c1-12), not ${NANO_SHA:0:12}"; fi

raw_log after after-reload 900 || not_ok "[$RUNTIME] the after-update checks said nothing"
cleanup
finish
