#!/usr/bin/env bash
# timeout: 900
# covers: scripts/openclaw-plugins/clawbox-local-lean/* scripts/start-llamacpp.sh
# covers: src/lib/llamacpp.ts src/lib/llamacpp-server.ts src/lib/local-tool-search.ts src/lib/local-ai-thinking.ts
# covers: src/app/setup-api/llamacpp/* src/app/setup-api/local-ai/llamacpp/*
# covers: src/lib/local-ai-proxy.ts scripts/gateway-pre-start.sh
#
# Local AI as the chat model, used the way an owner uses it: Gemma 4 E2B on
# llama.cpp picked in the chat header (POST /setup-api/chat/model, the
# picker's own call), then asked in Bulgarian for a small web app —
# "направи ми проста todo страница" — through the real gateway:
#
#   * the on-device model answers it (no cloud fallback took the turn), with
#     the lean prompt (clawbox-local-lean: a model call far below the ~13k
#     prompt tokens of OpenClaw's full prompt) and Tool Search off while it
#     is the primary (direct tool schemas);
#   * it calls clawbox__webapp_create and a new page lands in data/webapps/;
#   * the reply is Bulgarian, not Russian — judged here by letters and words
#     only one of the two has, never by the plugin's own detector;
#   * the gateway and the web server are the same processes afterwards;
#   * for the record: MemAvailable before the model loaded and its lowest
#     during the turn, llama-server's RSS, and its prefill and decode speed
#     on one fixed prompt (llama-server's own timings). Decode under 10 tok/s
#     fails (the model is no longer on the GPU), and so does no measurement.
#
# Then the two launch decisions behind it, read off the running box:
#
#   * the window and KV cache: llama-server runs with the window OpenClaw's
#     row is told, and neither is still a superseded shipped value (131072
#     tokens, q4_0 cache, 131072-token answers) — the shipped 32768 / q8_0 /
#     8192 pass, an owner's own .env value is noted;
#   * thinking on demand: the row declares binary reasoning (`none`/`high`)
#     with `off` as the model's default and llama-server starts with
#     `--reasoning off`; then one short question through the gateway, once at
#     the default level and once with `--thinking high` — the second must
#     spend clearly more output tokens (its reasoning) than the first.
#
# Two attempts, each on a session of its own: the turn passes when one does,
# and a miss is noted. Afterwards the box is put back — the primary model and
# tools.toolSearch as they were, the web apps the turn made uninstalled, Local
# AI turned off again when this test turned it on. Skips when OpenClaw, the
# llama.cpp runtime or the Gemma GGUF is not on the board (a download is up
# to 3.4 GB, which is the installer's job, not this test's).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

PROMPT="направи ми проста todo страница"
# Seconds one attempt may take, model load included (a cold start reads a
# 3.35 GB GGUF; the page-writing turn took 31-56 s in the benchmark).
TURN_SECONDS=300
# A lean model call is ~1.3k prompt tokens plus what the turn added; the full
# prompt is ~13.4k on its own.
LEAN_MAX_PROMPT_PER_CALL=8000
MIN_DECODE_TOK_S=10

# The thinking check: a question with a one-word answer, so the output tokens
# of a turn without thinking are a handful and a turn with it adds its
# reasoning (253 tokens on a like question in the benchmark).
THINK_PROMPT="Колко е 17 × 23? Отговори само с числото."
THINK_TURN_SECONDS=150
THINK_MIN_EXTRA_OUTPUT=40
# What the test may have spent before the thinking turns start, out of its
# 900 s: both turns and the way out must still fit.
THINK_START_BY=$((900 - 2 * THINK_TURN_SECONDS - 60))
# The shipped launch values (src/lib/llamacpp.ts) and the ones they replaced.
SHIPPED_CTX=32768 SHIPPED_KV=q8_0 SHIPPED_MAX_TOKENS=8192
SUPERSEDED_CTX=131072 SUPERSEDED_KV=q4_0 SUPERSEDED_MAX_TOKENS=131072

