#!/bin/bash
# TASK-1069 on-box benchmark. Runs as the clawbox user on a bench Nano.
# Usage: run-box.sh <out-dir>   (needs BENCH_SUDO_PW in env for the gateway restarts)
set -u
OUT=${1:-/tmp/mcp-bench}; mkdir -p "$OUT"
export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH
SERIAL=$(tr -d '\0' </proc/device-tree/serial-number)
STORE=$HOME/clawbox/data/config.json
log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$OUT/run.log"; }
now() { date +%s.%N; }
sudo_() { echo "$BENCH_SUDO_PW" | sudo -S -p "" "$@"; }

log "box serial=$SERIAL openclaw=$(openclaw --version 2>/dev/null | head -1) clawbox=$(grep '"version"' ~/clawbox/package.json | head -1)"
python3 - "$OUT/box.json" "$SERIAL" <<'EOF'
import json,sys,subprocess
c=json.load(open("/home/clawbox/.openclaw/openclaw.json"))
p=(c.get("agents",{}).get("defaults",{}).get("model") or {}).get("primary")
json.dump({"serial":sys.argv[2],"model":p,"mcpRegistered":"clawbox" in (c.get("mcp",{}).get("servers") or {}),
 "gatewayPid":subprocess.run(["systemctl","show","clawbox-gateway","-p","MainPID","--value"],capture_output=True,text=True).stdout.strip()},open(sys.argv[1],"w"))
EOF

# ── 1. cold probes through OpenClaw's own MCP doctor ─────────────────────
log "1/5 cold probes"
: > "$OUT/probes.txt"
for i in 1 2 3 4 5; do s=$(now); openclaw mcp doctor clawbox --probe >/dev/null 2>&1; rc=$?; echo "$i rc=$rc wall=$(echo "$(now) - $s" | bc)" >> "$OUT/probes.txt"; done
cat "$OUT/probes.txt" | tee -a "$OUT/run.log"

# ── 2. direct MCP client: tools/list size, per-tool latency, RSS ─────────
log "2/5 direct MCP bench"
(cd ~/clawbox && bun "$OUT/mcp-direct.ts" > "$OUT/direct.json" 2> "$OUT/direct.err"); log "direct rc=$? $(head -c 200 "$OUT/direct.json")"

# ── 3+4. model-in-the-loop turns, MCP on then off ────────────────────────
PROMPTS=(
 "hi"
 "hi"
 "hi"
 "What is the CPU temperature and memory usage of this device right now?"
 "List the files in your home folder."
 "Create a file named bench-note.txt in your home folder containing the line 'hello from bench', then show me its contents."
 "Find files ending in .md under your home folder and show me the first five paths."
 "Run the command uname -a and tell me the kernel version."
 "Add the line 'bench was here' to the USER.md file in your workspace folder, then read the file back to confirm."
 "Fetch https://example.com/ and tell me the page title."
)
turns() {
  local mode=$1; local f="$OUT/turns-$mode.jsonl"; : > "$f"
  local i=0
  for p in "${PROMPTS[@]}"; do
    i=$((i+1)); local key="bench-$mode-$i-$(date +%s)"
    local s=$(now)
    timeout 420 openclaw agent --agent main --session-key "$key" -m "$p" --json --timeout 400 > /tmp/turn.json 2> /tmp/turn.err
    local rc=$?; local wall=$(echo "$(now) - $s" | bc)
    python3 - "$mode" "$i" "$p" "$rc" "$wall" /tmp/turn.json /tmp/turn.err >> "$f" <<'EOF'
import json,sys
mode,i,prompt,rc,wall,jf,ef=sys.argv[1:]
row={"mode":mode,"i":int(i),"prompt":prompt,"rc":int(rc),"wallS":round(float(wall),2)}
try:
    d=json.load(open(jf)); r=d.get("result") or {}; m=r.get("meta") or {}; a=m.get("agentMeta") or {}
    row.update({"status":d.get("status"),"final":"".join(p.get("text","") for p in (r.get("payloads") or []))[:300],
      "durationMs":m.get("durationMs"),"usage":a.get("usage"),"promptTokens":a.get("promptTokens"),
      "estimatedPromptTokens":(a.get("contextBudgetStatus") or {}).get("estimatedPromptTokens"),
      "model":a.get("model"),"provider":a.get("provider"),"assistantTurns":a.get("assistantTurns"),
      "tools":(a.get("terminalReceipt") or {}).get("successfulToolNames"),"toolSummary":m.get("toolSummary") or a.get("toolSummary"),
      "error":(d.get("error") or {}).get("message") if isinstance(d.get("error"),dict) else d.get("error")})
except Exception as e:
    row["parseError"]=str(e)[:120]; row["stderr"]=open(ef).read()[-300:]
print(json.dumps(row))
EOF
    log "turn $mode #$i rc=$rc wall=${wall}s $(tail -1 "$f" | python3 -c 'import json,sys;d=json.loads(sys.stdin.read());u=d.get("usage") or {};print("in=%s out=%s tools=%s err=%s"%(u.get("input"),u.get("output"),d.get("tools"),(d.get("error") or "")[:60]))')"
    ps -eo pid,rss,etimes,args | grep clawbox-mcp | grep -v grep | sed "s/^/mcp-proc after turn $i: /" >> "$OUT/run.log"
  done
}
mcp_switch() { # on|off through the product's own switch, then a gateway restart so pre-start applies it
  python3 - "$STORE" "$1" <<'EOF'
import json,sys
p,mode=sys.argv[1:]; c=json.load(open(p))
if mode=="off": c["clawbox_mcp_enabled"]=False
else: c.pop("clawbox_mcp_enabled",None)
json.dump(c,open(p,"w"))
EOF
  sudo_ systemctl restart clawbox-gateway; sleep 20
  python3 -c "import json;c=json.load(open('/home/clawbox/.openclaw/openclaw.json'));print('mcp registered:', 'clawbox' in (c.get('mcp',{}).get('servers') or {}))" | tee -a "$OUT/run.log"
}
log "3/5 turns with MCP ON"; turns on
log "4/5 switching MCP OFF"; mcp_switch off
turns off
log "restoring MCP ON"; mcp_switch on
rm -f ~/bench-note.txt ~/mcp-bench-note.txt
# ── 5. done ───────────────────────────────────────────────────────────────
log "5/5 done"; echo done > "$OUT/DONE"
