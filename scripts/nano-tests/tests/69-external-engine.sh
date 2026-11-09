#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/external-engine*.ts src/app/setup-api/local-ai/external/*
# covers: src/components/local-ai/ExternalEngineCard.tsx src/lib/local-ai-proxy.ts
# covers: scripts/nano-tests/board/openai-mock.mjs scripts/nano-tests/board/external-engine-ui.mjs
#
# The external AI engine (TASK-2376) on the box's own runtime — OpenClaw or
# Hermes, whichever it runs; the suite's Hermes pass switches the runtime and
# runs it again. An OpenAI-compatible mock (board/openai-mock.mjs) is started
# on the board as the owner's engine, with a key of its own, and then, the way
# the owner does it in Settings → Local AI → External engine:
#
#   * Test: a wrong key is `unauthorized`, a model the engine does not list is
#     `model_not_listed` (with what it does list), a port nobody answers is
#     `unreachable`, and the right fields pass;
#   * Save makes it the Local AI: GET answers it without the key, the chat
#     model (OpenClaw) or Hermes' selection is the engine's model, the
#     provider list and setup status name it;
#   * a real chat turn is answered BY the engine (the mock's log holds the
#     request, with the key the box was given), and no llama-server for chat
#     is started — the Local AI proxy refuses the on-device model with 503;
#   * the owner's browser shows it (board/external-engine-ui.mjs): Settings'
#     card and the chat header name the model;
#   * Remove puts the box back where it was: the engine gone, the chat model
#     (or Hermes' selection) as before.
#
# The key is made and read ON the board and is never printed. The mock and
# its files are removed at the end, and an engine this test saved is removed
# even when it fails half way. Refuses to run over an engine the owner set up.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
PORT=18931
MODEL="nano-ci/echo-1"
NAME="echo-1"
RUN=${NANO_RUN_ID:-$$}
DIR="/tmp/nano-ext-$RUN"
SAVED=0
note "agent runtime: $RUNTIME"

board_owner_api GET /setup-api/local-ai/external
if [ "$API_STATUS" != 200 ]; then
  not_ok "GET /setup-api/local-ai/external answered $(api_error)"
  finish
fi
if [ "$(api_json '.configured')" = true ]; then
  not_ok "an external engine is already configured on this board ($(api_json '.displayName')); not touching the owner's setup"
  finish
fi

# What the chat runs on now, to compare after Remove.
if [ "$RUNTIME" = hermes ]; then
  # shellcheck disable=SC2016  # expanded on the board
  BEFORE=$(board 'PATH="$HOME/.local/bin:$PATH" timeout 60 hermes config get model.provider 2>/dev/null | tail -n1' | tail -n1)
else
  board_owner_api GET /setup-api/chat/model
  BEFORE=$(api_json '.activeModel // empty')
fi
note "chat model before: ${BEFORE:-none}"

# SC2016: the board script expands on the board; SC2317: run by the EXIT trap.
# shellcheck disable=SC2016,SC2317
cleanup() {
  if [ "$SAVED" = 1 ]; then
    board_owner_api DELETE /setup-api/local-ai/external
    note "cleanup: engine removal answered HTTP $API_STATUS"
  fi
  board '
    [ -f "$1/mock.pid" ] && kill "$(cat "$1/mock.pid")" 2>/dev/null
    rm -rf "$1"
  ' "$DIR" >/dev/null
}
trap cleanup EXIT

