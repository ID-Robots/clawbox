#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/project-mcp-servers.ts src/lib/clawbox-run-read-tools.ts src/app/setup-api/coding-agent/mcp-servers/*
# covers: mcp/lib/register.ts mcp/lib/profile.ts mcp/clawbox-mcp.ts src/components/CodingProjectMcpServersCard.tsx
#
# A project's MCP servers reaching a real delegated run (src/lib/project-mcp-servers.ts):
#
#   1. A stand-in board server is registered with the board's OWN harness, the
#      native way (`openclaw mcp set`), carrying a token in its env.
#   2. The owner's checklist (GET /setup-api/coding-agent/mcp-servers) lists it,
#      unticked, and never the token; the MCP bearer may not tick it; the owner
#      ticks it and "ClawBox read-only tools" for a fresh code project.
#   3. A run in that project must call the board's tool and `device_status`:
#      while it runs, the Coding Agent app itself — /app/coding, rendered in a
#      headless Chromium of the box's own with an owner session, the run opened
#      through the app's own open-run event — shows the run live with both
#      servers in its timeline; its record names them; and the harness's argv
#      has --strict-mcp-config and --mcp-config <a 0600 file> with no token in
#      it. The board's tool answers only after 30 s, so the run is still live
#      while all of that is looked at.
#   4. It completes with the value only the board's tool could have told it on
#      disk, and the token is in no run record, history or evidence file, and
#      the config file is gone.
#
# NOT `parallel:` — step 1 changes the harness's config. Everything is undone on
# the way out, ticked or not. The token, the owner's cookie and the bearer exist
# only on the board. Skipped on an edition without OpenClaw: the Hermes reader
# is covered by src/tests/unit/coding-agent-mcp-servers.test.ts.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ] || [ "$(api_json '.enabled')" != true ] || [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a run on this board: $(api_error) $(api_json -c '.readiness' | head -c 200)"
  finish
fi
board_api GET /setup-api/harness/mcp
if [ "$(api_json '.registered.openclaw')" = null ] || [ -z "$(api_json '.registered.openclaw')" ]; then
  skip "no OpenClaw on this edition (registered.openclaw is null)"
  finish
fi

# shellcheck disable=SC2016  # expanded on the board, not here
FLOW='
say() { printf "RESULT %s\n" "$*"; }
SECRET_FILE="$REPO/data/.session-secret"
RAND=$(tr -dc a-z0-9 </dev/urandom | head -c 8)
NAME="nanoboard$RAND"
PID="nano-ci-mcp-$RAND"
TOKEN="nanoci-fixture-$(tr -dc a-z0-9 </dev/urandom | head -c 24)"
MARKER="NB-$(tr -dc A-Z0-9 </dev/urandom | head -c 10)"
STUB_DIR=$(mktemp -d /tmp/nano-ci-mcp-XXXXXX)
SDK="$REPO/node_modules/@modelcontextprotocol/sdk/dist/esm"
NODE=$(command -v node)
RUN_ID=""