# "bg: …", "ru: …" or "unclear: …" for one reply, on stdin. Code blocks and
# tags are dropped first; then letters and whole words only Russian has (ы э ё,
# "что", "это", "создал", …) make it Russian, and a Cyrillic reply with no
# Russian marker and at least one Bulgarian-only one (ъ inside a word, ѝ,
# "това", "ето", "създадох", …) makes it Bulgarian. A word both languages
# use ("привет", "нужно", "ваш", "вам", "ли", "само") is in neither list: one
# such word must not turn a correct Bulgarian reply into a Russian one.
# shellcheck disable=SC2016  # jq's own variables
LANG_JQ='
def lower: explode | map(if . >= 1040 and . <= 1071 then . + 32 elif . >= 1024 and . <= 1039 then . + 80 elif . >= 65 and . <= 90 then . + 32 else . end) | implode;
def hits(list): . as $words | [$words[] | select(. as $w | list | index([$w]))] | length;
(gsub("```[\\s\\S]*?```"; " ") | gsub("<[^>]{0,200}>"; " ")) as $t
| ($t | [scan("\\p{Cyrillic}")] | length) as $cyr
| ($t | [scan("[A-Za-z]")] | length) as $lat
| ($t | [scan("[ыэёЫЭЁ]")] | length) as $ru_letters
| ($t | [scan("\\p{Cyrillic}[ъЪ]\\p{Cyrillic}|[ѝЍ]")] | length) as $bg_letters
| ($t | lower | [scan("\\p{L}+")]) as $words
| ($words | hits(["что","это","этот","эта","вот","создал","создала","сделал","сделала","страницу","простую","можно","конечно","пожалуйста","есть","задачу","если","теперь","вы","мне","меня","создан","создана","создано","объект","который","которая","которые","здравствуйте","спасибо","хорошо","сейчас","только","также","здесь","открыть","откройте","добавить","удалить"])) as $ru_words
| ($words | hits(["това","тази","тези","ето","създадох","направих","страницата","ще","може","можеш","със","във","към","също","задачите","бутон","добави","изтрий","които","който","която","нещо","е","сега","искаш"])) as $bg_words
| if $cyr == 0 then "unclear: no Cyrillic in the reply"
  elif $cyr * 10 < ($cyr + $lat) * 4 then "unclear: mostly Latin (\($cyr) Cyrillic, \($lat) Latin letters)"
  elif $ru_letters > 0 or $ru_words > 0 then "ru: \($ru_letters) Russian-only letters, \($ru_words) Russian-only words"
  elif $bg_letters + $bg_words > 0 then "bg: \($bg_letters) Bulgarian-only letters, \($bg_words) Bulgarian-only words"
  else "unclear: Cyrillic with nothing only Bulgarian has"
  end'

# The main agent's model and Tool Search as openclaw.json holds them, one JSON
# line: {"primary": …, "fallbacks": …, "toolSearch": … or "unset"}.
# shellcheck disable=SC2016  # expanded on the board
cfg_snapshot() {
  board '
    python3 - "$HOME/.openclaw/openclaw.json" <<"PY" 2>/dev/null || echo "{}"
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    print("{}"); raise SystemExit
m = ((c.get("agents") or {}).get("defaults") or {}).get("model")
t = c.get("tools") or {}
print(json.dumps({
    "primary": m.get("primary") if isinstance(m, dict) else m,
    "fallbacks": m.get("fallbacks") if isinstance(m, dict) else None,
    "toolSearch": t["toolSearch"] if isinstance(t, dict) and "toolSearch" in t else "unset",
}, sort_keys=True))
PY
  ' | tail -n 1
}

# "<MemAvailable MB> <gateway pid> <web server pid> <llama-server running 0/1>"
# shellcheck disable=SC2016  # expanded on the board
box_snapshot() {
  board '
    avail=$(awk "/^MemAvailable:/ {print int(\$2/1024)}" /proc/meminfo)
    gw=$(systemctl show clawbox-gateway.service -p MainPID --value)
    st=$(systemctl show clawbox-setup.service -p MainPID --value)
    pid=$(cat "$REPO/data/llamacpp/server.pid" 2>/dev/null)
    up=0; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && up=1
    echo "$avail ${gw:-0} ${st:-0} $up"
  ' | tail -n 1
}

# The on-device row as openclaw.json tells OpenClaw about it, and the model's
# own thinking default, one JSON line: {"contextWindow": …, "maxTokens": …,
# "reasoning": …, "efforts": […], "thinking": …}; "{}" when unreadable.
# shellcheck disable=SC2016  # expanded on the board
local_row_snapshot() {
  board '
    python3 - "$HOME/.openclaw/openclaw.json" "$1" <<"PY" 2>/dev/null || echo "{}"
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    print("{}"); raise SystemExit
ref = sys.argv[2]
mid = ref.split("/", 1)[1] if "/" in ref else ref
prov = ((c.get("models") or {}).get("providers") or {}).get("llamacpp") or {}
rows = prov.get("models") if isinstance(prov, dict) else None
row = next((m for m in (rows or []) if isinstance(m, dict) and m.get("id") == mid), {})
compat = row.get("compat") if isinstance(row.get("compat"), dict) else {}
entry = (((c.get("agents") or {}).get("defaults") or {}).get("models") or {}).get(ref)
params = entry.get("params") if isinstance(entry, dict) else None
print(json.dumps({
    "contextWindow": row.get("contextWindow"),
    "maxTokens": row.get("maxTokens"),
    "reasoning": row.get("reasoning"),
    "efforts": compat.get("supportedReasoningEfforts"),
    "thinking": params.get("thinking") if isinstance(params, dict) else None,
}, sort_keys=True))
PY
  ' "$1" | tail -n 1
}

