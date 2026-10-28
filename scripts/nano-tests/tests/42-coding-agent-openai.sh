#!/usr/bin/env bash
# timeout: 600
# covers: src/lib/coding-openai.ts src/lib/coding-codex.ts src/lib/coding-provider.ts src/app/setup-api/coding-agent/openai/*
# covers: src/components/CodingAgentOpenAICard.tsx config/codex-target.txt
#
# OpenAI as a coding provider, on the board's own pinned Codex CLI
# (config/codex-target.txt, installed at ~/.local/bin/codex):
#
#   1. The CLI takes every flag a run and the connect flow hand it
#      (src/lib/coding-codex.ts buildCodexArgs, src/lib/coding-openai.ts):
#      `exec` and `exec resume` with --json, --skip-git-repo-check, -c and -m;
#      `login` with --device-auth; `logout`.
#   2. The coding-agent status lists OpenAI with its models and says whether
#      the Codex CLI is there and OpenAI is connected; the owner-only OpenAI
#      route refuses the MCP bearer and answers the owner its state.
#   3. Settings → Coding Agent, as the owner sees it: /app/coding in a headless
#      Chromium of the box's own with an owner cookie minted on the board, its
#      Settings page, the OpenAI provider row (Connect, or Connected) and the
#      OpenAI card's status line, key field and ChatGPT sign-in button.
#   4. That sign-in button, pressed: the card shows OpenAI's own device page
#      and a one-time code (never printed: a live code in a public log is one
#      anybody could approve), from `codex login --device-auth` in the coding
#      agent's own CODEX_HOME, and its Cancel ends it.
#   5. When the board holds an OpenAI credential for coding runs, one small
#      run on `openai` must complete; without one that step is a skip.
#
# NOT `parallel:` — step 4 starts a sign-in and step 5 a run. The owner cookie
# and the bearer exist only on the board.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ] || [ "$(api_json '.enabled')" != true ]; then
  not_ok "coding-agent status did not answer enabled: $(api_error)"
  finish
fi
STATUS_BODY=$API_BODY
note "openai: $(api_json -c '{codexInstalled: .readiness.codexInstalled, openaiConnected: .readiness.openaiConnected, provider: (.readiness.providers // [] | map(select(.id == "openai")) | .[0] | {ready, defaultModel, problems})}')"
if [ "$(api_json '[.readiness.providers // [] | .[] | select(.id == "openai")] | length')" = 1 ] \
  && [ "$(api_json '.readiness.providers[] | select(.id == "openai") | .models | length > 0')" = true ]; then
  ok "the status lists OpenAI as a provider, with its models"
else
  not_ok "the status lists no OpenAI provider with models: $(api_json -c '.readiness.providers // [] | map(.id)')"
fi
if [ "$(api_json '.readiness.codexInstalled')" = true ]; then
  ok "the status finds the Codex CLI an openai run needs"
else
  not_ok "the status finds no Codex CLI at ~/.local/bin/codex"
fi

# shellcheck disable=SC2016  # expanded on the board, not here
FLOW='
say() { printf "RESULT %s\n" "$*"; }
SECRET_FILE="$REPO/data/.session-secret"
WORK=$(mktemp -d /tmp/nano-ci-openai-XXXXXX)
CODEX="$HOME/.local/bin/codex"
trap '"'"'rm -rf -- "$WORK"'"'"' EXIT

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

