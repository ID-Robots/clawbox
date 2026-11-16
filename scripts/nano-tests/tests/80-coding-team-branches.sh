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
# branch of the worker's own) is a note, never a pass. A planner that runs the
# plan as ONE ordinary run is a valid outcome with checks of its own (TASK-2612).
# The owner's settings it changes are put back.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

SETTINGS_BEFORE=
# shellcheck disable=SC2317  # run by the EXIT trap
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
# The planner judges a plan whose tasks' files_hint mostly overlap
# (OVERLAP_ADVICE_SHARE, 60%: coding-team-board.ts teamAdvice) as one ordinary
# run, and it hints files as it likes. With one file of its own per task the
# planner's whim decided: [up.js, CHANGELOG.md] + [down.js, CHANGELOG.md] is
# 2 of 4 (50%, a team), the same with ./test.sh hinted by both is 4 of 6
# (67%, one run). So each task owns TWO files, in no folder the other's are
# in: even with CHANGELOG.md and test.sh hinted by both it is 4 of 8, 50%. A
# planner that still makes one run of it (a folder hint, src/keyboard.js named
# by both) is a valid outcome, checked as what it is below.
GOAL="Make two independent changes in this project, as two tasks that can run side by side. Each task owns two files of its own: task 1 owns src/up.js and UP.md, task 2 owns src/down.js and DOWN.md. Both also append to CHANGELOG.md. Change nothing else: src/keyboard.js, spec/ and ./test.sh stay as they are (./test.sh is only run).
1. In src/up.js change the value to: export const up = 1; and create UP.md holding the one line: up is now 1.
   This task is to be committed on a git branch of its own: first run \`git checkout -b fix/arrow-up-own\` in your folder, then edit src/up.js, write UP.md and commit them there.
2. In src/down.js change the value to: export const down = -1; and create DOWN.md holding the one line: down is now -1.
Each task also appends exactly one line to the end of CHANGELOG.md that says what it changed. After your change, run ./test.sh and quote what it prints.
Each task is to be reviewed on its own, by a reviewer that runs ./test.sh on it."
if ! start_coding_team "$GOAL"; then
  not_ok "the first team did not start: $(api_error)"
  finish
fi
ok "first team $TEAM_ID started"
wait_coding_team 450
note_team "first team"
A_STATUS=$TEAM_STATUS
A_BRANCH=$(team_json '.team.branch // empty')
A_SINGLE=$(team_json '.team.singleRun // false')

# Planner: a read-only run that could read the project before it planned.
PLANNER=$(team_json '.team.plannerRunId // ([.team.runs[] | select(.role == "planner") | .id] | first) // empty')
if [ -n "$PLANNER" ]; then
  board_api GET "/setup-api/coding-agent/runs?id=$PLANNER"
  READS=$(api_json '[.run.progress[]? | select(test("^(Read|Grep|Glob) |^\\$ git "))] | length')
  REFUSED=$(api_json '[(.run.deniedActions // [])[] | select(test("^(Read|Grep|Glob)"))] | length')
  if [ "${REFUSED:-0}" -gt 0 ]; then
    not_ok "planner: $PLANNER was refused $REFUSED read(s) of the project: $(api_json -c '.run.deniedActions[0:3]')"
  elif [ "$(api_json '.run.readOnly')" = true ] && [ "${READS:-0}" -gt 0 ]; then
    ok "planner: $PLANNER, read-only, read the project ($READS read step(s)) before it planned"
  else
    note "planner: $PLANNER readOnly=$(api_json '.run.readOnly'), $READS read step(s)"
  fi
fi

# Accepted and done: the same on both paths below.
ACCEPTED=$(team_json '[.team.tasks[] | select(.status == "complete" and .review.verdict == "accepted")] | length')
if [ "${ACCEPTED:-0}" -gt 0 ] && [ "$ACCEPTED" = "$(team_json '.team.tasks | length')" ]; then
  if [ "$A_STATUS" = "done" ]; then
    ok "alerts: every task ($ACCEPTED) accepted, and the team ended done"
  elif grep -q 'Stopped after' <<<"$(team_json '.team.error // ""')"; then
    not_ok "alerts: every task ($ACCEPTED) was accepted, yet the team was stopped on its alert count: $(team_json '.team.error')"
  else
    note "alerts: every task was accepted and the team ended $A_STATUS, not on its alert count: $(team_json '.team.error')"
  fi
fi

# ---- the planner made ONE ordinary run of it ------------------------------------
# A valid outcome (coding-team.ts runAsSingleRun): no team branch, worktrees or
# reviewer runs, so the own-branch, reviewer, publish and base checks below
# have nothing to look at. What must hold instead: the board says why, and a
# team that ended done has both changes where the run's work went — the
# project or the run's own branch — and not only on fix/arrow-up-own, where
# a worker's commit would have been lost.
if [ "$A_SINGLE" = true ]; then
  WHY=$(team_json '[.team.log[] | select(.type == "note" and (.message | test("one ordinary run"))) | .message[0:240]] | first // empty')
  if [ -n "$WHY" ]; then
    ok "single run: the planner's $(team_json '.team.tasks | length') task(s) ran as one ordinary run, and the board says why: $WHY"
  else
    not_ok "single run: the team ran as one run with no note saying why ($(team_json -c '.team.advice'))"
  fi
  WORKER=$(team_json '[.team.runs[] | select(.role == "worker") | .id] | first // empty')
  RUN_BRANCH="" PR_BRANCH=""
  if [ -n "$WORKER" ]; then
    board_api GET "/setup-api/coding-agent/runs?id=$WORKER"
    RUN_BRANCH=$(api_json '.run.worktree.branch // empty')
    PR_BRANCH=$(api_json '.run.pr.branch // empty')
    note "single run: $WORKER ended $(api_json '.run.status'), worktree $(api_json -c '.run.worktree | if . then {branch, base, result: (.result.kind // null), branchRemoved} else null end'), pull request $(api_json -c '.run.pr | if . then {branch, phase} else null end')"
  fi
  if grep -q 'NO CHANGE' <<<"$(team_json '.team.log[].message')"; then
    not_ok "single run: the team rejected the run's work as NO CHANGE"
  elif [ "$A_STATUS" != done ]; then
    note "single run: the team ended $A_STATUS ($(team_json '.team.error // "no error"')), so where its work landed was not checked"
  else
    # shellcheck disable=SC2016  # expanded on the board
    WHERE=$(board '
      cd "$1" || exit 1
      shift
      both() { case "$1" in *"up = 1"*) case "$2" in *"down = -1"*) return 0 ;; esac ;; esac; return 1; }
      if both "$(cat src/up.js 2>/dev/null)" "$(cat src/down.js 2>/dev/null)"; then echo "the project checkout"; exit 0; fi
      for ref in develop "$@"; do
        [ -n "$ref" ] && git rev-parse -q --verify "refs/heads/$ref" >/dev/null || continue
        if both "$(git show "$ref:src/up.js" 2>/dev/null)" "$(git show "$ref:src/down.js" 2>/dev/null)"; then echo "branch $ref"; exit 0; fi
      done
      exit 1
    ' "$PROJECT_DIR" "$RUN_BRANCH" "$PR_BRANCH")
    if [ -n "$WHERE" ]; then
      ok "single run: the team ended done and both changes (up = 1, down = -1) are in $WHERE, with no NO CHANGE"
    else
      not_ok "single run: the team ended done, but up = 1 and down = -1 are not both in the project or on the run's branch (${RUN_BRANCH:-none}${PR_BRANCH:+, $PR_BRANCH})"
    fi
  fi
  note "own branch, reviewer, publish, base: a single run has no team branch or reviewer runs, so this run did not test them (the second team is not started)"
  finish
fi

# ---- the multi-task team ---------------------------------------------------

# Own branch.
# shellcheck disable=SC2016  # expanded on the board
if [ "$(board 'git -C "$1" rev-parse --verify --quiet refs/heads/fix/arrow-up-own >/dev/null && echo made' "$PROJECT_DIR")" != made ]; then
  note "own branch: no worker made fix/arrow-up-own, so this run did not test it"
elif grep -q 'NO CHANGE' <<<"$(team_json '.team.log[].message')"; then
  not_ok "own branch: a worker committed on fix/arrow-up-own and the team rejected its work as NO CHANGE"
elif [ -n "$A_BRANCH" ] && board 'git -C "$1" show "$2:src/up.js" 2>/dev/null | grep -q "up = 1"' "$PROJECT_DIR" "$A_BRANCH"; then
  ok "own branch: the worker's commit on fix/arrow-up-own is on the team branch $A_BRANCH, no NO CHANGE ($(team_json '[.team.log[] | select(.message | test("branch of its own")) | .message[0:200]] | first // "no note"'))"
else
  not_ok "own branch: a worker made fix/arrow-up-own, but src/up.js on ${A_BRANCH:-<no team branch>} is not its change"
fi

# Alerts.
CONFLICTS=$(team_json '[.team.log[] | select(.type == "alert" and (.message | test("Merge conflict")))] | length')
if [ "${CONFLICTS:-0}" -gt 0 ]; then
  if grep -q 'Stopped after' <<<"$(team_json '.team.error // ""')"; then
    not_ok "alerts: the team had $CONFLICTS merge conflict(s) and was stopped on its alert count: $(team_json '.team.error')"
  else
    ok "alerts: $CONFLICTS merge conflict(s) did not stop the team (it ended $A_STATUS with $(team_json '.team.alerts') alert(s) on the record)"
  fi
else
  note "alerts: the two workers did not conflict on CHANGELOG.md, so this run did not test it"
fi

# Reviewer: each task's own has a shell. The one over the merged whole is
# read-only by design (read-only git, no shell): it must still have looked.
REVIEWERS=$(team_json '[.team.runs[] | select(.role == "reviewer" and (.taskId // null) != null) | .id] | join(" ")')
[ -n "$REVIEWERS" ] || note "reviewer: the team had no per-task reviewer run (shape $(team_json -c '.team.shape'))"
FINAL=$(team_json '[.team.runs[] | select(.role == "reviewer" and (.taskId // null) == null) | .id] | join(" ")')
for rid in $FINAL; do
  board_api GET "/setup-api/coding-agent/runs?id=$rid"
  RAN=$(api_json '[.run.progress[]? | select(startswith("$"))] | length')
  SAID=$(api_json '(.run.resultText // .run.summary // "") | .[0:200]' | tr '\n' ' ')
  if grep -qiE 'static review|could not (be )?run|no (git|shell)' <<<"$SAID"; then
    not_ok "reviewer: the final reviewer $rid could run nothing ($RAN command(s)): $SAID"
  elif [ "${RAN:-0}" -gt 0 ]; then
    ok "reviewer: the final reviewer $rid (read-only) ran $RAN git command(s) and ruled: $SAID"
  else
    note "reviewer: the final reviewer $rid ran no command: $SAID"
  fi
done
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
# shellcheck disable=SC2016  # expanded on the board
if [ "$A_STATUS" = "done" ] && [ -n "$A_BRANCH" ]; then
  if board 'git -C "$1" rev-parse --verify --quiet "refs/heads/$2" >/dev/null' "$PROJECT_DIR.origin" "$A_BRANCH"; then
    ok "publish: the team pushed $A_BRANCH to origin ($(team_json '.team.pr.url // ([.team.log[] | select(.message | test("pull request")) | .message[0:200]] | first) // "no note"'))"
  else
    not_ok "publish: the team is done with every task accepted, but $A_BRANCH is not on origin"
  fi
else
  note "publish: the first team ended $A_STATUS, so it had nothing to publish"
fi

# ---- the second team, where the first left the checkout ----------------------
# shellcheck disable=SC2016  # expanded on the board
LEFT=$(board 'git -C "$1" rev-parse --abbrev-ref HEAD' "$PROJECT_DIR")
note "the checkout is on $LEFT after the first team"
# This test stops the second team, and a team the owner stopped holds its
# goal (coding-team.ts ownerStopRefusal): the run id keeps the next run of
# this test on the same board from being refused as that work.
# Two files at the top of the project, in no shared folder: a planner that
# hinted docs/ for both (docs/a.md, docs/b.md) made it 100% overlap and one
# run, with no branch to judge the base by.
GOAL="Two independent tasks that can run side by side: 1. create A.md at the top of the project holding the line A. 2. create B.md at the top of the project holding the line B. Change nothing else. (nano-ci $NANO_RUN_ID)"
if ! start_coding_team "$GOAL"; then
  not_ok "the second team did not start: $(api_error)"
  finish
fi
ok "second team $TEAM_ID started"
# Only its branch is wanted: stopped once it has one.
wait_coding_team 120 '.branch != null'
note_team "second team"
B_BRANCH=$(team_json '.team.branch // empty')
B_BASE=$(team_json '.team.base // empty')
# shellcheck disable=SC2016  # expanded on the board
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
