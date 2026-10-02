#!/usr/bin/env bash
# Run the on-device test suite against ONE nano-lab board (TASK-1324).
#
# Usage:
#   scripts/nano-tests/run.sh [--results DIR] [--only TEXT] <serial>
#
# Runs on the nano-lab runner host. It reaches the board only through the tests,
# and the tests reach it only through `nano-ci ssh` / `nano-ci scp` (see
# lib.sh): no address, key or password of a board is known to this repository.
# The board must already be reserved (`nano-ci reserve`) — this script never
# reserves, cleans up or releases one; .github/workflows/nano-hardware-tests.yml
# does, and so must anyone running it by hand.
#
# Every scripts/nano-tests/tests/NN-*.sh runs, in order, as `bash <test> <serial>`
# under a deadline — 600 s, or the test's own `# timeout: NNN` header line — and
# the next one runs whatever the last one did. One TAP line per test:
#
#   ok 1 - 10-build-identity (14s)
#   not ok 2 - 20-services (3s)
#   #   clawbox-gateway.service is failed, not active
#   ok 5 - 50-local-model (1s) # SKIP ollama is not installed on this board
#
# A test says what happened by PRINTING `ok - …`, `not ok - …` or
# `ok # SKIP …` lines (lib.sh). Its verdict is decided in this order:
#   ran past its deadline                     -> not ok, "timed out after Ns"
#   printed any `not ok` line                 -> not ok, that line is the reason
#   exited non-zero                           -> not ok, "exited N" + its last line
#   printed only `# SKIP` oks                 -> skip
#   printed at least one plain `ok`           -> ok
#   printed neither                           -> not ok: a test that asserted
#                                                nothing proved nothing
#
# Writes DIR/<test>.log (the test's output, redacted) and DIR/summary.json.
# DIR is --results, else $NANO_RESULTS_DIR, else ./results.
#
# What it prints and writes is published (the repository is public), so the
# board is named by its serial and lab only, and every test's output passes
# through scripts/public-hygiene.mjs: tokens and passwords, the board's address
# (<board-ip>), any other private address, home folder or internal name.
#
# Environment handed to every test: NANO_SERIAL, NANO_IP (never printed),
# NANO_LAB, NANO_SHA (the commit the board must be running; default: this
# checkout's HEAD),
# NANO_RUN_ID (names the folders a test creates on the board), NANO_CI (the
# helper, default `nano-ci`), NANO_RESULTS_DIR, NANO_TEST_NAME, NANO_TEST_TIMEOUT.
# NANO_TESTS_DIR and NANO_DEFAULT_TIMEOUT override the test folder and the 600 s
# default (the self-test uses both).
#
# Exit: 0 every test passed or was skipped; 1 at least one failed; 2 usage
# error, a missing tool, or no test to run; 130 interrupted.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TESTS_DIR=${NANO_TESTS_DIR:-$HERE/tests}
RESULTS_DIR=${NANO_RESULTS_DIR:-results}
DEFAULT_TIMEOUT=${NANO_DEFAULT_TIMEOUT:-600}
# After the deadline a test gets TERM, and KILL this much later.
KILL_GRACE=${NANO_KILL_GRACE:-15}
ONLY=""

usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "run.sh: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --results) [ -n "${2:-}" ] || die "--results needs a folder"; RESULTS_DIR=$2; shift 2 ;;
    --only)    [ -n "${2:-}" ] || die "--only needs a test name (or part of one)"; ONLY=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option '$1'" ;;
    *) break ;;
  esac
