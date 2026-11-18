#!/usr/bin/env bash
# timeout: 4500
# tier: long
# covers: config/clawbox-root-update*.service
# covers: scripts/nano-tests/update-raw-log-runs.sh
#
# An owner on an older build updates to the commit under test with the box's
# own updater, and the rebuild keeps every line of its output (TASK-2428). The
# update screen's raw log is the root update units' journals, and on an older
# build the root update unit sets no journald limit of its own, so journald's
# default (10000 lines per 30 s) applies — and journald fixes a unit's limit
# when the unit starts, so rebuild_reboot runs under whatever was loaded before
# it.
#
#   1. The board is put on the newest RELEASE whose root update unit sets no
#      limit of its own (the newest commit on main's first-parent line whose
#      config/clawbox-root-update@.service has no LogRateLimit line) through
#      `nano-ci rebuild` — what an owner's box that has not updated since runs.
#      Today that is the head of main; once a release carries the limit it is
#      still the last one that did not, so the stale path keeps being proven.
#      (TASK-2638: it was the head of beta, which already carried the limit, so
#      the "older build" was never older and the stale state could not be
#      found; the head of main alone would stop being one at the next
#      release.) `nano-ci rebuild` takes a branch, never a commit, so the
#      release is handed to it as a branch of the board's own clone
#      (refs/remotes/origin/nano-tests-93-older-release, which force-update's
#      `git fetch origin` leaves alone; removed at the end). That the board IS
#      in the stale state is asserted: the root update unit has journald's
#      default limit and no drop-in; anything else ends the test as a failure.
#   2. Settings > Update to NANO_BRANCH. While rebuild_reboot runs, systemd has
#      handed journald a limit no step reaches for it (the bridge drop-in the
#      new install.sh's step_apt_update installs before the rebuild).
#   3. After the update: the board runs NANO_SHA; apt_update said it bridged
#      the limit; the unit now carries the limit itself and the bridge is down;
#      rebuild_reboot's journal since the update began has no "Suppressed …
#      messages" line.
#
# Skipped without NANO_BRANCH or NANO_SHA.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# This test's time, on the runner's clock and taken first: run.sh stops it at
# NANO_TEST_TIMEOUT (the header above, the most a long-tier test may ask for).
# Every wait below leaves RESTORE_RESERVE for the rebuild back to the commit
# under test (one rebuild takes 2-5 minutes; the deadline still bounds a slower
# one, which nano-ci retries once).
TEST_DEADLINE=$(( $(date +%s) + ${NANO_TEST_TIMEOUT:-4500} - 60 ))
RESTORE_RESERVE=600

if [ -z "${NANO_BRANCH:-}" ]; then
  skip "NANO_BRANCH is not set: the updater needs the branch the commit under test is on"
  finish
fi
if [ -z "${NANO_SHA:-}" ]; then
  skip "NANO_SHA is not set: nothing to check the update landed on"
  finish
fi

# log_limit_ok, rebuild_unit_shown.
# shellcheck source=scripts/nano-tests/update-raw-log-runs.sh
source "$(dirname "${BASH_SOURCE[0]}")/../update-raw-log-runs.sh"

# Read in this shell, so the answer of the build under test is kept for the
# whole test (board_runtime caches it; a $(…) would throw the cache away and
# the older build would be asked again).
board_runtime >/dev/null
RUNTIME=$BOARD_RUNTIME
note "agent runtime: $RUNTIME"
# The branch of the board's clone the older release is rebuilt from (step 1).
FIXTURE=nano-tests-93-older-release
UNIT_SHOW='systemctl show -p LogRateLimitIntervalUSec -p LogRateLimitBurst -p NeedDaemonReload -p FragmentPath -p DropInPaths clawbox-root-update@rebuild_reboot.service'

# show_unit WHEN — `systemctl show` and the `systemctl cat` lines that set a
# limit, into the log. Sets SHOWN.
SHOWN=
show_unit() {
  local line
  SHOWN=$(board "$UNIT_SHOW") || SHOWN=""
  note "root update unit $1: $(printf '%s' "$SHOWN" | tr '\n' ' ')"
  # shellcheck disable=SC2016  # expanded on the board
  while IFS= read -r line; do [ -n "$line" ] && note "  $line"; done <<<"$(board 'systemctl cat clawbox-root-update@rebuild_reboot.service 2>/dev/null | grep -E "^# /|^LogRateLimit"')"
}
drop_ins() { printf '%s\n' "$SHOWN" | sed -n 's/^DropInPaths=//p'; }

