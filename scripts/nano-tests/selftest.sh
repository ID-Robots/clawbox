#!/usr/bin/env bash
# Self-test for the on-device test runner (TASK-1324) — no board involved.
#
# Runs scripts/nano-tests/run.sh against FIXTURE tests and a stub `nano-ci`,
# and checks what the runner decides: ok / not ok / skip parsing, the per-test
# deadline, the exit code, summary.json's shape, redaction, an interrupted run,
# lib.sh's quoting across `nano-ci ssh`, the job summary, and that every real
# test under tests/ follows the contract. Prints TAP; exits non-zero on any
# failure.
#
# Usage: bash scripts/nano-tests/selftest.sh
# Run in CI by the `checks` job of .github/workflows/pr-tests-coverage.yml and
# by `npm test` (src/tests/unit/nano-tests-runner.test.ts). Needs bash, jq and
# coreutils `timeout` — the same as run.sh.
#
# The fixtures and the small `bash -c` checks below are scripts of their own,
# single-quoted on purpose so that THEY expand their variables, not this file.
# shellcheck disable=SC2016
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$HERE/run.sh
LIB=$HERE/lib.sh
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

N=0
FAILS=0
check() { # DESCRIPTION COMMAND...
  local desc=$1
  shift
  N=$((N + 1))
  if "$@" >/dev/null 2>&1; then
    echo "ok $N - $desc"
  else
    FAILS=$((FAILS + 1))
    echo "not ok $N - $desc"
  fi
}
# jq_check DESCRIPTION FILE FILTER — the filter must yield true.
jq_check() { check "$1" jq -e "$3" "$2"; }
contains() { grep -qF -- "$2" "$1"; }
lacks() { ! grep -qF -- "$2" "$1"; }
line_matches() { grep -qE -- "$2" "$1"; }

# ---- the stub nano-ci --------------------------------------------------------
# `ssh` runs the command string locally the way the board's login shell would,
# so lib.sh's board() is exercised end to end; every call is logged.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/nano-ci" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${NANO_STUB_LOG:?}"
case "$1" in
  ssh)
    shift 2
    [ -z "${NANO_STUB_BANNER:-}" ] || printf 'Welcome to %s\nok banner\n' "$NANO_STUB_BANNER"
    exec bash -c "$*"
    ;;
  health) exit "${NANO_STUB_HEALTH:-0}" ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$WORK/bin/nano-ci"
export NANO_CI=$WORK/bin/nano-ci NANO_STUB_LOG=$WORK/nano-ci-calls.log NANO_SELFTEST_LIB=$LIB
export NANO_KILL_GRACE=1 NANO_SHA=0123456789abcdef0123456789abcdef01234567
unset GITHUB_ACTIONS NANO_RESULTS_DIR NANO_TESTS_DIR NANO_IP NANO_LAB NANO_RUN_ID
: > "$NANO_STUB_LOG"

fixture() { # DIR NAME BODY
  mkdir -p "$1"
  printf '#!/usr/bin/env bash\n%s\n' "$3" > "$1/$2"
}

