#!/usr/bin/env bash
# timeout: 2100
# tier: long
# covers: src/lib/external-engine.ts src/lib/external-engine-shared.ts src/app/setup-api/local-ai/external/*
# covers: src/components/local-ai/ExternalEngineCard.tsx
# covers: scripts/nano-tests/board/openai-mock.mjs scripts/nano-tests/board/external-engine-reasoning-ui.mjs
#
# The external AI engine's reasoning switch (TASK-2497) on the box's own
# runtime — OpenClaw or Hermes, whichever it runs; the suite's Hermes pass
# switches the runtime and runs it again. The OpenAI-compatible mock
# (board/openai-mock.mjs --reasoning) stands in for a DeepSeek-class model
# behind vLLM / SGLang: it takes `reasoning_effort`, logs what each request
# carried, and answers a `reasoning_content` part for every effort but `none`.
#
#   * Test with `detectReasoning` says the engine reasons;
#   * Save with the switch ON: the record keeps it, OpenClaw's model entry is
#     `reasoning: true` with Off mapped to `none` (Hermes keeps its own
#     per-turn level and gets no new key);
#   * EVERY level, by the CLI and in the owner's browser: the picker lists
#     them, a turn at each sends the expected `reasoning_effort` (the mock's
#     log is the proof), the reply shows its reasoning part or, at Off, none;
#     levels are switched in one conversation; the picked level survives a page
#     reload and a restart of the runtime (pre-start keeps `reasoning: true`);
#     Edit → Save keeps the switch on;
#   * Remove, then Save with the switch OFF: the behaviour before TASK-2497 —
#     `reasoning: false`, no effort contract, the turn carries no effort;
#   * Remove puts the box back where it was.
#
# Prints one `# TABLE runtime | path | level | sent | thinking | verdict` line
# per turn for the PR's evidence. The key is made and read ON the board and is
# never printed; the mock and its files are removed at the end, and an engine
# this test saved is removed even when it fails half way. Refuses to run over
# an engine the owner set up.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
PORT=18934
MODEL="nano-ci/think-1"
RUN=${NANO_RUN_ID:-$$}
DIR="/tmp/nano-extr-$RUN"
MARK="NANO-RSN-$RUN-$RUNTIME"
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

chat_selection() {
  if [ "$RUNTIME" = hermes ]; then
    # shellcheck disable=SC2016  # expanded on the board
    board 'PATH="$HOME/.local/bin:$PATH" timeout 60 hermes config get model.provider 2>/dev/null | tail -n1' | tail -n1
  else
    board_owner_api GET /setup-api/chat/model
    api_json '.activeModel // empty'
  fi
}
BEFORE=$(chat_selection)
note "chat model before: ${BEFORE:-none}"

# SC2016: the board script expands on the board; SC2317: run by the EXIT trap.
# shellcheck disable=SC2016,SC2317
cleanup() {
  board_owner_api GET /setup-api/local-ai/external
  if [ "$(api_json '.configured')" = true ] && [ "$(api_json '.baseUrl')" = "http://127.0.0.1:$PORT/v1" ] \
    && [ "$(api_json '.modelId')" = "$MODEL" ]; then
    board_owner_api DELETE /setup-api/local-ai/external
    note "cleanup: this test's engine removed (HTTP $API_STATUS)"
  fi
  board '
    [ -f "$1/mock.pid" ] && kill "$(cat "$1/mock.pid")" 2>/dev/null
    rm -rf "$1"
  ' "$DIR" >/dev/null
}
trap cleanup EXIT

