#!/usr/bin/env bash
# Smoke test for the ClawBox MCP tools over JSON-RPC stdio.
#
#   bash mcp/test-tools.sh
#
# Run it ON A DEVICE (it needs the real filesystem, the real /setup-api and the
# real edition lock). It spawns a fresh MCP server per call, so it is slow but
# completely isolated.
#
# The SECURITY block at the bottom is the part that matters: every one of those
# cases must come back BLOCKED_PATH. They are the paths that leak the device's
# provider keys, OAuth tokens and SSH identity if a guard regresses.

set -uo pipefail
cd "$(dirname "$0")/.." || { echo "Failed to cd to project root"; exit 1; }

PASS=0
FAIL=0
SKIP=0

# Which tools exist here is edition-dependent, so ask the device rather than
# running every block and calling the absent half a failure.
EDITION=$(bun mcp/clawbox-cli.ts edition 2>/dev/null || echo openclaw)
[ "$EDITION" = "hermes" ] || EDITION=openclaw

call_tool() {
  local name="$1" params="$2" expect="${3:-ok}"   # ok | error | <ERROR_CODE>
  local result
  result=$(
    (
      echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
      sleep 0.3
      echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
      sleep 0.2
      echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$params}}"
      sleep 1.5
    ) | timeout 20 bun mcp/clawbox-mcp.ts 2>/dev/null | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        msg = json.loads(line.strip())
    except Exception:
        continue
    if msg.get('id') != 3:
        continue
    r = msg.get('result', msg.get('error', {}))
    text = ''
    if 'content' in r and r['content']:
        text = r['content'][0].get('text', '')
    elif 'message' in r:
        text = r['message']
    code = ''
    try:
        code = json.loads(text).get('code', '')
    except Exception:
        pass
    tag = 'ERROR' if (r.get('isError') or code) else 'OK'
    print(f'{tag}|{code}|' + text.replace(chr(10), ' ')[:90])
" 2>/dev/null
  )

  local status="${result%%|*}"
  local rest="${result#*|}"
  local code="${rest%%|*}"
  local text="${rest#*|}"

  local ok=false
  case "$expect" in
    ok)    [ "$status" = "OK" ] && ok=true ;;
    error) [ "$status" = "ERROR" ] && ok=true ;;
    *)     [ "$code" = "$expect" ] && ok=true ;;
  esac

  if [ -z "$status" ]; then
    printf "  \033[33m⊘\033[0m %-22s (no response — is the device web server running?)\n" "$name"
    SKIP=$((SKIP + 1))
  elif [ "$ok" = true ]; then
    printf "  \033[32m✓\033[0m %-22s %s\n" "$name" "${code:+[$code] }${text:0:60}"
    PASS=$((PASS + 1))
  else
    printf "  \033[31m✗\033[0m %-22s expected %s, got %s %s\n" "$name" "$expect" "${code:-$status}" "${text:0:60}"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "═══════════════════════════════════════════"
echo " ClawBox MCP smoke tests — $EDITION edition"
echo "═══════════════════════════════════════════"

echo ""
echo "── Orientation (both editions) ──"
call_tool "device_status"   '{}'
call_tool "clawbox_health"  '{}'
call_tool "clawbox_context" '{}'
call_tool "system_info"     '{}'
call_tool "update_check"    '{}'
call_tool "ui_list_apps"    '{}'

echo ""
echo "── Argument validation ──"
call_tool "ui_open_app"     '{"app_id":"no-such-app-xyz"}' NOT_FOUND
call_tool "preferences_set" '{"key":"ui_language","value":"klingon"}' BAD_ARGUMENT
# Schema rejections must come back as the BAD_ARGUMENT envelope, not as the
# SDK's raw zod issue array. And a small `lines` must simply work.
call_tool "logs_tail"       '{"unit":"clawbox-setup","lines":3}'
call_tool "logs_tail"       '{"unit":"clawbox-setup","lines":9999}' BAD_ARGUMENT
call_tool "system_power"    '{"action":"reboot"}' BAD_ARGUMENT