# 1. The engine: a mock with a key of its own, made on the board.
# shellcheck disable=SC2016  # expanded on the board
up=$(board '
  mkdir -p "$1" && chmod 700 "$1"
  head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n" > "$1/key"; chmod 600 "$1/key"
  setsid nohup node "$REPO/scripts/nano-tests/board/openai-mock.mjs" --port "$2" --model "$3" \
    --key-file "$1/key" --log "$1/requests.jsonl" > "$1/mock.out" 2>&1 < /dev/null &
  echo $! > "$1/mock.pid"
  for _ in $(seq 1 30); do grep -q READY "$1/mock.out" 2>/dev/null && break; sleep 0.5; done
  grep -q READY "$1/mock.out" && echo up || { echo down; tail -n 3 "$1/mock.out"; }
' "$DIR" "$PORT" "$MODEL")
if [ "$(printf '%s\n' "$up" | head -n1)" != up ]; then
  not_ok "the OpenAI-compatible mock did not start: $(printf '%s' "$up" | tail -n +2 | tr '\n' ' ')"
  finish
fi
ok "an OpenAI-compatible engine (mock) answers on 127.0.0.1:$PORT with a key of its own"

# engine_call METHOD PATH KEYMODE MODEL [BASE] — the owner's call with the
# engine fields built ON the board, the key read there: KEYMODE is `key` (the
# mock's), `wrong` or `none`. Sets API_STATUS / API_BODY.
engine_call() {
  local out
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board '
    case "$3" in key) k=$(cat "$6/key") ;; wrong) k=not-the-engines-key ;; *) k="" ;; esac
    body=$(jq -n --arg b "$5" --arg m "$4" --arg k "$k" \
      "{baseUrl: \$b, modelId: \$m, contextWindow: 131072, maxTokens: 4096, imageInput: false} + (if \$k == \"\" then {} else {apiKey: \$k} end)")
    owner_api "$1" "$2" "$body"
  ' "$1" "$2" "$3" "$4" "${5:-http://127.0.0.1:$PORT/v1}" "$DIR")
  API_STATUS=$(printf '%s\n' "$out" | head -n1)
  API_BODY=$(printf '%s\n' "$out" | tail -n +2)
}

# 2. Test: each refusal in its own words, then a pass.
engine_call POST /setup-api/local-ai/external/test wrong "$MODEL"
if [ "$(api_json '.code')" = unauthorized ]; then ok "Test: a wrong key is refused as unauthorized"; else not_ok "Test with a wrong key: $(api_error) code=$(api_json '.code')"; fi
engine_call POST /setup-api/local-ai/external/test key "no-such-model"
if [ "$(api_json '.code')" = model_not_listed ] && [ "$(api_json '.models[0]')" = "$MODEL" ]; then ok "Test: a model the engine does not list is model_not_listed, with the engine's own list"; else not_ok "Test with a missing model: $(api_error) code=$(api_json '.code')"; fi
engine_call POST /setup-api/local-ai/external/test key "$MODEL" "http://127.0.0.1:$((PORT + 1))/v1"
if [ "$(api_json '.code')" = unreachable ]; then ok "Test: a port nobody answers is unreachable"; else not_ok "Test of a dead port: $(api_error) code=$(api_json '.code')"; fi
engine_call POST /setup-api/local-ai/external/test key "$MODEL"
if [ "$(api_json '.ok')" = true ]; then ok "Test: the engine answers and lists $MODEL"; else not_ok "Test of the right fields: $(api_error) code=$(api_json '.code')"; fi

# 3. Save.
engine_call POST /setup-api/local-ai/external key "$MODEL"
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.success')" = true ]; then
  SAVED=1
  ok "Save: the engine is the Local AI ($(api_json '.modelRef'))"
  w=$(api_json '.warning // empty'); [ -n "$w" ] && note "save warning: $w"
else
  not_ok "Save answered $(api_error) code=$(api_json '.code')"
  finish
fi
# shellcheck disable=SC2016  # expanded on the board
leak=$(board 'k=$(cat "$1/key"); grep -c -F "$k" "$REPO/data/config.json" 2>/dev/null || true' "$DIR" | tail -n1)
if [ "${leak:-0}" = 0 ]; then ok "the key is not in the device store (data/config.json)"; else not_ok "the key is in data/config.json"; fi
# shellcheck disable=SC2016  # expanded on the board
perm=$(board 'stat -c %a "$REPO/data/.external-engine-key" 2>/dev/null' | tail -n1)
if [ "$perm" = 600 ]; then ok "the key's own file is 0600"; else not_ok "data/.external-engine-key is ${perm:-missing}, not 0600"; fi