# 1. The engine: a reasoning mock with a key of its own, made on the board.
# shellcheck disable=SC2016  # expanded on the board
up=$(board '
  mkdir -p "$1" "$1/shots" && chmod 700 "$1"
  head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n" > "$1/key"; chmod 600 "$1/key"
  setsid nohup node "$REPO/scripts/nano-tests/board/openai-mock.mjs" --port "$2" --model "$3" --reasoning \
    --key-file "$1/key" --log "$1/requests.jsonl" > "$1/mock.out" 2>&1 < /dev/null &
  echo $! > "$1/mock.pid"
  for _ in $(seq 1 30); do grep -q READY "$1/mock.out" 2>/dev/null && break; sleep 0.5; done
  grep -q READY "$1/mock.out" && echo up || { echo down; tail -n 3 "$1/mock.out"; }
' "$DIR" "$PORT" "$MODEL")
if [ "$(printf '%s\n' "$up" | head -n1)" != up ]; then
  not_ok "the reasoning mock did not start: $(printf '%s' "$up" | tail -n +2 | tr '\n' ' ')"
  finish
fi
ok "a reasoning OpenAI-compatible engine (mock) answers on 127.0.0.1:$PORT"

# engine_call METHOD PATH EXTRA_JSON — the owner's call with the engine fields
# built ON the board (key read there) plus EXTRA_JSON. Sets API_STATUS/API_BODY.
engine_call() {
  local out
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board '
    body=$(EXT_KEY="$(cat "$4/key")" EXT_BASE="$5" EXT_MODEL="$6" EXT_EXTRA="$3" python3 -c "
import json, os
d = {\"baseUrl\": os.environ[\"EXT_BASE\"], \"modelId\": os.environ[\"EXT_MODEL\"], \"contextWindow\": 131072, \"maxTokens\": 4096, \"imageInput\": False, \"apiKey\": os.environ[\"EXT_KEY\"]}
d.update(json.loads(os.environ.get(\"EXT_EXTRA\") or \"{}\"))
print(json.dumps(d))")
    owner_api "$1" "$2" "$body"
  ' "$1" "$2" "$3" "$DIR" "http://127.0.0.1:$PORT/v1" "$MODEL")
  API_STATUS=$(printf '%s\n' "$out" | head -n1)
  API_BODY=$(printf '%s\n' "$out" | tail -n +2)
}

# sent MARKER — what the newest chat request answered with MARKER carried:
# "<effort|absent> <thought:true|false>", or "missing".
sent() {
  # shellcheck disable=SC2016  # expanded on the board
  board '
    python3 -c "
import json, sys
hit = None
for line in open(sys.argv[1]):
    try:
        r = json.loads(line)
    except ValueError:
        continue
    if r.get(\"path\") == \"/v1/chat/completions\" and r.get(\"authorized\") and r.get(\"reply\") == sys.argv[2]:
        hit = r
if hit is None:
    print(\"missing\")
else:
    e = hit.get(\"effort\")
    print((\"absent\" if e is None else str(e)) + \" \" + (\"true\" if hit.get(\"thought\") else \"false\"))
" "$1/requests.jsonl" "$2" 2>/dev/null || echo missing
  ' "$DIR" "$1" | tail -n1
}

# judge PATH LEVEL MARKER EXPECTED_EFFORT [UI_THINKING] — one TABLE row: the
# effort the engine got for MARKER against EXPECTED ("absent" = no field), and
# whether the reply carried / showed a reasoning part (none at `none`/absent-off).
judge() {
  local path=$1 level=$2 marker=$3 want=$4 shown=${5:-} got effort thought verdict=ok
  got=$(sent "$marker")
  effort=${got%% *}
  thought=${got#* }
  [ "$got" = missing ] && { effort=missing; thought=-; }
  [ "$effort" = "$want" ] || verdict="not ok"
  if [ -n "$shown" ]; then
    # In the browser: the reasoning part is shown exactly when the engine sent one.
    [ "$shown" = "$([ "$thought" = true ] && echo yes || echo no)" ] || verdict="not ok"
    thought="engine=$thought ui=$shown"
  fi
  note "TABLE $RUNTIME | $path | $level | sent=$effort (want $want) | thinking: $thought | $verdict"
  if [ "$verdict" = ok ]; then ok "$path $level: the engine got reasoning_effort=$effort ($thought)"; else not_ok "$path $level: the engine got reasoning_effort=$effort, want $want ($thought)"; fi
}

# The wire value of a picker label / CLI level on this runtime.
want_for() {
  case "$1" in
    Off|off|None|none) echo none ;;
    Minimal|minimal) echo minimal ;;
    Low|low) echo low ;;
    Medium|medium) echo medium ;;
    High|high) echo high ;;
    X-High|xhigh) echo xhigh ;;
    Max|max) echo max ;;
    *) echo "?" ;;
  esac
}

# cli_turn LEVEL MARKER — one turn by the runtime's own CLI at LEVEL. Prints the exit code.
cli_turn() {
  if [ "$RUNTIME" = hermes ]; then
    # shellcheck disable=SC2016  # expanded on the board
    board '
      cd "$HOME" && PATH="$HOME/.local/bin:$PATH" timeout 240 "$HOME/.local/bin/hermes" chat \
        -q "Reply with exactly this text and nothing else: $2" -Q --reasoning "$1" >/dev/null 2>&1; echo "rc=$?"
    ' "$1" "$2" | tail -n1
  else
    # shellcheck disable=SC2016  # expanded on the board
    board '
      out=$(timeout 240 "$1" agent --agent main --session-key "$4" --thinking "$2" \
        -m "Reply with exactly this text and nothing else: $3" --json --timeout 230 2>&1); rc=$?
      echo "rc=$rc $(printf "%s" "$out" | grep -oE "(INVALID_REQUEST|not supported)[^\"]{0,120}" | head -n1)"
    ' "$OPENCLAW_BIN" "$1" "$2" "nano-ci-$RUN-$2" | tail -n1
  fi
}

# ui PHASE — the browser phase; sets UI to its output lines.
ui() {
  # shellcheck disable=SC2016  # expanded on the board
  UI=$(board '
    CHROME=$(find "$HOME/.cache/ms-playwright" -type f \( -path "*/chrome-linux/chrome" -o -path "*/chrome-linux64/chrome" -o -path "*/chrome-linux-arm64/chrome" \) 2>/dev/null | sort -V | tail -1)
    if [ -z "$CHROME" ]; then
      for bin in chromium-browser google-chrome-stable google-chrome chromium; do
        p=$(command -v "$bin" 2>/dev/null) || continue
        grep -qE "(/snap/bin/chromium|snap run chromium)" "$p" 2>/dev/null && continue
        CHROME=$p; break
      done
    fi
    [ -n "$CHROME" ] || { echo "RESULT skip - no Chromium on this board"; exit 0; }
    cookie=$(node -e "const fs=require(\"fs\"),c=require(\"crypto\");const s=fs.readFileSync(process.argv[1],\"utf8\").trim();let g=0;try{const j=JSON.parse(fs.readFileSync(process.argv[2],\"utf8\"));if(Number.isFinite(j.session_generation))g=j.session_generation}catch{};const p=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,gen:g})).toString(\"base64url\");process.stdout.write(p+\".\"+c.createHmac(\"sha256\",s).update(p).digest(\"hex\"))" "$REPO/data/.session-secret" "$REPO/data/config.json")
    mkdir -p "$1/profile"
    OWNER_COOKIE=$cookie CHROME=$CHROME PROFILE_DIR="$1/profile" PHASE="$2" MARK="$3" SHOTS_DIR="${4:-$1/shots}" \
      timeout -k 10 900 node "$REPO/scripts/nano-tests/board/external-engine-reasoning-ui.mjs" 2>&1 \
      | grep -E "^(RESULT|NOTE|LEVELS|PICKER|TURN|RELOAD|CARD_SWITCH|CARD_LINE|DONE)( |$)" || true
  ' "$DIR" "$1" "$MARK-$1" "${NANO_SHOTS_DIR:-}")
  while IFS= read -r line; do
    case "$line" in
      "RESULT ok - "*) ok "${line#RESULT ok - }" ;;
      "RESULT not ok - "*) not_ok "${line#RESULT not ok - }" ;;
      "RESULT skip - "*) skip "${line#RESULT skip - }" ;;
      "NOTE "*) note "${line#NOTE }" ;;
      "") ;;
      *) note "ui[$1]: $line" ;;
    esac
  done <<<"$UI"
  grep -q "^DONE" <<<"$UI" || grep -q "^RESULT skip - " <<<"$UI" || not_ok "the $1 browser phase did not finish"
}