# drop_fixture — remove the remote-tracking ref the older release was rebuilt
# from (step 1), and its local branch unless that is still checked out.
drop_fixture() {
  # shellcheck disable=SC2016  # expanded on the board
  board '
    git -C "$REPO" update-ref -d "refs/remotes/origin/$1" 2>/dev/null
    [ "$(git -C "$REPO" symbolic-ref -q --short HEAD)" = "$1" ] || git -C "$REPO" branch -q -D "$1" 2>/dev/null
    true
  ' "$FIXTURE" >/dev/null
}

# update_phase — the owner's update as /setup-api/update/status says it now
# (running | completed | failed | idle), or "" when the box does not answer.
update_phase() {
  API_MAX_TIME=20 board_api GET /setup-api/update/status
  [ "$API_STATUS" = 200 ] && api_json '.phase // empty'
}

# settle_and_restore — the way out once the owner's update may have started
# but its end was not seen (an update/run whose answer was lost, or a wait that
# ran out). A rebuild beside a running update would race it, so the update is
# waited out first, for as long as this test's own time leaves room for the
# rebuild back; then the build under test is put back. An update that has
# still not ended is left alone, and that is said: the tests after this one
# would run on a box in the middle of an update.
settle_and_restore() {
  local phase room grace
  phase=$(update_phase)
  # `completed` or `idle` may be the last run's word, read in the moment before
  # this update shows `running` (the updater resets its state, then awaits,
  # then says running): it ends nothing until two minutes have shown no update
  # running. `failed` is this run's or the last one's verdict either way.
  case "$phase" in
    completed|idle)
      grace=$(( TEST_DEADLINE - RESTORE_RESERVE - $(date +%s) ))
      [ "$grace" -gt 120 ] && grace=120
      while [ "$grace" -gt 0 ]; do
        sleep 10
        grace=$((grace - 10))
        [ "$(update_phase)" = running ] && { phase=running; break; }
      done
      ;;
  esac
  case "$phase" in
    completed|failed|idle) ;;
    *)
      room=$(( TEST_DEADLINE - RESTORE_RESERVE - $(date +%s) ))
      if [ "$room" -gt 0 ]; then
        note "the update is ${phase:-not answering}: waiting up to ${room}s for it to end before the build under test is put back"
        wait_app_update "$room"
        phase=$UPDATE_PHASE
        # Ended while the box rebooted, so never seen running by this wait.
        [ "$phase" = timeout ] && phase=$(update_phase)
      fi
      ;;
  esac
  case "$phase" in
    completed|failed|idle)
      note "the update is $phase"
      UPDATE_PHASE=$phase
      back_on_test_build
      ;;
    *)
      not_ok "[$RUNTIME] the owner's update has not ended (${phase:-no answer}) and this test's time is up: the board is left as it is, since a rebuild would race the update, and the tests after this one are not run"
      # run.sh reports every test still to start as "not run" with this line.
      printf '%s\n' "$NANO_TEST_NAME left the board in the middle of an owner's update it could not wait out (${phase:-no answer})" > "${NANO_STOP_FILE:-/dev/null}"
      drop_fixture
      ;;
  esac
}

