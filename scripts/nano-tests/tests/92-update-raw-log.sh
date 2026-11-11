#!/usr/bin/env bash
# timeout: 5400
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
# stay on the board in /tmp until the test removes them.
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
raw_log() {
  local out line said=0 later=0
  out=$(board "$FLOW" "$SHOTS" "$1" "$RUN_TAG" "$2" "${3:-600}")
  while IFS= read -r line; do
    case "$line" in
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
  [ "$said" = 1 ] && [ "$later" = 0 ]
}

cleanup() {
  # shellcheck disable=SC2016  # expanded on the board
  board 'd=/tmp/nano-update-raw-log-$1; [ -s "$d/reader.pid" ] && kill "$(cat "$d/reader.pid")" 2>/dev/null; rm -rf -- "$d"' "$RUN_TAG" >/dev/null 2>&1
}
trap cleanup EXIT

raw_log reader-start reader 60 || { not_ok "[$RUNTIME] the background log reader did not start"; finish; }

START=$(date +%s)
if start_app_update "$NANO_BRANCH"; then
  ok "[$RUNTIME] the owner's update to $NANO_BRANCH started"
else
  not_ok "[$RUNTIME] the update did not start: $API_STATUS $(printf '%s' "$API_BODY" | head -c 300)"
  finish
fi

# Between the status polls: a panel check on a root step before the restart,
# and one on a root step after it. `step` is the step wait_app_update last saw.
LIVE_BEFORE=0
LIVE_AFTER=0
live_checks() {
  case "${step:-}" in
    apt_update|chromium_install|vnc_install|openclaw_install|openclaw_patch|gateway_setup)
      if [ "$LIVE_BEFORE" = 0 ] && raw_log live before-restart; then LIVE_BEFORE=1; fi ;;
    post_update|hermes_edition|llamacpp_runtime)
      if [ "$LIVE_AFTER" = 0 ] && raw_log live after-restart; then LIVE_AFTER=1; fi ;;
  esac
}
wait_app_update 4800 live_checks
note "update took $(( $(date +%s) - START ))s and ended: $UPDATE_PHASE${UPDATE_ERROR:+ ($UPDATE_ERROR)}"
case "$UPDATE_PHASE" in
  completed) ok "[$RUNTIME] the update completed" ;;
  failed) not_ok "[$RUNTIME] the update failed: $UPDATE_ERROR (its log is checked all the same)" ;;
  *) not_ok "[$RUNTIME] the update did not end within 80 minutes"; finish ;;
esac
[ "$LIVE_BEFORE" = 1 ] || note "no panel check ran on a root step before the restart (the steps went by between two polls)"
[ "$LIVE_AFTER" = 1 ] || note "no panel check ran on a root step after the restart (the steps went by between two polls)"

if [ "$(board_head)" = "$NANO_SHA" ]; then ok "[$RUNTIME] the board is on ${NANO_SHA:0:12} after the update"; else not_ok "[$RUNTIME] the board is on $(board_head | cut -c1-12), not ${NANO_SHA:0:12}"; fi

raw_log after after-reload 900 || not_ok "[$RUNTIME] the after-update checks said nothing"
finish