# ui_turns — a TABLE row for every TURN line of the last browser phase.
ui_turns() {
  local label marker thinking
  while read -r _ label marker thinking _; do
    judge "browser" "$label" "$marker" "$(want_for "$label")" "${thinking#thinking=}"
  done < <(grep "^TURN " <<<"$UI")
}

ui_value() { grep "^$1 " <<<"$UI" | head -n1 | cut -d' ' -f2-; }

openclaw_entry() {
  # shellcheck disable=SC2016  # expanded on the board
  board 'python3 -c "
import json, os
p = os.path.expanduser(\"~/.openclaw/openclaw.json\")
c = json.load(open(p))
e = ((c.get(\"models\") or {}).get(\"providers\") or {}).get(\"clawext\")
if not e:
    print(\"absent\")
else:
    m = (e.get(\"models\") or [{}])[0]
    print(json.dumps({\"reasoning\": m.get(\"reasoning\"), \"compat\": m.get(\"compat\")}, sort_keys=True, separators=(\",\", \":\")))
"' | tail -n1
}
ENTRY_ON='{"compat":{"reasoningEffortMap":{"off":"none"},"supportedReasoningEfforts":["none","low","medium","high"]},"reasoning":true}'
ENTRY_OFF='{"compat":null,"reasoning":false}'

restart_runtime() {
  if [ "$RUNTIME" = hermes ]; then
    # Hermes' own restart door (bounceHermesDashboardShared): the chat backend
    # stops and systemd brings it back.
    board_api POST /setup-api/hermes/plugins/reload
    echo "HTTP $API_STATUS $(api_json -c '{restarted, ready} // empty' 2>/dev/null)"
  else
    board 'sudo -n /usr/bin/systemctl restart clawbox-gateway.service 2>&1; echo rc=$?' | tail -n1
  fi
}

# 2. Test asks whether the engine reasons.
engine_call POST /setup-api/local-ai/external/test '{"detectReasoning": true}'
if [ "$(api_json '.ok')" = true ] && [ "$(api_json '.reasoningDetected')" = true ]; then ok "Test: the engine answers and is detected as reasoning"; else not_ok "Test with detectReasoning: $(api_error) ok=$(api_json '.ok') reasoningDetected=$(api_json '.reasoningDetected')"; fi

# 3. Save with the switch ON.
engine_call POST /setup-api/local-ai/external '{"reasoning": true}'
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.success')" = true ] && [ "$(api_json '.reasoning')" = true ]; then
  ok "Save with reasoning on: the engine is the Local AI ($(api_json '.modelRef')), reasoning=true"
else
  not_ok "Save with reasoning on answered $(api_error) reasoning=$(api_json '.reasoning')"
  finish
fi
board_owner_api GET /setup-api/local-ai/external
if [ "$(api_json '.reasoning')" = true ]; then ok "GET reads the switch back on"; else not_ok "GET after save: reasoning=$(api_json '.reasoning')"; fi
note "unsupported on $RUNTIME: $(api_json '.unsupported | join(",")')"

if [ "$RUNTIME" = openclaw ]; then
  entry=$(openclaw_entry)
  if [ "$entry" = "$ENTRY_ON" ]; then ok "openclaw.json: clawext's model is reasoning:true, efforts none/low/medium/high, off→none"; else not_ok "openclaw.json clawext model after save: $entry"; fi
  wait_gateway_health 180 || note "the gateway did not report healthy within 180 s"
  board_owner_api GET /setup-api/chat/model
  levels=$(api_json -r '.local.thinkingLevels // [] | join(",")')
  note "gateway thinking levels for clawext/$MODEL: ${levels:-none}"
  case ",$levels," in *,low,*medium,*high,*) ok "the gateway publishes low/medium/high for the engine ($levels)" ;; *) not_ok "the gateway's thinking levels for the engine: ${levels:-none}" ;; esac
else
  # shellcheck disable=SC2016  # expanded on the board
  hk=$(board 'PATH="$HOME/.local/bin:$PATH" timeout 60 hermes config get providers.clawext 2>/dev/null | grep -ci reason || true' | tail -n1)
  if [ "${hk:-0}" = 0 ]; then ok "Hermes: no reasoning key is written into providers.clawext (Hermes sends the chat's level itself)"; else not_ok "Hermes providers.clawext carries a reasoning key"; fi
fi

# 4. Every level by the runtime's CLI.
if [ "$RUNTIME" = hermes ]; then CLI_LEVELS="none minimal low medium high xhigh max"; else CLI_LEVELS="off low medium high"; fi
for lvl in $CLI_LEVELS; do
  r=$(cli_turn "$lvl" "$MARK-cli-$lvl")
  note "cli $lvl: $r"
  judge "cli" "$lvl" "$MARK-cli-$lvl" "$(want_for "$lvl")"
done

# 5. Every level in the owner's browser, one conversation; then a reload.
ui levels
offered=$(ui_value LEVELS)
note "picker offers: ${offered:-nothing}"
if [ "$RUNTIME" = hermes ]; then want_levels="None|Minimal|Low|Medium|High|X-High|Max"; else want_levels="Off|Low|Medium|High"; fi
if [ "$offered" = "$want_levels" ]; then ok "the chat's picker offers $offered"; else not_ok "the chat's picker offers '${offered}', want '$want_levels'"; fi
ui_turns
last=${offered##*|}
reload=$(ui_value RELOAD)
if [ -n "$last" ] && [ "$reload" = "$last" ]; then ok "after a page reload the picker is still on $last"; else not_ok "after a page reload the picker reads '${reload}', want '$last'"; fi

# 6. A restart of the runtime: pre-start keeps the reasoning entry, the level stays.
r=$(restart_runtime)
note "runtime restart: $r"
if wait_runtime_settled 300; then ok "$RUNTIME settled after the restart (${SETTLE_WAITED}s)"; else not_ok "$RUNTIME not settled after the restart: ${SETTLE_STATE:-unknown}"; fi
if [ "$RUNTIME" = openclaw ]; then
  entry=$(openclaw_entry)
  if [ "$entry" = "$ENTRY_ON" ]; then ok "after the gateway restart (pre-start ran) clawext's model is still reasoning:true with off→none"; else not_ok "after the gateway restart clawext's model is $entry"; fi
fi
board_owner_api GET /setup-api/local-ai/external
if [ "$(api_json '.reasoning')" = true ]; then ok "the record still says reasoning on after the restart"; else not_ok "the record after the restart: reasoning=$(api_json '.reasoning')"; fi
lvl=medium
note "cli $lvl after restart: $(cli_turn "$lvl" "$MARK-cli-restart-$lvl")"
judge "cli after restart" "$lvl" "$MARK-cli-restart-$lvl" "$(want_for "$lvl")"
ui check
picked=$(ui_value PICKER)
if [ -n "$last" ] && [ "$picked" = "$last" ]; then ok "after the restart the picker is still on $last"; else not_ok "after the restart the picker reads '${picked}', want '$last'"; fi
ui_turns

# 7. Edit → Save, untouched, keeps the switch on.
ui card
sw=$(ui_value CARD_SWITCH)
line=$(ui_value CARD_LINE)
if [ "$RUNTIME" = hermes ]; then want_sw="on/disabled"; want_line="before=no after=no"; else want_sw="on"; want_line="before=yes after=yes"; fi
if [ "$sw" = "$want_sw" ]; then ok "the card's reasoning switch reads $sw when editing"; else not_ok "the card's reasoning switch reads '${sw}', want '$want_sw'"; fi
if [ "$line" = "$want_line" ]; then ok "the card's summary reasoning line: $line"; else not_ok "the card's summary reasoning line: '${line}', want '$want_line'"; fi
board_owner_api GET /setup-api/local-ai/external
if [ "$(api_json '.reasoning')" = true ]; then ok "Edit → Save kept reasoning on"; else not_ok "after Edit → Save: reasoning=$(api_json '.reasoning')"; fi
[ "$RUNTIME" = openclaw ] && { entry=$(openclaw_entry); [ "$entry" = "$ENTRY_ON" ] && ok "after Edit → Save clawext is still reasoning:true" || not_ok "after Edit → Save clawext is $entry"; }

# 8. Remove.
board_owner_api DELETE /setup-api/local-ai/external
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.removed')" = true ]; then ok "Remove: the engine is gone"; else not_ok "Remove answered $(api_error)"; fi
[ "$RUNTIME" = openclaw ] && { entry=$(openclaw_entry); [ "$entry" = absent ] && ok "openclaw.json has no clawext after Remove" || not_ok "openclaw.json after Remove: $entry"; }
AFTER=$(chat_selection)
if [ "$AFTER" = "$BEFORE" ]; then ok "the chat is back on ${AFTER:-what it was}"; else not_ok "the chat was on ${BEFORE:-none} and is now on ${AFTER:-none}"; fi

# 9. Save with the switch OFF: as before TASK-2497.
engine_call POST /setup-api/local-ai/external '{"reasoning": false}'
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.reasoning')" = false ]; then ok "Save with reasoning off: reasoning=false"; else not_ok "Save with reasoning off answered $(api_error) reasoning=$(api_json '.reasoning')"; fi
if [ "$RUNTIME" = openclaw ]; then
  entry=$(openclaw_entry)
  if [ "$entry" = "$ENTRY_OFF" ]; then ok "openclaw.json: clawext's model is reasoning:false with no effort contract"; else not_ok "openclaw.json clawext model with the switch off: $entry"; fi
  wait_gateway_health 180 || note "the gateway did not report healthy within 180 s"
  board_owner_api GET /setup-api/chat/model
  note "gateway thinking levels with the switch off: $(api_json -r '.local.thinkingLevels // [] | join(",")')"
  r=$(cli_turn medium "$MARK-cli-off-medium")
  note "cli medium with the switch off: $r"
  case "$r" in rc=0*) note "TABLE $RUNTIME | cli (switch off) | medium | accepted | - | note" ;; *) note "TABLE $RUNTIME | cli (switch off) | medium | refused by the gateway: ${r#rc=* } | - | as before" ;; esac
  note "cli off with the switch off: $(cli_turn off "$MARK-cli-off-off")"
  judge "cli (switch off)" "off" "$MARK-cli-off-off" "absent"
else
  note "cli medium with the switch off: $(cli_turn medium "$MARK-cli-off-medium")"
  judge "cli (switch off)" "medium" "$MARK-cli-off-medium" "medium"
fi
ui off
offered=$(ui_value LEVELS)
note "picker with the switch off: '${offered}'"
if [ "$RUNTIME" = openclaw ]; then
  case "$offered" in ""|Off) ok "with the switch off the picker offers no effort levels ('${offered}')" ;; *) not_ok "with the switch off the picker offers '$offered'" ;; esac
  while read -r _ label marker thinking _; do
    judge "browser (switch off)" "$label" "$marker" "absent"
  done < <(grep "^TURN " <<<"$UI")
else
  ui_turns
fi

# 10. Remove again.
board_owner_api DELETE /setup-api/local-ai/external
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.removed')" = true ]; then ok "Remove: the engine is gone"; else not_ok "Remove answered $(api_error)"; fi
AFTER=$(chat_selection)
if [ "$AFTER" = "$BEFORE" ]; then ok "the chat is back on ${AFTER:-what it was}"; else not_ok "the chat was on ${BEFORE:-none} and is now on ${AFTER:-none}"; fi

finish
