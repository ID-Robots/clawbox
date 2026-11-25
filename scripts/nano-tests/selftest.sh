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
# in a home folder of the board's own (where run.sh keeps its suite claim), so
# lib.sh's board() is exercised end to end; every call is logged.
mkdir -p "$WORK/bin" "$WORK/board-home"
cat > "$WORK/bin/nano-ci" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${NANO_STUB_LOG:?}"
case "$1" in
  ssh)
    shift 2
    [ -z "${NANO_STUB_BANNER:-}" ] || printf 'Welcome to %s\nok banner\n' "$NANO_STUB_BANNER"
    HOME=${NANO_STUB_HOME:?} exec bash -c "$*"
    ;;
  health) exit "${NANO_STUB_HEALTH:-0}" ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$WORK/bin/nano-ci"
export NANO_STUB_HOME=$WORK/board-home
# The suite claim run.sh holds on the board while it runs.
CLAIMF=$NANO_STUB_HOME/.cache/clawbox-nano-tests/suite.claim
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
echo "board at $NANO_IP, gateway at $(printf "%s.%s.%s.%s" 10 9 8 7), log in /$(printf home)/station1/x.log"
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
  .serial == "SERIAL-1" and has("ip") == false and .lab == "lab-x"
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
check "the board's address is redacted" contains "$L" "board at <board-ip>, gateway at <private-ip>, log in /home/<user>/x.log"
check "...from the run's output too" lacks "$OUT" "192.0.2.10"
check "the run names the board by serial and lab" line_matches "$OUT" '^# board SERIAL-1 in lab-x, commit 0123456789ab'
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

# ---- a test that leaves the box unfit for the rest -------------------------
STOP=$WORK/tests-stop
fixture "$STOP" 10-first.sh 'echo "ok - fine"'
fixture "$STOP" 20-stopper.sh 'echo "20-stopper left the box mid-update" > "$NANO_STOP_FILE"; echo "not ok - left the box mid-update"'
fixture "$STOP" 30-after.sh 'touch "$NANO_RESULTS_DIR/../after-ran"; echo "ok - must not run after a stop"'
NANO_TESTS_DIR=$STOP bash "$RUN" --results "$WORK/res-stop" SERIAL-20 > "$WORK/out-stop.txt" 2>&1
check "a test that stops the suite still fails the run (1)" test $? -eq 1
check "...the test after it does not run" test ! -e "$WORK/after-ran"
check "...and is a skip that carries the stop's reason" line_matches "$WORK/out-stop.txt" '^ok 3 - 30-after \(0s\) # SKIP not run: 20-stopper left the box mid-update$'
check "...while the one before it ran" line_matches "$WORK/out-stop.txt" '^ok 1 - 10-first '

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
check "...and gives the board's suite claim back" test ! -e "$CLAIMF"
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
check "it names the board by serial and lab, and the commit" contains "$WORK/summary.md" '| `SERIAL-1` | lab-x | `abc1234` |'
check "it never names the board's address" lacks "$WORK/summary.md" "192.0.2.10"
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
for name in 10-build-identity 20-services 25-gateway-channels 30-chat-turn 40-coding-agent-run 45-codex-auth-mirror-lock \
  50-memory-pressure 60-media-tools 65-prime-radiant-mcp 75-full-reboot 76-gnome-initial-setup 77-vnc-clean-boot 78-one-browser \
  79-browser-clean-start 85-update-rollback 90-upgrade-from-release; do
  check "tests/$name.sh is there" test -f "$HERE/tests/$name.sh"
