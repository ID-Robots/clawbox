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
# the next one runs whatever the last one did. Neighbours that share a
# `# parallel: GROUP` header (tests that only READ the box: no restart, no
# reboot, no memory pressure, no sudo) run at the same time, each under its own
# deadline; their lines still come out in NN order. NANO_PARALLEL=0 runs every
# test on its own. One TAP line per test:
#
#   ok 1 - 10-build-identity (14s)
#   not ok 2 - 20-services (3s)
#   #   clawbox-gateway.service is failed, not active
#   ok 5 - 60-media-tools (1s) # SKIP generateImages and generateAudio are both off
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
# NANO_BRANCH (the branch the commit under test is the head of; the update
# tests hand it to the box's own updater), NANO_TESTS_LONG.
#
# A test whose first 20 lines hold `# tier: long` takes tens of minutes (it
# rebuilds the box, more than once): it runs only with NANO_TESTS_LONG=1 and is
# reported as a skip otherwise. The workflow sets it for a pull request labelled
# `nano-long` and for a dispatch with `long` ticked.
#
# NANO_TESTS_SELECT names the tests to run (space- or comma-separated names,
# e.g. "10-build-identity 30-chat-turn"); every other test is reported as a
# skip, "not affected by this change". Empty or `all` runs every test. The
# workflow takes it from scripts/nano-tests/select-tests.sh, which maps a pull
# request's changed files onto the tests that cover them; a name that is no
# test here is a usage error. NANO_TESTS_SELECT_REASON, when set, is noted.
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
[ -f "$HYGIENE" ] || die "missing scripts/public-hygiene.mjs, which redacts every log"
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

