#!/usr/bin/env bash
# timeout: 300
#
# The gateway is ready, settled, and every chat channel it runs is healthy.
#
#   * /startupz answers 200 (the gateway finished starting) and /readyz
#     reports the event loop NOT degraded. A gateway that has just started
#     says `degraded: ["cpu"]` for its first seconds; that is a box settling,
#     not a verdict, so this waits up to 180 s for it to settle
#     (wait_gateway_settled in lib.sh) and fails only when it never does.
#   * /readyz lists nothing in `failing` — readiness folds in channel health,
#     so a channel that is down shows up here first.
#   * `openclaw channels status --json` reports no status issue, and every
#     configured channel account that is enabled is running, with no last
#     error. A board with no channel configured has nothing to check there,
#     and says so in a note.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if wait_gateway_settled 180; then
  ok "gateway started and settled (${SETTLE_WAITED}s)"
  [ -z "$SETTLE_SEEN" ] || note "on the way: $SETTLE_SEEN"
else
  not_ok "gateway not settled after ${SETTLE_WAITED}s: ${SETTLE_STATE:-unknown} (seen: ${SETTLE_SEEN:-nothing})"
fi

READY=$(printf '%s' "$READY_BODY" | jq -r '.ready' 2>/dev/null)
FAILING=$(printf '%s' "$READY_BODY" | jq -r '(.failing // []) | map(if type == "string" then . else (.id // .name // tostring) end) | join(", ")' 2>/dev/null)
if [ "$READY" = true ] && [ -z "$FAILING" ]; then
  ok "/readyz: ready, nothing failing"
elif [ -n "$FAILING" ]; then
  not_ok "/readyz lists failing checks: $FAILING"
else
  not_ok "/readyz is not ready: $(printf '%s' "$READY_BODY" | head -c 200)"
fi

# stdout only: a plugin warning on stderr goes to the log, not into jq.
# shellcheck disable=SC2016  # expanded on the board
STATUS=$(board 'timeout 90 "$1" channels status --json 2>/dev/null' "$OPENCLAW_BIN" | sed -n '/^{/,$p')
if ! printf '%s' "$STATUS" | jq -e . >/dev/null 2>&1; then
  not_ok "openclaw channels status --json gave no JSON: $(printf '%s' "$STATUS" | head -c 200)"
  finish
fi
ok "openclaw channels status answers"

ISSUES=$(printf '%s' "$STATUS" | jq -r '(.statusIssues // [])[] | (.message // .text // tostring)' 2>/dev/null)
while IFS= read -r issue; do
  [ -n "$issue" ] && not_ok "channel status issue: $issue"
done <<<"$ISSUES"

# One line per configured account: "<channel>/<account> <enabled> <running> <lastError>".
ACCOUNTS=$(printf '%s' "$STATUS" | jq -r '
  (.channelAccounts // {}) | to_entries[] | .key as $ch
  | (.value | if type == "array" then . else [.] end)[]
  | [$ch + "/" + ((.accountId // .id // "default") | tostring),
     ((.enabled // true) | tostring), ((.running // false) | tostring),
     ((.lastError // "") | tostring | gsub("[\r\n]"; " ") | .[0:160])] | @tsv' 2>/dev/null)
if [ -z "$ACCOUNTS" ]; then
  note "no chat channel is configured on this board: nothing to check beyond the gateway"
fi
while IFS=$'\t' read -r acct enabled running lasterr; do
  [ -n "$acct" ] || continue
  if [ "$enabled" = false ]; then
    note "$acct is disabled: not required"
  elif [ "$running" = true ] && [ -z "$lasterr" ]; then
    ok "channel $acct is running"
  else
    not_ok "channel $acct is enabled but running=$running${lasterr:+, last error: $lasterr}"
  fi
done <<<"$ACCOUNTS"

finish