owner_cookie() {
  node -e "
    const fs = require(\"fs\"), crypto = require(\"crypto\");
    const secret = fs.readFileSync(process.argv[1], \"utf8\").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1800, gen })).toString(\"base64url\");
    process.stdout.write(payload + \".\" + crypto.createHmac(\"sha256\", secret).update(payload).digest(\"hex\"));
  " "$SECRET_FILE" "$REPO/data/config.json"
}
# call METHOD PATH COOKIE [BODY]: status on the first line, body after; the cookie on curl stdin.
call() {
  local method=$1 path=$2 cookie=$3 body=${4:-} out code extra=()
  [ -n "$body" ] && extra=(-H "Content-Type: application/json" --data-binary "$body")
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$cookie" \
    | curl -sS -o "$out" -w "%{http_code}" -X "$method" --max-time 120 "${extra[@]}" -K - "$DASHBOARD$path" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}
status_of() { printf "%s\n" "$1" | head -n1; }
body_of() { printf "%s\n" "$1" | tail -n +2; }
# py EXPR: evaluate EXPR with the JSON on stdin as j; prints the result (True/False/a value).
py() { python3 -c "import json,sys; j=json.load(sys.stdin); a=sys.argv[2:]; print(eval(sys.argv[1]))" "$@" 2>/dev/null; }

cleanup() {
  [ -n "${OWNER:-}" ] && call POST /setup-api/coding-agent/mcp-servers "$OWNER" "{\"project\":\"$PID\",\"servers\":[]}" >/dev/null 2>&1
  openclaw mcp unset "$NAME" >/dev/null 2>&1
  api POST /setup-api/code "{\"action\":\"delete-project\",\"projectId\":\"$PID\"}" >/dev/null 2>&1
  rm -rf -- "$STUB_DIR"
}
trap cleanup EXIT

if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi
if [ ! -f "$SDK/server/mcp.js" ] || [ -z "$NODE" ]; then say "not ok - no node or no MCP SDK in the checkout to run the stand-in board"; exit 0; fi
OWNER=$(owner_cookie)

# 1. The stand-in board: one read tool, answering the marker it was started with.
cat > "$STUB_DIR/board.mjs" <<"EOF"
const [marker, sdk] = process.argv.slice(2);
const { McpServer } = await import(sdk + "/server/mcp.js");
const { StdioServerTransport } = await import(sdk + "/server/stdio.js");
const server = new McpServer({ name: "nanoboard", version: "1.0.0" });
server.registerTool("nano_board_read", { description: "Read the project board: the ids of its open tasks." }, async () => {
  // A slow board, on purpose: the run stays live while the app is looked at.
  await new Promise((resolve) => setTimeout(resolve, 30000));
  return { content: [{ type: "text", text: JSON.stringify({ tasks: [marker], signedIn: (process.env.BOARD_TOKEN || "").length > 0 }) }] };
});
await server.connect(new StdioServerTransport());
EOF
# The Coding Agent app, as the owner sees it: a headless Chromium of the box
# own (the one the browser route launches), a context of its own with the
# owner cookie, /app/coding, the run opened by the app open-run event.
cat > "$STUB_DIR/app-check.cjs" <<"EOF"
const { chromium } = require("playwright");
const [runId, name, exe] = process.argv.slice(2);
const out = (line) => process.stdout.write(line + "\n");
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: "clawbox_session", value: process.env.OWNER_COOKIE, url: "http://127.0.0.1" }]);
    const page = await context.newPage();
    await page.goto("http://127.0.0.1/app/coding", { waitUntil: "domcontentloaded", timeout: 60000 });
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent("clawbox:open-coding-run", { detail: { runId: id } })), runId);
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body ? document.body.innerText : "");
      const status = await page.evaluate(async (id) => {
        const r = await fetch("/setup-api/coding-agent/runs?id=" + encodeURIComponent(id), { cache: "no-store" });
        return r.ok ? (await r.json()).run.status : "http-" + r.status;
      }, runId);
      const line = text.split("\n").find((l) => l.includes(name) && l.includes("ClawBox read-only tools"));
      const card = await page.locator("[data-testid=coding-agent-live-card]").count();
      if (line && status === "running" && card > 0) {
        out("APP live " + line.trim().slice(0, 160));
        return;
      }
      if (status !== "running") {
        out("APP settled-before-seen status=" + status + " line=" + (line ? "yes" : "no") + " card=" + card);
        return;
      }
    }
    out("APP not-seen");
  } finally {
    await browser.close();
  }
})().catch((err) => out("APP error " + String((err && err.message) || err).slice(0, 200)));
EOF
EXE=$(find "$HOME/.cache/ms-playwright" -maxdepth 4 -type f \( -name headless_shell -o -name chrome \) -perm -u+x 2>/dev/null | sort -V | tail -n 1)

ENTRY=$(python3 -c "import json,sys; print(json.dumps({\"command\": sys.argv[1], \"args\": [sys.argv[2], sys.argv[3], sys.argv[4]], \"env\": {\"BOARD_TOKEN\": sys.argv[5]}}))" "$NODE" "$STUB_DIR/board.mjs" "$MARKER" "$SDK" "$TOKEN")
if openclaw mcp set "$NAME" "$ENTRY" >/dev/null 2>&1; then say "ok - registered a stand-in board server with the harness (openclaw mcp set)"; else say "not ok - openclaw mcp set refused the stand-in server"; exit 0; fi

r=$(api POST /setup-api/code "{\"action\":\"init\",\"projectId\":\"$PID\",\"name\":\"$PID\"}")
if [ "$(status_of "$r")" != 200 ]; then say "not ok - the code project could not be made: HTTP $(status_of "$r")"; exit 0; fi
PROJECT_PATH=$(body_of "$r" | py "j.get(\"path\", \"\")")

