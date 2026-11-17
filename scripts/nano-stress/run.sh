#!/usr/bin/env bash
# ClawBox stress run on a nano-lab board (TASK-2500). See docs/nano-stress-test.md.
#
#   scripts/nano-stress/run.sh [--results DIR] [--budget-min N] [--strict] <serial> [-- STRESS_OPTION ...]
#   scripts/nano-stress/run.sh --unpack-to DIR
#
# Runs on the lab RUNNER HOST, like scripts/nano-tests: every board command goes
# through `$NANO_CI ssh <serial>` (scripts/nano-tests/lib.sh), so set
# NANO_CI=nano-board for a board leased with nano-lease. It
#
#   1. reads which agent runtime the board runs (OpenClaw or Hermes) and waits
#      for it to be settled;
#   2. packs board-stress.mjs and every local module it imports, followed
#      through their own imports (board-modules.mjs), unpacks them in a fresh
#      /tmp folder on the board and starts the run DETACHED there (an ssh
#      hiccup during a 30–60 min run must not end it);
#   3. polls it, printing its progress lines, until it writes its record;
#   4. brings the raw record and the board-side log back into DIR and runs
#      report.mjs: DIR/stress-<runtime>.json and DIR/stress-<runtime>.md;
#   5. removes its folder on the board once the record is safely here.
#      Interrupted, it stops the board side first (which ends its turns and
#      deletes its chat sessions before it exits) and brings back the partial
#      record; a record that will not come back keeps the folder on the board.
#
# STRESS_OPTIONs go to board-stress.mjs unchanged, e.g.
#   -- --ramp 1,2,4,8 --ramp-turns 3 --long-turns 32 --tool-turns 8 --steps idle,ramp,long,tool
#
# --unpack-to DIR packs the board side and unpacks it into DIR here, the same
# way the board does, prints the entry's path inside DIR and exits: the check
# that what the board gets is complete (src/tests/unit/nano-stress-ship.test.ts).
#
# Exit status: 0 when the run finished and its record was summarised; 1 when
# it did not finish (the budget ran out, it died, it would not start) or its
# record could not be read — a partial record is still summarised then; 3 with
# --strict when the summary lists findings (failed turns, OOM kills, restarts,
# low memory).
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RESULTS=
BUDGET_MIN=150
STRICT=0
SERIAL=
UNPACK_TO=
while [ $# -gt 0 ]; do
  case "$1" in
    --results) RESULTS=$2; shift 2 ;;
    --unpack-to) UNPACK_TO=$2; shift 2 ;;
    --budget-min) BUDGET_MIN=$2; shift 2 ;;
    --strict) STRICT=1; shift ;;
    --) shift; break ;;
    -h|--help) sed -n '2,35p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) SERIAL=$1; shift ;;
  esac
done
# ---- the board side, packed ----------------------------------------------------
#
# Everything the board runs travels as ONE base64 argument inside the ONE
# command string the ssh hop carries (lib.sh `board`), base64-encoded again
# there. Linux caps a single argument at 128 KiB (MAX_ARG_STRLEN), so the
# payload — the gzipped tar of every module, base64 — must stay under
# NANO_STRESS_MAX_PAYLOAD characters: 80000 is ~107 KiB after the second
# encoding, prelude included, and about 200 KB of source.
MAX_PAYLOAD=${NANO_STRESS_MAX_PAYLOAD:-80000}
PAYLOAD=
ENTRY=
pack_board_side() {
  local tgz rc
  tgz=$(mktemp) || return 1
  ENTRY=$(node "$HERE/board-modules.mjs" pack "$HERE/board-stress.mjs" "$tgz")
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$ENTRY" ]; then
    rm -f "$tgz"
    echo "could not pack the board side (board-modules.mjs exit $rc)" >&2
    return 1
  fi
  PAYLOAD=$(base64 -w0 "$tgz")
  rm -f "$tgz"
  if [ -z "$PAYLOAD" ]; then
    echo "the packed board side is empty" >&2
    return 1
  fi
  if [ "${#PAYLOAD}" -gt "$MAX_PAYLOAD" ]; then
    echo "the packed board side is ${#PAYLOAD} characters of base64, over the $MAX_PAYLOAD that fit one ssh argument" >&2
    return 1
  fi
  # Pre-flight: unpacked on its own, the entry loads — every module it
  # imports came along. Loaded, not run: it starts only as the main module, and
  # the path reaches node in the environment so no argv[1] names it main.
  local probe
  probe=$(mktemp -d) || return 1
  if ! unpack_payload "$probe" "$PAYLOAD" \
    || ! PROBE_ENTRY="$probe/$ENTRY" node -e 'import(require("node:url").pathToFileURL(process.env.PROBE_ENTRY).href).catch((e) => { console.error(e.message); process.exit(1); })'; then
    rm -rf -- "$probe"
    echo "the packed board side does not load on its own (a module it imports was not packed?)" >&2
    return 1
  fi
  rm -rf -- "$probe"
}
# unpack_payload DIR PAYLOAD — open the payload into DIR. The ONE way it is
# opened: run here for --unpack-to, and sent to the board verbatim
# (`declare -f`) for the real run.
unpack_payload() {
  mkdir -p "$1" && printf '%s' "$2" | base64 -d | tar -xzmf - -C "$1"
}

