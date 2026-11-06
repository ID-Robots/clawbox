#!/usr/bin/env bash
# timeout: 2400
# tier: long
# covers: mcp/clawbox-mcp.ts
#
# The first assistant tool call after the box's MCP server sat idle (TASK-2189),
# on whichever agent runtime the board runs. A real chat turn opens the server,
# the box is left alone for 11 minutes — past the 10-minute idle rule in
# mcp/clawbox-mcp.ts — and then the assistant is asked to create ONE Prime
# Radiant page, calling the tool once and never retrying:
#
#   * Hermes holds one clawbox server for its whole life and only notices a
#     dead one once a call is already in flight ("lost its stdio subprocess
#     after the tool call began ... did not replay it"). Its server must still
#     run after the pause, the create must work with no such line in
#     ~/.hermes/logs/errors.log, and fresh conversations must not add servers.
#   * OpenClaw's gateway keeps one server per session key, so the idle exit
#     stays there: the session's server must have exited, and the create on the
#     same session key must still work (the gateway reconnects before it calls).
#
# Either way the page must exist exactly once afterwards. Every page the test
# made is deleted again. Long tier: the pause alone is 11 minutes.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

IDLE_WAIT_S=660
TITLE="Nano CI idle check $NANO_RUN_ID"
RUNTIME=$(board_runtime)
note "agent runtime: $RUNTIME"

# One line per clawbox MCP server on the board: "<pid> <hermes|openclaw|other>
# <age in s>". The pattern cannot match the script that runs it.
# shellcheck disable=SC2016  # expanded on the board
SERVERS='
for pid in $(pgrep -f "mcp/clawbox-mc[p][.]ts" 2>/dev/null); do
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d " ")
  age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d " ")
  [ -n "$ppid" ] && [ -n "$age" ] || continue
  case "$(ps -o args= -p "$ppid" 2>/dev/null)" in
    *hermes*) who=hermes ;;
    *openclaw*) who=openclaw ;;
    *) who=other ;;
  esac
  printf "%s %s %s\n" "$pid" "$who" "$age"
done'
servers() { board "$SERVERS" | grep -E '^[0-9]+ [a-z]+ [0-9]+$'; }
# Is this pid still a clawbox MCP server?
alive() { servers | awk -v p="$1" '$1 == p { found = 1 } END { exit !found }'; }

# Lines in a file under the board's home (0 when it is missing), and the lines
# added after the first N.
# shellcheck disable=SC2016  # expanded on the board
count_lines() { board 'wc -l < "$HOME/$1" 2>/dev/null || echo 0' "$1" | tail -n 1 | tr -d ' '; }
# shellcheck disable=SC2016  # expanded on the board
lines_after() { board 'tail -n +"$(( $2 + 1 ))" "$HOME/$1" 2>/dev/null' "$1" "$2"; }

