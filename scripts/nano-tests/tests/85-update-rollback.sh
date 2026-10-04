#!/usr/bin/env bash
# timeout: 4200
# tier: long
#
# An update whose build dies rolls back to a box that still works.
#
# The commonest real failure of an update on an 8 GB Jetson is `next build`
# being killed (out of memory: `JavaScript heap out of memory`, exit 137). This
# reproduces exactly that, through the box's own updater:
#
#   1. The board is put on the current release (the head of main) through
#      `nano-ci rebuild` — kept when it is on the release already.
#   2. The owner's path: pin the update branch to the branch under test
#      (NANO_BRANCH) and POST /setup-api/update/run.
#   3. Every `next build` the update starts is SIGKILLed, as the OOM killer
#      would.
#   4. The update must end `failed` with a reason, NOT `completed`, and the box
#      must be left working: the dashboard serves /login, the gateway settles,
#      the build it serves names the commit it has checked out (no drift: the
#      rollback put back both, or neither), and a chat turn answers.
#
# Skipped without NANO_BRANCH. The board is left on the release (or wherever
# the rollback left it); 90-upgrade-from-release updates it from there.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "${NANO_BRANCH:-}" ]; then
  skip "NANO_BRANCH is not set: the updater needs the branch the commit under test is on"
  finish
fi

ensure_on_release || finish

KILLS=0
# A running build retitles itself `next-build (vNN)`; `node … next build` is
# its command line before that.
# shellcheck disable=SC2317  # called by wait_app_update as its tick
kill_builds() {
  local n
  # Matched on the process's own command line, never with `pkill -f`: the
  # script `board` runs is itself a `bash -c` whose argv holds this pattern.
  # shellcheck disable=SC2016  # expanded on the board
  n=$(board '
    pids=$(ps -u "$(id -u)" -o pid=,args= | awk "\$2 ~ /^next-build/ || (\$2 ~ /(node|bun)\$/ && / next build/) {print \$1}")
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
    echo "count $(printf "%s" "$pids" | grep -c .)"
  ' | sed -n "s/^count //p" | tail -n 1)
  if [[ ${n:-} =~ ^[1-9][0-9]*$ ]]; then
    KILLS=$((KILLS + n))
    note "killed $n next build process(es), as an OOM kill would"
  fi
}

if start_app_update "$NANO_BRANCH"; then
  ok "update to $NANO_BRANCH started through /setup-api/update/run"
else
  not_ok "the update did not start: $(api_error)"
  finish
fi
wait_app_update 3000 kill_builds
note "next build processes killed: $KILLS"
if [ "$KILLS" -eq 0 ]; then
  not_ok "the update never ran next build while it was watched (phase $UPDATE_PHASE): nothing was rolled back"
elif [ "$UPDATE_PHASE" = failed ]; then
  ok "the update with a killed build ended failed: ${UPDATE_ERROR:-no reason given}"
  [ -n "$UPDATE_ERROR" ] || not_ok "the failed update gave the owner no reason"
elif [ "$UPDATE_PHASE" = completed ]; then
  not_ok "the update reported completed although every next build it started was killed"
else
  not_ok "the update did not end within 50 min (phase $UPDATE_PHASE)"
fi

# The box must be usable whatever the updater said.
if wait_gateway_settled 300; then
  ok "gateway settled after the failed update (${SETTLE_WAITED}s)"
else
  not_ok "gateway not settled after the failed update: ${SETTLE_STATE:-unknown}"
fi
# shellcheck disable=SC2016  # expanded on the board
LOGIN=$(board 'for _ in $(seq 1 24); do c=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "$DASHBOARD/login"); [ "$c" = 200 ] && break; sleep 5; done; echo "$c"' | tail -n 1)
if [ "$LOGIN" = 200 ]; then ok "dashboard still serves /login"; else not_ok "dashboard answered /login with ${LOGIN:-nothing} after the rollback"; fi
HEAD1=$(board_head)
note "checkout after the failed update: ${HEAD1:0:12} (was ${HEAD0:0:12})"
IDENT=$(build_identity_ok); rc=$?
if [ "$rc" -eq 0 ]; then
  ok "the served build names the checked-out commit: $(tail -n 1 <<<"$IDENT")"
else
  not_ok "drift after the rollback: the served build is not the checked-out commit ${HEAD1:0:12}: $(tr '\n' ' ' <<<"$IDENT" | cut -c1-200)"
fi
chat_turn
finish