# back_on_test_build — the tests after this one (99-) judge the commit under
# test. Called only once the board has been moved off it: unless the owner's
# update completed AND left the board on it, it is rebuilt to it before leaving
# (an update that failed after its checkout moved can leave HEAD right and the
# build half installed).
back_on_test_build() {
  if [ "${UPDATE_PHASE:-}" != completed ] || [ "$(board_head)" != "$NANO_SHA" ]; then
    # shellcheck disable=SC2016  # expanded on the board
    board 'printf "%s\n" "$1" > /tmp/nano-ci-want-sha' "$NANO_SHA" >/dev/null
    "$NANO_CI" rebuild "$NANO_SERIAL" "$NANO_BRANCH" 2>&1 | grep -E '^\[nano-ci\]|rc=|FAILED' | while IFS= read -r l; do note "restore: $l"; done
    if [ "$(board_head)" = "$NANO_SHA" ]; then
      note "the board is back on ${NANO_SHA:0:12}"
    else
      not_ok "[$RUNTIME] could not put the board back on ${NANO_SHA:0:12} (it is at $(board_head | cut -c1-12)): the tests after this one would judge the wrong build"
    fi
    # shellcheck disable=SC2016  # expanded on the board
    if [ -n "${SAVED_WANT:-}" ]; then board 'printf "%s\n" "$1" > /tmp/nano-ci-want-sha' "$SAVED_WANT" >/dev/null; else board 'rm -f /tmp/nano-ci-want-sha' >/dev/null; fi
  fi
  drop_fixture
}