# The flags the running llama-server was started with, one line:
# "ctx=… ctk=… ctv=… reasoning=…", or "none" when it is not running.
# shellcheck disable=SC2016  # expanded on the board
server_flags() {
  board '
    pid=$(cat "$REPO/data/llamacpp/server.pid" 2>/dev/null)
    if [ -z "$pid" ] || [ ! -r "/proc/$pid/cmdline" ]; then echo none; exit 0; fi
    args=" $(tr "\0" " " < "/proc/$pid/cmdline") "
    flag() { sed -n -E "s/.* $1 ([^ ]+) .*/\\1/p" <<<"$args" | head -n 1; }
    echo "ctx=$(flag --ctx-size) ctk=$(flag --cache-type-k) ctv=$(flag --cache-type-v) reasoning=$(flag --reasoning)"
  ' | tail -n 1
}

# ---- what the board has --------------------------------------------------------

# shellcheck disable=SC2016  # expanded on the board
if [ "$(board '[ -x "$1" ] && echo yes' "$OPENCLAW_BIN" | tail -n 1)" != yes ]; then
  skip "no OpenClaw on this board ($OPENCLAW_BIN)"
  finish
fi
board_api GET /setup-api/llamacpp/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "llamacpp/status did not answer: $(api_error)"
  finish
fi
if [ "$(api_json '.binaryInstalled')" != true ] || [ "$(api_json '.modelAvailable')" != true ]; then
  skip "Local AI is not on this board (llama.cpp runtime: $(api_json '.binaryInstalled'), Gemma GGUF: $(api_json '.modelAvailable'))"
  finish
fi
LLAMA_URL=$(api_json '.baseUrl // empty')

board_api GET /setup-api/chat/model
if [ "$API_STATUS" != 200 ]; then
  not_ok "chat/model did not answer: $(api_error)"
  finish