# ---- suite A: one of everything ---------------------------------------------
A=$WORK/tests-mixed
fixture "$A" 10-pass.sh 'echo "ok - first"; echo "ok - second"'
fixture "$A" 15-lib.sh 'source "$NANO_SELFTEST_LIB"; ok "a"; not_ok "lib says no"; ok "b"; finish'
fixture "$A" 20-fail.sh 'echo "ok - fine part"; echo "not ok - the widget is broken"; exit 1'
fixture "$A" 30-skip.sh 'echo "ok # SKIP no widget on this board"'
fixture "$A" 40-timeout.sh '# timeout: 2
echo "ok - started"; echo $$ > "$NANO_RESULTS_DIR/../timeout.pid"; sleep 30; echo "ok - never"'
fixture "$A" 50-silent.sh 'exit 0'
fixture "$A" 60-crash.sh 'echo "ok - partial"; echo "boom" >&2; exit 3'
fixture "$A" 70-noise.sh 'echo "ok gateway ready" >&2; echo "not ok: retrying"; echo "okay"; echo "ok - real"'
fixture "$A" 80-secret.sh 'echo "Authorization: Bearer abc.DEF-123"
echo "{\"token\":\"s3cr3t\",\"password\": \"hunter2\",\"promptTokens\": 5}"
echo "Cookie: clawbox_session=xyz987; Path=/"
echo "ok - printed secrets"'
fixture "$A" 90-env.sh '# timeout: 7
[ "$1" = SERIAL-1 ] && [ "$NANO_SERIAL" = SERIAL-1 ] && [ "$NANO_TEST_NAME" = 90-env ] \
  && [ "$NANO_TEST_TIMEOUT" = 7 ] && [ "$NANO_SHA" = 0123456789abcdef0123456789abcdef01234567 ] \
  && [ -n "$NANO_RUN_ID" ] && [ -d "$NANO_RESULTS_DIR" ] && [ "$NANO_IP" = 192.0.2.10 ] \
  && [ ! -t 0 ] && echo "ok - environment" || echo "not ok - environment: $*"'
fixture "$A" 9-not-a-test.sh 'echo "not ok - must never run"'
fixture "$A" helper.sh 'echo "not ok - must never run"'
mkdir -p "$WORK/res-mixed"
echo stale > "$WORK/res-mixed/99-stale.log"

T0=$(date +%s)
NANO_TESTS_DIR=$A NANO_DEFAULT_TIMEOUT=20 NANO_IP=192.0.2.10 NANO_LAB=lab-x \
  bash "$RUN" --results "$WORK/res-mixed" SERIAL-1 > "$WORK/out-mixed.txt" 2>&1
RC=$?
T1=$(date +%s)
S=$WORK/res-mixed/summary.json
OUT=$WORK/out-mixed.txt

check "a failing suite exits 1" test "$RC" -eq 1
check "TAP plan counts the ten NN- tests and nothing else" contains "$OUT" "1..10"
check "a test printing only ok lines passes" line_matches "$OUT" '^ok 1 - 10-pass \([0-9]+s\)$'
check "a lib.sh not_ok fails the test" line_matches "$OUT" '^not ok 2 - 15-lib '
check "a not ok line fails the test" line_matches "$OUT" '^not ok 3 - 20-fail '
check "the not ok text is the reason" line_matches "$OUT" '^#   the widget is broken$'
check "ok # SKIP is a skip, with its reason" line_matches "$OUT" '^ok 4 - 30-skip \([0-9]+s\) # SKIP no widget on this board$'
check "a test past its deadline fails" line_matches "$OUT" '^not ok 5 - 40-timeout '
check "a test that printed nothing fails" line_matches "$OUT" '^not ok 6 - 50-silent '
check "a non-zero exit fails the test" line_matches "$OUT" '^not ok 7 - 60-crash '
check "stray ok/not ok look-alikes decide nothing" line_matches "$OUT" '^ok 8 - 70-noise '
check "later tests still run after failures" line_matches "$OUT" '^ok 10 - 90-env '
check "the environment and a closed stdin reach the test" lacks "$WORK/res-mixed/90-env.log" "not ok"
check "files that are not NN-*.sh never run" lacks "$OUT" "must never run"
check "the deadline kills the test, not the sleep it was in" test $((T1 - T0)) -lt 25
if [ -f "$WORK/timeout.pid" ]; then
  check "the timed-out test's process is gone" bash -c '! kill -0 "$(cat "$1")" 2>/dev/null' _ "$WORK/timeout.pid"
fi
check "output printed before the deadline is kept" contains "$WORK/res-mixed/40-timeout.log" "ok - started"

jq_check "summary.json has the run's facts" "$S" '
  .serial == "SERIAL-1" and .ip == "192.0.2.10" and .lab == "lab-x"
  and .sha == "0123456789abcdef0123456789abcdef01234567"
  and (.run_id | type == "string" and length > 0)
  and (.started_at | test("^[0-9-]+T[0-9:]+Z$")) and (.finished_at | test("^[0-9-]+T[0-9:]+Z$"))'