# 2. The checklist.
r=$(call GET "/setup-api/coding-agent/mcp-servers?project=$PID" "$OWNER")
b=$(body_of "$r")
if [ "$(status_of "$r")" = 200 ] && [ "$(printf "%s" "$b" | py "any(o[\"id\"] == a[0] and o[\"usable\"] for o in j[\"options\"]) and j[\"selected\"] == []" "$NAME")" = True ]; then
  say "ok - the checklist lists the harness server, usable and unticked"
else
  say "not ok - the checklist did not list $NAME usable and unticked: HTTP $(status_of "$r") $(printf "%s" "$b" | head -c 300)"
fi
case "$b" in *"$TOKEN"*) say "not ok - the checklist answer carries the server token" ;; *) say "ok - the checklist names servers and never the token" ;; esac
r=$(api POST /setup-api/coding-agent/mcp-servers "{\"project\":\"$PID\",\"servers\":[\"$NAME\"]}")
[ "$(status_of "$r")" = 403 ] && say "ok - the MCP bearer may not tick a server" || say "not ok - the MCP bearer ticking a server answered HTTP $(status_of "$r")"
r=$(call POST /setup-api/coding-agent/mcp-servers "$OWNER" "{\"project\":\"$PID\",\"servers\":[\"$NAME\",\"clawbox\"]}")
if [ "$(status_of "$r")" = 200 ] && [ "$(body_of "$r" | py "sorted(j[\"selected\"]) == sorted([a[0], \"clawbox\"])" "$NAME")" = True ]; then
  say "ok - the owner ticked the board and ClawBox read-only tools"
else
  say "not ok - the owner could not tick them: HTTP $(status_of "$r") $(body_of "$r" | head -c 300)"; exit 0
fi

# 3. The run.
TASK="Call the MCP tool nano_board_read (from the $NAME MCP server) and the MCP tool device_status (from the clawbox MCP server). Then create a file named board.txt in the current working folder whose entire content is exactly the first task id that nano_board_read returned, and nothing else. Do not create, change or delete any other file, do not run a build or a server, and do not open a browser. Say done when the file is written."
BODY=$(python3 -c "import json,sys; print(json.dumps({\"task\": sys.argv[1], \"projectId\": sys.argv[2]}))" "$TASK" "$PID")
r=$(api POST /setup-api/coding-agent/run "$BODY")
RUN_ID=$(body_of "$r" | py "j[\"run\"][\"id\"]")
if [ "$(status_of "$r")" != 202 ] || [ -z "$RUN_ID" ] || [ "$RUN_ID" = None ]; then say "not ok - the run did not start: HTTP $(status_of "$r") $(body_of "$r" | head -c 300)"; exit 0; fi
say "ok - run $RUN_ID started in $PID"
# One deadline for the watch and the wait, well inside the 900 s of the test,
# so the cleanup on the way out always runs.
RUN_END=$(( $(date +%s) + 600 ))
APP_OUT="$STUB_DIR/app.out"
APP_PID=""
if [ -n "$EXE" ]; then
  OWNER_COOKIE="$OWNER" NODE_PATH="$REPO/node_modules" timeout 240 node "$STUB_DIR/app-check.cjs" "$RUN_ID" "$NAME" "$EXE" > "$APP_OUT" 2>&1 &
  APP_PID=$!
else
  echo "APP no-chromium" > "$APP_OUT"
fi

# While it runs: the record the app polls, and the harness argv.
LIVE=""; ARGV=""
while [ "$(date +%s)" -lt "$RUN_END" ]; do
  r=$(api GET "/setup-api/coding-agent/runs?id=$RUN_ID")
  NOW_STATUS=$(body_of "$r" | py "j[\"run\"][\"status\"]")
  if [ -z "$LIVE" ]; then
    LIVE=$(body_of "$r" | py "\"yes\" if j[\"run\"][\"status\"] == \"running\" and any(\"MCP servers in this run:\" in str(p) and a[0] in str(p) and \"ClawBox read-only tools\" in str(p) for p in j[\"run\"].get(\"progress\", [])) else \"\"" "$NAME")
    [ "$LIVE" = "None" ] && LIVE=""
  fi
  if [ -z "$ARGV" ]; then
    ARGV=$(python3 - "$RUN_ID" "$TOKEN" "$REPO" <<"EOF"
import os, stat, sys
run_id, token, repo = sys.argv[1:4]
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        argv = open(f"/proc/{pid}/cmdline", "rb").read().decode("utf-8", "replace").split("\0")
    except OSError:
        continue
    if "--strict-mcp-config" not in argv or not any(run_id in a for a in argv):
        continue
    i = argv.index("--mcp-config") if "--mcp-config" in argv else -1
    path = argv[i + 1] if i >= 0 and i + 1 < len(argv) else ""
    mode = oct(stat.S_IMODE(os.stat(path).st_mode)) if path and os.path.isfile(path) else "none"
    print(" ".join([
        "strict=yes",
        "file=" + ("streams" if path.startswith(repo + "/data/coding-agent-streams/" + run_id + ".mcp-") else "other:" + path[:80]),
        "mode=" + mode,
        "token=" + ("LEAKED" if any(token in a for a in argv) else "absent"),
    ]))
    break
EOF
)
  fi
  [ -n "$LIVE" ] && [ -n "$ARGV" ] && break
  # Settled before both were seen: nothing more to watch.
  [ -n "$NOW_STATUS" ] && [ "$NOW_STATUS" != running ] && break
  sleep 2
done
[ -n "$LIVE" ] && say "ok - while it ran, its record named the board and ClawBox read-only tools" || say "not ok - no live record of the run named both servers while it ran"
[ -n "$APP_PID" ] && wait "$APP_PID"
APP=$(grep "^APP " "$APP_OUT" | head -n 1)
case "$APP" in
  "APP live "*) say "ok - the Coding Agent app showed the run live, its timeline naming both servers: ${APP#APP live }" ;;
  *) say "not ok - the Coding Agent app did not show the live run with both servers: ${APP:-$(tail -n 2 "$APP_OUT" | tr "\n" " " | head -c 200)}" ;;