fi
BEFORE_MODEL=$(api_json '.activeModel // empty')
# shellcheck disable=SC2016  # jq's own variable
BEFORE_PROVIDER=$(api_json '. as $s | (.options // [])[] | select(.id == $s.activeOptionId) | .provider // empty' | head -n 1)
LOCAL_MODEL=$(api_json '.local.model // empty')
if [ -n "$LOCAL_MODEL" ] && [[ $LOCAL_MODEL != llamacpp/* ]]; then
  skip "Local AI on this board is $LOCAL_MODEL, not Gemma on llama.cpp"
  finish
fi
note "chat model before: ${BEFORE_MODEL:-none}${BEFORE_PROVIDER:+ (row $BEFORE_PROVIDER)}; Local AI row: ${LOCAL_MODEL:-not configured}"

board_api GET "/setup-api/preferences?keys=installed_apps"
# Without this list no page the turn writes is known to be the test's own, and
# none is uninstalled afterwards.
APPS_KNOWN=0
[ "$API_STATUS" = 200 ] && APPS_KNOWN=1
BEFORE_APPS=" $(api_json '(.installed_apps // [])[]' | tr '\n' ' ') "
CFG_BEFORE=$(cfg_snapshot)
TOOLSEARCH_BEFORE=$(jq -c '.toolSearch' <<<"$CFG_BEFORE" 2>/dev/null)
read -r AVAIL_BEFORE GW_PID ST_PID LLAMA_UP_BEFORE <<<"$(box_snapshot)"
note "before: MemAvailable ${AVAIL_BEFORE:-?} MB, llama-server running: ${LLAMA_UP_BEFORE:-?}, tools.toolSearch: ${TOOLSEARCH_BEFORE:-?}"

# ---- putting the box back, whatever happens below ------------------------------

SWITCHED=0 CONFIGURED_HERE=0 RESTORED=0 NEW_APPS=""
restore() {
  [ "$RESTORED" = 1 ] && return 0
  RESTORED=1
  local id body after back
  for id in $NEW_APPS; do
    board_api POST /setup-api/apps/uninstall "{\"appId\":\"$id\"}"
    if [ "$API_STATUS" = 200 ]; then
      note "uninstalled the test's web app $id"
    else
      not_ok "could not uninstall the test's web app $id: $(api_error)"
    fi
  done
  if [ "$SWITCHED" = 1 ]; then
    if [ -n "$BEFORE_MODEL" ] && [[ $BEFORE_MODEL != llamacpp/* ]]; then
      body=$(jq -cn --arg m "$BEFORE_MODEL" --arg p "$BEFORE_PROVIDER" '{model: $m} + (if $p == "" then {} else {provider: $p} end)')
      board_api POST /setup-api/chat/model "$body"
      back=$(api_json '.activeModel // empty')
      if [ "$API_STATUS" = 200 ] && [ "$back" = "$BEFORE_MODEL" ]; then
        ok "the chat model is back on $BEFORE_MODEL"
      elif [ "$API_STATUS" = 200 ] && [[ $BEFORE_MODEL == deepseek/* && $back == deepseek/* ]]; then
        # chat/model writes every ClawBox AI pick as its one chat id
        # (canonicalChatModel: the proxy serves Flash under the Pro id too).
        ok "the chat model is back on ClawBox AI ($back; it was $BEFORE_MODEL, which a pick writes as $back)"
      else
        not_ok "could not put the chat model back on $BEFORE_MODEL: $(api_error)"
      fi
    else
      note "the chat model stays on ${BEFORE_MODEL:-none}: it was not a cloud model before"
    fi
  fi
  if [ "$CONFIGURED_HERE" = 1 ]; then
    board_api POST /setup-api/local-ai '{"action":"disable"}'
    if [ "$API_STATUS" = 200 ]; then
      note "Local AI turned off again (this test turned it on)"
    else
      not_ok "could not turn Local AI off again: $(api_error)"
    fi
  fi
  if [ "$SWITCHED" = 1 ]; then
    sleep 3
    after=$(jq -c '.toolSearch' <<<"$(cfg_snapshot)" 2>/dev/null)
    if [ "$after" = "$TOOLSEARCH_BEFORE" ]; then
      ok "tools.toolSearch is back to ${TOOLSEARCH_BEFORE}"
    else
      not_ok "tools.toolSearch is ${after:-unreadable} after the switch back, was ${TOOLSEARCH_BEFORE}"
    fi
  fi
}
trap restore EXIT
trap 'restore; exit 143' TERM INT

# ---- Local AI on, and picked in the chat header --------------------------------

if [ -z "$LOCAL_MODEL" ]; then
  # Settings → Local AI's Install with the runtime and the GGUF already there:
  # it starts the model, writes the llamacpp row and returns it to standby.
  # An NDJSON stream; its last line says success or error.
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board 'API_MAX_TIME=600 api POST /setup-api/llamacpp/install "$1"' '{"scope":"local"}')
  last=$(printf '%s\n' "$out" | tail -n +2 | jq -c 'select(.success != null or .error != null)' 2>/dev/null | tail -n 1)
  if [ "$(jq -r '.success // false' <<<"$last" 2>/dev/null)" != true ]; then
    not_ok "Settings → Local AI's Install did not configure Gemma: ${last:-$(printf '%s' "$out" | head -c 200)}"
    finish
  fi
  CONFIGURED_HERE=1
  board_api GET /setup-api/chat/model
  LOCAL_MODEL=$(api_json '.local.model // empty')
  if [ -z "$LOCAL_MODEL" ]; then
    not_ok "Local AI was installed but the chat picker offers no local model"
    finish
  fi
  ok "Local AI turned on through Settings → Local AI's Install ($LOCAL_MODEL)"
fi

board_api POST /setup-api/chat/model "$(jq -cn --arg m "$LOCAL_MODEL" '{model: $m}')"
SWITCHED=1
if [ "$API_STATUS" != 200 ] || [ "$(api_json '.activeModel // empty')" != "$LOCAL_MODEL" ]; then
  not_ok "the chat header's pick of $LOCAL_MODEL did not land: $(api_error)"
  finish
fi
ok "the chat model is $LOCAL_MODEL (the header picker's call)"
# The pick hot-applies (agents.defaults and tools reload without a restart).
sleep 5
CFG_LOCAL=$(cfg_snapshot)
if [ "$(jq -r '.primary // empty' <<<"$CFG_LOCAL" 2>/dev/null)" != "$LOCAL_MODEL" ]; then
  not_ok "openclaw.json does not name $LOCAL_MODEL as the primary: $CFG_LOCAL"
fi
if [ "$TOOLSEARCH_BEFORE" = '"unset"' ]; then
  if [ "$(jq -c '.toolSearch' <<<"$CFG_LOCAL" 2>/dev/null)" = '{"enabled":false}' ]; then
    ok "Tool Search is off while the on-device model is the primary (direct tool schemas)"
  else
    not_ok "Tool Search was not turned off for the on-device primary: tools.toolSearch is $(jq -c '.toolSearch' <<<"$CFG_LOCAL" 2>/dev/null)"
  fi
else
  note "the owner's own tools.toolSearch ($TOOLSEARCH_BEFORE) is left as it is"
fi

# ---- the turn ------------------------------------------------------------------

# One turn on the board: the CLI's JSON is kept in a file while the lowest
# MemAvailable is sampled every second, then come a TURN line, one PAGE line
# per web app page written during the turn, and the JSON last.
# shellcheck disable=SC2016  # expanded on the board
TURN='
  bin=$1 key=$2 prompt=$3 secs=$4
  out=$(mktemp) marker=$(mktemp) low=$(mktemp)
  avail() { awk "/^MemAvailable:/ {print int(\$2/1024)}" /proc/meminfo; }
  avail > "$low"
  ( while :; do a=$(avail); [ "$a" -lt "$(cat "$low")" ] && echo "$a" > "$low"; sleep 1; done ) &
  sampler=$!
  start=$(date +%s)
  timeout "$secs" "$bin" agent --agent main --session-key "$key" -m "$prompt" --json --timeout $((secs - 20)) > "$out"
  rc=$?
  took=$(( $(date +%s) - start ))
  kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
  pid=$(cat "$REPO/data/llamacpp/server.pid" 2>/dev/null)
  rss=$(awk "/^VmRSS:/ {print int(\$2/1024)}" "/proc/${pid:-0}/status" 2>/dev/null)
  echo "TURN rc=$rc secs=$took min_avail_mb=$(cat "$low") server_rss_mb=${rss:-0}"
  find "$REPO/data/webapps" -mindepth 2 -maxdepth 2 -name index.html -newer "$marker" 2>/dev/null | while read -r page; do
    id=$(basename "$(dirname "$page")")
    echo "PAGE $id bytes=$(wc -c < "$page") html=$(grep -ciE "<html|<!doctype" "$page") input=$(grep -ciE "<input|<textarea" "$page") script=$(grep -ci "<script" "$page")"
  done
  sed -n "/^{/,\$p" "$out"
  rm -f "$out" "$marker" "$low"
'

val() { sed -n -E "s/.* $1=([0-9-]+).*/\\1/p" <<<" $2" | head -n 1; }
PASSED=0 MIN_AVAIL="" SERVER_RSS=""
for attempt in 1 2; do
  ANSWER=$(board "$TURN" "$OPENCLAW_BIN" "nano-ci-$NANO_RUN_ID-local-ai-$(date +%s)-$attempt" "$PROMPT" "$TURN_SECONDS")
  TURN_LINE=$(grep -m 1 '^TURN ' <<<"$ANSWER")
  JSON=$(sed -n '/^{/,$p' <<<"$ANSWER")
  RC=$(val rc "$TURN_LINE") SECS=$(val secs "$TURN_LINE")
  MIN_AVAIL=$(val min_avail_mb "$TURN_LINE") SERVER_RSS=$(val server_rss_mb "$TURN_LINE")
  note "attempt $attempt: ${TURN_LINE:-no answer from the board}"

  REPLY=$(jq -r '[ (.result.payloads // [])[]?.text, .result.text, .reply, .text ]
    | map(select(type == "string")) | join("\n")' <<<"$JSON" 2>/dev/null)
  META=$(jq -c 'first(.. | objects | select(has("agentMeta")) | .agentMeta) // {}' <<<"$JSON" 2>/dev/null)
  [ -n "$META" ] || META='{}'
  TOOLS=$(jq -r '(first(.. | objects | select(has("toolSummary")) | .toolSummary) // {}) | (.tools // []) | join(" ")' <<<"$JSON" 2>/dev/null)
  PROVIDER=$(jq -r '.provider // empty' <<<"$META" 2>/dev/null)
  MODEL=$(jq -r '.model // empty' <<<"$META" 2>/dev/null)
  PROMPT_TOKENS=$(jq -r '.usage.input // empty' <<<"$META" 2>/dev/null)
  OUTPUT_TOKENS=$(jq -r '.usage.output // empty' <<<"$META" 2>/dev/null)
  CALLS=$(jq -r '.assistantTurns // empty' <<<"$META" 2>/dev/null)
  VERDICT=$(printf '%s' "$REPLY" | jq -Rrs "$LANG_JQ" 2>/dev/null)
  note "attempt $attempt: answered by ${PROVIDER:-?}/${MODEL:-?}; tools: ${TOOLS:-none named}; prompt tokens ${PROMPT_TOKENS:-?} over ${CALLS:-?} model call(s), ${OUTPUT_TOKENS:-?} out; language ${VERDICT:-?}"
  note "attempt $attempt reply: $(printf '%s' "$REPLY" | tr '\n' ' ' | head -c 400)"
  [ -n "$JSON" ] || note "attempt $attempt: no JSON from the CLI: $(printf '%s' "$ANSWER" | tail -n 5 | tr '\n' ' ' | head -c 300)"

  PAGES=$(grep '^PAGE ' <<<"$ANSWER")
  GOOD_PAGE=""
  while read -r _ id rest; do
    [ -n "$id" ] || continue
    if ! [[ $id =~ ^[A-Za-z0-9._-]+$ ]]; then
      note "a page folder with an unexpected name was written: $id"
      continue
    fi
    note "attempt $attempt: page $id $rest"
    # Only an app that was not installed before the test is the test's to remove.
    if [ "$APPS_KNOWN" = 1 ] && [[ $BEFORE_APPS != *" $id "* ]] && [[ " $NEW_APPS " != *" $id "* ]]; then
      NEW_APPS="$NEW_APPS $id"
    fi
    bytes=$(val bytes "$rest") html=$(val html "$rest")
    if [ "${bytes:-0}" -ge 200 ] && [ "${html:-0}" -ge 1 ]; then GOOD_PAGE=$id; fi
  done <<<"$PAGES"

  WHY=()
  [ "$RC" = 0 ] || WHY+=("the CLI exited ${RC:-?}")
  if [ -n "$PROVIDER" ] && [ "$PROVIDER" != llamacpp ]; then
    WHY+=("answered by $PROVIDER (a cloud fallback), not the on-device model")
  fi
  if [ -n "$TOOLS" ] && [[ " $TOOLS " != *webapp_create* ]]; then
    WHY+=("clawbox__webapp_create was not called (tools: $TOOLS)")
  fi
  [ -n "$GOOD_PAGE" ] || WHY+=("no web app page was written")
  [[ $VERDICT == bg:* ]] || WHY+=("the reply is not Bulgarian (${VERDICT:-no reply})")
  if [[ $PROMPT_TOKENS =~ ^[0-9]+$ ]] && [[ $CALLS =~ ^[0-9]+$ ]] && [ "$CALLS" -gt 0 ] \
    && [ $((PROMPT_TOKENS / CALLS)) -gt "$LEAN_MAX_PROMPT_PER_CALL" ]; then
    WHY+=("$((PROMPT_TOKENS / CALLS)) prompt tokens per model call: the lean prompt was not used")
  fi
  if [ "${#WHY[@]}" -eq 0 ]; then
    PASSED=1
    ok "Gemma answered \"$PROMPT\" in Bulgarian and made the web app $GOOD_PAGE with clawbox__webapp_create (attempt $attempt, ${SECS:-?} s)"
    [ -n "$PROVIDER" ] || note "the CLI's JSON names no provider: the no-fallback check could not run"
    [ -n "$TOOLS" ] || note "the CLI's JSON names no tools: the call is proven by the page on disk alone"
    break
  fi
  note "attempt $attempt failed: $(IFS=';'; echo "${WHY[*]}")"
done
[ "$PASSED" = 1 ] || not_ok "Gemma did not answer \"$PROMPT\" with a Bulgarian reply and a web app in two attempts"

# ---- memory and speed ----------------------------------------------------------

read -r _ GW_PID2 ST_PID2 _ <<<"$(box_snapshot)"
if [ "$GW_PID2" = "$GW_PID" ] && [ "$ST_PID2" = "$ST_PID" ]; then
  ok "clawbox-gateway and clawbox-setup are the same processes after the turn (no OOM kill, no restart)"
else
  not_ok "a service was killed or restarted during the turn (gateway $GW_PID -> $GW_PID2, web server $ST_PID -> $ST_PID2)"
fi
if [ "$LLAMA_UP_BEFORE" = 1 ]; then BEFORE_STATE="with llama-server already up"; else BEFORE_STATE="with the model in standby"; fi
note "memory: MemAvailable ${AVAIL_BEFORE:-?} MB before the test ($BEFORE_STATE), ${MIN_AVAIL:-?} MB at the lowest during the last turn; llama-server RSS ${SERVER_RSS:-?} MB"

# The turn has just woken llama-server and the runtime is configured, so no
# measurement is a fault (a server that died or stopped after the turn), not
# a reason to let the speed requirement pass unchecked.
if [ -z "$LLAMA_URL" ]; then
  not_ok "llamacpp/status named no llama-server URL: the decode speed could not be measured"
else
  # About 900 prompt tokens and up to 200 out, thinking off: prefill and decode
  # as llama-server itself times them. cache_prompt off, so the prefill is real.
  SPEED_BODY=$(jq -cn --arg p "$(printf 'The quick brown fox jumps over the lazy dog near the river bank at dawn. %.0s' {1..60})Summarize this text in five sentences." \
    '{messages: [{role: "user", content: $p}], max_tokens: 200, temperature: 0, cache_prompt: false, chat_template_kwargs: {enable_thinking: false}}')
  # shellcheck disable=SC2016  # expanded on the board
  SPEED=$(board 'curl -sS --max-time 240 -H "Content-Type: application/json" --data-binary "$2" "${1%/}/chat/completions"' "$LLAMA_URL" "$SPEED_BODY")
  DECODE=$(jq -r '.timings.predicted_per_second // empty | floor' <<<"$SPEED" 2>/dev/null)
  PREFILL=$(jq -r '.timings.prompt_per_second // empty | floor' <<<"$SPEED" 2>/dev/null)
  NOTE_SPEED=$(jq -r '"\(.timings.prompt_n // "?") prompt tokens, \(.timings.predicted_n // "?") generated"' <<<"$SPEED" 2>/dev/null)
  if [ -z "$DECODE" ]; then
    not_ok "no decode speed from llama-server right after the turn: $(printf '%s' "${SPEED:-no answer}" | tr '\n' ' ' | head -c 200)"
  elif [ "$DECODE" -ge "$MIN_DECODE_TOK_S" ]; then
    ok "llama-server decodes at $DECODE tok/s and prefills at ${PREFILL:-?} tok/s ($NOTE_SPEED)"
  else
    not_ok "llama-server decodes at only $DECODE tok/s (want at least $MIN_DECODE_TOK_S): is the model still on the GPU?"
  fi
fi

# ---- the window, the KV cache and thinking on demand ---------------------------

# word KEY LINE — the value after "KEY=" in a "k=v k=v" line, "" when absent.
word() { sed -n -E "s/.* $1=([^ ]*).*/\\1/p" <<<" $2" | head -n 1; }

# llama-server has just answered the speed prompt, so it is up: read the flags
# it really runs with, not the .env that should have produced them.
ROW=$(local_row_snapshot "$LOCAL_MODEL")
FLAGS=$(server_flags)
note "OpenClaw's row for $LOCAL_MODEL: ${ROW:-unreadable}; llama-server runs with: ${FLAGS:-unreadable}"
ROW_CTX=$(jq -r '.contextWindow // empty' <<<"$ROW" 2>/dev/null)
ROW_MAX=$(jq -r '.maxTokens // empty' <<<"$ROW" 2>/dev/null)
S_CTX=$(word ctx "$FLAGS") S_CTK=$(word ctk "$FLAGS") S_CTV=$(word ctv "$FLAGS") S_REASONING=$(word reasoning "$FLAGS")

# start-llamacpp.sh always passes all four, so a missing one is a failed read.
if [ -z "$S_CTX" ] || [ -z "$S_CTK" ] || [ -z "$S_CTV" ] || [ -z "$S_REASONING" ]; then
  not_ok "llama-server's launch flags could not be read after the turn (${FLAGS:-no answer})"
else
  if [ "$S_CTX" = "$ROW_CTX" ]; then
    ok "OpenClaw is told the window llama-server has: $S_CTX tokens"
  else
    not_ok "llama-server runs a $S_CTX-token window but OpenClaw's row says ${ROW_CTX:-nothing}"
  fi
  if [ "$S_CTX" = "$SUPERSEDED_CTX" ] || [ "$S_CTK" = "$SUPERSEDED_KV" ] || [ "$S_CTV" = "$SUPERSEDED_KV" ]; then
    not_ok "llama-server still runs a superseded launch value: window $S_CTX, KV cache $S_CTK/$S_CTV (shipped: $SHIPPED_CTX, $SHIPPED_KV/$SHIPPED_KV)"
  elif [ "$S_CTX" = "$SHIPPED_CTX" ] && [ "$S_CTK" = "$SHIPPED_KV" ] && [ "$S_CTV" = "$SHIPPED_KV" ]; then
    ok "llama-server runs the shipped launch: a $SHIPPED_CTX-token window and a $SHIPPED_KV KV cache"
  else
    note "llama-server runs window $S_CTX, KV cache $S_CTK/$S_CTV, not the shipped $SHIPPED_CTX, $SHIPPED_KV/$SHIPPED_KV (an owner's own .env value)"
  fi
fi
if [ -z "$ROW_MAX" ]; then
  not_ok "OpenClaw's row for $LOCAL_MODEL names no maxTokens (the gateway pre-start always writes one)"
elif [ "$ROW_MAX" = "$SUPERSEDED_MAX_TOKENS" ]; then
  not_ok "OpenClaw's row still lets one answer run to the superseded $SUPERSEDED_MAX_TOKENS tokens"
elif [ "$ROW_MAX" = "$SHIPPED_MAX_TOKENS" ]; then
  ok "one answer is capped at $SHIPPED_MAX_TOKENS tokens"
else
  note "OpenClaw's row caps one answer at ${ROW_MAX:-nothing} tokens (shipped: $SHIPPED_MAX_TOKENS)"
fi

EFFORTS=$(jq -c '.efforts' <<<"$ROW" 2>/dev/null)
THINK_DEFAULT=$(jq -r '.thinking // empty' <<<"$ROW" 2>/dev/null)
if [ "$(jq -r '.reasoning' <<<"$ROW" 2>/dev/null)" = true ] && [ "$EFFORTS" = '["none","high"]' ] \
  && [ "$THINK_DEFAULT" = off ] && [ "$S_REASONING" = off ]; then
  ok "thinking is per request: the row offers none/high, the model's default is off and llama-server starts with --reasoning off"
else
  not_ok "thinking is not declared per request and off by default: row reasoning $(jq -c '.reasoning' <<<"$ROW" 2>/dev/null), efforts ${EFFORTS:-?}, model default ${THINK_DEFAULT:-unset}, llama-server --reasoning ${S_REASONING:-?}"
fi

# One short turn on a session of its own: a TURN line, then the CLI's JSON.
# $5 is a --thinking level, or "" for the level the model has by default.
# shellcheck disable=SC2016  # expanded on the board
THINK_TURN='
  bin=$1 key=$2 prompt=$3 secs=$4 level=$5
  extra=()
  [ -n "$level" ] && extra=(--thinking "$level")
  out=$(mktemp)
  start=$(date +%s)
  timeout "$secs" "$bin" agent --agent main --session-key "$key" -m "$prompt" "${extra[@]}" --json --timeout $((secs - 20)) > "$out"
  rc=$?
  echo "TURN rc=$rc secs=$(( $(date +%s) - start ))"
  sed -n "/^{/,\$p" "$out"
  rm -f "$out"
'

# think_turn LEVEL — one THINK_PROMPT turn; sets T_RC, T_SECS, T_PROVIDER, T_OUT.
think_turn() {
  local answer line json meta reply
  answer=$(board "$THINK_TURN" "$OPENCLAW_BIN" "nano-ci-$NANO_RUN_ID-local-think-${1:-default}-$(date +%s)" "$THINK_PROMPT" "$THINK_TURN_SECONDS" "$1")
  line=$(grep -m 1 '^TURN ' <<<"$answer")
  json=$(sed -n '/^{/,$p' <<<"$answer")
  meta=$(jq -c 'first(.. | objects | select(has("agentMeta")) | .agentMeta) // {}' <<<"$json" 2>/dev/null)
  [ -n "$meta" ] || meta='{}'
  T_RC=$(val rc "$line") T_SECS=$(val secs "$line")
  T_PROVIDER=$(jq -r '.provider // empty' <<<"$meta" 2>/dev/null)
  T_OUT=$(jq -r '.usage.output // empty' <<<"$meta" 2>/dev/null)
  reply=$(jq -r '[ (.result.payloads // [])[]?.text, .result.text, .reply, .text ]
    | map(select(type == "string")) | join(" ")' <<<"$json" 2>/dev/null | tr '\n' ' ' | head -c 200)
  note "thinking ${1:-at the default level}: ${line:-no answer from the board}; answered by ${T_PROVIDER:-?}, ${T_OUT:-?} output tokens; reply: ${reply:-none}"
}

if [ "$SECONDS" -gt "$THINK_START_BY" ]; then
  not_ok "no time left for the thinking check: $SECONDS s spent, its two turns may take $((2 * THINK_TURN_SECONDS)) s"
else
  think_turn ""
  OFF_RC=$T_RC OFF_SECS=$T_SECS OFF_PROVIDER=$T_PROVIDER OFF_OUT=$T_OUT
  think_turn high
  HIGH_RC=$T_RC HIGH_SECS=$T_SECS HIGH_PROVIDER=$T_PROVIDER HIGH_OUT=$T_OUT
  if [ "$OFF_RC" != 0 ] || [ "$HIGH_RC" != 0 ]; then
    not_ok "a thinking-check turn failed (default level: exit ${OFF_RC:-?}, --thinking high: exit ${HIGH_RC:-?})"
  elif [ "$OFF_PROVIDER" != llamacpp ] || [ "$HIGH_PROVIDER" != llamacpp ]; then
    not_ok "a thinking-check turn was not answered by the on-device model (default level: ${OFF_PROVIDER:-?}, --thinking high: ${HIGH_PROVIDER:-?})"
  elif ! [[ $OFF_OUT =~ ^[0-9]+$ && $HIGH_OUT =~ ^[0-9]+$ ]]; then
    not_ok "the CLI's JSON names no output tokens for a thinking-check turn (default level: ${OFF_OUT:-none}, --thinking high: ${HIGH_OUT:-none})"
  elif [ "$HIGH_OUT" -ge $((OFF_OUT + THINK_MIN_EXTRA_OUTPUT)) ]; then
    ok "thinking is off by default and on when asked: $OFF_OUT output tokens in ${OFF_SECS:-?} s at the default level, $HIGH_OUT in ${HIGH_SECS:-?} s with --thinking high"
  else
    not_ok "thinking did not follow the level: $HIGH_OUT output tokens with --thinking high against $OFF_OUT at the default level (want at least $THINK_MIN_EXTRA_OUTPUT more)"
  fi
fi

restore
finish