# ask KEY MESSAGE — one assistant turn on the runtime under test, in the
# conversation KEY. Sets REPLY (the assistant's text) and TURN_RC.
REPLY=
TURN_RC=0
ask() {
  local key=$1 message=$2 out body
  if [ "$RUNTIME" = hermes ]; then
    # The desktop chat's own route, as the owner: a dashboard turn of the
    # long-lived Hermes, the one that holds the clawbox server.
    body=$(jq -cn --arg m "$message" --arg k "$key" '{message: $m, sessionKey: $k}')
    # shellcheck disable=SC2016  # expanded on the board
    out=$(board 'API_MAX_TIME=330 owner_api POST /setup-api/hermes/chat "$1"' "$body")
    TURN_RC=$(printf '%s\n' "$out" | head -n 1)
    REPLY=$(printf '%s\n' "$out" | tail -n +2 | jq -r '.text // .error // empty' 2>/dev/null)
    [ "$TURN_RC" = 200 ] && TURN_RC=0
  else
    # shellcheck disable=SC2016  # expanded on the board
    out=$(board '
      timeout 330 "$1" agent --agent main --session-key "$2" -m "$3" --json --timeout 320
    ' "$OPENCLAW_BIN" "$key" "$message")
    TURN_RC=$?
    REPLY=$(printf '%s\n' "$out" | sed -n '/^{/,$p' | jq -r '
      [ (.result.payloads // [])[]?.text, .result.text, .reply, .text ]
      | map(select(type == "string")) | join("\n")' 2>/dev/null)
  fi
}

# The pages titled TITLE, one vault path per line.
our_pages() {
  local q
  q=$(jq -rn --arg t "$NANO_RUN_ID" '$t | @uri')
  board_api GET "/setup-api/prime-radiant/pages?q=$q&limit=50"
  # shellcheck disable=SC2016  # $t is jq's
  api_json --arg t "$TITLE" '.pages[]? | select(.title == $t) | .path'
}

cleanup() {
  local p seg
  for p in $(our_pages); do
    seg=$(jq -rn --arg p "$p" '$p | split("/") | map(@uri) | join("/")')
    board_api DELETE "/setup-api/prime-radiant/pages/$seg"
    note "deleted $p (HTTP $API_STATUS)"
  done
}

# ---- the wiki the create writes into -------------------------------------------
board_api GET /setup-api/prime-radiant/status
if [ "$(api_json '.initialised')" != true ]; then
  # What opening the app does on a box with no vault yet.
  board_owner_api POST /setup-api/prime-radiant/init
  note "Prime Radiant had no vault: init answered HTTP $API_STATUS"
fi

# ---- how this board's Hermes treats a server that went away ---------------------
if [ "$RUNTIME" = hermes ]; then
  # shellcheck disable=SC2016  # expanded on the board
  board '
    "$HOME/.local/bin/hermes" --version 2>/dev/null | head -n 1
    f=$(find "$HOME/.hermes/hermes-agent" -path "*/tools/mcp_tool.py" 2>/dev/null | head -n 1)
    [ -n "$f" ] || exit 0
    grep -nE "lost its stdio|did not replay|reconnect|keepalive|_ping|idle" "$f" | head -n 30
  ' | while IFS= read -r line; do note "hermes: $line"; done
fi

# ---- 1. a turn opens the server --------------------------------------------------
BEFORE=$(servers)
WARM_KEY="nano-ci-$NANO_RUN_ID-idle-warm"
ask "$WARM_KEY" "Call the prime_radiant_status tool once and reply with only the number of pages it reports."
note "warm-up turn: rc $TURN_RC, reply: $(printf '%s' "$REPLY" | tr '\n' ' ' | head -c 200)"
AFTER=$(servers)
note "clawbox MCP servers before: $(printf '%s' "$BEFORE" | tr '\n' ';') after: $(printf '%s' "$AFTER" | tr '\n' ';')"

if [ "$RUNTIME" = hermes ]; then
  # The longest-lived server Hermes holds is the one its chat uses.
  HELD=$(printf '%s\n' "$AFTER" | awk '$2 == "hermes"' | sort -k3,3nr | head -n 1 | cut -d' ' -f1)
  if [ -z "$HELD" ]; then
    skip "no long-lived Hermes process holds a clawbox MCP server on this box (the chat ran a one-shot hermes chat)"
    finish
  fi
else
  # The server the gateway opened for this session key: the one that is new.
  HELD=$(comm -13 <(printf '%s\n' "$BEFORE" | cut -d' ' -f1 | sort) <(printf '%s\n' "$AFTER" | awk '$2 == "openclaw"' | cut -d' ' -f1 | sort) | head -n 1)
  if [ -z "$HELD" ]; then
    not_ok "the warm-up turn opened no clawbox MCP server under the OpenClaw gateway (rc $TURN_RC)"
    finish
  fi
fi
note "the server under test: pid $HELD"

ERR0=$(count_lines .hermes/logs/errors.log)
STDERR0=$(count_lines .hermes/logs/mcp-stderr.log)
START=$(date +%s)

# ---- 2. the box is left alone past the idle rule ----------------------------------
note "idle for ${IDLE_WAIT_S}s"
sleep "$IDLE_WAIT_S"

if [ "$RUNTIME" = hermes ]; then
  lines_after .hermes/logs/mcp-stderr.log "$STDERR0" | grep -F "[clawbox-mcp]" | tail -n 5 \
    | while IFS= read -r line; do note "mcp-stderr: $line"; done
  if alive "$HELD"; then
    ok "Hermes' clawbox MCP server (pid $HELD) is still running after ${IDLE_WAIT_S}s idle"
  else
    not_ok "Hermes' clawbox MCP server (pid $HELD) exited while idle; Hermes notices only once a call is in flight"
  fi
else
  # shellcheck disable=SC2016  # expanded on the board
  board 'journalctl -u clawbox-gateway.service --since "@$1" --no-pager -o cat 2>/dev/null | grep -E "clawbox-mcp|bundle-mcp" | tail -n 5' "$START" \
    | while IFS= read -r line; do note "gateway: $line"; done
  if alive "$HELD"; then
    not_ok "the session's clawbox MCP server (pid $HELD) still runs after ${IDLE_WAIT_S}s idle: OpenClaw's idle exit did not fire"
  else
    ok "the session's clawbox MCP server (pid $HELD) idle-exited under OpenClaw, as before"
  fi
fi

# ---- 3. the first call after the pause: one write ---------------------------------
if [ "$RUNTIME" = hermes ]; then KEY="nano-ci-$NANO_RUN_ID-idle-create"; else KEY=$WARM_KEY; fi
ask "$KEY" "Create a Prime Radiant page with the prime_radiant_page_create tool: type howto, title \"$TITLE\", domain facilities, summary \"A check page made by the on-device tests; it is deleted again.\". Call the tool exactly once. If the call fails, do not call it again and do not check anything: reply with the exact error text. If it works, reply with exactly: CREATED <the page path>"
note "create turn: rc $TURN_RC, reply: $(printf '%s' "$REPLY" | tr '\n' ' ' | head -c 300)"

if [ "$RUNTIME" = hermes ]; then
  LOST=$(lines_after .hermes/logs/errors.log "$ERR0" | grep -E "lost its stdio subprocess|did not replay" | tail -n 3)
  if [ -n "$LOST" ]; then
    while IFS= read -r line; do note "errors.log: $line"; done <<<"$LOST"
    not_ok "the first tool call after the pause found the server gone: $(printf '%s' "$LOST" | tail -n 1 | head -c 240)"
  else
    ok "errors.log has no lost-subprocess line for the first tool call after the pause"
  fi
fi

PAGES=$(our_pages)
N=$(printf '%s' "$PAGES" | grep -c .)
if [ "$N" -eq 1 ] && grep -qF "CREATED" <<<"$REPLY"; then
  ok "the first tool call after ${IDLE_WAIT_S}s idle created the page, once: $PAGES"
elif [ "$N" -eq 1 ]; then
  not_ok "the page exists once, but the assistant did not report the call as working: $(printf '%s' "$REPLY" | tr '\n' ' ' | head -c 240)"
else
  not_ok "the first tool call after ${IDLE_WAIT_S}s idle left $N page(s) titled \"$TITLE\" (want 1); reply: $(printf '%s' "$REPLY" | tr '\n' ' ' | head -c 240)"
fi

# ---- 4. Hermes without the idle exit: nothing piles up -----------------------------
if [ "$RUNTIME" = hermes ]; then
  HELD_BEFORE=$(servers | awk '$2 == "hermes"' | wc -l)
  for i in 1 2; do
    ask "nano-ci-$NANO_RUN_ID-idle-more-$i" "Call the prime_radiant_status tool once and reply with only the number of pages it reports."
    note "fresh conversation $i: rc $TURN_RC, reply: $(printf '%s' "$REPLY" | tr '\n' ' ' | head -c 120)"
  done
  HELD_AFTER=$(servers | awk '$2 == "hermes"' | wc -l)
  if [ "$HELD_AFTER" -le "$HELD_BEFORE" ]; then
    ok "two fresh conversations added no clawbox MCP server under Hermes ($HELD_BEFORE before, $HELD_AFTER after)"
  else
    not_ok "two fresh conversations took Hermes' clawbox MCP servers from $HELD_BEFORE to $HELD_AFTER"
  fi
fi

cleanup
finish
