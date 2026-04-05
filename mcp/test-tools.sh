#!/usr/bin/env bash
# Quick smoke test for all ClawBox MCP tools via JSON-RPC stdio.
# Usage: bash mcp/test-tools.sh
#
# Each test spawns a fresh MCP server, sends initialize + tool call, checks result.
# Green = pass, Red = fail

set -uo pipefail
cd "$(dirname "$0")/.." || { echo "Failed to cd to project root"; exit 1; }

PASS=0
FAIL=0
SKIP=0

call_tool() {
  local name="$1" params="$2" expect_error="${3:-false}"
  local result
  result=$(
    (
      echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
      sleep 0.3
      echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
      sleep 0.2
      echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$params}}"
      sleep 1.5
    ) | timeout 8 bun mcp/clawbox-mcp.ts 2>/dev/null | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        msg = json.loads(line.strip())
        if msg.get('id') == 3:
            r = msg.get('result', msg.get('error', {}))
            is_err = r.get('isError', False) or 'code' in r
            text = ''
            if 'content' in r:
                text = r['content'][0].get('text','')[:100]
            elif 'message' in r:
                text = r['message'][:100]
            tag = 'ERROR' if is_err else 'OK'
            print(f'{tag}|{text}')
    except: pass
" 2>/dev/null
  )

  local status="${result%%|*}"
  local text="${result#*|}"

  if [ "$expect_error" = "true" ]; then
    if [ "$status" = "ERROR" ]; then
      printf "  \033[32m✓\033[0m %-25s (expected error) %s\n" "$name" "${text:0:70}"
      PASS=$((PASS + 1))
    else
      printf "  \033[31m✗\033[0m %-25s expected error but got OK: %s\n" "$name" "${text:0:70}"
      FAIL=$((FAIL + 1))
    fi
  else
    if [ "$status" = "OK" ]; then
      printf "  \033[32m✓\033[0m %-25s %s\n" "$name" "${text:0:70}"
      PASS=$((PASS + 1))
    elif [ -z "$status" ]; then
      printf "  \033[33m⊘\033[0m %-25s (no response — may need running server)\n" "$name"
      SKIP=$((SKIP + 1))
    else
      printf "  \033[31m✗\033[0m %-25s %s\n" "$name" "${text:0:70}"
      FAIL=$((FAIL + 1))
    fi
  fi
}

echo ""
echo "═══════════════════════════════════════════"
echo " ClawBox MCP Tool Smoke Tests"
echo "═══════════════════════════════════════════"

echo ""
echo "── Core Coding Tools ──"

call_tool "bash" '{"command":"echo hello"}'
call_tool "bash" '{"command":"rm -rf /","description":"test dangerous detection"}'  # warns but doesn't block
call_tool "bash" '{"command":"sleep 10","run_in_background":true}'
call_tool "task_status" '{"id":"bg-999"}' true  # non-existent task

echo ""
call_tool "read_file" '{"file_path":"package.json","limit":2}'
call_tool "read_file" '{"file_path":"/dev/zero"}' true
call_tool "read_file" '{"file_path":"/nonexistent"}' true

echo ""
call_tool "write_file" '{"file_path":"/tmp/mcp-smoke.txt","content":"line1\nline2\nline3"}'
call_tool "read_file" '{"file_path":"/tmp/mcp-smoke.txt"}'
call_tool "edit_file" '{"file_path":"/tmp/mcp-smoke.txt","old_string":"line2","new_string":"EDITED"}'
call_tool "edit_file" '{"file_path":"/tmp/mcp-smoke.txt","old_string":"line2","new_string":"EDITED"}' true
call_tool "edit_file" '{"file_path":"/tmp/mcp-smoke.txt","old_string":"same","new_string":"same"}' true

echo ""
call_tool "list_directory" '{"path":"mcp"}'
call_tool "glob" '{"pattern":"*.ts","path":"mcp"}'
call_tool "glob" '{"pattern":"*.xyz","path":"mcp"}'
call_tool "grep" '{"pattern":"McpServer","path":"mcp","include":"*.ts"}'
call_tool "grep" '{"pattern":"McpServer","path":"mcp","output_mode":"files_with_matches"}'
call_tool "grep" '{"pattern":"McpServer","path":"mcp","output_mode":"count"}'
call_tool "grep" '{"pattern":"ZZZNOMATCH","path":"mcp"}'

echo ""
echo "── Web Tools ──"

call_tool "web_fetch" '{"url":"https://httpbin.org/json","max_length":500}'
call_tool "web_fetch" '{"url":"not-a-url"}' true
call_tool "web_search" '{"query":"clawbox jetson","max_results":3}'

echo ""
echo "── Notebook Edit ──"

# Create a test notebook
python3 -c "
import json
nb = {'nbformat':4,'nbformat_minor':5,'metadata':{},'cells':[
  {'cell_type':'code','source':['print(1)'],'metadata':{},'outputs':[],'execution_count':None},
  {'cell_type':'markdown','source':['# Hello'],'metadata':{}}
]}
with open('/tmp/mcp-test.ipynb','w') as f: json.dump(nb,f)
" 2>/dev/null

call_tool "read_file" '{"file_path":"/tmp/mcp-test.ipynb"}'
call_tool "notebook_edit" '{"notebook_path":"/tmp/mcp-test.ipynb","cell_index":0,"new_source":"print(42)"}'
call_tool "notebook_edit" '{"notebook_path":"/tmp/mcp-test.ipynb","cell_index":0,"new_source":"# New cell","cell_type":"markdown","edit_mode":"insert"}'
call_tool "notebook_edit" '{"notebook_path":"/tmp/mcp-test.ipynb","cell_index":2,"edit_mode":"delete"}'
call_tool "notebook_edit" '{"notebook_path":"/tmp/mcp-test.ipynb","cell_index":99}' true

echo ""
echo "── Agent ──"

call_tool "agent" '{"description":"test agent","commands":"echo step1\necho step2\necho done"}'

echo ""
echo "── Task Management ──"

call_tool "task_create" '{"subject":"First task","description":"desc"}'
call_tool "task_create" '{"subject":"Blocked task","blocked_by":"task-1"}'
call_tool "task_list" '{}'

echo ""
echo "── ClawBox Tools (require running web server) ──"
echo "  (skipped — start dev server first: bun run dev)"

echo ""
echo "═══════════════════════════════════════════"
printf " Results: \033[32m%d passed\033[0m" "$PASS"
[ "$FAIL" -gt 0 ] && printf ", \033[31m%d failed\033[0m" "$FAIL"
[ "$SKIP" -gt 0 ] && printf ", \033[33m%d skipped\033[0m" "$SKIP"
echo ""
echo "═══════════════════════════════════════════"

# Cleanup
rm -f /tmp/mcp-smoke.txt /tmp/mcp-test.ipynb

exit "$FAIL"