# 1. The pinned CLI and the flags it is handed. Its help is read with a
# throwaway CODEX_HOME: the CLI writes into its home even for --help, and
# ~/.codex is the gateway runtime own.
if [ ! -x "$CODEX" ]; then say "not ok - no Codex CLI at ~/.local/bin/codex"; exit 0; fi
mkdir -p "$WORK/codex-home"
# Stdout only: the CLI warns on stderr about a home under /tmp.
codex_help() { CODEX_HOME="$WORK/codex-home" "$CODEX" "$@" --help 2>/dev/null; }
PIN=$(sed -n -E "s/^([0-9][^[:space:]]*)[[:space:]].*/\1/p" "$REPO/config/codex-target.txt" 2>/dev/null | head -n1)
say "note - $(CODEX_HOME="$WORK/codex-home" "$CODEX" --version 2>/dev/null | head -n1) (pinned ${PIN:-unknown})"
EXEC_HELP=$(codex_help exec)
RESUME_HELP=$(codex_help exec resume)
LOGIN_HELP=$(codex_help login)
MISSING=""
for flag in "--json" "--skip-git-repo-check" "-c, --config" "-m, --model"; do
  case "$EXEC_HELP" in *"$flag"*) ;; *) MISSING="$MISSING exec[$flag]" ;; esac
  case "$RESUME_HELP" in *"$flag"*) ;; *) MISSING="$MISSING exec-resume[$flag]" ;; esac
done
case "$LOGIN_HELP" in *--device-auth*) ;; *) MISSING="$MISSING login[--device-auth]" ;; esac
codex_help logout >/dev/null || MISSING="$MISSING logout"
[ -z "$MISSING" ] && say "ok - the pinned Codex takes every flag a run and the connect flow use" || say "not ok - the pinned Codex lacks:$MISSING"

# 2. The owner-only route.
r=$(api GET /setup-api/coding-agent/openai)
[ "$(status_of "$r")" = 403 ] && say "ok - the MCP bearer may not read the OpenAI connection" || say "not ok - the MCP bearer reading the OpenAI connection answered HTTP $(status_of "$r")"
if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi
OWNER=$(owner_cookie)
r=$(call GET /setup-api/coding-agent/openai "$OWNER")
CONN=$(body_of "$r")
if [ "$(status_of "$r")" = 200 ] && [ "$(printf "%s" "$CONN" | py "j.get(\"codexInstalled\") is True and j.get(\"status\") in (\"connected\", \"disconnected\", \"limited\") and len(j.get(\"models\") or []) > 0")" = True ]; then
  say "ok - the owner reads the OpenAI connection: $(printf "%s" "$CONN" | py "json.dumps({k: j.get(k) for k in (\"connected\", \"source\", \"status\", \"codexInstalled\", \"defaultModel\")})")"
else
  say "not ok - the owner could not read the OpenAI connection: HTTP $(status_of "$r") $(printf "%s" "$CONN" | head -c 200)"
fi
case "$CONN" in *sk-*) say "not ok - the OpenAI connection answer carries something key-shaped" ;; esac
CONNECTED=$(printf "%s" "$CONN" | py "\"true\" if j.get(\"connected\") is True else \"false\"")

# 3 and 4. Settings → Coding Agent in the box own Chromium.
cat > "$WORK/settings-check.cjs" <<"EOF"
const { chromium } = require("playwright");
const [exe] = process.argv.slice(2);
const out = (line) => process.stdout.write(line + "\n");
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: "clawbox_session", value: process.env.OWNER_COOKIE, url: "http://127.0.0.1" }]);
    const page = await context.newPage();
    await page.goto("http://127.0.0.1/app/coding", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator("[data-testid=coding-agent-sidebar-settings]").first().click({ timeout: 60000 });
    const row = page.locator("[data-testid=coding-agent-provider-openai]").first();
    await row.waitFor({ timeout: 60000 });
    const connect = page.locator("[data-testid=coding-agent-provider-connect-openai]");
    const hasConnect = (await connect.count()) > 0;
    const notSetUp = page.locator("[data-testid=coding-agent-provider-openai-not-set-up]");
    out("ROW connected=" + (await row.getAttribute("data-connected"))
      + " connect=" + (hasConnect ? (await connect.first().isDisabled() ? "disabled" : "enabled") : "none")
      + " not-set-up=" + ((await notSetUp.count()) > 0 ? JSON.stringify((await notSetUp.first().innerText()).slice(0, 160)) : "none"));
    await page.locator("[data-testid=coding-agent-openai-card]").first().waitFor({ timeout: 60000 });
    const state = page.locator("[data-testid=coding-agent-openai-state][data-status]").first();
    await state.waitFor({ timeout: 60000 });
    const signin = page.locator("[data-testid=coding-agent-openai-signin]");
    out("CARD status=" + (await state.getAttribute("data-status"))
      + " key-field=" + ((await page.locator("[data-testid=coding-agent-openai-key]").count()) > 0 ? "yes" : "no")
      + " signin=" + ((await signin.count()) > 0 ? (await signin.first().isDisabled() ? "disabled" : "enabled") : "none")
      + " no-codex=" + ((await page.locator("[data-testid=coding-agent-openai-no-codex]").count()) > 0 ? "yes" : "no"));
    if ((await signin.count()) === 0 || await signin.first().isDisabled()) { out("SIGNIN not-offered"); return; }
    await signin.first().click();
    const login = page.locator("[data-testid=coding-agent-openai-login]").first();
    try {
      await login.waitFor({ timeout: 60000 });
    } catch {
      const err = await page.locator("[data-testid=coding-agent-openai-card]").first().innerText();
      out("SIGNIN no-device-card " + JSON.stringify(err.slice(-200)));
      return;
    }
    const hrefs = await login.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") || ""));
    const page_ = hrefs.find((h) => /^https:\/\/auth\.openai\.com\//.test(h)) || "";
    const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.test(await login.innerText());
    out("SIGNIN device-page=" + (page_ ? new URL(page_).origin + new URL(page_).pathname : "none") + " code=" + (code ? "shown" : "none"));
    await page.locator("[data-testid=coding-agent-openai-signin-cancel]").first().click({ timeout: 30000 });
    await login.waitFor({ state: "detached", timeout: 30000 }).then(() => out("CANCEL ended"), () => out("CANCEL still-shown"));
  } finally {
    await browser.close();
  }
})().catch((err) => out("APP error " + String((err && err.message) || err).slice(0, 200)));
EOF
EXE=$(find "$HOME/.cache/ms-playwright" -maxdepth 4 -type f \( -name headless_shell -o -name chrome \) -perm -u+x 2>/dev/null | sort -V | tail -n 1)
if [ -z "$EXE" ]; then
  say "not ok - no Chromium of the box own under ~/.cache/ms-playwright to open Settings with"