jq_check "summary.json counts" "$S" '.planned == 10 and .total == 10 and .passed == 4 and .failed == 5 and .skipped == 1'
jq_check "summary.json verdict is not ok, not interrupted" "$S" '.ok == false and .interrupted == false'
jq_check "every test row has the same shape" "$S" '
  .tests | length == 10 and all(.[];
    (keys == ["duration_s","exit_code","log","name","reason","status","timeout_s"])
    and (.status | IN("pass","fail","skip"))
    and (.duration_s | type == "number") and (.timeout_s | type == "number")
    and (.exit_code | type == "number") and .log == (.name + ".log"))'
jq_check "tests are recorded in NN order" "$S" '[.tests[].name] == ["10-pass","15-lib","20-fail","30-skip","40-timeout","50-silent","60-crash","70-noise","80-secret","90-env"]'
jq_check "reasons: not ok text, SKIP text, deadline, silence, exit" "$S" '
  .tests[1].reason == "lib says no" and .tests[2].reason == "the widget is broken"
  and .tests[3].status == "skip" and .tests[3].reason == "no widget on this board"
  and .tests[4].reason == "timed out after 2s" and .tests[4].timeout_s == 2
  and .tests[5].reason == "printed no ok / not ok line"
  and .tests[6].reason == "exited 3: boom" and .tests[6].exit_code == 3'
jq_check "the default deadline and a # timeout header" "$S" '.tests[0].timeout_s == 20 and .tests[9].timeout_s == 7'
for t in 10-pass 15-lib 20-fail 30-skip 40-timeout 50-silent 60-crash 70-noise 80-secret 90-env; do
  check "results/$t.log is written" test -f "$WORK/res-mixed/$t.log"
done
check "a previous run's logs are cleared" test ! -e "$WORK/res-mixed/99-stale.log"
L=$WORK/res-mixed/80-secret.log
check "bearer tokens are redacted" lacks "$L" "abc.DEF-123"
check "token values are redacted" lacks "$L" "s3cr3t"
check "passwords are redacted" lacks "$L" "hunter2"
check "the session cookie is redacted" lacks "$L" "xyz987"
check "redaction leaves the rest readable" contains "$L" '"promptTokens": 5'
check "run.sh never reserves, cleans or releases a board" bash -c '! grep -qE "^(reserve|cleanup|release|rebuild) " "$1"' _ "$NANO_STUB_LOG"

# ---- suite B: passes and skips only ----------------------------------------
B=$WORK/tests-green
fixture "$B" 10-pass.sh 'echo "ok - fine"'
fixture "$B" 20-lib-skip.sh 'source "$NANO_SELFTEST_LIB"; skip "nothing to do here"; finish'
NANO_TESTS_DIR=$B bash "$RUN" --results "$WORK/res-green" SERIAL-2 > "$WORK/out-green.txt" 2>&1
RC=$?
check "a suite of passes and skips exits 0" test "$RC" -eq 0
jq_check "its summary says ok" "$WORK/res-green/summary.json" '.ok == true and .passed == 1 and .skipped == 1 and .failed == 0'
check "lib.sh skip is a skip" line_matches "$WORK/out-green.txt" '^ok 2 - 20-lib-skip .*# SKIP nothing to do here$'

NANO_TESTS_DIR=$A bash "$RUN" --only 30-sk --results "$WORK/res-only" SERIAL-3 > "$WORK/out-only.txt" 2>&1
RC=$?
check "--only runs the matching test alone" test "$RC" -eq 0
check "--only plans one test" contains "$WORK/out-only.txt" "1..1"

