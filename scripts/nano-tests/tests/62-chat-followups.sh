#!/usr/bin/env bash
# timeout: 300
# parallel: probes
# covers: mcp/tools/email.ts mcp/tools/system.ts mcp/tools/coding-agent.ts mcp/tools/desktop.ts install.sh config/default-skills/clawbox-handbook/SKILL.md
#
# Telegram-first follow-ups on the real box:
#   - the document libraries the agent uses for "make me a quote / a letter / a
#     spreadsheet" are importable by the box's python3 without a pip install
#     (python-docx, openpyxl, reportlab — install.sh's apt step);
#   - the box's own MCP server offers email_connect and update_run;
#   - email_connect refuses to touch a box that already has a mail account (run
#     only on such a box; on one without an account it would really connect).
# Read-only: update_run is never called (it would raise an owner question), and
# email_connect is only called where it must refuse.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

LIBS=$(board 'python3 -c "import docx, openpyxl, reportlab; print(\"libs-ok\")" 2>&1 | tail -n 1')
if [ "$LIBS" = libs-ok ]; then
  ok "python3 imports docx, openpyxl and reportlab"
else
  not_ok "document libraries missing: $(printf '%s' "$LIBS" | head -c 200)"
fi

# shellcheck disable=SC2016  # JavaScript, not shell
SESSION='
(async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["run", "mcp/clawbox-mcp.ts"], cwd: process.cwd(), stderr: "ignore" });
  const client = new Client({ name: "nano-ci", version: "1.0.0" });
  await client.connect(transport);
  const text = (r) => (Array.isArray(r.content) && r.content[0] && r.content[0].type === "text" ? r.content[0].text : "");
  const out = { names: (await client.listTools()).tools.map((t) => t.name) };
  if (process.argv.includes("--configured") && out.names.includes("email_connect")) {
    const r = await client.callTool({ name: "email_connect", arguments: { address: "nano-ci@example.invalid", app_password: "not-a-real-password", mode: "send", confirm: true } });
    out.connect = { isError: r.isError === true, text: text(r) };
  }
  console.log(JSON.stringify(out));
  await client.close();
  process.exit(0);
})().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
'

board_api GET /setup-api/email/status
CONFIGURED=$(api_json '.configured')
[ -n "$CONFIGURED" ] || CONFIGURED=unknown
FLAG=""
[ "$CONFIGURED" = true ] && FLAG="--configured"
# shellcheck disable=SC2016  # expanded on the board
RAW=$(board 'cd "$REPO" && exec timeout 180 bun -e "$1" -- $2' "$SESSION" "$FLAG")
ANSWER=$(printf '%s\n' "$RAW" | grep '^{' | tail -n 1)
if [ -z "$ANSWER" ] || ! printf '%s' "$ANSWER" | jq -e . >/dev/null 2>&1; then
  not_ok "the MCP session did not answer: $(printf '%s' "$RAW" | tail -n 3 | tr '\n' ' ' | head -c 300)"
  finish
fi
j() { printf '%s' "$ANSWER" | jq -r "$@" 2>/dev/null; }

for name in update_run update_check email_connect email_send coding_agent_run webapp_create; do
  # shellcheck disable=SC2016  # $n is jq's
  if j --arg n "$name" '.names | index($n) != null' | grep -qx true; then
    ok "the MCP server lists $name"
  else
    case "$name" in
      email_*|coding_agent_run) skip "$name is not offered on this box (feature probe off)" ;;
      *) not_ok "the MCP server does not list $name" ;;
    esac
  fi
done

if [ "$CONFIGURED" = true ]; then
  if [ "$(j '.connect.isError')" = true ] && j '.connect.text' | grep -qi "already connected"; then
    ok "email_connect refuses to replace the connected account"
  else
    not_ok "email_connect did not refuse on a box with an account: $(j '.connect.text' | head -c 200)"
  fi
else
  skip "no mail account on this box (email/status configured=$CONFIGURED); email_connect is not called"
fi
finish
