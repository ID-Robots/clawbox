#!/usr/bin/env bash
# timeout: 600
#
# A delegated coding run, end to end, through the routes the assistant uses
# (src/app/setup-api/coding-agent/): POST run with a tiny task in a fresh
# folder, long-poll runs?id= until it settles, and assert it `completed` AND
# left exactly the file it was asked for on disk. The run is authenticated with
# the board's MCP bearer, read on the board (lib.sh `api`), never printed.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent status did not answer: $(api_error)"
  finish
fi
note "status: $(api_json -c '{enabled, ready, defaultDirectory, running, generateImages, generateAudio}')"
if [ "$(api_json '.enabled')" != true ]; then
  not_ok "the coding agent is switched off on this board (status.enabled=false): the lab image must enable it"
  finish
fi
if [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a run: $(api_json -c '.readiness' | head -c 300)"
  finish
fi

if ! fresh_project_dir ""; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi
ok "fresh folder $PROJECT_DIR"

LINE="NANO-CI $NANO_SERIAL $NANO_RUN_ID $(date +%s)"
TASK="Create a file named hello.txt in the current working folder whose entire content is exactly this one line:
$LINE
Do not create, change or delete any other file, do not run a build or a server, and do not verify anything in a browser. Say done when the file is written."

if ! start_coding_run "$TASK"; then
  not_ok "the run did not start: $(api_error)"
  remove_project_dir
  finish
fi
ok "run $RUN_ID started (HTTP 202)"

wait_coding_run 540
expect_completed

# shellcheck disable=SC2016  # expanded on the board
CONTENT=$(board '
  ls -la "$1" >&2
  [ -f "$1/hello.txt" ] || { echo "<no hello.txt>"; exit 3; }
  cat "$1/hello.txt"
' "$PROJECT_DIR")
rc=$?
if [ "$rc" -eq 3 ]; then
  not_ok "hello.txt is not in $PROJECT_DIR"
elif [ "$CONTENT" = "$LINE" ]; then
  ok "hello.txt holds exactly the requested line"
else
  not_ok "hello.txt holds '$(printf '%s' "$CONTENT" | head -c 200 | tr '\n' '|')', expected '$LINE'"
fi

remove_project_dir
finish