# Change-based selection: NANO_TESTS_SELECT, checked against the tests here
# before anything runs. SELECTED holds " name name … " — or is empty for all.
NANO_PARALLEL=${NANO_PARALLEL:-1}
read -r -a SELECT_LIST <<<"$(printf '%s' "${NANO_TESTS_SELECT:-}" | tr ',\t\r\n' '    ')"
SELECTED=""
if [ ${#SELECT_LIST[@]} -gt 0 ] && [ "${SELECT_LIST[*]}" != all ]; then
  for want in "${SELECT_LIST[@]}"; do
    [[ $want =~ ^[0-9][0-9]-[a-z0-9-]+$ ]] || die "NANO_TESTS_SELECT: '$want' is not a test name"
    [ -f "$TESTS_DIR/$want.sh" ] || die "NANO_TESTS_SELECT: no test named $want in $TESTS_DIR"
    SELECTED="$SELECTED $want"
  done
  SELECTED="$SELECTED "
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

# The `# tier: NAME` header, looked for in the first 20 lines; "" when none.
tier_for() {
  head -n 20 "$1" | sed -n -E 's/^#[[:space:]]*tier:[[:space:]]*([a-z]+)[[:space:]]*$/\1/p' | head -n 1
}

# The `# parallel: GROUP` header, looked for in the first 20 lines; "" when none.
parallel_for() {
  head -n 20 "$1" | sed -n -E 's/^#[[:space:]]*parallel:[[:space:]]*([a-z0-9-]+)[[:space:]]*$/\1/p' | head -n 1
}
NANO_TESTS_LONG=${NANO_TESTS_LONG:-0}
export NANO_TESTS_LONG NANO_BRANCH=${NANO_BRANCH:-}

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
  local log=$1 rc=$2 elapsed=$3 limit=$4 line oks
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
  # Read whole, then matched: a `grep -q` on the pipe can SIGPIPE the first
  # grep on a long log, which under pipefail reads as no plain ok line. The
  # -n test: a here-string of nothing is one empty line, and -v would pick it.
  oks=$(grep -E "$OK_RE" "$log")
  if [ -n "$oks" ] && grep -q -v -i -E "$SKIP_RE" <<<"$oks"; then
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
    --arg selection "${SELECTED:+${SELECTED# }}" \
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
      selection: (if $selection == "" then "all" else ($selection | rtrimstr(" ") | split(" ")) end),
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

# Per test, by its place in TESTS: name, deadline, `# parallel:` group, the
# reason it is skipped without running ("" when it runs), and, once started,
# its pid, start, exit status and duration. STATE is pending, running, ended
# (exited, not yet reported) or recorded.
NAMES=() LIMITS=() GROUPS_OF=() PRESKIP=() PIDS=() STARTS=() RCS=() ELAPSED=() STATE=()
for i in "${!TESTS[@]}"; do
  file=${TESTS[$i]}
  NAMES[i]=$(basename "$file" .sh)
  LIMITS[i]=$(timeout_for "$file")
  GROUPS_OF[i]=$(parallel_for "$file")
  PRESKIP[i]=""
  if [ "$(tier_for "$file")" = long ] && [ "$NANO_TESTS_LONG" != 1 ]; then
    PRESKIP[i]="long-tier test, runs only with NANO_TESTS_LONG=1 (label nano-long)"
  elif [ -n "$SELECTED" ] && [[ $SELECTED != *" ${NAMES[i]} "* ]]; then
    PRESKIP[i]="not affected by this change (change-based selection; the full suite runs on beta and main, and with the label nano-full)"
  fi
  STATE[i]=pending
done

# start_test I — test I in the background under its deadline: `timeout` puts
# it in a process group of its own and signals that whole group at the
# deadline, `nano-ci ssh` children included; a cancelled job stops it through
# on_signal.
start_test() {
  local i=$1
  echo "# ${NAMES[i]}: running (deadline ${LIMITS[i]}s)"
  STARTS[i]=$(date +%s)
  NANO_TEST_NAME=${NAMES[i]} NANO_TEST_TIMEOUT=${LIMITS[i]} \
    timeout --kill-after="$KILL_GRACE" "${LIMITS[i]}" bash "${TESTS[i]}" "$SERIAL" </dev/null >"$WORK/${NAMES[i]}.raw" 2>&1 &
  PIDS[i]=$!
  STATE[i]=running
}

# reap I — the exit status and duration of test I, which has ended (or is
# waited for here until it does).
reap() {
  local i=$1 rc
  wait "${PIDS[i]}"
  rc=$?
  RCS[i]=$rc
  ELAPSED[i]=$(( $(date +%s) - STARTS[i] ))
  STATE[i]=ended
}

# report I — test I's log redacted, its verdict recorded and printed.
report() {
  # $1, not i: the words of one `local` are expanded before any is assigned.
  local i=$1 name=${NAMES[$1]} log=$RESULTS_DIR/${NAMES[$1]}.log
  redact < "$WORK/$name.raw" > "$log"
  rm -f "$WORK/$name.raw"
  verdict "$log" "${RCS[i]}" "${ELAPSED[i]}" "${LIMITS[i]}"
  record "$name" "$STATUS" "$REASON" "${ELAPSED[i]}" "${LIMITS[i]}" "${RCS[i]}"
  STATE[i]=recorded
  case "$STATUS" in
    pass) echo "ok $((i + 1)) - $name (${ELAPSED[i]}s)" ;;
    skip) echo "ok $((i + 1)) - $name (${ELAPSED[i]}s) # SKIP $REASON" ;;
    *)
      FAILED=$((FAILED + 1))
      echo "not ok $((i + 1)) - $name (${ELAPSED[i]}s)"
      echo "#   $REASON"
      if [ "${GITHUB_ACTIONS:-}" = true ]; then
        echo "::error title=nano test $name failed::$(gh_escape "$REASON")"
      fi
      ;;
  esac
  show_log "$name" "$log"
}

# report_skip I — a test that does not run here (long tier, not selected).
report_skip() {
  local i=$1 name=${NAMES[$1]}
  echo "ok # SKIP ${PRESKIP[i]}" > "$RESULTS_DIR/$name.log"
  record "$name" skip "${PRESKIP[i]}" 0 "${LIMITS[i]}" 0
  STATE[i]=recorded
  echo "ok $((i + 1)) - $name (0s) # SKIP ${PRESKIP[i]}"
}

