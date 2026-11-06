#!/usr/bin/env bash
# timeout: 900
# covers: scripts/coding-run-hook.mjs src/lib/coding-run-inbox.ts
#
# The launcher's watcher RESTARTED MID-RUN is not the run's work either.
#
# 46-coding-run-launcher-watcher shows a watcher forked at session start is
# told apart by the command clock. A launcher also restarts its watcher
# (`<launcher> --heal-watch <session dir>`) when it moves the session to
# another account mid-run: AFTER the run's first command, in a session of its
# own, adopted by init — the clock cannot tell it from a job the run
# backgrounded, and the Stop hook held finished runs over it until its
# refusals ran out. Here the board's claude-ds is put behind a stand-in
# launcher whose watcher waits for the spawn's command clock to be stamped,
# then restarts itself with the harness's own session folder (its
# CLAUDE_CONFIG_DIR) on its command line, and stays a few seconds after the
# harness has gone, as a launcher's watcher takes a moment to notice. Then:
#
#   - a run that only sleeps and writes a file must settle `completed` with no
#     stop-guard line, no `stop-blocks.json` and `leftover` false, while the log
#     shows the restarted watcher in its scope, started after the clock's
#     stamp, and alive until after the harness had gone;
#   - a run that leaves `setsid python3 -m http.server` listening must still
#     have it on its record (`leftover` true), the stop guard naming no
#     watcher, and the owner's Kill must end the server.
#
# The wrapper is put back afterwards, also when this test fails.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# Each run settles in a minute or two; two waits (each may overrun by one
# 60 s poll) fit the 900 s deadline.
QUICK_SECONDS=300
PORT=$(( 18000 + RANDOM % 2000 ))
LAUNCHER_LOG=$BOARD_HOME/.cache/nano-ci-launcher-47.log
LAUNCHER=$BOARD_HOME/.cache/nano-ci-launcher-47

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent status did not answer: $(api_error)"
  finish