done
for t in "$HERE"/tests/*; do
  name=$(basename "$t")
  check "tests/$name is named NN-name.sh" bash -c '[[ $1 =~ ^[0-9][0-9]-[a-z0-9-]+\.sh$ ]]' _ "$name"
  check "tests/$name parses" bash -n "$t"
  check "tests/$name sources lib.sh" grep -q 'source "$(dirname "${BASH_SOURCE\[0\]}")/../lib.sh"' "$t"
  # A long-tier test (`# tier: long`, opt-in) may take up to 75 min; every
  # other one shares the suite's 40 minutes.
  check "tests/$name declares a deadline of at most 900 s (4500 s for a long-tier test)" \
    bash -c 't=$(head -n 20 "$1" | sed -n -E "s/^#[[:space:]]*timeout:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p" | head -n 1)
      max=900; head -n 20 "$1" | grep -qE "^#[[:space:]]*tier:[[:space:]]*long[[:space:]]*$" && max=4500
      [ -n "$t" ] && [ "$t" -le "$max" ]' _ "$t"
  # A test that runs beside others only reads the box: whatever restarts,
  # reboots or stops something goes through sudo, and none of that may share
  # the board with another test.
  if head -n 20 "$t" | grep -qE '^#[[:space:]]*parallel:'; then
    check "tests/$name names its parallel group in lower case" \
      bash -c 'head -n 20 "$1" | grep -qE "^#[[:space:]]*parallel:[[:space:]]*[a-z0-9-]+[[:space:]]*$"' _ "$t"
    check "tests/$name runs side by side, so it uses no sudo and never reboots" \
      bash -c '! grep -vE "^[[:space:]]*#" "$1" | grep -qE "sudo|reboot|poweroff|systemctl (restart|stop|kill)|kill -"' _ "$t"
  fi
  # Every pattern of its map names a file that exists: a typo, or a file
  # moved since, would quietly stop selecting this test.
  check "tests/$name maps only onto files that exist (# covers:)" bash -c '
    patterns=$(head -n 20 "$1" | sed -n -E "s/^#[[:space:]]*covers:[[:space:]]*(.*[^[:space:]])[[:space:]]*$/\1/p" | tr " " "\n" | grep .)
    [ -n "$patterns" ] || exit 0
    files=$(git -C "$2" ls-files)
    while IFS= read -r p; do
      case "$p" in *[!A-Za-z0-9._/*-]*) echo "bad pattern $p"; exit 1 ;; esac
      re="^$(printf "%s" "$p" | sed -e "s/[.]/[.]/g" -e "s/[*]/.*/g")\$"
      grep -qE "$re" <<<"$files" || { echo "no file matches $p"; exit 1; }
    done <<<"$patterns"' _ "$t" "$HERE/../.."
done

# ---- 85-update-rollback keeps the checkout only over the release's build -----
# The real test against a stand-in lib.sh whose board answers from T85_*: the
# update moved the core and failed, so the checkout stays on NANO_SHA. The board
# must start on a build of the release's commit, and the build put back must be
# a build of that same commit, whole, with no rollback record left.
export T85=$WORK/t85
mkdir -p "$T85/tests"
cp "$HERE/tests/85-update-rollback.sh" "$T85/tests/"
cat > "$T85/lib.sh" <<'EOF'
NANO_TEST_FAILED=0
ok() { printf 'ok - %s\n' "$*"; }
not_ok() { printf 'not ok - %s\n' "$*"; NANO_TEST_FAILED=1; }
skip() { printf 'ok # SKIP %s\n' "$*"; }
note() { printf '# %s\n' "$*"; }
finish() { exit "$NANO_TEST_FAILED"; }
ensure_on_release() { HEAD0=$T85_RELEASE; }
start_app_update() { :; }
api_error() { :; }
wait_app_update() { "$2"; UPDATE_PHASE=failed UPDATE_ERROR="Rebuild failed"; }
runtime_settled_line() { ok "settled"; }
runtime_kept() { ok "runtime kept"; }
runtime_chat_turn() { ok "chat turn answered"; }
board_head() { echo "$NANO_SHA"; }
build_identity_ok() {
  echo "BUILD IDENTITY: FAIL — .next/build-info.json was built from $T85_BUILT but the checkout is at $NANO_SHA"
  return 1
}
board() {
  case "$1" in
    *python3*) # the facts: at the start, then after the update
      if [ -e "$T85/started" ]; then echo "$T85_EDITION 2026.11.5 $T85_BUILT 2026.10.9 2026.11.5 $T85_TARGET"; return; fi
      : > "$T85/started"
      echo "$T85_EDITION 2026.10.9 $T85_START 2026.10.9 2026.10.9 present" ;;
    # The served build is whole as its own commit's (unless T85_WHOLE=0), and
    # as no other.
    *verify-build-identity.sh*)
      if [ "$2" = "$T85_BUILT" ] && [ "$T85_WHOLE" = 1 ]; then echo "BUILD IDENTITY: OK — 2 artifact(s) built from ${2:0:7}"; return 0; fi
      echo "BUILD IDENTITY: FAIL — .next/standalone/.next/build-info.json was built from $T85_BUILT but the checkout is at $2"
      return 1 ;;
    *'next build'*) echo "count 1" ;;
    *) echo 200 ;;
  esac
}
EOF
R85=1111111111111111111111111111111111111111
t85() { # NAME BUILD-SERVED-AFTER [BUILD-AT-START [WHOLE (1|0) [RECORD (absent|present)]]]
  rm -f "$T85/started"
  T85_RELEASE=$R85 T85_BUILT=$2 T85_START=${3:-$R85} T85_WHOLE=${4:-1} T85_TARGET=${5:-absent} \
    T85_EDITION=${T85_EDITION:-openclaw} NANO_BRANCH=fix/x \
    bash "$T85/tests/85-update-rollback.sh" > "$WORK/t85-$1.out" 2>&1
}
t85 release 1111111111111111111111111111111111111111
check "85: the checkout kept over the release's build after a core move passes" test $? -eq 0
check "...as kept by design" contains "$WORK/t85-release.out" "ok - checkout kept on 0123456789ab"
t85 other 2222222222222222222222222222222222222222
check "85: a whole build of another commit put back under the kept checkout fails" test $? -eq 1
check "...naming it as not the release's" contains "$WORK/t85-other.out" "not ok - the restored build 222222222222 is not the release's"
t85 start 3333333333333333333333333333333333333333 3333333333333333333333333333333333333333
check "85: a board whose build at the start is of another commit fails" test $? -eq 1
check "...at the start, before any update" contains "$WORK/t85-start.out" "not ok - the board did not start on the release's build"
check "...and never blames the restore" lacks "$WORK/t85-start.out" "update to fix/x started"
t85 broken "$R85" "$R85" 0
check "85: a build of the release's commit that is not whole fails the kept checkout" test $? -eq 1
check "...saying so" contains "$WORK/t85-broken.out" "not ok - the restored build does not hold together as 111111111111's"
t85 record "$R85" "$R85" 1 present
check "85: a rollback record left behind fails the kept checkout" test $? -eq 1
check "...saying so" contains "$WORK/t85-record.out" "not ok - data/config.json still holds the dashboard's rollback target"
T85_EDITION=hermes NANO_REQUIRE_CORE_MOVE=1 t85 hermes "$R85"
check "85: NANO_REQUIRE_CORE_MOVE=1 on a Hermes board notes that no core moves" contains "$WORK/t85-hermes.out" "# Hermes edition: no OpenClaw core moves"
check "...and does not fail the run for it" lacks "$WORK/t85-hermes.out" "not ok - Hermes edition"

