#!/usr/bin/env bash
# timeout: 720
# covers: src/lib/coding-team*.ts src/lib/coding-run-worktree.ts src/app/setup-api/coding-agent/team/*
#
# A real coding TEAM started while the box's only run slot is held by a run in
# ANOTHER folder, with a goal whose two steps edit the same two files, in a
# simulated repository (lib.sh make_sim_repo) whose checkout was left on a
# coding team's branch. Ways teams once failed with nothing wrong in the code:
#
#   busy slot  the team waits for the slot: no alert, no failure (three
#              "a coding run is already in progress" alerts once stopped a
#              team in 15 s)
#   overlap    a plan whose tasks name the same files runs as ONE run, said on
#              the board before it starts
#   base       that run's copy of the project forks from the project's base,
#              not from the team branch the checkout was left on
#
# A check whose situation did not come about (the other run was over first, a
# planner that did not split the work) is a note, never a pass. The owner's
# settings it changes are put back.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

SETTINGS_BEFORE=
HOLDER_DIR=
HOLDER=
# shellcheck disable=SC2317  # run by the EXIT trap
cleanup() {
  if [ -n "$HOLDER" ]; then
    board_api POST /setup-api/coding-agent/stop "$(jq -cn --arg id "$HOLDER" '{runId: $id}')"
  fi
  if [ -n "$SETTINGS_BEFORE" ]; then
    board_api POST /setup-api/coding-agent/settings "$SETTINGS_BEFORE"
    note "settings put back: HTTP $API_STATUS"
  fi
  # shellcheck disable=SC2016  # expanded on the board
  [ -z "$HOLDER_DIR" ] || board 'case "$1" in /home/clawbox/?*/nano-ci-*) rm -rf -- "$1" ;; esac' "$HOLDER_DIR" >/dev/null 2>&1
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
# One run at a time: the run in the other folder takes the box's only slot.
board_api POST /setup-api/coding-agent/settings '{"autoPr":false,"maxParallelRuns":1}'
[ "$API_STATUS" = 200 ] || { not_ok "could not allow only one run at once: $(api_error)"; finish; }

API_BODY=$STATUS_BODY
if ! fresh_project_dir "-busy" || ! make_sim_repo; then
  not_ok "could not prepare the simulated repository in $PROJECT_DIR"
  finish
fi
# What a team that failed leaves behind: the checkout on its branch, a commit on it.
# shellcheck disable=SC2016  # expanded on the board
if ! board '
  set -e
  cd "$1"
  git checkout -q -b clawbox/team-nanoci01
  printf "left by a team that failed\n" > LEFTOVER.md
  git add -A
  git commit -q -m "a failed team'"'"'s work"
' "$PROJECT_DIR"; then
  not_ok "could not leave the checkout on a team branch"
  finish
fi
ok "simulated repository on develop, its checkout left on clawbox/team-nanoci01, in $PROJECT_DIR"

HOLDER_DIR="${PROJECT_DIR%-busy}-holder"
# shellcheck disable=SC2016  # expanded on the board
if ! board 'case "$1" in /home/clawbox/?*/nano-ci-*) rm -rf -- "$1" && mkdir -p -- "$1" ;; *) exit 2 ;; esac' "$HOLDER_DIR"; then
  not_ok "could not create $HOLDER_DIR"
  finish
fi
board_api POST /setup-api/coding-agent/run "$(jq -cn --arg dir "$HOLDER_DIR" '{task: "Run the shell command `sleep 60` and wait for it to finish, then create done.txt in the current folder holding the line ok. Do nothing else.", directory: $dir}')"
HOLDER=$(api_json '.run.id // empty')
if [ "$API_STATUS" != 202 ] || [ -z "$HOLDER" ]; then
  not_ok "the run in the other folder did not start: $(api_error)"
  HOLDER=
  finish
fi
ok "run $HOLDER in another folder holds the box's only slot"

GOAL="Two steps on the same two files, src/keyboard.js and spec/keyboard.spec.js: step 1 renames up to forward in both files; step 2 adds export const back = -1; to src/keyboard.js and the line expect(back).toBe(-1); to spec/keyboard.spec.js. Both steps edit both files. Plan it as exactly two tasks, one per step, step 2 depending on step 1, each naming both files."
if ! start_coding_team "$GOAL"; then
  not_ok "the team did not start: $(api_error)"
  finish
fi
ok "team $TEAM_ID started"
wait_coding_team 480
note_team "team"

# Busy slot.
BUSY=$(team_json '[.team.log[] | select(.type == "alert" and (.message | test("already in progress|No worker|No lead|No planner|could not start"; "i")))] | length')
WAITS=$(team_json '[.team.log[] | select(.type == "note" and (.message | test("Waiting for a free slot")))] | length')
if [ "${BUSY:-0}" -gt 0 ]; then
  not_ok "busy slot: the team raised $BUSY alert(s) over the slot run $HOLDER held"
elif [ "${WAITS:-0}" -gt 0 ] && [ "$TEAM_STATUS" = "done" ]; then
  ok "busy slot: the team waited for the slot run $HOLDER held, raised no alert for it, and ended done"
elif [ "${WAITS:-0}" -gt 0 ] && [ "$TEAM_STATUS" = "failed" ] && [ -n "$(team_json '.team.unlanded.branch // empty')" ] \
  && team_json '.team.unlanded.reason // ""' | grep -q "not on"; then
  # This test leaves the checkout on a team branch (the base check below), so a
  # single run's merge home is refused as not on the base: the honest outcome
  # is failed with the branch named, never done with the project folder empty.
  ok "busy slot: the team waited for the slot run $HOLDER held, raised no alert for it, and ended failed only because the checkout this test left off its base would not take the merge (work on $(team_json '.team.unlanded.branch'))"
elif [ "${WAITS:-0}" -gt 0 ]; then
  not_ok "busy slot: the team waited for the slot, then ended $TEAM_STATUS: $(team_json '.team.error')"
else
  note "busy slot: the team never waited for a slot (run $HOLDER was over first), so this run did not test it"
fi

# Overlap.
ADVICE=$(team_json '.team.advice.reason // "none"')
SINGLE=$(team_json '.team.singleRun // false')
if [ "$ADVICE" = overlap ] && [ "$SINGLE" = true ]; then
  ok "overlap: a plan whose tasks share $(team_json '.team.advice.overlap')% of their files ran as one run"
elif [ "$ADVICE" = overlap ]; then
  not_ok "overlap: the plan's tasks share $(team_json '.team.advice.overlap')% of their files and it still ran as a team"
else
  note "overlap: the planner's tasks did not overlap (advice $ADVICE, singleRun $SINGLE), so this run did not test it"
fi

# Base of that single run.
RID=$(team_json 'if .team.singleRun then (.team.tasks[0].assigned_to // empty) else empty end')
if [ -n "$RID" ]; then
  board_api GET "/setup-api/coding-agent/runs?id=$RID"
  WT_BASE=$(api_json '.run.worktree.base // empty')
  WT_BRANCH=$(api_json '.run.worktree.branch // empty')
  # shellcheck disable=SC2016  # expanded on the board
  if [ -n "$WT_BRANCH" ] && ! board 'git -C "$1" rev-parse --verify --quiet "refs/heads/$2" >/dev/null' "$PROJECT_DIR" "$WT_BRANCH"; then
    note "base: the single run $RID's branch $WT_BRANCH is gone (forked from ${WT_BASE:-<none>}), so its history could not be read"
  elif [ "$WT_BASE" = develop ] && [ -n "$WT_BRANCH" ] && ! board 'git -C "$1" merge-base --is-ancestor clawbox/team-nanoci01 "$2"' "$PROJECT_DIR" "$WT_BRANCH"; then
    ok "base: the single run $RID forked $WT_BRANCH from develop, without the leftover team branch's commit"
  elif [ -n "$WT_BRANCH" ]; then
    not_ok "base: the single run $RID forked $WT_BRANCH from ${WT_BASE:-<none>}"
  else
    note "base: the single run $RID had no copy of its own"
  fi
fi

finish