fi
if [ "$(api_json '.enabled')" != true ] || [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a run here: $(api_json -c '{enabled, ready}')"
  finish
fi
note "agent runtime: $(board_runtime)"

restore_wrapper() {
  # shellcheck disable=SC2016  # expanded on the board
  board '
    w=$HOME/.local/bin/claude-ds
    if [ -e "$w.nano-ci-real" ]; then mv -f "$w.nano-ci-real" "$w"; fi
    rm -f "$1"
  ' "$LAUNCHER" >/dev/null 2>&1
}
# On every way out, a runner's TERM or a hang-up included; and first of all,
# in case an earlier run of this test was killed before it could.
trap restore_wrapper EXIT
trap 'restore_wrapper; exit 143' TERM
trap 'restore_wrapper; exit 130' INT
trap 'restore_wrapper; exit 129' HUP
restore_wrapper

# The stand-in launcher: forks its watcher into a session of its own and lets
# go of it (init adopts it), then becomes the real wrapper — the harness keeps
# the launcher's pid. The watcher logs where it is, finds its spawn's command
# clock by the scope it sits in (clawbox-run-<run id>-<token>.scope), waits for
# the stamp and restarts itself with the session folder on its command line.
# shellcheck disable=SC2016  # expanded on the board
if ! board '
  set -e
  w=$HOME/.local/bin/claude-ds
  [ -x "$w" ]
  [ -e "$w.nano-ci-real" ] || cp -p "$w" "$w.nano-ci-real"
  mkdir -p "$(dirname "$1")"
  : > "$1"
  cat > "$2" <<\WATCH
#!/bin/sh
# nano-ci 47-coding-run-launcher-watcher-midrun: the stand-in launcher watcher.
#   <this> <harness pid> <log> start
#     at session start: waits for the run first command, then restarts itself
#     the way a launcher does when it moves the session to another account
#   <this> <harness pid> <log> --heal-watch <session dir>
#     the restarted watcher, alive until a while after the harness is gone
h=$1 log=$2
cg=$(grep -m1 "^0::" /proc/self/cgroup)
if [ "$3" = --heal-watch ]; then
  printf "restart %s %s %s %s\n" "$$" "$(cut -d" " -f22 /proc/$$/stat)" "$4" "$cg" >> "$log"
  while kill -0 "$h" 2>/dev/null; do sleep 2; done
  sleep 6
  printf "end %s\n" "$$" >> "$log"
  exit 0
fi
printf "start %s %s\n" "$$" "$cg" >> "$log"
scope=${cg##*/}; rest=${scope#clawbox-run-}; rest=${rest%.scope}
clock=$HOME/clawbox/data/coding-agent-artifacts/${rest%-*}/.run-jobs/first-command-${rest##*-}
i=0
while [ ! -s "$clock" ] && kill -0 "$h" 2>/dev/null && [ "$i" -lt 3000 ]; do sleep 0.2; i=$((i + 1)); done
if [ ! -s "$clock" ]; then printf "no-clock %s\n" "$clock" >> "$log"; exit 0; fi
sleep 1
session=$(tr "\0" "\n" < "/proc/$h/environ" 2>/dev/null | sed -n "s/^CLAUDE_CONFIG_DIR=//p" | head -n 1)
[ -n "$session" ] || session=$HOME/.claude
setsid "$0" "$h" "$log" --heal-watch "$session" </dev/null >/dev/null 2>&1 &
exit 0
WATCH
  chmod 755 "$2"
  cat > "$w.nano-ci-shim" <<SHIM
#!/bin/sh
# nano-ci 47-coding-run-launcher-watcher-midrun: a launcher whose watcher restarts mid-run
( setsid "$2" "\$\$" "$1" start </dev/null >/dev/null 2>&1 & )
exec "\$0.nano-ci-real" "\$@"
SHIM
  chmod 755 "$w.nano-ci-shim"
  mv -f "$w.nano-ci-shim" "$w"
' "$LAUNCHER_LOG" "$LAUNCHER"; then
  not_ok "could not put the stand-in launcher in front of claude-ds"
  finish
fi
ok "claude-ds now starts behind a launcher that restarts its --heal-watch watcher after the run's first command"

# launcher_seen RUN_ID — the launcher's log, the spawn's clock, the session
# its Stop hook recorded, and its stop-blocks.json if there is one.
launcher_seen() {
  # shellcheck disable=SC2016  # expanded on the board
  board '
    cat "$1" 2>/dev/null
    e=$HOME/clawbox/data/coding-agent-artifacts/$2/.run-jobs
    for f in "$e"/first-command-*; do
      [ -e "$f" ] || continue
      case "$f" in
        *.stop-ran) echo "stop-ran: $(tr "\n" " " < "$f")" ;;
        *) echo "clock $(basename "$f"): $(tr "\n" " " < "$f")" ;;
      esac
    done
    if [ -e "$e/stop-blocks.json" ]; then echo "stop-blocks: $(cat "$e/stop-blocks.json")"; fi
    true
  ' "$LAUNCHER_LOG" "$1"
}

# restarted_in_scope SEEN RUN_ID — ok/not ok: the watcher restarted in that
# run's scope, after the clock's stamp. Sets RESTART_PID and RESTART_SESSION.
restarted_in_scope() {
  local line stamp ticks
  line=$(printf '%s\n' "$1" | grep -m1 "^restart .*clawbox-run-$2-")
  RESTART_PID=$(printf '%s' "$line" | awk '{print $2}')
  ticks=$(printf '%s' "$line" | awk '{print $3}')
  RESTART_SESSION=$(printf '%s' "$line" | awk '{print $4}')
  stamp=$(printf '%s\n' "$1" | sed -n 's/^clock first-command-[a-z0-9]*: \([0-9][0-9.]*\).*/\1/p' | head -n 1)
  if [ -z "$line" ]; then
    not_ok "no watcher restarted in the run's scope, so this run proves nothing: $(printf '%s' "$1" | grep -m1 '^no-clock' || true)"
    return
  fi
  if [ -z "$stamp" ]; then
    not_ok "the spawn's command clock was not stamped"
    return
  fi
  if awk -v t="$ticks" -v s="$stamp" 'BEGIN { exit !(t + 0 > s * 100) }'; then
    ok "the launcher restarted its watcher (pid $RESTART_PID, --heal-watch $RESTART_SESSION) in the run's scope AFTER the first command (start $ticks > clock $stamp s)"
  else
    not_ok "the restarted watcher did not start after the clock's stamp (start $ticks, clock $stamp s)"
  fi
}

# --- 1. a run that starts nothing of its own --------------------------------
if ! fresh_project_dir "-launcher-midrun"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi
START=$(date +%s)
if ! start_coding_run "First run the command: sleep 8 — with the Bash tool, in the foreground. Then write the single word done into a new file named done.txt in this folder, and end your turn. Do not start any background process, server or job."; then
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
  ok "no stop-guard line: the restarted watcher did not hold the run"
fi
# The settle's verdict comes a moment after the harness has gone, while the
# watcher is still there (it stays 6-8 s longer).
sleep 12
board_api GET "/setup-api/coding-agent/runs?id=$RUN_ID"
if [ "$(api_json '.run.leftover')" = true ]; then
  not_ok "its record says it left something running: $(api_json -r '.run.progress // [] | map(select(test("still running"))) | join("; ")')"
else
  ok "its record says it left nothing running"
fi
SEEN=$(launcher_seen "$RUN_ID")
note "launcher log and clock: $(printf '%s' "$SEEN" | tr '\n' '|' | head -c 900)"
restarted_in_scope "$SEEN" "$RUN_ID"
if [ -n "$RESTART_PID" ] && printf '%s\n' "$SEEN" | grep -q "^end $RESTART_PID\$"; then
  ok "the restarted watcher lived until after the harness had gone"
else
  not_ok "the restarted watcher did not outlive the harness, so the stop proves nothing"
fi
if [ -n "$RESTART_SESSION" ] && printf '%s\n' "$SEEN" | grep '^stop-ran: ' | grep -qF -- " $RESTART_SESSION "; then
  ok "the Stop hook recorded the harness's session folder, the one the watcher names"
else
  not_ok "the Stop hook's record does not name the watcher's session: $(printf '%s\n' "$SEEN" | grep -m1 '^stop-ran' || echo none)"
fi
if printf '%s\n' "$SEEN" | grep -q "^stop-blocks:"; then
  not_ok "the stop guard refused a stop: $(printf '%s\n' "$SEEN" | grep -m1 '^stop-blocks:' | head -c 300)"
else
  ok "the stop guard never refused this run's stop"
fi
remove_project_dir

# --- 2. a run that leaves a setsid server listening -------------------------
if ! fresh_project_dir "-launcher-midrun-server"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi
if ! start_coding_run "First run the command: sleep 5 — with the Bash tool, in the foreground. Then leave a web server running for the owner: start it with the Bash tool exactly like this:
  setsid python3 -m http.server $PORT --bind 127.0.0.1 </dev/null >/dev/null 2>&1 &
Check with curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ that it answers 200, then end your turn and leave the server running. Do not change any file."; then
  not_ok "the server run did not start: HTTP $API_STATUS $(api_error)"
  remove_project_dir
  finish
fi
ok "run $RUN_ID started (server on port $PORT)"
wait_coding_run "$QUICK_SECONDS"
expect_completed
sleep 12
board_api GET "/setup-api/coding-agent/runs?id=$RUN_ID"
if [ "$(api_json '.run.leftover')" = true ]; then
  ok "its record says it left something running (left_running)"
else
  not_ok "the server it left is not on its record: leftover=$(api_json '.run.leftover')"
fi
SEEN=$(launcher_seen "$RUN_ID")
note "launcher log and clock: $(printf '%s' "$SEEN" | tr '\n' '|' | head -c 900)"
restarted_in_scope "$SEEN" "$RUN_ID"
if printf '%s\n' "$SEEN" | grep '^stop-blocks:' | grep -q -- '--heal-watch'; then
  not_ok "the stop guard named the launcher's watcher: $(printf '%s\n' "$SEEN" | grep -m1 '^stop-blocks:' | head -c 300)"
else
  ok "the stop guard never named the launcher's watcher"
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
if board 'w=$HOME/.local/bin/claude-ds; ! grep -q nano-ci "$w" && [ ! -e "$w.nano-ci-real" ] && [ ! -e "$1" ]' "$LAUNCHER"; then
  ok "claude-ds is the installed wrapper again"
else
  not_ok "claude-ds was not put back"
fi
finish