# A cancel (the job's own, or its timeout): every running test is stopped, and
# the run is reported in NN order up to there — what ended with its verdict,
# what was still running as interrupted.
on_signal() {
  local i
  INTERRUPTED=true
  for i in "${!STATE[@]}"; do
    [ "${STATE[i]}" = running ] && kill -TERM "${PIDS[i]}" 2>/dev/null
  done
  for i in "${!STATE[@]}"; do
    [ "${STATE[i]}" = running ] && wait "${PIDS[i]}" 2>/dev/null
  done
  for i in "${!STATE[@]}"; do
    case "${STATE[i]}" in
      running)
        [ -f "$WORK/${NAMES[i]}.raw" ] && redact < "$WORK/${NAMES[i]}.raw" > "$RESULTS_DIR/${NAMES[i]}.log"
        record "${NAMES[i]}" fail "interrupted" "$(( $(date +%s) - STARTS[i] ))" "${LIMITS[i]}" 130
        STATE[i]=recorded
        echo "not ok - ${NAMES[i]} (interrupted)"
        ;;
      ended) report "$i" ;;
    esac
  done
  write_summary
  rm -rf "$WORK"
  exit 130
}
trap on_signal INT TERM

echo "TAP version 13"
echo "1..${#TESTS[@]}"
echo "# board $SERIAL${NANO_LAB:+ in $NANO_LAB}, commit ${NANO_SHA:-unknown}, run $NANO_RUN_ID"
if [ -n "$SELECTED" ]; then
  echo "# change-based selection:${SELECTED% }${NANO_TESTS_SELECT_REASON:+ ($NANO_TESTS_SELECT_REASON)}"
fi

FAILED=0
COUNT=${#TESTS[@]}
i=0
while [ "$i" -lt "$COUNT" ]; do
  if [ -n "${PRESKIP[i]}" ]; then
    report_skip "$i"
    i=$((i + 1))
    continue
  fi
  # The batch: this test, and — when it names a group — every neighbour after
  # it that names the same one (tests skipped in between do not break it).
  group=${GROUPS_OF[i]}
  end=$((i + 1))
  if [ -n "$group" ] && [ "$NANO_PARALLEL" != 0 ]; then
    while [ "$end" -lt "$COUNT" ] && { [ -n "${PRESKIP[end]}" ] || [ "${GROUPS_OF[end]}" = "$group" ]; }; do
      end=$((end + 1))
    done
  fi
  members=()
  for ((k = i; k < end; k++)); do
    [ -n "${PRESKIP[k]}" ] || members+=("$k")
  done
  if [ ${#members[@]} -gt 1 ]; then
    echo "# side by side (parallel: $group):$(for k in "${members[@]}"; do printf ' %s' "${NAMES[k]}"; done)"
  fi
  for k in "${members[@]}"; do start_test "$k"; done
  if [ ${#members[@]} -eq 1 ]; then
    reap "${members[0]}"
  else
    # Each one's own duration: looked at every second, reaped as it ends.
    left=${#members[@]}
    while [ "$left" -gt 0 ]; do
      for k in "${members[@]}"; do
        if [ "${STATE[k]}" = running ] && ! kill -0 "${PIDS[k]}" 2>/dev/null; then
          reap "$k"
          left=$((left - 1))
        fi
      done
      [ "$left" -eq 0 ] || sleep 1
    done
  fi
  for ((k = i; k < end; k++)); do
    if [ -n "${PRESKIP[k]}" ]; then report_skip "$k"; else report "$k"; fi
  done
  i=$end
done

write_summary
rm -rf "$WORK"
echo "# $((COUNT - FAILED)) of $COUNT passed or skipped; summary: $RESULTS_SHOWN/summary.json"
[ "$FAILED" -eq 0 ]
