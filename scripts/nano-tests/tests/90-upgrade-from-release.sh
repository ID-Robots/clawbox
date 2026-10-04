#!/usr/bin/env bash
# timeout: 4200
# tier: long
#
# An owner on the current release updates to the commit under test with the
# box's own updater, and keeps everything.
#
#   1. The board is put on the current release (the head of main) through
#      `nano-ci rebuild` — skipped when it is already on a commit other than
#      the one under test (85-update-rollback leaves it there).
#   2. State an owner has is recorded: a project file, the setup and password
#      flags in data/config.json, the main agent's model, the update branch.
#   3. Settings > Update: pin NANO_BRANCH, POST /setup-api/update/run, and
#      the update must end `completed`.
#   4. The board runs exactly NANO_SHA, its served build names it, the
#      gateway settles, the recorded state is unchanged, no clawbox unit is
#      failed, and a real chat turn answers.
#
# Skipped without NANO_BRANCH.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "${NANO_BRANCH:-}" ]; then
  skip "NANO_BRANCH is not set: the updater needs the branch the commit under test is on"
  finish
fi
if [ -z "${NANO_SHA:-}" ]; then
  skip "NANO_SHA is not set: nothing to check the upgrade landed on"
  finish
fi

HEAD0=$(board_head)
if [ -z "$HEAD0" ] || [ "$HEAD0" = "$NANO_SHA" ]; then
  note "board on the commit under test: rebuilding it to the current release first (several minutes)"
  if rebuild_to_release; then
    ok "board on the release ${RELEASE_SHA:0:12}"
  else
    not_ok "could not put the board on the release (it is at $(board_head | cut -c1-12))"
    finish
  fi
  HEAD0=$RELEASE_SHA
else
  note "upgrading from ${HEAD0:0:12}"
fi
if ! wait_gateway_settled 300; then
  note "the starting build is not settled (${SETTLE_STATE:-unknown}); updating anyway"
fi

PROJ="$BOARD_HOME/Projects/nano-ci-upgrade-$(printf '%s' "$NANO_RUN_ID" | tr -c 'A-Za-z0-9._-' '-')"
# State an owner has, one "key value" line each.
# shellcheck disable=SC2016  # expanded on the board
STATE_SCRIPT='
  echo "project $(cat "$1/keep.txt" 2>/dev/null | md5sum | cut -c1-12)"
  # python3, not jq: a stock board has no jq.
  echo "setup $(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get(\"setup_complete\"), c.get(\"password_configured\"))" "$REPO/data/config.json" 2>/dev/null)"
  echo "model $(python3 -c "import json,sys; m=json.load(open(sys.argv[1])).get(\"agents\",{}).get(\"defaults\",{}).get(\"model\"); print(m.get(\"primary\") if isinstance(m,dict) else m)" "$HOME/.openclaw/openclaw.json" 2>/dev/null)"
  echo "sessions $(ls "$HOME/.openclaw/agents/main/agent/" 2>/dev/null | grep -c sqlite)"
'
# shellcheck disable=SC2016  # expanded on the board
board 'mkdir -p -- "$1" && printf "kept across the upgrade %s\n" "$2" > "$1/keep.txt"' "$PROJ" "$NANO_RUN_ID" >/dev/null
BEFORE=$(board "$STATE_SCRIPT" "$PROJ")
while IFS= read -r l; do note "before: $l"; done <<<"$BEFORE"

START=$(date +%s)
if start_app_update "$NANO_BRANCH"; then
  ok "update from ${HEAD0:0:12} to $NANO_BRANCH started through /setup-api/update/run"
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

HEAD1=$(board_head)
if [ "$HEAD1" = "$NANO_SHA" ]; then
  ok "the board runs the commit under test ${NANO_SHA:0:12}"
else
  not_ok "the board is at ${HEAD1:-nothing}, expected $NANO_SHA"
fi
IDENT=$(build_identity_ok); rc=$?
if [ "$rc" -eq 0 ]; then
  ok "the served build names the checked-out commit"
else
  not_ok "drift after the upgrade: $(tr '\n' ' ' <<<"$IDENT" | cut -c1-200)"
fi
if wait_gateway_settled 300; then
  ok "gateway settled after the upgrade (${SETTLE_WAITED}s)"
else
  not_ok "gateway not settled after the upgrade: ${SETTLE_STATE:-unknown}"
fi

AFTER=$(board "$STATE_SCRIPT" "$PROJ")
while IFS= read -r l; do
  key=${l%% *}
  was=$(grep "^$key " <<<"$BEFORE")
  if [ "$l" = "$was" ]; then ok "kept: $l"; else not_ok "changed by the upgrade: '$was' -> '$l'"; fi
done <<<"$AFTER"
# shellcheck disable=SC2016  # expanded on the board
FAILED=$(board 'systemctl list-units --state=failed --no-legend --plain "clawbox*" 2>/dev/null | awk "{print \$1}" | tr "\n" " "; rm -rf -- "$1"' "$PROJ" | tail -n 1)
if [ -z "${FAILED// /}" ]; then ok "no clawbox unit failed"; else not_ok "failed after the upgrade: $FAILED"; fi
chat_turn
finish