esac
case "$ARGV" in
  "strict=yes file=streams mode=0o600 token=absent") say "ok - the harness argv keeps --strict-mcp-config and names a 0600 --mcp-config file, no token" ;;
  "") say "not ok - the harness process of $RUN_ID was never seen" ;;
  *) say "not ok - the harness argv: $ARGV" ;;
esac

STATUS=running
while [ "$(date +%s)" -lt "$RUN_END" ]; do
  r=$(API_MAX_TIME=75 api GET "/setup-api/coding-agent/runs?id=$RUN_ID&wait=60")
  STATUS=$(body_of "$r" | py "j[\"run\"][\"status\"]")
  [ "$STATUS" = running ] || break
done
RUN_JSON=$(body_of "$r")
if [ "$STATUS" = running ]; then
  api POST /setup-api/coding-agent/stop "{\"runId\":\"$RUN_ID\"}" >/dev/null
  say "not ok - run $RUN_ID was still running at the deadline and was stopped"
elif [ "$STATUS" = completed ]; then
  say "ok - run $RUN_ID completed"
else
  say "not ok - run $RUN_ID ended $STATUS: $(printf "%s" "$RUN_JSON" | py "str(j[\"run\"].get(\"error\") or j[\"run\"].get(\"summary\") or \"\")[:300]")"
fi

# 4. What it left, and what it did not.
GOT=$(tr -d "\r\n" < "$PROJECT_PATH/board.txt" 2>/dev/null)
[ "$GOT" = "$MARKER" ] && say "ok - board.txt holds the task id only the board tool could tell it" || say "not ok - board.txt holds \"${GOT:0:60}\", not the board tool answer"
for tool in nano_board_read device_status; do
  case "$RUN_JSON" in *"$tool"*) say "ok - the run record shows the run calling $tool" ;; *) say "not ok - the run record shows no call to $tool" ;; esac
done
LEAKS=""
case "$RUN_JSON" in *"$TOKEN"*) LEAKS="$LEAKS run-record" ;; esac
grep -rqF -- "$TOKEN" "$REPO/data/coding-agent-runs.json" 2>/dev/null && LEAKS="$LEAKS runs-file"
grep -rqF -- "$TOKEN" "$REPO/data/coding-agent-artifacts/$RUN_ID" 2>/dev/null && LEAKS="$LEAKS artifacts"
for d in coding-agent-history coding-agent-archive; do grep -rqF -- "$TOKEN" "$REPO/data/$d" 2>/dev/null && LEAKS="$LEAKS $d"; done
[ -z "$LEAKS" ] && say "ok - the token is in no run record, history or evidence file" || say "not ok - the token is in:$LEAKS"
ls "$REPO/data/coding-agent-streams/$RUN_ID".mcp-*.json >/dev/null 2>&1 && say "not ok - the run MCP config file outlived the run" || say "ok - the run MCP config file is gone"
'

out=$(board "$FLOW")
results=$(printf '%s\n' "$out" | grep '^RESULT ' | sed 's/^RESULT //')
if [ -z "$results" ]; then
  not_ok "the MCP servers flow printed nothing on the board"
  printf '%s\n' "$out" | tail -n 20 | while IFS= read -r line; do note "$line"; done
else
  printf '%s\n' "$results" | while IFS= read -r line; do
    case "$line" in
      "ok - "*) ok "${line#ok - }" ;;
      "not ok - "*) printf 'not ok - %s\n' "${line#not ok - }" ;;
      *) note "$line" ;;
    esac
  done
  printf '%s\n' "$results" | grep -q '^not ok - ' && NANO_TEST_FAILED=1
fi
finish
