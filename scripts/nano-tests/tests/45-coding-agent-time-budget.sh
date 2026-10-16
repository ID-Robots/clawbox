#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/coding-*.ts src/lib/code-projects.ts src/app/setup-api/coding-agent/* src/app/setup-api/code/*
# covers: scripts/coding-run-hook.mjs scripts/coding-run-preview mcp/tools/coding-agent.ts mcp/tools/coding.ts
#
# The coding agent's TIME BUDGET on the real box, through the same routes
# 40-coding-agent-run uses (src/app/setup-api/coding-agent/):
#
#   1. POST run refuses a budget the box would not take (too short, in the
#      past): 400 with code "budget", and no run is started.
#   2. A run started with an explicit 5-minute `budget` and a trivial task:
#      the answer and the run record carry the resolved budget (an absolute
#      deadline exactly 5 min after it was set), the record exposes the time
#      record while it runs (budget, time used, nothing finished yet), the run
#      completes early with the stop reason "done", and both time-record
#      artifacts (time-record.json, time-record.log) are served.
#   3. A run whose TASK TEXT says "you have N minutes" — N the shortest budget
#      the box takes — and that is told to wait for a script that runs 30 s
#      past it before it finishes: the words become the budget (source
#      "text"), and the box ends the run by itself — at the deadline (status
#      stopped, stop reason "time", resumable) or, if the model finished its
#      steps sooner, as done — in either case within the deadline plus the
#      wrap-up grace, never past the safety margin, with the stop line on the
#      record. The "Safety margin:" note is asserted too: a budget that short
#      starts inside its 10-minute margin.
#
# N is 5 on a box as shipped. The test boards set
# CLAWBOX_CODING_MIN_BUDGET_MINUTES=1 (.github/workflows/nano-hardware-tests.yml
# writes it into the board's .env before the rebuild), so there the deadline
# is one minute away instead of five; the status route answers the floor
# (minTimeBudgetMinutes) and this test reads it there, so it runs as it should
# on any board. The too-short budget in 1. is "2m" under a floor of 3 minutes
# or more and "0.5m" under a lower one.
#
# Model wording is never asserted, only the structure and the timing the box
# itself enforces. Every instant is read from the box's own records (setAt,
# deadline, finishedAt), so the runner host's clock is never compared with the
# board's.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

BUDGET_S=300        # part 2's explicit budget: 5 minutes
WRAP_UP_GRACE_S=120 # the deadline's stop lets a write land (60 s) and then ends the run

# iso_s ISO — an ISO 8601 instant (with or without fractional seconds) as epoch seconds; "" when unreadable.
iso_s() { jq -rn --arg t "$1" '$t | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch empty' 2>/dev/null; }

# start_budget_run TASK BUDGET_JSON — POST /setup-api/coding-agent/run in PROJECT_DIR
# with a `budget` field (a JSON value: a string, an object, or null for none).
# Sets RUN_ID; returns non-zero with API_STATUS/API_BODY for the reason.
start_budget_run() {
  local body
  body=$(jq -cn --arg task "$1" --arg dir "$PROJECT_DIR" --argjson budget "$2" '{task: $task, directory: $dir, budget: $budget}')
  board_api POST /setup-api/coding-agent/run "$body"
  RUN_ID=$(api_json '.run.id // empty')
  [ "$API_STATUS" = 202 ] && [ -n "$RUN_ID" ]
}

# wait_time_record SECONDS — poll runs?id= until the run's time record is on the answer
# (its first lines are written right after the start, asynchronously).
wait_time_record() {
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    board_api GET "/setup-api/coding-agent/runs?id=$RUN_ID"
    [ "$API_STATUS" = 200 ] && [ "$(api_json '.run.timeRecord != null')" = true ] && return 0
    sleep 3
  done
  return 1
}

# wait_record_closed SECONDS — after the run settled, poll runs?id= until its
# time record carries the stop line (closed asynchronously, right after the
# status changes). Leaves the last answer in API_BODY; returns non-zero when
# the record never closed.
wait_record_closed() {
  local deadline=$(( $(date +%s) + $1 ))
  while :; do
    board_api GET "/setup-api/coding-agent/runs?id=$RUN_ID"
    [ "$API_STATUS" = 200 ] && [ "$(api_json '.run.timeRecord.stopReason != null')" = true ] && return 0
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 3
  done
}