# The key VALUE, looked for on the board in what the owner's GET answers.
# shellcheck disable=SC2016  # expanded on the board
seen=$(board 'k=$(cat "$1/key"); owner_api GET "/setup-api/local-ai/external?probe=1" | grep -c -F "$k" || true' "$DIR" | tail -n1)
board_owner_api GET /setup-api/local-ai/external?probe=1
if [ "${seen:-1}" = 0 ] && [ "$(api_json '.apiKeySet')" = true ] && [ "$(api_json '.status.modelListed')" = true ]; then
  ok "GET answers the engine and its live status, never the key"
else
  not_ok "GET after save (key seen ${seen:-?} time(s)): $(printf '%s' "$API_BODY" | head -c 300)"
fi

# 4. What the UI reads.
if [ "$RUNTIME" = openclaw ]; then
  wait_gateway_health 180 || note "the gateway did not report healthy within 180 s"
  board_owner_api GET /setup-api/chat/model
  if [ "$(api_json '.activeModel')" = "clawext/$MODEL" ] && [ "$(api_json '.local.label')" = "$NAME" ] && [ "$(api_json '.local.external')" = true ]; then
    ok "chat model: the primary is clawext/$MODEL and the local row is named \"$NAME\""
  else
    not_ok "chat model after save: active=$(api_json '.activeModel') local=$(api_json '.local | tostring')"
  fi
else
  # shellcheck disable=SC2016  # expanded on the board
  sel=$(board 'PATH="$HOME/.local/bin:$PATH"; printf "%s %s\n" "$(timeout 60 hermes config get model.provider 2>/dev/null | tail -n1)" "$(timeout 60 hermes config get model.default 2>/dev/null | tail -n1)"' | tail -n1)
  if [ "$sel" = "clawext $MODEL" ]; then ok "Hermes' selection is clawext / $MODEL"; else not_ok "Hermes' selection after save: $sel"; fi
  board_owner_api GET "/setup-api/hermes/models?refresh=1"
  # shellcheck disable=SC2016  # $m is jq's own variable
  row=$(api_json --arg m "$MODEL" '[.providers[]? | select(.id == "clawext")][0] | "\(.name) \(.models | map(.id) | any(. == $m))"')
  if [ "$row" = "$NAME true" ]; then ok "Hermes' model list offers the clawext row named \"$NAME\" with $MODEL"; else not_ok "Hermes model list clawext row: ${row:-absent}"; fi
fi
board_owner_api GET /setup-api/providers/status
prow=$(api_json '[.providers[] | select(.id == "clawext")][0] | "\(.label)|\(.section)"')
if [ "$prow" = "$NAME (external engine)|localAi" ]; then ok "the provider list shows \"$NAME (external engine)\" as the Local AI row"; else not_ok "providers/status clawext row: ${prow:-absent}"; fi
board_owner_api GET /setup-api/setup/status
if [ "$(api_json '.external_engine.displayName')" = "$NAME" ]; then ok "setup status reports the external engine"; else not_ok "setup status external_engine: $(api_json '.external_engine | tostring')"; fi

# 5. A real chat turn, answered by the engine.
runtime_chat_turn
# shellcheck disable=SC2016  # expanded on the board
hits=$(board 'jq -c "select(.path == \"/v1/chat/completions\" and .authorized == true and .model == \"$2\")" "$1/requests.jsonl" 2>/dev/null | grep -c "NANO-CI-OK" || true' "$DIR" "$MODEL" | tail -n1)
if [ "${hits:-0}" -ge 1 ]; then ok "the turn reached the engine with its key ($hits request(s) in the mock's log)"; else not_ok "the mock's log holds no authorized chat request for the turn"; fi