# 1. The older build an owner's box is on: the newest release (main's
# first-parent line) whose root update unit file has no LogRateLimit line.
# shellcheck disable=SC2016  # expanded on the board
FOUND=$(board '
  git -C "$REPO" fetch -q origin main 2>/dev/null || { echo "nofetch"; exit 0; }
  main=$(git -C "$REPO" rev-parse -q --verify refs/remotes/origin/main) || { echo "nomain"; exit 0; }
  echo "main $main"
  n=0
  for c in $(git -C "$REPO" rev-list --first-parent -n 500 "$main"); do
    n=$((n + 1))
    u=$(git -C "$REPO" show "$c:config/clawbox-root-update@.service" 2>/dev/null) || continue
    if ! printf "%s\n" "$u" | grep -q "^LogRateLimit"; then
      echo "stale $c $n $(git -C "$REPO" describe --tags --exact-match "$c" 2>/dev/null)"
      git -C "$REPO" merge-base --is-ancestor "$1" "$c" 2>/dev/null && echo "contains"
      break
    fi
  done
' "$NANO_SHA")
MAIN_SHA=$(printf '%s\n' "$FOUND" | sed -n 's/^main //p' | tr -d '[:space:]')
if printf '%s\n' "$FOUND" | grep -qx nofetch; then
  # A clone that cannot fetch main may hold an old copy of it, and the newest
  # release would be missed; the board has not been touched yet.
  not_ok "[$RUNTIME] the board could not fetch main from its origin: the newest release without the limit cannot be known"
  finish
fi
read -r BASE_SHA BASE_NTH BASE_TAG <<<"$(printf '%s\n' "$FOUND" | sed -n 's/^stale //p')"
if [ ${#MAIN_SHA} -ne 40 ]; then
  not_ok "[$RUNTIME] could not read the head of main in the board's clone"
  finish
fi
if [ ${#BASE_SHA} -ne 40 ] || ! [[ $BASE_SHA =~ ^[0-9a-f]+$ ]]; then
  # Every release of the last 500 carries the limit: the stale path has been
  # gone from owners' boxes for that long, and the bridge with it.
  skip "[$RUNTIME] no release on main's last 500 first-parent commits has a root update unit without a limit: no older build is left to update from"
  finish
fi
BASE_NAME="release ${BASE_TAG:-${BASE_SHA:0:12}}"
if [ "$BASE_SHA" = "$MAIN_SHA" ]; then
  note "older build: the head of main ${BASE_SHA:0:12}${BASE_TAG:+ ($BASE_TAG)}, whose root update unit sets no limit"
else
  note "older build: ${BASE_SHA:0:12}${BASE_TAG:+ ($BASE_TAG)}, $(( BASE_NTH - 1 )) release(s) behind the head of main ${MAIN_SHA:0:12}: the last whose root update unit sets no limit"
fi
if [ "$BASE_SHA" = "$NANO_SHA" ] || printf '%s\n' "$FOUND" | grep -qx contains; then
  skip "[$RUNTIME] the $BASE_NAME is the commit under test or already contains it: there is no older build to update from"
  finish
fi
note "board at $(board_head | cut -c1-12): rebuilding it to the $BASE_NAME first, as branch $FIXTURE of its clone (several minutes)"
SAVED_WANT=$(board 'cat /tmp/nano-ci-want-sha 2>/dev/null' | tr -d '[:space:]')
# shellcheck disable=SC2016  # expanded on the board
board '
  [ "$(git -C "$REPO" symbolic-ref -q --short HEAD)" = "$1" ] || git -C "$REPO" branch -q -D "$1" 2>/dev/null
  git -C "$REPO" update-ref "refs/remotes/origin/$1" "$2" && printf "%s\n" "$2" > /tmp/nano-ci-want-sha
' "$FIXTURE" "$BASE_SHA" >/dev/null
"$NANO_CI" rebuild "$NANO_SERIAL" "$FIXTURE" 2>&1 | grep -E '^\[nano-ci\]|rc=|FAILED' | while IFS= read -r l; do note "rebuild: $l"; done
if [ -n "$SAVED_WANT" ]; then
  # shellcheck disable=SC2016  # expanded on the board
  board 'printf "%s\n" "$1" > /tmp/nano-ci-want-sha' "$SAVED_WANT" >/dev/null
else
  board 'rm -f /tmp/nano-ci-want-sha' >/dev/null
fi
if [ "$(board_head)" != "$BASE_SHA" ]; then
  not_ok "[$RUNTIME] could not put the board on the $BASE_NAME (it is at $(board_head | cut -c1-12))"
  back_on_test_build
  finish
fi
ok "[$RUNTIME] board rebuilt to the $BASE_NAME"
if wait_runtime_settled 300; then
  ok "[$RUNTIME] older build up and settled"
else
  not_ok "[$RUNTIME] older build not settled: ${SETTLE_STATE:-unknown}"
  back_on_test_build
  finish
fi

show_unit "on the older build"
if [ -n "$(drop_ins)" ]; then
  not_ok "[$RUNTIME] the older build's root update unit has a drop-in ($(drop_ins)): a leftover, not an owner's box — nothing below would prove the stale path"
  back_on_test_build
  finish
fi
if why=$(printf '%s\n' "$SHOWN" | log_limit_ok); then
  # The release's unit file sets no limit, so the rebuild did not install it.
  not_ok "[$RUNTIME] the $BASE_NAME's root update unit file sets no limit, yet the installed one has a limit no step reaches ($why): the rebuild left a newer unit, not an owner's box — nothing below would prove the stale path"
  back_on_test_build
  finish
fi
ok "[$RUNTIME] on the older build the root update unit has no drop-in and journald's default limit, as an owner's box does ($why)"

# 2. The owner's update, and the limit while the rebuild runs. Its journals
# are read --since the BOARD's clock: the runner's may differ.
# shellcheck disable=SC2016  # expanded on the board
START=$(board 'date +%s' | tail -n 1 | tr -dc '0-9')
[ -n "$START" ] || START=$(date +%s)
T_UPDATE=$(date +%s)
# An update needs ~10 minutes, 40 when it rebuilds llama.cpp: with less than
# 20 left after the checks and the rebuild back, none is started.
if [ $(( TEST_DEADLINE - RESTORE_RESERVE - 240 - T_UPDATE )) -lt 1200 ]; then
  not_ok "[$RUNTIME] the older build took too long to come up: too little of this test's time is left to update from it"
  back_on_test_build
  finish
fi
if start_app_update "$NANO_BRANCH"; then
  ok "[$RUNTIME] the owner's update to $NANO_BRANCH started"
else
  not_ok "[$RUNTIME] the update did not start: $API_STATUS $(printf '%s' "$API_BODY" | head -c 300)"
  # The answer can be lost after the update did start (a curl timeout).
  settle_and_restore
  finish
fi
REBUILD_SEEN=0
# shellcheck disable=SC2317  # called by wait_app_update as its tick
rebuild_tick() {
  local shown why
  [ "$REBUILD_SEEN" = 1 ] && return 0
  shown=$(rebuild_unit_shown) || return 0
  case "$shown" in RUNNING*) ;; *) return 0 ;; esac
  REBUILD_SEEN=1
  note "rebuild_reboot running: $(printf '%s' "$shown" | sed 1d | tr '\n' ' ')"
  if why=$(printf '%s\n' "$shown" | log_limit_ok); then
    ok "[$RUNTIME] while rebuild_reboot runs, journald's limit for it is one no step reaches ($(printf '%s\n' "$shown" | grep -E '^(LogRateLimit|Exported_|DropInPaths)' | tr '\n' ' ' | sed 's/ $//'))"
  else
    not_ok "[$RUNTIME] while rebuild_reboot runs, it would lose lines: $why"
  fi
}
# Up to what the test's time leaves after the checks below (~4 min) and the
# rebuild back: about 55 minutes (an update that rebuilds llama.cpp took 40).
UPDATE_WAIT=$(( TEST_DEADLINE - RESTORE_RESERVE - 240 - $(date +%s) ))
wait_app_update "$UPDATE_WAIT" rebuild_tick
note "update took $(( $(date +%s) - T_UPDATE ))s and ended: $UPDATE_PHASE${UPDATE_ERROR:+ ($UPDATE_ERROR)}"
case "$UPDATE_PHASE" in
  completed) ok "[$RUNTIME] the update from the $BASE_NAME completed" ;;
  failed) not_ok "[$RUNTIME] the update from the $BASE_NAME failed: $UPDATE_ERROR" ;;
  *)
    not_ok "[$RUNTIME] the update did not end within ${UPDATE_WAIT}s"
    settle_and_restore
    finish
    ;;
