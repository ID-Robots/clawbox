#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/coding-team*.ts src/lib/coding-run-worktree.ts src/app/setup-api/coding-agent/team/*
#
# A real coding TEAM on the board's own models and git, in a simulated
# repository (lib.sh make_sim_repo): two tasks side by side, then a second
# team started where the first left the checkout. Ways teams once failed with
# nothing wrong in the code:
#
#   own branch  a worker that commits on a branch it made itself
#               (`git checkout -b`) has its work merged, not rejected as
#               NO CHANGE
#   alerts      a merge conflict between the two workers never stops the team,
#               and a team whose every task is accepted ends done
#   reviewer    a task's reviewer has a shell and runs something
#   publish     a finished team pushes its branch for a pull request (opening
#               it on GitHub needs a login a lab board does not have)
#   base        a team started in a folder another team left on its branch
#               forks from the project's base, without that team's commits
#
# A check whose situation the models did not bring about (no conflict, no
# branch of the worker's own) is a note, never a pass. The owner's settings
# it changes are put back.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

SETTINGS_BEFORE=
cleanup() {
  if [ -n "$SETTINGS_BEFORE" ]; then
    board_api POST /setup-api/coding-agent/settings "$SETTINGS_BEFORE"
    note "settings put back: HTTP $API_STATUS"
  fi
  remove_sim_repo
}

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ] || [ "$(api_json '.enabled')" != true ] || [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a team here: $(api_error) $(api_json -c '{enabled, ready, readiness}' | head -c 300)"
  finish
fi
STATUS_BODY=$API_BODY

board_api GET /setup-api/coding-agent/settings
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent settings did not answer: $(api_error)"
  finish
fi
SETTINGS_BEFORE=$(api_json -c '{autoPr: (.autoPr // false), maxParallelRuns: (.maxParallelRuns // 2)}')
note "settings before: $SETTINGS_BEFORE"
trap cleanup EXIT
# Pull requests on (a finished team publishes), two runs at once (workers side by side).
board_api POST /setup-api/coding-agent/settings '{"autoPr":true,"maxParallelRuns":2}'
[ "$API_STATUS" = 200 ] || { not_ok "could not turn pull requests on and allow two runs at once: $(api_error)"; finish; }

API_BODY=$STATUS_BODY
if ! fresh_project_dir "-branches" || ! make_sim_repo; then
  not_ok "could not prepare the simulated repository in $PROJECT_DIR"
  finish
fi
ok "simulated repository on develop, with a local origin, in $PROJECT_DIR"

# ---- the first team --------------------------------------------------------
GOAL="Make two independent changes in this project, as two tasks that can run side by side:
1. In src/up.js change the value to: export const up = 1;
   This task is to be committed on a git branch of its own: first run \`git checkout -b fix/arrow-up-own\` in your folder, then edit src/up.js and commit it there.
2. In src/down.js change the value to: export const down = -1;
Each task also appends exactly one line to the end of CHANGELOG.md that says what it changed. After your change, run ./test.sh and quote what it prints."
if ! start_coding_team "$GOAL"; then
  not_ok "the first team did not start: $(api_error)"
  finish
fi
ok "first team $TEAM_ID started"
wait_coding_team 540
note_team "first team"
A_STATUS=$TEAM_STATUS
A_BRANCH=$(team_json '.team.branch // empty')

# Own branch.
if [ "$(board 'git -C "$1" rev-parse --verify --quiet refs/heads/fix/arrow-up-own >/dev/null && echo made' "$PROJECT_DIR")" != made ]; then
  note "own branch: no worker made fix/arrow-up-own, so this run did not test it"
elif team_json '.team.log[].message' | grep -q 'NO CHANGE'; then
  not_ok "own branch: a worker committed on fix/arrow-up-own and the team rejected its work as NO CHANGE"
elif [ -n "$A_BRANCH" ] && board 'git -C "$1" show "$2:src/up.js" 2>/dev/null | grep -q "up = 1"' "$PROJECT_DIR" "$A_BRANCH"; then
  ok "own branch: the worker's commit on fix/arrow-up-own is on the team branch $A_BRANCH, no NO CHANGE ($(team_json '[.team.log[] | select(.message | test("branch of its own")) | .message[0:200]] | first // "no note"'))"
else
  not_ok "own branch: a worker made fix/arrow-up-own, but src/up.js on ${A_BRANCH:-<no team branch>} is not its change"
fi

# Alerts.
CONFLICTS=$(team_json '[.team.log[] | select(.type == "alert" and (.message | test("Merge conflict")))] | length')
if [ "${CONFLICTS:-0}" -gt 0 ]; then
  if team_json '.team.error // ""' | grep -q 'Stopped after'; then
    not_ok "alerts: the team had $CONFLICTS merge conflict(s) and was stopped on its alert count: $(team_json '.team.error')"
  else
    ok "alerts: $CONFLICTS merge conflict(s) did not stop the team (it ended $A_STATUS with $(team_json '.team.alerts') alert(s) on the record)"
  fi
else
  note "alerts: the two workers did not conflict on CHANGELOG.md, so this run did not test it"
fi
ACCEPTED=$(team_json '[.team.tasks[] | select(.status == "complete" and .review.verdict == "accepted")] | length')
if [ "${ACCEPTED:-0}" -gt 0 ] && [ "$ACCEPTED" = "$(team_json '.team.tasks | length')" ]; then
  if [ "$A_STATUS" = done ]; then
    ok "alerts: every task ($ACCEPTED) accepted, and the team ended done"
  else
    not_ok "alerts: every task ($ACCEPTED) was accepted, yet the team ended $A_STATUS: $(team_json '.team.error')"
  fi
fi

# Reviewer.
REVIEWERS=$(team_json '[.team.runs[] | select(.role == "reviewer") | .id] | join(" ")')
[ -n "$REVIEWERS" ] || note "reviewer: the team had no per-task reviewer run (shape $(team_json -c '.team.shape'))"
for rid in $REVIEWERS; do
  board_api GET "/setup-api/coding-agent/runs?id=$rid"
  RO=$(api_json '.run.readOnly')
  RAN=$(api_json '[.run.progress[]? | select(startswith("$"))] | length')
  SAID=$(api_json '(.run.resultText // .run.summary // "") | .[0:200]' | tr '\n' ' ')
  if [ "$RO" = false ] && [ "${RAN:-0}" -gt 0 ]; then
    ok "reviewer: $rid had a shell and ran $RAN command(s)"
  elif grep -qiE 'static review|could not (be )?run|no (git|shell)' <<<"$SAID"; then
    not_ok "reviewer: $rid could run nothing (readOnly=$RO, $RAN command(s)): $SAID"
  else
    note "reviewer: $rid readOnly=$RO, $RAN command(s): $SAID"
  fi
done

# Publish.
if [ "$A_STATUS" = done ] && [ -n "$A_BRANCH" ]; then
  if board 'git -C "$1" rev-parse --verify --quiet "refs/heads/$2" >/dev/null' "$PROJECT_DIR.origin" "$A_BRANCH"; then
    ok "publish: the team pushed $A_BRANCH to origin ($(team_json '.team.pr.url // ([.team.log[] | select(.message | test("pull request")) | .message[0:200]] | first) // "no note"'))"
  else
    not_ok "publish: the team is done with every task accepted, but $A_BRANCH is not on origin"
  fi
else
  note "publish: the first team ended $A_STATUS, so it had nothing to publish"
fi

# ---- the second team, where the first left the checkout ----------------------
LEFT=$(board 'git -C "$1" rev-parse --abbrev-ref HEAD' "$PROJECT_DIR")
note "the checkout is on $LEFT after the first team"
GOAL="Two independent tasks that can run side by side: 1. create docs/a.md holding the line A. 2. create docs/b.md holding the line B. Change nothing else."
if ! start_coding_team "$GOAL"; then
  not_ok "the second team did not start: $(api_error)"
  finish
fi
ok "second team $TEAM_ID started"
# Only its branch is wanted: stopped once it has one.
wait_coding_team 180 '.branch != null'
note_team "second team"
B_BRANCH=$(team_json '.team.branch // empty')
B_BASE=$(team_json '.team.base // empty')
if [ -z "$A_BRANCH" ] || [ "$LEFT" != "$A_BRANCH" ]; then
  note "base: the first team left the checkout on $LEFT, not on its branch, so this run did not test it"
elif [ -z "$B_BRANCH" ]; then
  note "base: the second team got no branch of its own (singleRun $(team_json '.team.singleRun')), so this run did not test it"
elif [ "$B_BASE" = develop ] && ! board 'git -C "$1" merge-base --is-ancestor "$2" "$3"' "$PROJECT_DIR" "$A_BRANCH" "$B_BRANCH"; then
  ok "base: the second team forked $B_BRANCH from develop, without the first team's commits, although the checkout was on $A_BRANCH"
else
  not_ok "base: the second team's base is ${B_BASE:-<none>} and $B_BRANCH $(board 'git -C "$1" merge-base --is-ancestor "$2" "$3" && echo carries || echo "does not carry"' "$PROJECT_DIR" "$A_BRANCH" "$B_BRANCH") the first team's commits"
fi

finish
