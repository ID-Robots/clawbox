# shellcheck shell=bash
# Helpers for scripts/nano-tests/tests/NN-*.sh (TASK-1324) — SOURCED by a test,
# never run on its own. See docs/nano-hardware-tests.md.
#
# A test runs on the nano-lab RUNNER HOST, not on the board. Everything it does
# to the board goes through `nano-ci ssh <serial> …` — this file is the one
# place that builds those commands, so no test hand-quotes a remote shell line
# and no test ever sees the board's MCP bearer (see `api` in BOARD_PRELUDE).
#
# What a test reports is what it PRINTS, TAP-style, one line per assertion:
#
#   ok - <what held>
#   not ok - <what did not, and why>
#   ok # SKIP <why this test does not apply to this board>
#   # <a note for the log>
#
# run.sh turns those lines into the test's verdict; the exit status only
# matters when a test dies before it could say anything. Anything else a test
# prints — a remote tool's stderr included — is kept in its log and never read
# as a result, as long as it does not start with one of those exact shapes, so
# board output goes through `note` rather than straight to stdout.
#
# Deliberately NOT `set -e`: a test that stopped at its first failed command
# would report one problem and hide the rest. Each helper returns a status and
# the test decides what it means.
set -uo pipefail

NANO_SERIAL=${NANO_SERIAL:-${1:-}}
if [ -z "$NANO_SERIAL" ]; then
  echo "not ok - no board serial: run this test through scripts/nano-tests/run.sh <serial>"
  exit 1
fi
NANO_CI=${NANO_CI:-nano-ci}
NANO_RUN_ID=${NANO_RUN_ID:-local}
NANO_SHA=${NANO_SHA:-}

# Where things live on a lab board. The CLI path is the canonical one:
# install-x64.sh's OPENCLAW_BIN and config/clawbox-gateway.service's ExecStart.
BOARD_HOME=/home/clawbox
BOARD_REPO=$BOARD_HOME/clawbox
OPENCLAW_BIN=$BOARD_HOME/.npm-global/bin/openclaw
export BOARD_HOME BOARD_REPO OPENCLAW_BIN

NANO_TEST_FAILED=0

ok()     { printf 'ok - %s\n' "$*"; }
not_ok() { printf 'not ok - %s\n' "$*"; NANO_TEST_FAILED=1; }
skip()   { printf 'ok # SKIP %s\n' "$*"; }
note()   { printf '# %s\n' "$*"; }
# End the test: non-zero when anything above was `not ok`.
finish() { exit "$NANO_TEST_FAILED"; }

# Prepended to every script `board` runs: the clawbox user's environment as a
# non-interactive ssh does not give it, and the one authenticated HTTP helper.
# shellcheck disable=SC2016  # expanded on the board, not here
BOARD_PRELUDE='
set -uo pipefail
printf "%s\n" "@@nano-ci-output@@"
export HOME=/home/clawbox
export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
REPO=/home/clawbox/clawbox
DASHBOARD=http://127.0.0.1