# check_time_artifacts STOP_REASON — both time-record artifacts of RUN_ID are served and name the stop.
check_time_artifacts() {
  board_api GET "/setup-api/coding-agent/artifacts?runId=$RUN_ID&file=time-record.json"
  # shellcheck disable=SC2016  # $d is jq's, bound with --arg
  if [ "$API_STATUS" = 200 ] && [ "$(api_json --arg d "$DEADLINE" '.budget.deadline == $d and ([.records[].kind] | index("stop") != null)')" = true ]; then
    ok "time-record.json is served for $RUN_ID, with the budget's deadline and a stop line"
  else
    not_ok "time-record.json for $RUN_ID: $(api_error)"
  fi
  board_api GET "/setup-api/coding-agent/artifacts?runId=$RUN_ID&file=time-record.log"
  if [ "$API_STATUS" = 200 ] && grep -qF "reason: $1" <<<"$API_BODY"; then
    ok "time-record.log is served for $RUN_ID and records the stop (reason: $1)"
  else
    not_ok "time-record.log for $RUN_ID: HTTP $API_STATUS, $(printf '%s' "$API_BODY" | wc -l) lines, no 'reason: $1' line"
  fi
}

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent status did not answer: $(api_error)"
  finish
fi
note "status: $(api_json -c '{enabled, ready, defaultDirectory, running, timeZone, defaultTimeBudget, minTimeBudgetMinutes}')"
# The shortest budget the box takes (5 min, absent on a build without the
# field), and what part 1 sends as one that is too short for it.
FLOOR_MIN=$(api_json '.minTimeBudgetMinutes // 5')
[[ $FLOOR_MIN =~ ^[1-5]$ ]] || FLOOR_MIN=5
FLOOR_S=$((FLOOR_MIN * 60))
if [ "$FLOOR_MIN" -gt 2 ]; then TOO_SHORT='"2m"'; else TOO_SHORT='"0.5m"'; fi
if [ "$FLOOR_MIN" -ne 5 ]; then
  note "this board takes budgets from $FLOOR_MIN min (CLAWBOX_CODING_MIN_BUDGET_MINUTES): part 3 waits a $FLOOR_MIN-minute deadline"
fi
if [ "$(api_json '.enabled')" != true ]; then
  not_ok "the coding agent is switched off on this board (status.enabled=false): the lab image must enable it"
  finish