# 6. The on-device chat model stays down.
# shellcheck disable=SC2016  # expanded on the board
gate=$(board '
  token=$(tr -d "\r\n" < "$REPO/data/.local-ai-token")
  printf "header = \"Authorization: Bearer %s\"\n" "$token" \
    | curl -s -o /dev/null -w "%{http_code}" --max-time 30 -K - "$DASHBOARD/setup-api/local-ai/llamacpp/v1/models"
' | tail -n1)
if [ "$gate" = 503 ]; then ok "the Local AI proxy refuses the on-device model (503) while the engine is selected"; else not_ok "the llama.cpp proxy answered $gate, not 503"; fi
# shellcheck disable=SC2016  # expanded on the board
chat_llama=$(board '
  n=0
  for pid in $(pgrep -x llama-server 2>/dev/null); do
    tr "\0" " " < /proc/$pid/cmdline | grep -q -- "/data/embed/" && continue
    n=$((n + 1))
  done
  echo $n
' | tail -n1)
if [ "${chat_llama:-1}" = 0 ]; then ok "no llama-server for chat is running"; else not_ok "$chat_llama llama-server process(es) for chat are running"; fi

# 7. The owner's browser.
# shellcheck disable=SC2016  # expanded on the board
ui=$(board '
  CHROME=$(find "$HOME/.cache/ms-playwright" -type f \( -path "*/chrome-linux/chrome" -o -path "*/chrome-linux64/chrome" -o -path "*/chrome-linux-arm64/chrome" \) 2>/dev/null | sort -V | tail -1)
  if [ -z "$CHROME" ]; then
    for bin in chromium-browser google-chrome-stable google-chrome chromium; do
      p=$(command -v "$bin" 2>/dev/null) || continue
      grep -qE "(/snap/bin/chromium|snap run chromium)" "$p" 2>/dev/null && continue
      CHROME=$p; break
    done
  fi
  [ -n "$CHROME" ] || { echo "RESULT skip - no Chromium on this board"; exit 0; }
  cookie=$(node -e "const fs=require(\"fs\"),c=require(\"crypto\");const s=fs.readFileSync(process.argv[1],\"utf8\").trim();let g=0;try{const j=JSON.parse(fs.readFileSync(process.argv[2],\"utf8\"));if(Number.isFinite(j.session_generation))g=j.session_generation}catch{};const p=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+1200,gen:g})).toString(\"base64url\");process.stdout.write(p+\".\"+c.createHmac(\"sha256\",s).update(p).digest(\"hex\"))" "$REPO/data/.session-secret" "$REPO/data/config.json")
  mkdir -p "$1/profile" "${3:-$1}"
  OWNER_COOKIE=$cookie CHROME=$CHROME PROFILE_DIR="$1/profile" MODEL_NAME="$2" SHOTS_DIR="${3:-}" \
    timeout 300 node "$REPO/scripts/nano-tests/board/external-engine-ui.mjs" 2>&1 | grep -E "^(RESULT|NOTE) "
' "$DIR" "$NAME" "${NANO_SHOTS_DIR:-}")
while IFS= read -r line; do
  case "$line" in
    "RESULT ok - "*) ok "${line#RESULT ok - }" ;;
    "RESULT not ok - "*) not_ok "${line#RESULT not ok - }" ;;
    "RESULT skip - "*) skip "${line#RESULT skip - }" ;;
    "NOTE "*) note "${line#NOTE }" ;;
  esac
done <<<"$ui"

# 8. Remove: the box as it was.
board_owner_api DELETE /setup-api/local-ai/external
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.removed')" = true ]; then
  SAVED=0
  ok "Remove: the engine is gone"
  w=$(api_json '.warning // empty'); [ -n "$w" ] && note "remove warning: $w"
else
  not_ok "Remove answered $(api_error) code=$(api_json '.code')"
fi
if [ "$RUNTIME" = hermes ]; then
  # shellcheck disable=SC2016  # expanded on the board
  AFTER=$(board 'PATH="$HOME/.local/bin:$PATH" timeout 60 hermes config get model.provider 2>/dev/null | tail -n1' | tail -n1)
else
  board_owner_api GET /setup-api/chat/model
  AFTER=$(api_json '.activeModel // empty')
fi
if [ "$AFTER" = "$BEFORE" ]; then ok "the chat is back on ${AFTER:-what it was}"; else not_ok "the chat was on ${BEFORE:-none} and is now on ${AFTER:-none}"; fi
board_owner_api GET /setup-api/local-ai/external
if [ "$(api_json '.configured')" = false ]; then ok "GET answers no engine after Remove"; else not_ok "GET after Remove: $(printf '%s' "$API_BODY" | head -c 200)"; fi

finish