else
  APP=$(OWNER_COOKIE="$OWNER" NODE_PATH="$REPO/node_modules" timeout 240 node "$WORK/settings-check.cjs" "$EXE" 2>&1)
  ROW=$(printf "%s\n" "$APP" | sed -n "s/^ROW //p")
  CARD=$(printf "%s\n" "$APP" | sed -n "s/^CARD //p")
  SIGNIN=$(printf "%s\n" "$APP" | sed -n "s/^SIGNIN //p")
  CANCEL=$(printf "%s\n" "$APP" | sed -n "s/^CANCEL //p")
  ERR=$(printf "%s\n" "$APP" | sed -n "s/^APP error //p")
  [ -n "$ERR" ] && say "not ok - Settings → Coding Agent could not be read: $ERR"
  case "$ROW" in
    *"connected=true"*) say "ok - Settings → Coding Agent lists OpenAI, connected ($ROW)" ;;
    *"connected=false"*"connect=enabled"*|*"connected=false"*"connect=disabled"*"not-set-up=\""*) say "ok - Settings → Coding Agent lists OpenAI with its Connect button ($ROW)" ;;
    *) say "not ok - Settings → Coding Agent shows no usable OpenAI row: ${ROW:-<none>}" ;;
  esac
  case "$CARD" in
    *"status=connected"*|*"status=disconnected"*|*"status=limited"*) say "ok - the OpenAI card shows its status ($CARD)" ;;
    *) say "not ok - the OpenAI card shows no status: ${CARD:-<none>}" ;;
  esac
  case "$CARD" in *"no-codex=yes"*) say "not ok - the OpenAI card says the Codex CLI is missing" ;; esac
  case "$SIGNIN" in
    "device-page=https://auth.openai.com/"*" code=shown") say "ok - the ChatGPT sign-in shows OpenAI own device page and a one-time code ($(printf "%s" "$SIGNIN" | sed "s/ code=shown//"))" ;;
    not-offered) case "$CONNECTED" in true) say "note - the ChatGPT sign-in is not offered: this board is already signed in" ;; *) say "not ok - the ChatGPT sign-in is not offered on a board with no sign-in" ;; esac ;;
    *) say "not ok - the ChatGPT sign-in did not reach OpenAI device page: ${SIGNIN:-<none>}" ;;
  esac
  case "$SIGNIN" in
    "device-page="*) [ "$CANCEL" = ended ] && say "ok - Cancel ends the sign-in" || say "not ok - Cancel left the sign-in on the card: ${CANCEL:-<none>}" ;;
  esac