# ---- usage errors -----------------------------------------------------------
NANO_TESTS_DIR=$B bash "$RUN" >/dev/null 2>&1
check "no serial is a usage error (2)" test $? -eq 2
NANO_TESTS_DIR=$B bash "$RUN" 'x;reboot' >/dev/null 2>&1
check "a serial with shell characters is refused (2)" test $? -eq 2
mkdir -p "$WORK/empty"
NANO_TESTS_DIR=$WORK/empty bash "$RUN" --results "$WORK/res-empty" SERIAL-4 >/dev/null 2>&1
check "no test to run is an error (2)" test $? -eq 2
NANO_CI=$WORK/bin/no-such-helper NANO_TESTS_DIR=$B bash "$RUN" --results "$WORK/res-nohelper" SERIAL-5 > "$WORK/out-nohelper.txt" 2>&1
check "a missing nano-ci is an error (2)" test $? -eq 2
check "...that names what is missing" contains "$WORK/out-nohelper.txt" "no-such-helper"

# ---- an interrupted run -----------------------------------------------------
C=$WORK/tests-cancel
fixture "$C" 10-pass.sh 'echo "ok - fine"'
fixture "$C" 20-long.sh 'echo "ok - started"; echo $$ > "$NANO_RESULTS_DIR/../long.pid"; sleep 60'
fixture "$C" 30-after.sh 'echo "ok - must not run after a cancel"'
NANO_TESTS_DIR=$C bash "$RUN" --results "$WORK/res-cancel" SERIAL-6 > "$WORK/out-cancel.txt" 2>&1 &
RUNNER=$!
for _ in $(seq 1 100); do
  [ -s "$WORK/long.pid" ] && break
  sleep 0.1
done
kill -TERM "$RUNNER"
wait "$RUNNER"
RC=$?
check "a cancelled run exits 130" test "$RC" -eq 130
jq_check "its summary is written and marked interrupted" "$WORK/res-cancel/summary.json" '
  .interrupted == true and .ok == false and .planned == 3 and .total == 2
  and .tests[1].name == "20-long" and .tests[1].status == "fail" and .tests[1].reason == "interrupted"'
check "no test runs after the cancel" lacks "$WORK/out-cancel.txt" "must not run after a cancel"
sleep 0.5
if [ -s "$WORK/long.pid" ]; then
  check "the running test is stopped with the runner" bash -c '! kill -0 "$(cat "$1")" 2>/dev/null' _ "$WORK/long.pid"
fi

