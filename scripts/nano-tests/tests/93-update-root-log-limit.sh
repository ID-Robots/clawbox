#!/usr/bin/env bash
# timeout: 4200
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
#   1. The board is put on the head of beta through `nano-ci rebuild`, and that
#      it IS the stale state is asserted: the root update unit has journald's
#      default limit and no drop-in. A leftover of a newer build would make the
#      rest prove nothing, so it ends the test.
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

RUNTIME=$(board_runtime)
note "agent runtime: $RUNTIME"
BASE_BRANCH=beta
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

# 1. The older build an owner's box is on.
# shellcheck disable=SC2016  # expanded on the board
BASE_SHA=$(board 'git -C "$REPO" ls-remote origin "refs/heads/$1" 2>/dev/null | cut -f1' "$BASE_BRANCH" | tail -n 1 | tr -d '[:space:]')
if [ ${#BASE_SHA} -ne 40 ] || ! [[ $BASE_SHA =~ ^[0-9a-f]+$ ]]; then
  not_ok "[$RUNTIME] could not read the head of $BASE_BRANCH on the board's origin"
  finish
fi
if [ "$BASE_SHA" = "$NANO_SHA" ]; then
  skip "[$RUNTIME] the head of $BASE_BRANCH is the commit under test: there is no older build to update from"
  finish
fi
note "board at $(board_head | cut -c1-12): rebuilding it to $BASE_BRANCH ${BASE_SHA:0:12} first (several minutes)"
SAVED_WANT=$(board 'cat /tmp/nano-ci-want-sha 2>/dev/null' | tr -d '[:space:]')
# shellcheck disable=SC2016  # expanded on the board
board 'printf "%s\n" "$1" > /tmp/nano-ci-want-sha' "$BASE_SHA" >/dev/null
"$NANO_CI" rebuild "$NANO_SERIAL" "$BASE_BRANCH" 2>&1 | grep -E '^\[nano-ci\]|rc=|FAILED' | while IFS= read -r l; do note "rebuild: $l"; done
if [ -n "$SAVED_WANT" ]; then
  # shellcheck disable=SC2016  # expanded on the board
  board 'printf "%s\n" "$1" > /tmp/nano-ci-want-sha' "$SAVED_WANT" >/dev/null
else
  board 'rm -f /tmp/nano-ci-want-sha' >/dev/null
fi
if [ "$(board_head)" != "$BASE_SHA" ]; then
  not_ok "[$RUNTIME] could not put the board on $BASE_BRANCH ${BASE_SHA:0:12} (it is at $(board_head | cut -c1-12))"
  finish
fi
ok "[$RUNTIME] board rebuilt to $BASE_BRANCH ${BASE_SHA:0:12}"
if wait_runtime_settled 300; then
  ok "[$RUNTIME] older build up and settled"
else
  not_ok "[$RUNTIME] older build not settled: ${SETTLE_STATE:-unknown}"
  finish
fi

show_unit "on the older build"
if [ -n "$(drop_ins)" ]; then
  not_ok "[$RUNTIME] the older build's root update unit has a drop-in ($(drop_ins)): a leftover, not an owner's box — nothing below would prove the stale path"
  finish
fi
if why=$(printf '%s\n' "$SHOWN" | log_limit_ok); then
  not_ok "[$RUNTIME] the older build's root update unit already has a limit no step reaches: not the stale path"
  finish
fi
ok "[$RUNTIME] on the older build the root update unit has no drop-in and journald's default limit, as an owner's box does ($why)"

# 2. The owner's update, and the limit while the rebuild runs.
START=$(date +%s)
if start_app_update "$NANO_BRANCH"; then
  ok "[$RUNTIME] the owner's update to $NANO_BRANCH started"
else
  not_ok "[$RUNTIME] the update did not start: $API_STATUS $(printf '%s' "$API_BODY" | head -c 300)"
  finish
fi
REBUILD_SEEN=0
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
wait_app_update 3600 rebuild_tick
note "update took $(( $(date +%s) - START ))s and ended: $UPDATE_PHASE${UPDATE_ERROR:+ ($UPDATE_ERROR)}"
case "$UPDATE_PHASE" in
  completed) ok "[$RUNTIME] the update from $BASE_BRANCH completed" ;;
  failed) not_ok "[$RUNTIME] the update from $BASE_BRANCH failed: $UPDATE_ERROR" ;;
  *) not_ok "[$RUNTIME] the update did not end within 60 minutes"; finish ;;
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
JOURNAL=$(board 'j=$(journalctl -u clawbox-root-update@rebuild_reboot.service --since "@$1" -o cat 2>/dev/null); printf "LINES %s\n" "$(printf "%s\n" "$j" | wc -l)"; printf "%s\n" "$j" | grep -E "^Suppressed [0-9]+ messages" | head -n 3' "$START")
note "rebuild_reboot's journal since the update began: $(printf '%s\n' "$JOURNAL" | sed -n 's/^LINES //p') lines"
SUPPRESSED=$(printf '%s\n' "$JOURNAL" | grep -E '^Suppressed ' || true)
if [ -z "$SUPPRESSED" ]; then
  ok "[$RUNTIME] journald dropped none of rebuild_reboot's lines (no \"Suppressed … messages\" in its journal since the update began)"
else
  not_ok "[$RUNTIME] journald dropped lines of rebuild_reboot: $(printf '%s' "$SUPPRESSED" | tr '\n' ';')"
fi
finish
