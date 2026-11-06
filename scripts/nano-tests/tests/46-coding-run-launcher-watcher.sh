#!/usr/bin/env bash
# timeout: 900
# covers: scripts/coding-run-hook.mjs src/lib/coding-run-inbox.ts
#
# The keep-alive Stop hook, and the settle's "left running", count only what
# the RUN started — not what the launcher of its harness put in its scope.
#
# A launcher's own watcher (`<launcher> --heal-watch <session dir>`, forked at
# session start, reparented to init, alive until the session ends) shares the
# run's scope. The hook refused every stop over it as "a process you started",
# so finished runs looped on sleep and ps until the refusals ran out. Here the
# board's claude-ds wrapper is put behind a stand-in launcher that leaves such a
# watcher in every run's scope (and logs where it was), and then:
#
#   - a run that only writes a file must settle `completed` promptly, with no
#     stop-guard line on its page and nothing left running on its record, while
#     the watcher was in its scope for the whole run;
#   - a run that leaves a server listening on a port (the documented exception)
#     must settle `completed` too, its record must say it left something
#     running, and the owner's Kill must end the server.
#
# The background job that must still keep a run open is 43-coding-run-keepalive.
# The wrapper is put back afterwards, also when this test fails.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# A run that only writes one file settles in a minute or two; the old loop ran
# until the hook's refusals were spent. Two waits (each may overrun by one 60 s
# poll) fit the 900 s deadline.
QUICK_SECONDS=300
PORT=$(( 18000 + RANDOM % 2000 ))
LAUNCHER_LOG=$BOARD_HOME/.cache/nano-ci-launcher.log

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent status did not answer: $(api_error)"
  finish