esac
[ "$REBUILD_SEEN" = 1 ] || not_ok "[$RUNTIME] rebuild_reboot was never seen running, so its journald limit went unchecked"
if [ "$(board_head)" = "$NANO_SHA" ]; then ok "[$RUNTIME] the board is on ${NANO_SHA:0:12} after the update"; else not_ok "[$RUNTIME] the board is on $(board_head | cut -c1-12), not ${NANO_SHA:0:12}"; fi

# 3. After it.
# shellcheck disable=SC2016  # expanded on the board
BRIDGED=$(board 'journalctl -u clawbox-root-update@apt_update.service --since "@$1" -o cat 2>/dev/null | grep -F "journald limit bridged" | tail -n 1' "$START")
if [ -n "$BRIDGED" ]; then
  ok "[$RUNTIME] apt_update bridged the limit before the rebuild:${BRIDGED#*:}"
else
  not_ok "[$RUNTIME] apt_update's journal since the update began does not say it bridged the limit"
fi
show_unit "after the update"
if why=$(printf '%s\n' "$SHOWN" | log_limit_ok); then
  ok "[$RUNTIME] after the update the root update unit's limit is one no step reaches"
else
  not_ok "[$RUNTIME] after the update the root update unit would lose lines: $why"
fi
if [ -z "$(drop_ins)" ]; then
  ok "[$RUNTIME] the unit carries the limit itself: the bridge drop-in is gone"
else
  not_ok "[$RUNTIME] the bridge drop-in is still there after the update: $(drop_ins)"
fi
# shellcheck disable=SC2016  # expanded on the board
JOURNAL=$(board 'j=$(journalctl -u clawbox-root-update@rebuild_reboot.service --since "@$1" -o cat 2>/dev/null); n=0; [ -n "$j" ] && n=$(printf "%s\n" "$j" | wc -l); printf "LINES %s\n" "$n"; printf "%s\n" "$j" | grep -E "^Suppressed [0-9]+ messages" | head -n 3' "$START")
LINES=$(printf '%s\n' "$JOURNAL" | sed -n 's/^LINES //p' | tr -dc '0-9')
note "rebuild_reboot's journal since the update began: ${LINES:-?} lines"
SUPPRESSED=$(printf '%s\n' "$JOURNAL" | grep -E '^Suppressed ' || true)
if [ "${LINES:-0}" -eq 0 ]; then
  # An empty journal holds no "Suppressed" line either: nothing was judged.
  not_ok "[$RUNTIME] rebuild_reboot's journal since the update began is empty: whether journald dropped lines cannot be told"
elif [ -z "$SUPPRESSED" ]; then
  ok "[$RUNTIME] journald dropped none of rebuild_reboot's lines (no \"Suppressed … messages\" in its journal since the update began)"
else
  not_ok "[$RUNTIME] journald dropped lines of rebuild_reboot: $(printf '%s' "$SUPPRESSED" | tr '\n' ';')"
fi
# An update that did not land leaves the board on the older release.
back_on_test_build
finish
