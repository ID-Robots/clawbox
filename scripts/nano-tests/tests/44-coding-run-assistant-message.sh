#!/usr/bin/env bash
# timeout: 600
# covers: src/lib/coding-run-report.ts src/app/setup-api/coding-agent/run-report/route.ts
# covers: mcp/tools/coding-agent.ts mcp/lib/run-context.ts
#
# A single coding run can tell the assistant that started it something while
# it is still working (`assistant_message`, kind question | blocker | milestone):
#
#   - the run is started the way the assistant starts one (the MCP bearer, so
#     source "agent") and is told to send one milestone with a token, write the
#     tool's answer into result.txt and finish;
#   - its page must show "Message to the assistant (milestone): <token>";
#   - OpenClaw: with no chat recorded for the run the message goes to the
#     owner's main conversation, and the gateway's store must hold it under
#     the run's fixed frame "[Coding run <id> · milestone]";
#   - Hermes: a run no Hermes chat asked for has no chat to tell, so the tool
#     must refuse in words that say so, and the run still completes.
#
# Authenticated with the board's MCP bearer, read on the board (lib.sh `api`).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent status did not answer: $(api_error)"
  finish
fi
if [ "$(api_json '.enabled')" != true ] || [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a run here: $(api_json -c '{enabled, ready}')"
  finish
fi
if ! fresh_project_dir "-assistant-message"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi

board_api GET /setup-api/harness/active
EDITION=$(api_json -r '.active // empty')
[ -n "$EDITION" ] || EDITION=openclaw
note "agent runtime: $EDITION"

TOKEN="ASSISTANT-MSG-$NANO_SERIAL-$(date +%s)"
TASK="Call your assistant_message tool exactly once, with kind \"milestone\" and text \"$TOKEN\".
Then write the tool's whole answer, exactly as it came back (an error included), into a file named result.txt in this folder.
Then end. Do not change any other file, do not run a build or a server."

if ! start_coding_run "$TASK"; then
  not_ok "the run did not start: HTTP $API_STATUS $(api_error)"
  remove_project_dir
  finish
fi
ok "run $RUN_ID started (HTTP 202)"

wait_coding_run 480
expect_completed
PROGRESS=$(api_json -r '.run.progress // [] | join("\n")')
# shellcheck disable=SC2016  # expanded on the board
RESULT=$(board '
  cd "$1"
  for f in result.txt .clawbox/worktrees/"$2"/result.txt; do [ -f "$f" ] && { cat "$f"; exit 0; }; done
  b=$(git for-each-ref --format="%(refname:short)" "refs/heads/clawbox/$2" 2>/dev/null | head -n1)
  [ -n "$b" ] && git show "$b:result.txt" 2>/dev/null
' "$PROJECT_DIR" "$RUN_ID" 2>/dev/null)
note "result.txt: $(printf '%s' "$RESULT" | tr '\n' ' ' | head -c 300)"

if [ "$EDITION" = hermes ]; then
  if printf '%s' "$RESULT" | grep -qi "not started from a ClawBox chat\|UNSUPPORTED"; then
    ok "Hermes, no chat asked for the run: the tool refused in words that say there is no chat to tell"
  else
    not_ok "Hermes: expected the no-chat refusal in result.txt"
  fi
else
  if printf '%s' "$PROGRESS" | grep -qF "Message to the assistant (milestone): $TOKEN"; then
    ok "the run's page shows its message to the assistant"
  else
    not_ok "no 'Message to the assistant (milestone): $TOKEN' line on the run's page"
  fi
  if printf '%s' "$RESULT" | grep -qi "Posted into the assistant's chat"; then
    ok "the tool answered that the message was posted into the assistant's chat"
  else
    not_ok "the tool did not say the message was posted into the assistant's chat"
  fi
  # The gateway keeps its sessions under the agent's state dir (files or its
  # sqlite store); the frame and the token must be there, together.
  # shellcheck disable=SC2016  # expanded on the board
  SEEN=$(board '
    d="$HOME/.openclaw/agents/main"
    for i in $(seq 1 12); do
      if grep -raF -- "[Coding run $1 · milestone] $2" "$d" >/dev/null 2>&1; then echo yes; exit 0; fi
      sleep 5
    done
    echo no
  ' "$RUN_ID" "$TOKEN")
  if [ "$SEEN" = yes ]; then
    ok "the assistant's conversation holds the message under the run's frame"
  else
    not_ok "the message is not in the assistant's conversation"
  fi
fi

remove_project_dir
finish