fi
if [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a run: $(api_json -c '.readiness' | head -c 300)"
  finish
fi
if [ "$(api_json '.defaultTimeBudget')" != null ]; then
  not_ok "the lab image sets a default time budget ($(api_json '.defaultTimeBudget')); this test expects none"
  finish
fi

if ! fresh_project_dir "-budget"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi
DIR_A=$PROJECT_DIR
if ! fresh_project_dir "-deadline"; then
  not_ok "could not create $PROJECT_DIR on the board"
  PROJECT_DIR=$DIR_A; remove_project_dir
  finish
fi
DIR_B=$PROJECT_DIR
ok "fresh folders $DIR_A and $DIR_B"

cleanup() {
  PROJECT_DIR=$DIR_A; remove_project_dir
  PROJECT_DIR=$DIR_B; remove_project_dir
}

# ---- 1. budgets the box refuses, before any run ------------------------------
PROJECT_DIR=$DIR_A
for bad in "$TOO_SHORT" '"2020-01-01T00:00:00Z"' '"not a budget"'; do
  if start_budget_run "Create a file named never.txt in the current working folder." "$bad"; then
    not_ok "budget $bad started run $RUN_ID instead of being refused"
    board_api POST /setup-api/coding-agent/stop "$(jq -cn --arg id "$RUN_ID" '{runId: $id}')"
  elif [ "$API_STATUS" = 400 ] && [ "$(api_json '.code')" = budget ] && [ "$(api_json '.kind')" = invalid ]; then
    ok "budget $bad is refused: HTTP 400, code budget"
  else
    not_ok "budget $bad: expected HTTP 400 with code budget, got $(api_error)"
  fi
done

# ---- 2. an explicit 5-minute budget on a trivial task: done early ------------
LINE="NANO-CI budget $NANO_SERIAL $NANO_RUN_ID $(date +%s)"
TASK="Create a file named hello.txt in the current working folder whose entire content is exactly this one line:
$LINE
Do not create, change or delete any other file, do not run a build or a server, and do not verify anything in a browser. Say done when the file is written."

if ! start_budget_run "$TASK" '"5m"'; then
  not_ok "the budgeted run did not start: $(api_error)"
  cleanup
  finish
fi
ok "run $RUN_ID started with budget \"5m\" (HTTP 202)"
note "answer: $(api_json -c '{started, queued, routedToTeam, timeBudget, timeBudgetIgnored}')"

DEADLINE=$(api_json '.timeBudget.deadline // empty')
SET_AT=$(api_json '.timeBudget.setAt // empty')
D=$(iso_s "$DEADLINE"); S=$(iso_s "$SET_AT")
if [ -n "$D" ] && [ -n "$S" ] && [ $((D - S)) -eq "$BUDGET_S" ]; then
  ok "the answer carries the resolved budget: deadline $DEADLINE, exactly $BUDGET_S s after it was set"
else
  not_ok "the answer's timeBudget is not a 5-minute deadline: $(api_json -c '.timeBudget')"
fi
if [ "$(api_json '.timeBudget.source')" = picker ]; then
  ok "the budget's source is the request (picker)"
else
  not_ok "the budget's source is '$(api_json '.timeBudget.source')', not picker"
fi
if [ "$(api_json '.routedToTeam // false')" = false ]; then
  ok "a 5-minute budget stays one run (not routed to a team)"
else
  not_ok "a 5-minute budget was routed to a team: $(api_json -c '{routedToTeam, team: .team.id}')"
fi
# shellcheck disable=SC2016  # $d is jq's, bound with --arg
if [ "$(api_json --arg d "$DEADLINE" '.run.timeBudget.deadline == $d')" = true ]; then
  ok "the run record stores the same budget"
else
  not_ok "the run record's timeBudget differs from the answer's: $(api_json -c '.run.timeBudget')"
fi

if wait_time_record 60; then
  note "time record while running: $(api_json -c '.run.timeRecord | {usedMs, leftMs, finishedAt, stopReason, kinds: [.records[].kind]}')"
  # shellcheck disable=SC2016  # $d is jq's, bound with --arg
  if [ "$(api_json --arg d "$DEADLINE" '.run.timeRecord | (.budget.deadline == $d) and (.usedMs >= 0) and ([.records[].kind] | index("budget") != null and index("start") != null)')" = true ]; then
    ok "the run exposes its time record: the budget, time used, and the budget and start lines"
  else
    not_ok "the run's time record is not as expected: $(api_json -c '.run.timeRecord | {budget: .budget.deadline, usedMs, kinds: [.records[].kind]}')"
  fi
else
  not_ok "run $RUN_ID exposed no time record within 60 s: $(api_error)"
fi

wait_coding_run 300
expect_completed
if [ "$RUN_STATUS" = completed ]; then
  wait_record_closed 30 || note "the time record had no stop line 30 s after the run completed"
  STOP=$(api_json '.run.timeRecord.stopReason // empty')
  FIN=$(api_json '.run.timeRecord.finishedAt // empty'); F=$(iso_s "$FIN")
  LEFT=$(api_json '.run.timeRecord.leftMs // empty')
  if [ "$STOP" = "done" ] && [ -n "$F" ] && [ "$F" -le "$D" ] && [ -n "$LEFT" ] && [ "$LEFT" -gt 0 ]; then
    ok "the time record closed: stop reason done, finished at $FIN with $LEFT ms of the budget left"
  else
    not_ok "the completed run's time record did not close as done before the deadline: $(api_json -c '.run.timeRecord | {stopReason, finishedAt, leftMs, usedMs}')"
  fi
  if [ "$(api_json '.run.extraWork.items // [] | length')" = 0 ]; then
    ok "no extra work: the whole 5-minute budget is inside the safety margin"
  else
    not_ok "extra work was started inside the safety margin: $(api_json -c '.run.extraWork')"
  fi
  check_time_artifacts "done"
fi
# shellcheck disable=SC2016  # expanded on the board
CONTENT=$(board '[ -f "$1/hello.txt" ] && cat "$1/hello.txt" || echo "<no hello.txt>"' "$DIR_A")
if [ "$CONTENT" = "$LINE" ]; then
  ok "hello.txt holds exactly the requested line"
else
  note "hello.txt holds '$(printf '%s' "$CONTENT" | head -c 120 | tr '\n' '|')' (the file is the model's; not asserted)"
fi

# ---- 3. a budget from the task's words, and the deadline enforced ------------
PROJECT_DIR=$DIR_B
# A script the run is told to wait for: one call waits 30 s past the budget,
# and only then prints ALL DONE. A call the agent's own command limit cuts off
# prints nothing, and the task says to run it again. Its calls are counted on
# disk, for the log.
WAIT_S=$((FLOOR_S + 30))
if [ "$FLOOR_MIN" -eq 1 ]; then WORDS="1 minute"; else WORDS="$FLOOR_MIN minutes"; fi
# shellcheck disable=SC2016  # the JavaScript is written as it is
if ! board '
  cat > "$1/wait.js" <<"EOF"
const fs = require("fs");
const file = ".wait-count";
let n = 0;
try { n = parseInt(fs.readFileSync(file, "utf8"), 10) || 0; } catch {}
fs.writeFileSync(file, String(n + 1));
const seconds = Number(process.argv[2] || "330");
console.log(`waiting ${seconds} seconds; this is expected, please keep waiting for ALL DONE...`);
setTimeout(() => { console.log("ALL DONE: the wait has finished. Now create done.txt."); }, seconds * 1000);
EOF
  [ -s "$1/wait.js" ]
' "$DIR_B"; then
  not_ok "could not place wait.js in $DIR_B"
  cleanup
  finish
fi
TASK="You have $WORDS for this task. The current working folder holds wait.js. Run: node wait.js $WAIT_S — with a command timeout of at least $((WAIT_S + 70)) seconds ($(( (WAIT_S + 70) * 1000 )) ms) — and wait for it to finish: it takes about $WAIT_S seconds, and that wait is expected and is the whole point. Do not shorten it, do not run it in the background, do not read or change wait.js. It prints ALL DONE when it has finished. If it is cut off before it prints ALL DONE, run it again the same way and wait again. Only after it has printed ALL DONE, create a file named done.txt in the current working folder with the single word done in it. Do not create or change any other file and do not run anything else."

if ! start_budget_run "$TASK" null; then
  not_ok "the text-budget run did not start: $(api_error)"
  cleanup
  finish
fi
ok "run $RUN_ID started from a task that says \"You have $WORDS\" (HTTP 202)"
note "answer: $(api_json -c '{started, queued, routedToTeam, timeBudget, timeBudgetIgnored}')"

DEADLINE=$(api_json '.timeBudget.deadline // empty')
SET_AT=$(api_json '.timeBudget.setAt // empty')
D=$(iso_s "$DEADLINE"); S=$(iso_s "$SET_AT")
if [ -n "$D" ] && [ -n "$S" ] && [ $((D - S)) -eq "$FLOOR_S" ] && [ "$(api_json '.timeBudget.source')" = text ]; then
  ok "the task's words became the budget: source text, deadline $DEADLINE, $FLOOR_S s after it was set"
else
  not_ok "the words \"You have $WORDS\" did not become a $FLOOR_S s budget: $(api_json -c '{timeBudget, timeBudgetIgnored}')"
fi

if wait_time_record 60; then
  if [ "$(api_json '.run.status == "running" and .run.timeRecord.finishedAt == null and .run.timeRecord.leftMs == null and .run.timeRecord.usedMs >= 0')" = true ]; then
    ok "while the run works, its time record shows the time used ($(api_json '.run.timeRecord.usedMs') ms) and no finish yet"
  else
    not_ok "the in-progress time record is not as expected: $(api_json -c '{status: .run.status, timeRecord: (.run.timeRecord | {usedMs, leftMs, finishedAt, stopReason})}')"
  fi
  if [ "$(api_json '[.run.timeRecord.records[] | select(.kind == "note" and (.text | startswith("Safety margin:")))] | length > 0')" = true ]; then
    ok "the record notes the run started inside its safety margin (10 min > the $WORDS budget)"
  else
    not_ok "no 'Safety margin:' note on the record: $(api_json -c '[.run.timeRecord.records[] | {kind, text: .text[0:80]}]')"
  fi
else
  not_ok "run $RUN_ID exposed no time record within 60 s: $(api_error)"
fi

# The run must end BY ITSELF: at the deadline ($WORDS after the start) plus
# the wrap-up grace at the latest. wait_coding_run's own stop on the way out is
# the failure case here.
if ! wait_coding_run $((FLOOR_S + WRAP_UP_GRACE_S + 60)); then
  not_ok "run $RUN_ID was still running $((FLOOR_S + WRAP_UP_GRACE_S + 60)) s after its start: the deadline did not end it ($(run_account))"
  cleanup
  finish
fi
wait_record_closed 30 || note "the time record had no stop line 30 s after the run ended"
note "run ended: $(api_json -c '{status: .run.status, resumable: .run.resumable, error: (.run.error // "" | .[0:160]), timeRecord: (.run.timeRecord | {stopReason, finishedAt, usedMs, leftMs})}')"
# shellcheck disable=SC2016  # expanded on the board
note "wait.js was run $(board 'cat "$1/.wait-count" 2>/dev/null || echo 0' "$DIR_B" | tail -n1) time(s) on the board"
STOP=$(api_json '.run.timeRecord.stopReason // empty')
FIN=$(api_json '.run.timeRecord.finishedAt // empty'); F=$(iso_s "$FIN")
LEFT=$(api_json '.run.timeRecord.leftMs // empty')
case "$RUN_STATUS" in
  stopped)
    if [ "$STOP" = time ] && [ "$(api_json '.run.resumable')" = true ] && grep -qiF "deadline" <<<"$(api_json '.run.error // ""')"; then
      ok "the box stopped the run at its deadline: stop reason time, resumable, the record says why"
    else
      not_ok "the run stopped, but not as the deadline's stop: stopReason=$STOP resumable=$(api_json '.run.resumable') error=$(api_json '.run.error // "" | .[0:160]')"
    fi
    if [ -n "$F" ] && [ "$F" -ge "$D" ] && [ "$F" -le $((D + WRAP_UP_GRACE_S)) ]; then
      ok "it ended $((F - D)) s after the deadline, within the $WRAP_UP_GRACE_S s wrap-up grace"
    else
      not_ok "finishedAt $FIN is not within $WRAP_UP_GRACE_S s after the deadline $DEADLINE"
    fi
    if [ -n "$LEFT" ] && [ "$LEFT" -le 0 ]; then
      ok "the record's leftMs ($LEFT) shows the budget was used up"
    else
      not_ok "leftMs is '$LEFT' for a run stopped at its deadline"
    fi
    ;;
  completed)
    note "the model finished its steps before the deadline, so the deadline's stop was not exercised this time"
    if [ "$STOP" = "done" ] && [ -n "$F" ] && [ "$F" -le "$D" ]; then
      ok "the run completed on its own before the deadline: stop reason done, finished at $FIN"
    else
      not_ok "the completed run's record did not close as done before the deadline: stopReason=$STOP finishedAt=$FIN"
    fi
    ;;
  *)
    not_ok "run $RUN_ID ended $RUN_STATUS, neither stopped at its deadline nor completed: $(run_account)"
    ;;
esac
if [ -n "$STOP" ]; then
  check_time_artifacts "$STOP"
fi

cleanup
finish