echo ""
if [ "$EDITION" = "openclaw" ]; then
echo "── SECURITY: every one of these must be BLOCKED_PATH ──"
call_tool "read_file"       '{"file_path":"~/.ssh/id_rsa"}' BLOCKED_PATH
call_tool "read_file"       '{"file_path":"~/.hermes/.env"}' BLOCKED_PATH
# Dotenv files, by name and by relative path. The project root is the default
# search root, so these have to be refused on the plain spelling too, not only
# on a fully-qualified one — and refused for writes as well as reads.
call_tool "read_file"       '{"file_path":".env"}' BLOCKED_PATH
call_tool "read_file"       '{"file_path":".env.local"}' BLOCKED_PATH
call_tool "write_file"      '{"file_path":".env","content":"X=1"}' BLOCKED_PATH
# bash's pre-flight is a guard rail, not a boundary (see mcp/tools/coding.ts).
# These pin the spellings it does recognise, including indirect ones.
call_tool "bash"            '{"command":"cat ${HOME}/.hermes/.env"}' BLOCKED_PATH
call_tool "bash"            '{"command":"D=.hermes; cat /home/clawbox/$D/.env"}' BLOCKED_PATH
call_tool "bash"            '{"command":"find /home/clawbox -maxdepth 2 -name .env -exec cat {} +"}' BLOCKED_PATH
call_tool "read_file"       '{"file_path":"data/.mcp-token"}' BLOCKED_PATH
call_tool "read_file"       '{"file_path":"data/config.json"}' BLOCKED_PATH
call_tool "read_file"       '{"file_path":"/proc/self/environ"}' BLOCKED_PATH
call_tool "write_file"      '{"file_path":"~/.ssh/authorized_keys","content":"x"}' BLOCKED_PATH
call_tool "list_directory"  '{"path":"~/.openclaw"}' BLOCKED_PATH
call_tool "grep"            '{"pattern":".","path":"~/.hermes"}' BLOCKED_PATH
call_tool "grep"            '{"pattern":".","path":"~/.openclaw"}' BLOCKED_PATH
call_tool "glob"            '{"pattern":"*","path":"~/.ssh"}' BLOCKED_PATH
call_tool "bash"            '{"command":"cat ~/.ssh/id_rsa"}' BLOCKED_PATH
call_tool "notebook_edit"   '{"notebook_path":"~/.hermes/x.ipynb","cell_index":0,"new_source":"x"}' BLOCKED_PATH
call_tool "web_fetch"       '{"url":"http://127.0.0.1/setup-api/system/info"}' BLOCKED_PATH

echo ""
echo "── File tools ──"
call_tool "read_file"       '{"file_path":"package.json","limit":2}'
call_tool "read_file"       '{"file_path":"/definitely/not/here"}' NOT_FOUND
call_tool "write_file"      '{"file_path":"/tmp/mcp-smoke.txt","content":"line1\nline2\nline3"}'
call_tool "edit_file"       '{"file_path":"/tmp/mcp-smoke.txt","old_text":"line2","new_text":"EDITED"}'
call_tool "edit_file"       '{"file_path":"/tmp/mcp-smoke.txt","old_text":"line2","new_text":"EDITED"}' NOT_FOUND
call_tool "list_directory"  '{"path":"mcp"}'
call_tool "glob"            '{"pattern":"*.ts","path":"mcp"}'
call_tool "grep"            '{"pattern":"McpServer","path":"mcp","output_mode":"files_with_matches"}'
call_tool "grep"            '{"pattern":"ZZZNOMATCH","path":"mcp"}'
# A search whose include pattern targets dotenv files must come back empty: hits
# are filtered per RESULT, not only by checking the search root.
call_tool "grep"            '{"pattern":"[A-Z_]+=","include":"*.env"}'

echo ""
echo "── Shell + background jobs ──"
call_tool "bash"            '{"command":"echo hello"}'
call_tool "bash"            '{"command":"rm -rf /tmp/anything"}' DANGEROUS_COMMAND
call_tool "job_status"      '{"job_id":"job-999"}' NOT_FOUND
fi

if [ "$EDITION" = "hermes" ]; then
echo "── Hermes skills and AI configuration ──"
call_tool "skill_list"      '{}'
call_tool "skill_search"    '{"query":"pdf","limit":3}'
call_tool "skill_info"      '{"id":"not a valid id!!"}' BAD_ARGUMENT
call_tool "skill_uninstall" '{"name":"official/pdf"}' BAD_ARGUMENT
call_tool "ai_list_models"  '{}'
fi

echo ""
echo "═══════════════════════════════════════════"
printf " Results: \033[32m%d passed\033[0m" "$PASS"
[ "$FAIL" -gt 0 ] && printf ", \033[31m%d failed\033[0m" "$FAIL"
[ "$SKIP" -gt 0 ] && printf ", \033[33m%d skipped/not-on-this-edition\033[0m" "$SKIP"
echo ""
echo "═══════════════════════════════════════════"

rm -f /tmp/mcp-smoke.txt

exit "$FAIL"