# ---- long-tier tests are opt-in ----------------------------------------------
L=$WORK/tests-long
fixture "$L" 10-pass.sh 'echo "ok - fine"'
fixture "$L" 20-long.sh '# tier: long
echo "ok - long ran"'
NANO_TESTS_DIR=$L bash "$RUN" --results "$WORK/res-long" SERIAL-7 > "$WORK/out-long.txt" 2>&1
check "a long-tier test is skipped by default" line_matches "$WORK/out-long.txt" '^ok 2 - 20-long \(0s\) # SKIP long-tier'
jq_check "a skipped long-tier test is a skip in summary.json" "$WORK/res-long/summary.json" '.skipped == 1 and .ok'
NANO_TESTS_LONG=1 NANO_TESTS_DIR=$L bash "$RUN" --results "$WORK/res-long2" SERIAL-7 > "$WORK/out-long2.txt" 2>&1
check "NANO_TESTS_LONG=1 runs a long-tier test" line_matches "$WORK/out-long2.txt" '^ok 2 - 20-long \([0-9]+s\)$'

# ---- read-only neighbours run side by side -----------------------------------
P=$WORK/tests-parallel
fixture "$P" 10-a.sh '# parallel: g
sleep 3; echo "ok - a"'
fixture "$P" 20-b.sh '# parallel: g
sleep 3; echo "ok - b"'
fixture "$P" 25-long.sh '# parallel: g
# tier: long
echo "not ok - a long-tier test must not run here"'
fixture "$P" 30-c.sh '# parallel: g
sleep 1; echo "not ok - c is broken"; exit 1'
fixture "$P" 40-d.sh 'echo "ok - d"'
fixture "$P" 50-e.sh '# parallel: h
sleep 1; echo "ok - e"'
fixture "$P" 60-f.sh '# parallel: h
sleep 1; echo "ok - f"'
T0=$(date +%s)
NANO_TESTS_DIR=$P bash "$RUN" --results "$WORK/res-par" SERIAL-P > "$WORK/out-par.txt" 2>&1
RC=$?
T1=$(date +%s)
check "a parallel suite with a failure exits 1" test "$RC" -eq 1
check "neighbours sharing a group run at the same time (3 s + 1 s, not 9 s)" test $((T1 - T0)) -lt 8
check "...and say so" line_matches "$WORK/out-par.txt" '^# side by side \(parallel: g\): 10-a 20-b 30-c$'
check "their TAP lines keep NN order" bash -c '[ "$(grep -E "^(not )?ok [0-9]+ " "$1" | sed -E "s/^(not )?ok ([0-9]+) .*/\2/" | tr "\n" " ")" = "1 2 3 4 5 6 7 " ]' _ "$WORK/out-par.txt"
check "a long-tier test inside a group is skipped in its place" line_matches "$WORK/out-par.txt" '^ok 3 - 25-long \(0s\) # SKIP long-tier'
check "a failure inside a group is that test's alone" line_matches "$WORK/out-par.txt" '^not ok 4 - 30-c '
jq_check "each one keeps its own duration" "$WORK/res-par/summary.json" '
  ([.tests[] | select(.name == "10-a" or .name == "20-b") | .duration_s >= 3] | all)
  and ([.tests[] | select(.name == "30-c") | .duration_s <= 3] | all)'