# api METHOD PATH [JSON_BODY] -> the HTTP status on the first line, the body after it.
#
# The MCP bearer (data/.mcp-token) is read HERE, on the board, and handed to curl
# on its stdin as a config line: it is never on a command line where ps shows it,
# never in the output, and never leaves the board. "000" means no answer at all.
api() {
  local method=$1 path=$2 body=${3:-} out code token
  local extra=()
  if [ ! -r "$REPO/data/.mcp-token" ]; then
    printf "000\n{\"error\":\"%s is not readable on the board\"}\n" "$REPO/data/.mcp-token"
    return 0
  fi
  token=$(tr -d "\r\n" < "$REPO/data/.mcp-token")
  token=${token//\\/\\\\}
  token=${token//\"/\\\"}
  [ -n "$body" ] && extra=(-H "Content-Type: application/json" --data-binary "$body")
  out=$(mktemp)
  code=$(printf "header = \"Authorization: Bearer %s\"\n" "$token" \
    | curl -sS -o "$out" -w "%{http_code}" -X "$method" --max-time "${API_MAX_TIME:-150}" \
        "${extra[@]}" -K - "$DASHBOARD$path" 2>/dev/null)
  printf "%s\n" "${code:-000}"
  cat "$out"
  rm -f "$out"
}
'

# board SCRIPT [ARG...] — run a bash script on the board as the clawbox user.
#
# The script (prelude + `set -- ARG…` + SCRIPT) travels base64-encoded inside
# the ONE command string `nano-ci ssh` hands to the board's login shell, so no
# quote in it can break, or be broken by, the hop. Its stdout and stderr come
# back as they are and its exit status is the command's. stdin is closed: a
# remote command that waits for input must fail, not hang the test.
#
# The prelude's first line is a marker, and everything the hop printed before
# it (a banner, a "connecting to…") is dropped, so callers can read the first
# line of the answer as the answer. When the marker never arrives — the hop
# failed before the script started — every line is kept, for the log.
board() {
  local script=$1 args="set --" a b64
  shift
  for a in "$@"; do args+=" $(printf '%q' "$a")"; done
  b64=$(printf '%s\n%s\n%s\n' "$BOARD_PRELUDE" "$args" "$script" | base64 -w0)
  "$NANO_CI" ssh "$NANO_SERIAL" "bash -c \"\$(echo $b64 | base64 -d)\"" </dev/null \
    | awk 'found { print; next }
           $0 == "@@nano-ci-output@@" { found = 1; n = 0; next }
           { held[++n] = $0 }
           END { if (!found) for (i = 1; i <= n; i++) print held[i] }'
}

# board_api METHOD PATH [JSON_BODY] — an authenticated /setup-api call made ON
# the board (see `api` above). Sets API_STATUS ("000" when nothing answered) and
# API_BODY.
API_STATUS=000
API_BODY=
board_api() {
  local out
  # shellcheck disable=SC2016  # $@ is the board's positional list
  out=$(board 'api "$@"' "$@")
  API_STATUS=$(printf '%s\n' "$out" | head -n1)
  API_BODY=$(printf '%s\n' "$out" | tail -n +2)
  case "$API_STATUS" in [0-9][0-9][0-9]) ;; *) API_STATUS=000 ;; esac
}

# jq over API_BODY; prints nothing when the body is not JSON.
api_json() { printf '%s' "$API_BODY" | jq -r "$@" 2>/dev/null; }

# The first line of an error answer, for a `not ok` reason. Never the whole
# body: it can be a page of HTML.
api_error() {
  local msg
  msg=$(api_json '(.error // .message // empty) | tostring' | head -n1)
  [ -n "$msg" ] || msg=$(printf '%s' "$API_BODY" | head -c 200 | tr '\n' ' ')
  printf 'HTTP %s: %s' "$API_STATUS" "${msg:-no body}"
}

# wait_gateway_health SECONDS — poll /setup-api/gateway/health until it answers
# 200 with available:true. Sets WAITED to the seconds it took. The route is a
# TCP probe of the gateway's port, answered by the dashboard — so a pass means
# both the web server and the gateway are up.
WAITED=0
wait_gateway_health() {
  local budget=$1 start now
  start=$(date +%s)
  while :; do
    board_api GET /setup-api/gateway/health
    now=$(date +%s)
    WAITED=$((now - start))
    if [ "$API_STATUS" = 200 ] && [ "$(api_json '.available')" = true ]; then
      return 0
    fi
    [ "$WAITED" -ge "$budget" ] && return 1
    sleep 5
  done
}

