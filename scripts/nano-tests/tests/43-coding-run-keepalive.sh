#!/usr/bin/env bash
# timeout: 1500
# covers: scripts/coding-run-hook.mjs src/lib/coding-run-inbox.ts src/lib/coding-run-worktree.ts
# covers: src/lib/coding-run-inputs.ts
#
# A coding run must not end its turn while work it started is still running
# (the keep-alive Stop hook), and two start options it depends on:
#
#   - the project folder is a git repository checked out on an UNRELATED
#     branch, and the run is started with baseBranch "beta": its own branch
#     must fork from beta and carry nothing of the unrelated branch;
#   - it is GIVEN a file from the owner's Documents folder (input_files),
#     which used to be refused as outside_roots;
#   - it is told to start a four-minute background job and then to END ITS
#     TURN without waiting. Before the hook the run settled at once with the
#     job's result never written; now the hook keeps the turn open, so the run
#     may only settle after the job wrote its file, and its page says the stop
#     guard kept it working.
#
# Authenticated with the board's MCP bearer, read on the board (lib.sh `api`).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

JOB_SECONDS=240

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent status did not answer: $(api_error)"
  finish
fi
if [ "$(api_json '.enabled')" != true ] || [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a run here: $(api_json -c '{enabled, ready}')"
  finish
fi

if ! fresh_project_dir "-keepalive"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi

TOKEN="KEEPALIVE-$NANO_SERIAL-$(date +%s)"
INPUT=$BOARD_HOME/Documents/nano-ci-keepalive-input.txt
# A repository with main and beta, checked out on a branch beta does not have.
# shellcheck disable=SC2016  # expanded on the board
if ! board '
  set -e
  cd "$1"
  git init -q -b main
  git config user.email nano-ci@example.invalid
  git config user.name nano-ci
  echo base > base.txt
  git add -A && git commit -q -m base
  git branch beta
  git checkout -q -b nano-ci/unrelated
  echo unrelated > unrelated.txt
  git add -A && git commit -q -m unrelated
  mkdir -p "$(dirname "$2")"
  printf "%s\n" "$3" > "$2"
' "$PROJECT_DIR" "$INPUT" "$TOKEN"; then
  not_ok "could not prepare the repository in $PROJECT_DIR"
  remove_project_dir
  finish
fi
ok "repository on nano-ci/unrelated with main and beta, input file in Documents"

TASK="There is one file in the folder named by \$CLAWBOX_RUN_INPUTS_DIR. Read the single line it holds.
Then start this background job with the Bash tool, exactly once, and do not wait for it yourself:
  nohup sh -c 'sleep $JOB_SECONDS; printf \"%s\\n\" \"<the line>\" > late.txt' >/dev/null 2>&1 &
(with <the line> replaced by the line you read). Right after starting it, end your turn: say \"started\" and stop.
Do not write late.txt yourself, do not change any other file, do not run a build or a server."

START=$(date +%s)
body=$(jq -cn --arg task "$TASK" --arg dir "$PROJECT_DIR" --arg input "$INPUT" \
  '{task: $task, directory: $dir, baseBranch: "beta", inputs: [$input]}')
board_api POST /setup-api/coding-agent/run "$body"
RUN_ID=$(api_json '.run.id // empty')
if [ "$API_STATUS" != 202 ] || [ -z "$RUN_ID" ]; then
  not_ok "the run did not start: HTTP $API_STATUS $(api_error)"
  remove_project_dir
  finish
fi
ok "run $RUN_ID started (HTTP 202)"

note "inputs: $(api_json -c '.run.inputs // .run.inputFiles // empty' | head -c 300)"
if [ "$(api_json -r '.run.worktree.base // empty')" = beta ]; then
  ok "its copy forks from beta, not from the checked-out branch"
else
  not_ok "its copy forks from '$(api_json -r '.run.worktree.base // empty')', expected beta"
fi
BRANCH=$(api_json -r '.run.worktree.branch // empty')

wait_coding_run 1300
ELAPSED=$(( $(date +%s) - START ))
expect_completed
note "settled after ${ELAPSED}s"
PROGRESS=$(api_json -r '.run.progress // [] | join("\n")')

if [ "$ELAPSED" -ge "$JOB_SECONDS" ]; then
  ok "the run stayed open until its ${JOB_SECONDS}s job was done (${ELAPSED}s)"
else
  not_ok "the run settled after ${ELAPSED}s, before its ${JOB_SECONDS}s job could finish"
fi
if printf '%s' "$PROGRESS" | grep -q "The stop guard kept the run working"; then
  ok "its page says the stop guard kept it working"
else
  not_ok "no stop-guard line on the run's page"
fi

# The run's commit is on its own branch (the project sits on another branch,
# so it is not merged home). late.txt was written by the background job, not
# by a file tool, and must still be committed there with the input's line.
# shellcheck disable=SC2016  # expanded on the board
LATE=$(board '
  cd "$1"
  b=$2
  [ -n "$b" ] || b=$(git for-each-ref --format="%(refname:short)" "refs/heads/clawbox/*" | head -n1)
  git show "$b:late.txt" 2>/dev/null || echo "<late.txt is not committed on $b>"
  if git cat-file -e "$b:unrelated.txt" 2>/dev/null; then echo "<carries unrelated.txt>"; fi
  git merge-base --is-ancestor beta "$b" 2>/dev/null || echo "<not forked from beta>"
  [ -d ".clawbox/worktrees/$3" ] && echo "worktree kept: $(git -C ".clawbox/worktrees/$3" status --porcelain | tr "\n" " ")"
' "$PROJECT_DIR" "$BRANCH" "$RUN_ID")
note "branch $BRANCH: $(printf '%s' "$LATE" | tr '\n' '|')"
if printf '%s\n' "$LATE" | grep -qx "$TOKEN"; then
  ok "late.txt, written by the background job, is committed on the run's branch with the input's line"
else
  not_ok "late.txt is not committed on the run's branch with the input's line"
fi
if printf '%s' "$LATE" | grep -q "<carries unrelated.txt>\|<not forked from beta>"; then
  not_ok "the run's branch is not a clean fork of beta"
else
  ok "the run's branch is a fork of beta without the unrelated branch's work"
fi

# shellcheck disable=SC2016  # expanded on the board
board 'rm -f -- "$1"' "$INPUT" >/dev/null 2>&1
remove_project_dir
finish