jq_check "the summary lists them in NN order with the right counts" "$WORK/res-par/summary.json" '
  [.tests[].name] == ["10-a","20-b","25-long","30-c","40-d","50-e","60-f"]
  and .passed == 5 and .failed == 1 and .skipped == 1 and .selection == "all"'
T0=$(date +%s)
NANO_PARALLEL=0 NANO_TESTS_DIR=$P bash "$RUN" --results "$WORK/res-seq" SERIAL-P > "$WORK/out-seq.txt" 2>&1
T1=$(date +%s)
check "NANO_PARALLEL=0 runs every test on its own" test $((T1 - T0)) -ge 9
check "...with the same verdicts" bash -c 'diff <(jq -c "[.tests[] | [.name, .status]]" "$1") <(jq -c "[.tests[] | [.name, .status]]" "$2")' _ "$WORK/res-par/summary.json" "$WORK/res-seq/summary.json"

# ---- a cancel in the middle of a group ----------------------------------------
Q=$WORK/tests-par-cancel
fixture "$Q" 10-quick.sh '# parallel: g
echo "ok - quick"'
fixture "$Q" 20-slow.sh '# parallel: g
echo "ok - started"; echo $$ > "$NANO_RESULTS_DIR/../slow1.pid"; sleep 60'
fixture "$Q" 30-slow.sh '# parallel: g
echo "ok - started"; echo $$ > "$NANO_RESULTS_DIR/../slow2.pid"; sleep 60'
fixture "$Q" 40-after.sh 'echo "ok - must not run after a cancel"'
NANO_TESTS_DIR=$Q bash "$RUN" --results "$WORK/res-par-cancel" SERIAL-Q > "$WORK/out-par-cancel.txt" 2>&1 &
RUNNER=$!
for _ in $(seq 1 100); do
  [ -s "$WORK/slow1.pid" ] && [ -s "$WORK/slow2.pid" ] && break
  sleep 0.1
done
sleep 1.5
kill -TERM "$RUNNER"
wait "$RUNNER"
RC=$?
check "a run cancelled inside a group exits 130" test "$RC" -eq 130
jq_check "what ended is reported, what ran is interrupted, in NN order" "$WORK/res-par-cancel/summary.json" '
  .interrupted == true and .ok == false and .total == 3
  and [.tests[] | [.name, .status, .reason]] == [["10-quick","pass",""],["20-slow","fail","interrupted"],["30-slow","fail","interrupted"]]'
check "no test runs after the cancel" lacks "$WORK/out-par-cancel.txt" "must not run after a cancel"
sleep 0.5
for pidfile in "$WORK/slow1.pid" "$WORK/slow2.pid"; do
  if [ -s "$pidfile" ]; then
    check "the running tests are stopped with the runner ($(basename "$pidfile"))" bash -c '! kill -0 "$(cat "$1")" 2>/dev/null' _ "$pidfile"
  fi
done

# ---- change-based selection ----------------------------------------------------
NANO_TESTS_SELECT="10-a,40-d 60-f" NANO_TESTS_SELECT_REASON="from 2 files" NANO_TESTS_DIR=$P \
  bash "$RUN" --results "$WORK/res-sel" SERIAL-S > "$WORK/out-sel.txt" 2>&1