fi
printf "CONNECTED %s\n" "$CONNECTED"
'

out=$(board "$FLOW")
results=$(printf '%s\n' "$out" | grep '^RESULT ' | sed 's/^RESULT //')
if [ -z "$results" ]; then
  not_ok "the OpenAI flow printed nothing on the board"
  printf '%s\n' "$out" | tail -n 20 | while IFS= read -r line; do note "$line"; done
  finish
fi
printf '%s\n' "$results" | while IFS= read -r line; do
  case "$line" in
    "ok - "*) ok "${line#ok - }" ;;
    "not ok - "*) printf 'not ok - %s\n' "${line#not ok - }" ;;
    "note - "*) note "${line#note - }" ;;
    *) note "$line" ;;
  esac
done
printf '%s\n' "$results" | grep -q '^not ok - ' && NANO_TEST_FAILED=1

# 5. A run on OpenAI, when the board can make one.
if [ "$(printf '%s\n' "$out" | sed -n 's/^CONNECTED //p')" != true ]; then
  skip "no OpenAI credential for coding runs on this board: a run on openai needs an API key or a ChatGPT sign-in in Settings → Coding Agent"
  finish
fi
API_BODY=$STATUS_BODY
if ! fresh_project_dir "-openai"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi
LINE="NANO-CI-OPENAI $NANO_SERIAL $NANO_RUN_ID $(date +%s)"
TASK="Create a file named hello.txt in the current working folder whose entire content is exactly this one line:
$LINE
Do not create, change or delete any other file, do not run a build or a server, and do not verify anything in a browser. Say done when the file is written."
board_api POST /setup-api/coding-agent/run "$(jq -cn --arg task "$TASK" --arg dir "$PROJECT_DIR" '{task: $task, directory: $dir, provider: "openai"}')"
RUN_ID=$(api_json '.run.id // empty')
if [ "$API_STATUS" != 202 ] || [ -z "$RUN_ID" ]; then
  not_ok "the openai run did not start: $(api_error)"
  remove_project_dir
  finish
fi
if [ "$(api_json '.run.provider')" = openai ]; then
  ok "run $RUN_ID started on openai ($(api_json '.run.requestedModel'))"
else
  not_ok "run $RUN_ID started on $(api_json '.run.provider'), not openai"
fi
wait_coding_run 360
expect_completed
# shellcheck disable=SC2016  # expanded on the board
CONTENT=$(board '[ -f "$1/hello.txt" ] && cat "$1/hello.txt" || echo "<no hello.txt>"' "$PROJECT_DIR")
if [ "$CONTENT" = "$LINE" ]; then
  ok "hello.txt holds exactly the line asked for"
else
  not_ok "hello.txt holds \"${CONTENT:0:80}\", not the line asked for"
fi
remove_project_dir
finish