# ---- lib.sh -----------------------------------------------------------------
cat > "$WORK/lib-board.sh" <<'EOF'
source "$1"
# shellcheck disable=SC2016
out=$(board 'printf "%s|%s|%s" "$1" "$2" "$#"' 'a b' "c'd\"e \$HOME * \`x\`")
[ "$out" = "a b|c'd\"e \$HOME * \`x\`|2" ] || { echo "board: $out"; exit 1; }
# shellcheck disable=SC2016
out=$(board 'exit 7'; echo "rc=$?")
[ "$out" = "rc=7" ] || { echo "status: $out"; exit 1; }
EOF
NANO_SERIAL=SERIAL-7 bash "$WORK/lib-board.sh" "$LIB" > "$WORK/lib-board.out" 2>&1
check "board() carries arguments across nano-ci ssh verbatim, and its exit status" test $? -eq 0
NANO_STUB_BANNER=the-lab NANO_SERIAL=SERIAL-7 bash "$WORK/lib-board.sh" "$LIB" > "$WORK/lib-board-banner.out" 2>&1
check "...and drops whatever the hop prints before the script's output" test $? -eq 0
printf '#!/usr/bin/env bash\necho "board unreachable: no route"\nexit 255\n' > "$WORK/bin/nano-ci-down"
chmod +x "$WORK/bin/nano-ci-down"
cat > "$WORK/lib-board-fail.sh" <<'EOF'
source "$1"
out=$(NANO_CI=$2 board 'echo never'; echo "rc=$?")
[ "$out" = "board unreachable: no route
rc=255" ] || { echo "unreachable: $out"; exit 1; }
out=$(board 'exit 5'; echo "rc=$?")
[ "$out" = "rc=5" ] || { echo "status: $out"; exit 1; }
EOF
NANO_STUB_BANNER=the-lab NANO_SERIAL=SERIAL-7 bash "$WORK/lib-board-fail.sh" "$LIB" "$WORK/bin/nano-ci-down" > "$WORK/lib-board-fail.out" 2>&1
check "...and keeps what a failed hop printed, with its status" test $? -eq 0
if [ ! -e /home/clawbox/clawbox/data/.mcp-token ]; then
  cat > "$WORK/lib-api.sh" <<'EOF'
source "$1"
board_api GET /setup-api/coding-agent/status
[ "$API_STATUS" = 000 ] && api_error | grep -q "not readable" || { echo "$API_STATUS $API_BODY"; exit 1; }
EOF
  NANO_SERIAL=SERIAL-8 bash "$WORK/lib-api.sh" "$LIB" > "$WORK/lib-api.out" 2>&1
  check "board_api reports a board without an MCP token as 000, not a crash" test $? -eq 0
fi
env -u NANO_SERIAL bash -c 'source "$0"' "$LIB" > "$WORK/lib-noserial.out" 2>&1
check "lib.sh refuses to run without a serial" test $? -eq 1
check "...and says so as a not ok" contains "$WORK/lib-noserial.out" "not ok - no board serial"

# ---- summary.sh -------------------------------------------------------------
NANO_SERIAL=SERIAL-1 NANO_IP=192.0.2.10 NANO_LAB=lab-x NANO_SHA=abc1234 \
  bash "$HERE/summary.sh" "$S" > "$WORK/summary.md" 2>&1
check "the job summary exits 0" test $? -eq 0
check "it names the board and commit" contains "$WORK/summary.md" '| `SERIAL-1` | 192.0.2.10 | lab-x | `abc1234` |'
check "it counts the results" contains "$WORK/summary.md" "**4 passed, 5 failed, 1 skipped** of 10"
check "it has one row per test" test "$(grep -c '^| [0-9][0-9]* | `' "$WORK/summary.md")" -eq 10
check "a failure row carries its reason" contains "$WORK/summary.md" "| ❌ fail | "
NANO_SERIAL=SERIAL-9 NANO_OUTCOME="rebuild failed" bash "$HERE/summary.sh" "$WORK/nope.json" > "$WORK/summary-none.md" 2>&1
check "with no summary.json it still exits 0" test $? -eq 0
check "...and says the suite did not run" contains "$WORK/summary-none.md" "did not run"

# ---- the real tests follow the contract --------------------------------------
check "lib.sh parses" bash -n "$LIB"
check "run.sh parses" bash -n "$RUN"
check "summary.sh parses" bash -n "$HERE/summary.sh"
for name in 10-build-identity 20-services 30-chat-turn 40-coding-agent-run 60-media-tools 70-reboot-survival; do
  check "tests/$name.sh is there" test -f "$HERE/tests/$name.sh"
done
for t in "$HERE"/tests/*; do
  name=$(basename "$t")
  check "tests/$name is named NN-name.sh" bash -c '[[ $1 =~ ^[0-9][0-9]-[a-z0-9-]+\.sh$ ]]' _ "$name"
  check "tests/$name parses" bash -n "$t"
  check "tests/$name sources lib.sh" grep -q 'source "$(dirname "${BASH_SOURCE\[0\]}")/../lib.sh"' "$t"
  check "tests/$name declares a deadline of at most 900 s" \
    bash -c 't=$(head -n 20 "$1" | sed -n -E "s/^#[[:space:]]*timeout:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p" | head -n 1); [ -n "$t" ] && [ "$t" -le 900 ]' _ "$t"
done

echo "1..$N"
if [ "$FAILS" -gt 0 ]; then
  echo "# $FAILS of $N self-test checks failed" >&2
  for f in "$WORK"/out-*.txt "$WORK"/lib-*.out "$WORK"/res-*/summary.json; do
    [ -f "$f" ] || continue
    echo "# --- $(basename "$f")" >&2
    sed 's/^/#   /' "$f" >&2
  done
  exit 1
fi
echo "# all $N self-test checks passed"