RC=$?
check "a selection of passing tests exits 0" test "$RC" -eq 0
check "the selection is announced" line_matches "$WORK/out-sel.txt" '^# change-based selection: 10-a 40-d 60-f \(from 2 files\)$'
check "a test left out is a skip that says why" line_matches "$WORK/out-sel.txt" '^ok 2 - 20-b \(0s\) # SKIP not affected by this change'
check "...even a failing one, which never runs" line_matches "$WORK/out-sel.txt" '^ok 4 - 30-c \(0s\) # SKIP not affected by this change'
jq_check "summary.json names the selection and counts the rest as skipped" "$WORK/res-sel/summary.json" '
  .selection == ["10-a","40-d","60-f"] and .passed == 3 and .skipped == 4 and .failed == 0 and .ok and .planned == 7'
NANO_TESTS_SELECT=all NANO_TESTS_DIR=$B bash "$RUN" --results "$WORK/res-sel-all" SERIAL-S > /dev/null 2>&1
jq_check "NANO_TESTS_SELECT=all runs every test" "$WORK/res-sel-all/summary.json" '.selection == "all" and .passed == 1 and .skipped == 1'
NANO_TESTS_SELECT="99-no-such-test" NANO_TESTS_DIR=$P bash "$RUN" --results "$WORK/res-sel-bad" SERIAL-S > "$WORK/out-sel-bad.txt" 2>&1
check "a selection naming no test is a usage error (2)" test $? -eq 2
check "...that names it" contains "$WORK/out-sel-bad.txt" "99-no-such-test"
NANO_TESTS_SELECT='10-a;reboot' NANO_TESTS_DIR=$P bash "$RUN" --results "$WORK/res-sel-bad2" SERIAL-S > /dev/null 2>&1
check "a selection that is not test names is refused (2)" test $? -eq 2

# ---- one suite per board ---------------------------------------------------------
O=$WORK/tests-claim
fixture "$O" 10-claimed.sh 'read -r id expiry _ < "$NANO_STUB_HOME/.cache/clawbox-nano-tests/suite.claim"
if [ "$id" = "$NANO_RUN_ID" ] && [ "${expiry:-0}" -gt "$(date +%s)" ]; then echo "ok - the board is claimed by this run"
else echo "not ok - the claim is [$id $expiry], not one of this run"; fi'
fixture "$O" 20-ran.sh 'touch "$NANO_RESULTS_DIR/../claim-ran"; echo "ok - ran"'
check "no run left a claim on the board" test ! -e "$CLAIMF"
NANO_TESTS_DIR=$O bash "$RUN" --results "$WORK/res-claim" SERIAL-C > "$WORK/out-claim.txt" 2>&1
check "a run holds the board's suite claim while its tests run" test $? -eq 0
check "...and gives it back when it ends" test ! -e "$CLAIMF"
rm -f "$WORK/claim-ran"
printf 'other-run %s\n' $(($(date +%s) + 600)) > "$CLAIMF"
cp "$CLAIMF" "$WORK/claim-before"
NANO_TESTS_DIR=$O bash "$RUN" --results "$WORK/res-claim-busy" SERIAL-C > "$WORK/out-claim-busy.txt" 2>&1
check "a board another run has claimed is refused (2)" test $? -eq 2
check "...naming that run" contains "$WORK/out-claim-busy.txt" "running another suite (run other-run, its claim lasts"
check "...before any test starts" test ! -e "$WORK/claim-ran"
check "...and its claim is left as it was" cmp -s "$CLAIMF" "$WORK/claim-before"
printf 'gone-run %s\n' $(($(date +%s) - 5)) > "$CLAIMF"
NANO_TESTS_DIR=$O bash "$RUN" --results "$WORK/res-claim-stale" SERIAL-C > "$WORK/out-claim-stale.txt" 2>&1
check "a claim past its expiry (a run that died) is taken over" test $? -eq 0
check "...and given back at the end" test ! -e "$CLAIMF"
NANO_CI=$WORK/bin/nano-ci-down NANO_TESTS_DIR=$B bash "$RUN" --results "$WORK/res-claim-down" SERIAL-C > "$WORK/out-claim-down.txt" 2>&1
check "a board that does not answer the claim still runs its tests" test $? -eq 0
check "...saying so" contains "$WORK/out-claim-down.txt" "# the board did not answer the suite claim: running without one"
check "...without printing what the failed hop said" lacks "$WORK/out-claim-down.txt" "no route"
fixture "$WORK/tests-claim-none" 10-long.sh '# tier: long
echo "ok - long ran"'
calls=$(wc -l < "$NANO_STUB_LOG")
NANO_TESTS_DIR=$WORK/tests-claim-none bash "$RUN" --results "$WORK/res-claim-none" SERIAL-C > /dev/null 2>&1
check "a run whose every test is skipped claims nothing" test "$(wc -l < "$NANO_STUB_LOG")" -eq "$calls"

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