fi
if [ "$(api_json '.enabled')" != true ] || [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a run here: $(api_json -c '{enabled, ready}')"
  finish
fi

restore_wrapper() {
  # shellcheck disable=SC2016  # expanded on the board
  board '
    w=$HOME/.local/bin/claude-ds
    if [ -e "$w.nano-ci-real" ]; then mv -f "$w.nano-ci-real" "$w"; fi
  ' >/dev/null 2>&1
}
# On every way out, a runner's TERM or a hang-up included; and first of all,
# in case an earlier run of this test was killed before it could.
trap restore_wrapper EXIT
trap 'restore_wrapper; exit 143' TERM
trap 'restore_wrapper; exit 130' INT
trap 'restore_wrapper; exit 129' HUP
restore_wrapper

# The stand-in launcher: forks its watcher into a session of its own and lets
# go of it (init adopts it), with the session folder on its command line, then
# becomes the real wrapper. The watcher lives until the harness (the pid the
# launcher becomes) is gone, and logs its cgroup so the test can show it sat in
# the run's scope.
# shellcheck disable=SC2016  # expanded on the board
if ! board '
  set -e
  w=$HOME/.local/bin/claude-ds
  [ -x "$w" ]
  [ -e "$w.nano-ci-real" ] || cp -p "$w" "$w.nano-ci-real"
  mkdir -p "$(dirname "$1")"
  : > "$1"
  cat > "$w.nano-ci-shim" <<SHIM
#!/bin/sh
# nano-ci 46-coding-run-launcher-watcher: a launcher that leaves its own watcher in the run scope
s=\$(mktemp -d /tmp/nano-ci-launcher.XXXXXX)
( setsid sh -c '"'"'printf "start %s %s %s\n" "\$\$" "\$3" "\$(grep -m1 "^0::" /proc/self/cgroup)" >> "\$4"; while kill -0 "\$1" 2>/dev/null; do sleep 2; done; printf "end %s\n" "\$\$" >> "\$4"; rm -rf "\$2"'"'"' nano-ci-launcher "\$\$" "\$s" "\$s" "$1" --heal-watch "\$s" </dev/null >/dev/null 2>&1 & )
exec "\$0.nano-ci-real" "\$@"
SHIM
  chmod 755 "$w.nano-ci-shim"
  mv -f "$w.nano-ci-shim" "$w"
' "$LAUNCHER_LOG"; then
  not_ok "could not put the stand-in launcher in front of claude-ds"
  finish
fi
ok "claude-ds now starts behind a launcher that leaves a --heal-watch watcher in the run's scope"

# --- 1. a run that starts nothing of its own --------------------------------
if ! fresh_project_dir "-launcher"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi
START=$(date +%s)
if ! start_coding_run "Write the single word done into a new file named done.txt in this folder, then end your turn. Do not start any background process, server or job."; then
  not_ok "the run did not start: HTTP $API_STATUS $(api_error)"
  remove_project_dir
  finish
fi
ok "run $RUN_ID started"
wait_coding_run "$QUICK_SECONDS"
ELAPSED=$(( $(date +%s) - START ))
expect_completed
note "settled after ${ELAPSED}s"
PROGRESS=$(api_json -r '.run.progress // [] | join("\n")')
if printf '%s' "$PROGRESS" | grep -q "The stop guard kept the run working"; then
  not_ok "the stop guard held the run although it started nothing: $(printf '%s' "$PROGRESS" | grep -m1 'stop guard')"
else
  ok "no stop-guard line: the launcher's watcher did not hold the run"
fi
# The settle's verdict comes a moment after the harness has gone.
sleep 8
board_api GET "/setup-api/coding-agent/runs?id=$RUN_ID"
if [ "$(api_json '.run.leftover')" = true ]; then
  not_ok "its record says it left something running: $(api_json -r '.run.progress // [] | map(select(test("still running"))) | join("; ")')"
else
  ok "its record says it left nothing running"
fi
# shellcheck disable=SC2016  # expanded on the board
SEEN=$(board '
  cat "$1" 2>/dev/null
  e=$HOME/clawbox/data/coding-agent-artifacts/$2/.run-jobs
  for f in "$e"/first-command-*; do [ -e "$f" ] && echo "clock $(basename "$f"): $(tr "\n" " " < "$f")"; done
  if [ -e "$e/stop-blocks.json" ]; then echo "stop-blocks: $(cat "$e/stop-blocks.json")"; fi
  true
' "$LAUNCHER_LOG" "$RUN_ID")
note "launcher log and clock: $(printf '%s' "$SEEN" | tr '\n' '|' | head -c 600)"
if printf '%s\n' "$SEEN" | grep -q "^start .*clawbox-run-$RUN_ID-"; then
  ok "the launcher's watcher sat in the run's own scope (clawbox-run-$RUN_ID-…)"
else
  not_ok "no watcher was seen in the run's scope, so this run proves nothing"
fi
if printf '%s\n' "$SEEN" | grep -q "^clock first-command-[a-z0-9]*: [0-9]"; then
  ok "the spawn's command clock was stamped before its first command"
else
  not_ok "the spawn's command clock was not stamped"
fi
if printf '%s\n' "$SEEN" | grep -q "^stop-blocks:"; then
  not_ok "the stop guard refused a stop: $(printf '%s\n' "$SEEN" | grep -m1 '^stop-blocks:' | head -c 300)"
else
  ok "the stop guard never refused this run's stop"
fi
remove_project_dir

# --- 2. a run that leaves a server listening ---------------------------------
if ! fresh_project_dir "-launcher-server"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi
if ! start_coding_run "Leave a web server running for the owner: start it with the Bash tool exactly like this, in the background:
  nohup python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
Check with curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ that it answers 200, then end your turn and leave the server running. Do not change any file."; then
  not_ok "the server run did not start: HTTP $API_STATUS $(api_error)"
  remove_project_dir
  finish
fi
ok "run $RUN_ID started (server on port $PORT)"
wait_coding_run "$QUICK_SECONDS"
expect_completed
sleep 8
board_api GET "/setup-api/coding-agent/runs?id=$RUN_ID"
if [ "$(api_json '.run.leftover')" = true ]; then
  ok "its record says it left something running (left_running)"
else
  not_ok "the server it left is not on its record: leftover=$(api_json '.run.leftover')"
fi
# shellcheck disable=SC2016  # expanded on the board
UP=$(board 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$1/"' "$PORT")
if [ "$UP" = 200 ]; then
  ok "the server it left answers on $PORT"
else
  not_ok "nothing answers on $PORT ($UP)"
fi
board_api POST /setup-api/coding-agent/kill "$(jq -cn --arg id "$RUN_ID" '{runId: $id}')"
sleep 5
# shellcheck disable=SC2016  # expanded on the board
DOWN=$(board 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$1/"' "$PORT")
if [ "$API_STATUS" = 200 ] && [ "$DOWN" != 200 ]; then
  ok "the owner's Kill ended the server it left"
else
  not_ok "Kill answered HTTP $API_STATUS and the port still answers $DOWN"
  # shellcheck disable=SC2016  # expanded on the board
  board 'pkill -f "http.server $1" 2>/dev/null; true' "$PORT" >/dev/null 2>&1
fi
remove_project_dir

restore_wrapper
trap - EXIT TERM INT HUP
# shellcheck disable=SC2016  # expanded on the board
if board 'w=$HOME/.local/bin/claude-ds; ! grep -q nano-ci "$w" && [ ! -e "$w.nano-ci-real" ]'; then
  ok "claude-ds is the installed wrapper again"
else
  not_ok "claude-ds was not put back"
fi
finish