if [ -n "$UNPACK_TO" ]; then
  pack_board_side || exit 1
  unpack_payload "$UNPACK_TO" "$PAYLOAD" || { echo "could not unpack into $UNPACK_TO" >&2; exit 1; }
  printf '%s\n' "$ENTRY"
  exit 0
fi

if [ -z "$SERIAL" ]; then
  echo "usage: $0 [--results DIR] [--budget-min N] [--strict] <serial> [-- STRESS_OPTION ...]" >&2
  exit 2
fi
# Packed before the board is touched: a module that cannot ship fails here.
pack_board_side || exit 1
case "$BUDGET_MIN" in ''|*[!0-9]*) echo "--budget-min wants whole minutes" >&2; exit 2 ;; esac
STRESS_ARGS=("$@")
NANO_SERIAL=$SERIAL
# shellcheck source=scripts/nano-tests/lib.sh
source "$HERE/../nano-tests/lib.sh"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RESULTS=${RESULTS:-$PWD/nano-stress-$STAMP}
mkdir -p "$RESULTS"
# The board folder (and the progress poll) can be named for a test of this
# script; the folder must stay a /tmp/clawbox-stress-* one, the only kind the
# cleanup removes.
BOARD_DIR=${NANO_STRESS_BOARD_DIR:-/tmp/clawbox-stress-$STAMP}
BOARD_DIR_OK=0
case "$BOARD_DIR" in *..*) ;; /tmp/clawbox-stress-?*) BOARD_DIR_OK=1 ;; esac
[ "$BOARD_DIR_OK" = 1 ] || { echo "NANO_STRESS_BOARD_DIR must be a /tmp/clawbox-stress-* folder" >&2; exit 2; }
POLL_S=${NANO_STRESS_POLL_S:-30}
case "$POLL_S" in ''|*[!0-9]*|0) echo "NANO_STRESS_POLL_S wants whole seconds above 0" >&2; exit 2 ;; esac

say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

RUNTIME=$(board_runtime)
say "board runtime: $RUNTIME"
if wait_runtime_settled 300; then
  say "$RUNTIME settled (${SETTLE_WAITED}s)"
else
  say "$RUNTIME not settled: ${SETTLE_STATE:-unknown}"
  exit 1
fi
say "board build: $(board_head | cut -c1-12)"

