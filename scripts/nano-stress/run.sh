#!/usr/bin/env bash
# ClawBox stress run on a nano-lab board (TASK-2500). See docs/nano-stress-test.md.
#
#   scripts/nano-stress/run.sh [--results DIR] [--budget-min N] [--strict] <serial> [-- STRESS_OPTION ...]
#
# Runs on the lab RUNNER HOST, like scripts/nano-tests: every board command goes
# through `$NANO_CI ssh <serial>` (scripts/nano-tests/lib.sh), so set
# NANO_CI=nano-board for a board leased with nano-lease. It
#
#   1. reads which agent runtime the board runs (OpenClaw or Hermes) and waits
#      for it to be settled;
#   2. copies board-stress.mjs to a fresh /tmp folder on the board and starts
#      it DETACHED there (an ssh hiccup during a 30–60 min run must not end it);
#   3. polls it, printing its progress lines, until it writes its record;
#   4. brings the raw record and the board-side log back into DIR and runs
#      report.mjs: DIR/stress-<runtime>.json and DIR/stress-<runtime>.md;
#   5. removes its folder on the board. Interrupted, it stops the board side
#      first, which deletes its chat sessions before it exits.
#
# STRESS_OPTIONs go to board-stress.mjs unchanged, e.g.
#   -- --ramp 1,2,4,8 --ramp-turns 3 --long-turns 32 --tool-turns 8 --steps idle,ramp,long,tool
#
# Exit status: 0 when the record came back and was summarised; 1 when it did
# not; 3 with --strict when the summary lists findings (failed turns, OOM
# kills, restarts, low memory).
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RESULTS=
BUDGET_MIN=150
STRICT=0
SERIAL=
while [ $# -gt 0 ]; do
  case "$1" in
    --results) RESULTS=$2; shift 2 ;;
    --budget-min) BUDGET_MIN=$2; shift 2 ;;
    --strict) STRICT=1; shift ;;
    --) shift; break ;;
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) SERIAL=$1; shift ;;
  esac
done
if [ -z "$SERIAL" ]; then
  echo "usage: $0 [--results DIR] [--budget-min N] [--strict] <serial> [-- STRESS_OPTION ...]" >&2
  exit 2
fi
case "$BUDGET_MIN" in ''|*[!0-9]*) echo "--budget-min wants whole minutes" >&2; exit 2 ;; esac
STRESS_ARGS=("$@")
NANO_SERIAL=$SERIAL
# shellcheck source=scripts/nano-tests/lib.sh
source "$HERE/../nano-tests/lib.sh"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RESULTS=${RESULTS:-$PWD/nano-stress-$STAMP}
mkdir -p "$RESULTS"
BOARD_DIR=/tmp/clawbox-stress-$STAMP

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
FETCHED=0
cleanup() {
  if [ "$STARTED" = 1 ] && [ "$FETCHED" = 0 ]; then
    say "stopping the board side (it deletes its own chat sessions)"
    # shellcheck disable=SC2016  # expanded on the board
    board '
      pid=$(cat "$1/raw.json.pid" 2>/dev/null)
      case "$pid" in ""|*[!0-9]*) exit 0 ;; esac
      [ "$pid" -gt 1 ] || exit 0
      kill -TERM "$pid" 2>/dev/null || exit 0
      for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    ' "$BOARD_DIR" >/dev/null 2>&1
  fi
  if [ "$STARTED" = 1 ]; then
    # shellcheck disable=SC2016  # expanded on the board
    board 'case "$1" in /tmp/clawbox-stress-*) rm -rf -- "$1" ;; esac' "$BOARD_DIR" >/dev/null 2>&1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# shellcheck disable=SC2016  # expanded on the board
started=$(board '
  dir=$1; shift
  b64=$1; shift
  mkdir -p "$dir" && printf "%s" "$b64" | base64 -d > "$dir/stress.mjs" || { echo "could not write $dir"; exit 1; }
  setsid -f node "$dir/stress.mjs" --out "$dir/raw.json" "$@" </dev/null >"$dir/stress.log" 2>&1
  for _ in $(seq 1 20); do [ -s "$dir/raw.json.pid" ] && break; sleep 0.5; done
  [ -s "$dir/raw.json.pid" ] && echo started || { echo "did not start:"; tail -n 5 "$dir/stress.log"; }
' "$BOARD_DIR" "$(base64 -w0 "$HERE/board-stress.mjs")" "${STRESS_ARGS[@]}")
STARTED=1
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
  sleep 30
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board '
    dir=$1; shown=$2
    total=$(wc -l < "$dir/stress.log" 2>/dev/null || echo 0)
    echo "@@lines $total"
    [ "$total" -gt "$shown" ] && tail -n +"$((shown + 1))" "$dir/stress.log" | head -n 200
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
  # The board side writes what it has to raw.json.partial when stopped.
  cleanup_stop() {
    # shellcheck disable=SC2016  # expanded on the board
    board 'pid=$(cat "$1/raw.json.pid" 2>/dev/null); case "$pid" in ""|*[!0-9]*) exit 0;; esac; [ "$pid" -gt 1 ] && kill -TERM "$pid" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done' "$BOARD_DIR" >/dev/null 2>&1
  }
  cleanup_stop
fi

# The record comes back gzipped and base64-encoded over the same ssh hop.
fetch() {
  # shellcheck disable=SC2016  # expanded on the board
  board 'for f in "$1/raw.json" "$1/raw.json.partial"; do [ -s "$f" ] && { gzip -c "$f" | base64 -w0; exit 0; }; done; exit 1' "$BOARD_DIR" \
    | tail -n 1 | base64 -d 2>/dev/null | gunzip -c > "$RESULTS/raw-$RUNTIME.json" 2>/dev/null
}
fetch
# shellcheck disable=SC2016  # expanded on the board
board 'cat "$1/stress.log" 2>/dev/null; [ -s "$1/raw.json.error" ] && { echo "error:"; cat "$1/raw.json.error"; }; true' "$BOARD_DIR" > "$RESULTS/board-$RUNTIME.log"
FETCHED=1

if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$RESULTS/raw-$RUNTIME.json" 2>/dev/null; then
  say "no readable record came back (state: $STATE); the board-side log is $RESULTS/board-$RUNTIME.log"
  exit 1
fi
if ! node "$HERE/report.mjs" --json "$RESULTS/stress-$RUNTIME.json" --md "$RESULTS/stress-$RUNTIME.md" "$RESULTS/raw-$RUNTIME.json"; then
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