done
if [ $# -ne 1 ]; then usage >&2; exit 2; fi
SERIAL=$1
# It ends up inside the command lines the tests build: nothing but a serial.
[[ $SERIAL =~ ^[A-Za-z0-9._:-]+$ ]] || die "'$SERIAL' does not look like a board serial"
[[ $DEFAULT_TIMEOUT =~ ^[1-9][0-9]*$ ]] || die "NANO_DEFAULT_TIMEOUT must be a number of seconds"

NANO_CI=${NANO_CI:-nano-ci}
HYGIENE=$HERE/../public-hygiene.mjs
[ -f "$HYGIENE" ] || die "missing $HYGIENE, which redacts every log"
missing=()
for tool in jq timeout base64 sed node "$NANO_CI"; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
[ ${#missing[@]} -eq 0 ] || die "missing on this host: ${missing[*]}"

TESTS=()
# Sorted bytewise whatever the caller's locale: NN- is the order.
while IFS= read -r file; do
  [ -f "$file" ] || continue
  name=$(basename "$file" .sh)
  if [ -n "$ONLY" ] && [[ $name != *"$ONLY"* ]]; then continue; fi
  TESTS+=("$file")
done < <(printf '%s\n' "$TESTS_DIR"/[0-9][0-9]-*.sh | LC_ALL=C sort)
if [ ${#TESTS[@]} -eq 0 ]; then
  [ -z "$ONLY" ] || die "no test in $TESTS_DIR matches '$ONLY'"
  die "no test to run in $TESTS_DIR"
fi

mkdir -p "$RESULTS_DIR" || die "cannot create $RESULTS_DIR"
# Printed as given: the absolute path may name the host's home folder.
RESULTS_SHOWN=$RESULTS_DIR
RESULTS_DIR=$(cd "$RESULTS_DIR" && pwd)
# A reused folder must not carry a previous run's logs into this run's artifact.
rm -f "$RESULTS_DIR"/[0-9][0-9]-*.log "$RESULTS_DIR/summary.json"
WORK=$(mktemp -d) || die "cannot create a temporary folder"
RECORDS=$WORK/records.jsonl
: > "$RECORDS"

NANO_SHA=${NANO_SHA:-$(git -C "$HERE" rev-parse HEAD 2>/dev/null || true)}
NANO_RUN_ID=${NANO_RUN_ID:-local-$(date -u +%Y%m%d%H%M%S)-$$}
NANO_RUN_ID=$(printf '%s' "$NANO_RUN_ID" | tr -c 'A-Za-z0-9._-' '-')
export NANO_SERIAL=$SERIAL NANO_IP=${NANO_IP:-} NANO_LAB=${NANO_LAB:-} NANO_SHA NANO_RUN_ID \
  NANO_CI NANO_RESULTS_DIR=$RESULTS_DIR
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Redact what must never reach a log or the uploaded artifact: bearer tokens,
# the session cookie, and any token/password/secret/key value in JSON, a
# query string or an env-style line. The tests never fetch a secret to this
# host in the first place (lib.sh); this is the second line, not the first.
# Then the public-hygiene redactor: the board's address, any other private
# address, a home folder, an internal name or a credential's shape.
redact() {
  sed -E \
    -e 's/(bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/Ig' \
    -e 's/(clawbox_session=)[^;[:space:]"]+/\1[REDACTED]/g' \
    -e 's/((token|password|passwd|secret|api[_-]?key|authorization|cookie)"?[[:space:]]*[:=][[:space:]]*"?)[^"[:space:],;}&]+/\1[REDACTED]/Ig' |
    node "$HYGIENE" redact --mask-env "NANO_IP=<board-ip>"
}

# The `# timeout: NNN` header, looked for in the first 20 lines.
timeout_for() {
  local t
  t=$(head -n 20 "$1" | sed -n -E 's/^#[[:space:]]*timeout:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' | head -n 1)
  if [[ $t =~ ^[1-9][0-9]*$ ]]; then echo "$t"; else echo "$DEFAULT_TIMEOUT"; fi
}

# One line, at most 300 characters: a reason goes into TAP, JSON and the job summary.
one_line() { tr -d '\r' | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | cut -c1-300; }

# The TAP result lines a test may print — `ok`, `ok 3`, `ok - text`,
# `ok # SKIP why` and the same after `not ` — and nothing looser: the log also
# holds whatever the board's tools wrote to stderr, and a stray "ok gateway
# ready" or "not ok: retrying" there must not decide a verdict.
OK_RE='^ok( [0-9]+)?( - .*| #.*)?$'
NOT_OK_RE='^not ok( [0-9]+)?( - .*| #.*)?$'
SKIP_RE='#[[:space:]]*skip([[:space:]]|$)'

# verdict LOG EXIT_CODE ELAPSED LIMIT -> sets STATUS (pass|fail|skip) and REASON.
verdict() {
  local log=$1 rc=$2 elapsed=$3 limit=$4 line
  if [ "$rc" -eq 124 ] || { [ "$rc" -eq 137 ] && [ "$elapsed" -ge "$limit" ]; }; then
    STATUS=fail; REASON="timed out after ${limit}s"; return
  fi
  line=$(grep -m 1 -E "$NOT_OK_RE" "$log")
  if [ -n "$line" ]; then
    STATUS=fail
    REASON=$(printf '%s' "$line" | sed -E 's/^not ok( [0-9]+)?( - )?//' | one_line)
    [ -n "$REASON" ] || REASON="not ok (no reason given)"
    return
  fi
  if [ "$rc" -ne 0 ]; then
    STATUS=fail
    line=$(grep -v -E '^[[:space:]]*$' "$log" | tail -n 1 | one_line)
    REASON="exited $rc${line:+: $line}"
    return
  fi
  if grep -E "$OK_RE" "$log" | grep -q -v -i -E "$SKIP_RE"; then
    STATUS=pass; REASON=""; return
  fi
  line=$(grep -E "$OK_RE" "$log" | grep -m 1 -i -E "$SKIP_RE")
  if [ -n "$line" ]; then
    STATUS=skip
    REASON=$(printf '%s' "$line" | sed -E 's/^[^#]*#[[:space:]]*[Ss][Kk][Ii][Pp][[:space:]]*//' | one_line)
    return
  fi
  STATUS=fail; REASON="printed no ok / not ok line"
}

record() { # NAME STATUS REASON DURATION TIMEOUT EXIT
  jq -cn --arg name "$1" --arg status "$2" --arg reason "$3" \
    --argjson duration "$4" --argjson timeout "$5" --argjson exit "$6" \
    '{name: $name, status: $status, reason: $reason, duration_s: $duration,
      timeout_s: $timeout, exit_code: $exit, log: ($name + ".log")}' >> "$RECORDS"
}

INTERRUPTED=false
write_summary() {
  jq -s \
    --arg serial "$SERIAL" --arg lab "$NANO_LAB" --arg sha "$NANO_SHA" \
    --arg run_id "$NANO_RUN_ID" --arg started "$STARTED_AT" \
    --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson planned "${#TESTS[@]}" --argjson interrupted "$INTERRUPTED" '
    {
      serial: $serial, lab: $lab, sha: $sha, run_id: $run_id,
      started_at: $started, finished_at: $finished,
      planned: $planned,
      total: length,
      passed: (map(select(.status == "pass")) | length),
      failed: (map(select(.status == "fail")) | length),
      skipped: (map(select(.status == "skip")) | length),
      interrupted: $interrupted,
      ok: ((map(select(.status == "fail")) | length) == 0 and ($interrupted | not) and length == $planned),
      tests: .
    }' "$RECORDS" > "$RESULTS_DIR/summary.json"
}

# Print a test's log as TAP diagnostics. Indented on purpose: a line the board
# printed can never start with `::` and be taken as a workflow command.
show_log() {
  local name=$1 log=$2
  [ -s "$log" ] || return 0
  [ "${GITHUB_ACTIONS:-}" = true ] && echo "::group::$name log"
  sed 's/^/#   | /' "$log"
  [ "${GITHUB_ACTIONS:-}" = true ] && echo "::endgroup::"
  return 0
}

# Workflow-command data escaping (%, CR, LF), for the failure annotations.
gh_escape() { local s=${1//%/%25}; s=${s//$'\r'/%0D}; printf '%s' "${s//$'\n'/%0A}"; }

CHILD=""
CURRENT=""
CURRENT_START=0
CURRENT_LIMIT=0
on_signal() {
  INTERRUPTED=true
  if [ -n "$CHILD" ]; then
    kill -TERM "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
  fi
  if [ -n "$CURRENT" ]; then
    [ -f "$WORK/raw.log" ] && redact < "$WORK/raw.log" > "$RESULTS_DIR/$CURRENT.log"
    record "$CURRENT" fail "interrupted" "$(( $(date +%s) - CURRENT_START ))" "$CURRENT_LIMIT" 130
    echo "not ok - $CURRENT (interrupted)"
  fi
  write_summary
  rm -rf "$WORK"
  exit 130
}
trap on_signal INT TERM

echo "TAP version 13"
echo "1..${#TESTS[@]}"
echo "# board $SERIAL${NANO_LAB:+ in $NANO_LAB}, commit ${NANO_SHA:-unknown}, run $NANO_RUN_ID"

index=0
FAILED=0
for file in "${TESTS[@]}"; do
  index=$((index + 1))
  name=$(basename "$file" .sh)
  limit=$(timeout_for "$file")
  log=$RESULTS_DIR/$name.log
  echo "# $name: running (deadline ${limit}s)"
  CURRENT=$name CURRENT_START=$(date +%s) CURRENT_LIMIT=$limit
  # In the background and waited for, so a cancelled job can stop the test
  # (see on_signal). `timeout` puts the test in a process group of its own and
  # signals that whole group at the deadline, `nano-ci ssh` children included.
  NANO_TEST_NAME=$name NANO_TEST_TIMEOUT=$limit \
    timeout --kill-after="$KILL_GRACE" "$limit" bash "$file" "$SERIAL" </dev/null >"$WORK/raw.log" 2>&1 &
  CHILD=$!
  wait "$CHILD"
  rc=$?
  CHILD=""
  elapsed=$(( $(date +%s) - CURRENT_START ))
  redact < "$WORK/raw.log" > "$log"
  rm -f "$WORK/raw.log"
  CURRENT=""

  verdict "$log" "$rc" "$elapsed" "$limit"
  record "$name" "$STATUS" "$REASON" "$elapsed" "$limit" "$rc"
  case "$STATUS" in
    pass) echo "ok $index - $name (${elapsed}s)" ;;
    skip) echo "ok $index - $name (${elapsed}s) # SKIP $REASON" ;;
    *)
      FAILED=$((FAILED + 1))
      echo "not ok $index - $name (${elapsed}s)"
      echo "#   $REASON"
      if [ "${GITHUB_ACTIONS:-}" = true ]; then
        echo "::error title=nano test $name failed::$(gh_escape "$REASON")"
      fi
      ;;
  esac
  show_log "$name" "$log"
done

write_summary
rm -rf "$WORK"
echo "# $((index - FAILED)) of $index passed or skipped; summary: $RESULTS_SHOWN/summary.json"
[ "$FAILED" -eq 0 ]