STARTED=0
ENDED=0      # the board side is no longer running: nothing to stop
STOPPED=1    # 0: it would not stop, so its folder stays
COLLECTED=0  # its record came back and parses: only then may its folder go
TRIED=0      # the main flow already tried (twice) to bring it back
LOG_SAVED=0  # the board-side log is here
# stop_board_side — SIGTERM the board script and wait (up to 330 s: it ends
# its turns, closes the step's record and deletes every session it opened
# first; on a lab board that took 3-7 s) until it is gone. Prints "gone"
# or "alive <pid>"; returns non-zero while it still runs.
stop_board_side() {
  local out
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board '
    pid=$(cat "$1/raw.json.pid" 2>/dev/null)
    case "$pid" in ""|*[!0-9]*) echo gone; exit 0 ;; esac
    [ "$pid" -gt 1 ] || { echo gone; exit 0; }
    kill -TERM "$pid" 2>/dev/null || { echo gone; exit 0; }
    for _ in $(seq 1 330); do kill -0 "$pid" 2>/dev/null || { echo gone; exit 0; }; sleep 1; done
    echo "alive $pid"
  ' "$BOARD_DIR" 2>/dev/null | tail -n 1)
  say "board side: ${out:-no answer}"
  [ "$out" = gone ]
}
# fetch — the record (raw.json, or raw.json.partial from a stopped run) comes
# back gzipped and base64-encoded over the same ssh hop. Fails when nothing
# came back or a stage of the transfer failed.
fetch() {
  # shellcheck disable=SC2016  # expanded on the board
  board 'for f in "$1/raw.json" "$1/raw.json.partial"; do [ -s "$f" ] && { gzip -c "$f" | base64 -w0; exit 0; }; done; exit 1' "$BOARD_DIR" \
    | tail -n 1 | base64 -d 2>/dev/null | gunzip -c > "$RESULTS/raw-$RUNTIME.json" 2>/dev/null \
    && [ -s "$RESULTS/raw-$RUNTIME.json" ]
}
# collect — the record, checked to parse, and the board-side log, into
# $RESULTS. Only a collect that succeeded lets the board folder go: until then
# it holds the only copy of the run.
collect() {
  local log="$RESULTS/board-$RUNTIME.log"
  # Into a file of its own first: a failed retry must not empty a log an
  # earlier try saved.
  # shellcheck disable=SC2016  # expanded on the board
  if board 'cat "$1/stress.log" 2>/dev/null; [ -s "$1/raw.json.error" ] && { echo "error:"; cat "$1/raw.json.error"; }; true' "$BOARD_DIR" > "$log.part"; then
    mv -f -- "$log.part" "$log"
    LOG_SAVED=1
  else
    rm -f -- "$log.part"
  fi
  fetch || return 1
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$RESULTS/raw-$RUNTIME.json" 2>/dev/null || return 1
  [ "$LOG_SAVED" = 1 ] || return 1
  COLLECTED=1
}
summarize() {
  node "$HERE/report.mjs" --json "$RESULTS/stress-$RUNTIME.json" --md "$RESULTS/stress-$RUNTIME.md" "$RESULTS/raw-$RUNTIME.json"
}
cleanup() {
  [ "$STARTED" = 1 ] || return 0
  if [ "$ENDED" = 0 ]; then
    say "stopping the board side (it deletes its own chat sessions)"
    if stop_board_side; then ENDED=1; else STOPPED=0; fi
  fi
  if [ "$STOPPED" = 0 ]; then
    say "the board side still runs: $BOARD_DIR is kept on the board; stop it by the pid above"
    return 0
  fi
  # Interrupted: bring the partial record back (and summarise it) before
  # anything on the board is removed.
  if [ "$COLLECTED" = 0 ] && [ "$TRIED" = 0 ] && collect; then
    if summarize; then say "partial summary: $RESULTS/stress-$RUNTIME.md"; fi
  fi
  # A record that did not come back keeps the folder (as does a board that
  # does not answer), and so does a run whose log did not come back either:
  # it is all that says why it died. A run that never wrote a record, whose
  # log is here, has nothing left to keep.
  if [ "$COLLECTED" = 0 ]; then
    local held
    # shellcheck disable=SC2016  # expanded on the board
    held=$(board 'if [ -s "$1/raw.json" ] || [ -s "$1/raw.json.partial" ]; then echo record; else echo none; fi' "$BOARD_DIR" 2>/dev/null | tail -n 1)
    if [ "$held" != none ] || [ "$LOG_SAVED" = 0 ]; then
      say "the record or the log did not come back: $BOARD_DIR is kept on the board (raw.json or raw.json.partial, stress.log)"
      return 0
    fi
  fi
  # shellcheck disable=SC2016  # expanded on the board
  board 'case "$1" in /tmp/clawbox-stress-*) rm -rf -- "$1" ;; esac' "$BOARD_DIR" >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 130' INT TERM

say "board side: $ENTRY and the modules it imports, ${#PAYLOAD} characters packed"
# From here on the board folder may exist: the EXIT trap cleans it up.
STARTED=1
# shellcheck disable=SC2016  # expanded on the board
started=$(board "$(declare -f unpack_payload)"'
  dir=$1; payload=$2; entry=$3; shift 3
  # A fresh folder only: the pid file and record of an earlier run there
  # would pass for those of this one.
  [ -e "$dir" ] && { echo "@@exists"; exit 1; }
  unpack_payload "$dir" "$payload" || { echo "could not unpack the run into $dir"; exit 1; }
  [ -f "$dir/$entry" ] || { echo "$entry is not in the unpacked run"; exit 1; }
  setsid -f node "$dir/$entry" --out "$dir/raw.json" "$@" </dev/null >"$dir/stress.log" 2>&1
  for _ in $(seq 1 20); do [ -s "$dir/raw.json.pid" ] && break; sleep 0.5; done
  [ -s "$dir/raw.json.pid" ] && echo started || { echo "did not start:"; tail -n 5 "$dir/stress.log"; }
' "$BOARD_DIR" "$PAYLOAD" "$ENTRY" --runtime "$RUNTIME" "${STRESS_ARGS[@]}")
if [ "$(printf '%s\n' "$started" | tail -n 1)" = "@@exists" ]; then
  # Not this run's folder: nothing to stop, fetch or remove there.
  STARTED=0
  say "$BOARD_DIR already exists on the board: not starting over it"
  exit 1
fi
if [ "$(printf '%s\n' "$started" | tail -n 1)" != started ]; then
  say "the stress run did not start on the board:"
  printf '%s\n' "$started" | sed 's/^/  /'
  exit 1
fi
say "started on the board in $BOARD_DIR"

SHOWN=0
STATE=running
deadline=$(( $(date +%s) + BUDGET_MIN * 60 ))
while :; do
  sleep "$POLL_S"
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board '
    dir=$1; shown=$2
    total=$(wc -l < "$dir/stress.log" 2>/dev/null || echo 0)
    echo "@@lines $total"
    [ "$total" -gt "$shown" ] && tail -n +"$((shown + 1))" "$dir/stress.log"
    pid=$(cat "$dir/raw.json.pid" 2>/dev/null)
    if [ -s "$dir/raw.json" ]; then echo "@@state done"
    elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "@@state running"
    else echo "@@state dead"; fi
  ' "$BOARD_DIR" "$SHOWN")
  printf '%s\n' "$out" | grep -v '^@@' | sed 's/^/  board: /'
  n=$(printf '%s\n' "$out" | sed -n 's/^@@lines \([0-9]*\)$/\1/p' | tail -n 1)
  [ -n "$n" ] && [ "$n" -gt "$SHOWN" ] && SHOWN=$n
  STATE=$(printf '%s\n' "$out" | sed -n 's/^@@state //p' | tail -n 1)
  case "$STATE" in done|dead) break ;; esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    say "budget of $BUDGET_MIN min spent: stopping the run"
    STATE=budget
    break
  fi
done

if [ "$STATE" = budget ]; then
  # Stopped, the board side writes what it has to raw.json.partial — only once
  # it is gone is that file final.
  if ! stop_board_side; then
    STOPPED=0
    ENDED=1
    say "the board side did not stop; nothing fetched"
    exit 1
  fi
fi
ENDED=1

# Two tries: a transfer that fails once (an ssh hiccup) is not the end of a
# 30-minute run. The EXIT trap keeps the board folder if both fail.
if ! collect && ! { say "the record did not come back: trying once more"; collect; }; then
  TRIED=1
  say "no readable record came back (state: $STATE); the board-side log is $RESULTS/board-$RUNTIME.log"
  exit 1
fi
if ! summarize; then
  say "report.mjs could not summarise $RESULTS/raw-$RUNTIME.json"
  exit 1
fi
say "summary: $RESULTS/stress-$RUNTIME.md"
cat "$RESULTS/stress-$RUNTIME.md"
[ "$STATE" = done ] || { say "the run did not finish (state: $STATE): the summary covers the steps it reached"; exit 1; }
if [ "$STRICT" = 1 ] && node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(r.runs.some((x) => x.findings.length) ? 0 : 1)' "$RESULTS/stress-$RUNTIME.json"; then
  exit 3
fi
exit 0
