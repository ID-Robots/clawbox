#!/usr/bin/env bash
# timeout: 300
#
# The board runs the commit under test, cleanly built and actually served.
#
#   * /setup-api/system/build-identity?force=1 (src/lib/build-identity.ts)
#     names NANO_SHA for both the checkout and the build, dirty=false for both,
#     drift.buildVsCheckout "match", and a stamped buildId equal to the
#     deployed BUILD_ID.
#   * The web server was STARTED after that build was deployed. A server that
#     was not restarted by the rebuild keeps serving the previous build from
#     memory while every file on disk says otherwise.
#   * scripts/verify-build-identity.sh — the check install.sh's rebuild runs —
#     passes on the board against the same commit.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "$NANO_SHA" ]; then
  not_ok "NANO_SHA is empty: there is no commit to compare the board with"
  finish
fi

board_api GET "/setup-api/system/build-identity?force=1"
if [ "$API_STATUS" != 200 ]; then
  not_ok "build-identity did not answer: $(api_error)"
  finish
fi
note "build-identity: $(api_json -c '{build: .build | {commit, dirty, buildId, builtAt}, deployedBuildId, checkout: .checkout | {commit, branch, dirty}, drift: .drift | {buildVsCheckout, detected, reasons}}')"

expect() { # LABEL JQ_PATH EXPECTED
  local actual
  actual=$(api_json "$2 | tostring")
  if [ "$actual" = "$3" ]; then ok "$1 is $3"; else not_ok "$1 is ${actual:-missing}, expected $3"; fi
}
expect "checkout commit" .checkout.commit "$NANO_SHA"
expect "build commit" .build.commit "$NANO_SHA"
expect "checkout dirty" .checkout.dirty false
expect "build dirty" .build.dirty false
expect "drift.buildVsCheckout" .drift.buildVsCheckout match

DEPLOYED=$(api_json '.deployedBuildId // empty')
STAMPED=$(api_json '.build.buildId // empty')
if [ -n "$DEPLOYED" ] && [ "$DEPLOYED" = "$STAMPED" ]; then
  ok "the stamped build is the deployed one ($DEPLOYED)"
else
  not_ok "stamped buildId '${STAMPED:-none}' is not the deployed BUILD_ID '${DEPLOYED:-none}'"
fi

# The served build: the tree the service runs from (its cwd is
# .next/standalone, see build-identity.ts) and when the service last started.
# Answer: "<BUILD_ID> <its mtime> <service start, epoch s>", "-" for any it
# cannot read — so a missing value never shifts the next one into its place.
# An empty start stamp (a service that never started) is "-", not handed to
# `date -d ""`, which answers today's midnight.
# shellcheck disable=SC2016  # expanded on the board
SERVED=$(board '
  dir=$REPO/.next/standalone/.next
  [ -f "$dir/BUILD_ID" ] || dir=$REPO/.next
  id=$(tr -d "[:space:]" < "$dir/BUILD_ID" 2>/dev/null)
  built=$(stat -c %Y "$dir/BUILD_ID" 2>/dev/null)
  started=$(systemctl show clawbox-setup.service -p ExecMainStartTimestamp --value 2>/dev/null)
  started_s=""
  [ -z "$started" ] || started_s=$(date -d "$started" +%s 2>/dev/null)
  echo "${id:--} ${built:--} ${started_s:--}"
')
read -r SERVED_ID BUILT_AT STARTED_AT <<<"$SERVED"
if [ "${SERVED_ID:--}" = - ] || ! [[ ${BUILT_AT:-} =~ ^[0-9]+$ ]]; then
  not_ok "no deployed BUILD_ID on the board (answer: '${SERVED:-nothing}')"
elif ! [[ ${STARTED_AT:-} =~ ^[0-9]+$ ]]; then
  not_ok "cannot tell when clawbox-setup.service started (answer: '$SERVED')"
elif [ "$SERVED_ID" != "$DEPLOYED" ]; then
  not_ok "the service's build folder holds '$SERVED_ID', build-identity reported '$DEPLOYED'"
elif [ "$STARTED_AT" -ge "$BUILT_AT" ]; then
  ok "clawbox-setup.service started after build $SERVED_ID was deployed, so it serves it"
else
  not_ok "clawbox-setup.service started $((BUILT_AT - STARTED_AT))s BEFORE build $SERVED_ID was deployed: it still serves the previous build"
fi

# shellcheck disable=SC2016  # expanded on the board
VERIFY=$(board '
  [ -f "$REPO/scripts/verify-build-identity.sh" ] || { echo "absent"; exit 3; }
  bash "$REPO/scripts/verify-build-identity.sh" --project-dir "$REPO" --expect-sha "$1" 2>&1
' "$NANO_SHA")
rc=$?
while IFS= read -r line; do note "verify-build-identity: $line"; done <<<"$VERIFY"
case "$rc" in
  0) ok "scripts/verify-build-identity.sh passes on the board" ;;
  3) not_ok "scripts/verify-build-identity.sh is missing from the board's checkout" ;;
  *) not_ok "scripts/verify-build-identity.sh failed on the board (exit $rc): $(tail -n 1 <<<"$VERIFY")" ;;
esac

finish