# chat_turn — one real chat turn through the box's configured provider:
# `openclaw agent --agent main` must answer "NANO-CI-OK <serial>" within 240 s.
# Retried ONCE after 60 s, because the gateway restarts twice after a rebuild
# and a turn sent into a restart is lost rather than queued. Prints its own
# ok / not ok line. Each attempt uses a session of its own, so CI turns never
# land in the board's main chat and never read an earlier run's answer.
chat_turn() {
  local marker="NANO-CI-OK $NANO_SERIAL" attempt out rc json reply
  for attempt in 1 2; do
    # stdout only: the CLI's stderr goes straight to the test's log.
    # shellcheck disable=SC2016  # expanded on the board
    out=$(board '
      timeout 240 "$1" agent --agent main --session-key "$2" \
        -m "Reply with exactly this text and nothing else: $3" --json --timeout 230
    ' "$OPENCLAW_BIN" "nano-ci-$NANO_RUN_ID-$(date +%s)-$attempt" "$marker")
    rc=$?
    # --json prints one object, but a plugin warning can precede it on stdout.
    # The reply is read out of the object, never grepped from the raw output:
    # the prompt carries the marker too, and an echo of it must not pass.
    json=$(printf '%s\n' "$out" | sed -n '/^{/,$p')
    reply=$(printf '%s' "$json" | jq -r '
      [ (.result.payloads // [])[]?.text, .result.text, .reply, .text ]
      | map(select(type == "string")) | join("\n")' 2>/dev/null)
    if [ "$rc" -eq 0 ] && printf '%s' "$reply" | grep -qF "$marker"; then
      ok "chat turn answered \"$marker\" (attempt $attempt)"
      return 0
    fi
    if [ "$rc" -eq 124 ]; then
      note "attempt $attempt: no answer within 240 s"
    else
      note "attempt $attempt: exit $rc, reply: $(printf '%s' "${reply:-$out}" | tr '\n' ' ' | head -c 300)"
    fi
    [ "$attempt" -eq 1 ] && { note "retrying in 60 s"; sleep 60; }
  done
  not_ok "no chat turn answered \"$marker\" in two attempts"
  return 1
}

# ---- coding-agent runs (40-, 60-) -------------------------------------------

# fresh_project_dir SUFFIX — the folder a coding run works in, created empty on
# the board: <project folder>/nano-ci-<run id><SUFFIX>. The project folder is
# the owner's default when one is set (a run must be INSIDE it then — see
# resolveWorkingDirectory in src/lib/coding-agent.ts), ~/Projects otherwise.
# Needs API_BODY to hold a /setup-api/coding-agent/status answer. Sets
# PROJECT_DIR; returns non-zero when the folder could not be made.
PROJECT_DIR=
fresh_project_dir() {
  local base name
  base=$(api_json '.defaultDirectory // empty')
  [ -n "$base" ] || base=$BOARD_HOME/Projects
  name="nano-ci-$(printf '%s' "$NANO_RUN_ID$1" | tr -c 'A-Za-z0-9._-' '-')"
  PROJECT_DIR=$base/$name
  # shellcheck disable=SC2016  # expanded on the board
  board '
    case "$1" in /home/clawbox/?*/nano-ci-*) ;; *) echo "refusing to prepare $1"; exit 2 ;; esac
    rm -rf -- "$1" && mkdir -p -- "$1"
  ' "$PROJECT_DIR"
}

# remove_project_dir — best effort; nano-ci cleanup wipes test projects anyway.
remove_project_dir() {
  [ -n "$PROJECT_DIR" ] || return 0
  # shellcheck disable=SC2016  # expanded on the board
  board 'case "$1" in /home/clawbox/?*/nano-ci-*) rm -rf -- "$1" ;; esac' "$PROJECT_DIR" >/dev/null 2>&1
}

# start_coding_run TASK — POST /setup-api/coding-agent/run in PROJECT_DIR.
# Sets RUN_ID; returns non-zero (with API_STATUS/API_BODY for the reason).
RUN_ID=
start_coding_run() {
  local body
  body=$(jq -cn --arg task "$1" --arg dir "$PROJECT_DIR" '{task: $task, directory: $dir}')
  board_api POST /setup-api/coding-agent/run "$body"
  RUN_ID=$(api_json '.run.id // empty')
  [ "$API_STATUS" = 202 ] && [ -n "$RUN_ID" ]
}

# wait_coding_run SECONDS — long-poll GET /setup-api/coding-agent/runs?id=
# (the route holds each request up to 60 s) until the run leaves "running".
# Sets RUN_STATUS and leaves the last answer in API_BODY. On the deadline the
# run is stopped, so a stuck run does not keep spending the plan.
RUN_STATUS=
wait_coding_run() {
  local deadline=$(( $(date +%s) + $1 ))
  RUN_STATUS=running
  while [ "$(date +%s)" -lt "$deadline" ]; do
    board_api GET "/setup-api/coding-agent/runs?id=$RUN_ID&wait=60"
    if [ "$API_STATUS" = 200 ]; then
      RUN_STATUS=$(api_json '.run.status // empty')
      [ "$RUN_STATUS" = running ] || return 0
    else
      note "polling $RUN_ID: $(api_error)"
      sleep 10
    fi
  done
  RUN_STATUS=timeout
  board_api POST /setup-api/coding-agent/stop "$(jq -cn --arg id "$RUN_ID" '{runId: $id}')"
  note "stopped $RUN_ID after the deadline: HTTP $API_STATUS"
  return 1
}

# expect_completed — the ok / not ok line for the run wait_coding_run waited on.
expect_completed() {
  case "$RUN_STATUS" in
    completed) ok "run $RUN_ID completed" ;;
    timeout) not_ok "run $RUN_ID was still running at the deadline and was stopped: $(run_account)" ;;
    *) not_ok "run $RUN_ID ended ${RUN_STATUS:-with no status}, not completed: $(run_account)" ;;
  esac
}

# The last run answer's own account of itself, for a `not ok` reason.
run_account() {
  local text
  text=$(api_json '.run.summary // .run.resultText // .run.error // "" | tostring | .[0:300]' | tr '\n' ' ')
  text=${text% }
  printf '%s' "${text:-the run gave no account}"
}
