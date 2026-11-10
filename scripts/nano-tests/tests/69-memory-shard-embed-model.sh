#!/usr/bin/env bash
# timeout: 1800
# tier: long
# covers: scripts/start-embed-server.sh scripts/embed-model-select.sh scripts/ensure-local-embeddings.sh
# covers: src/lib/embed-server.ts src/lib/embed-runtime-ids.ts src/lib/local-embedding-gating.ts src/lib/local-embedding-model.ts
# covers: src/lib/embed-install-task.ts src/lib/embed-model-fetch.ts src/lib/memory-embedder.ts src/lib/memory-shard.ts
# covers: src/app/setup-api/embed/* src/app/setup-api/clawkeep/memory/provider/* mcp/tools/memory.ts
#
# The local embedding model choice (TASK-2411), on a real Jetson, on whichever
# runtime the board runs (OpenClaw or Hermes):
#
#   * Qwen3-Embedding-4B is offered as UNAVAILABLE here, with the plain
#     Jetson reason — in /setup-api/embed/status, in the provider GET and in
#     the MCP server's memory_shard_provider_get;
#   * every way of asking for it is refused and changes nothing: the
#     provider POST as the owner and as the assistant (409
#     local_model_unavailable, confirm or not), its download (409), and
#     memory_shard_provider_set over the box's own MCP server
#     (NOT_SUPPORTED_HERE) — no 4B pick in data/config.json, no 4B file;
#   * Qwen3-Embedding-0.6B installs, indexes and searches as before: the
#     owner's download (when it is not here yet), the switch onto the box,
#     a full pass over a folder of the test's own, and a search that finds
#     the test's note — through ClawBox's search route on Hermes, through
#     `openclaw memory search` on OpenClaw — with the embedder answering as
#     qwen3-embedding-0.6b.
#
# Put back on the way out: the folder, the source, the provider and Memory
# Shard's switch as they were. An index that was in the cloud is moved back
# there and a full pass is asked for: the cloud index the test replaced is
# rebuilt, not restored byte for byte.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

SMALL=qwen3-embedding-0.6b
LARGE=qwen3-embedding-4b
RUNTIME=$(board_runtime 2>/dev/null || echo unknown)
note "runtime: $RUNTIME"

# ---- 1. the 4B is unavailable on a Jetson, with the reason ----------------------

board_owner_api GET /setup-api/embed/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "embed/status did not answer: $(api_error)"
  finish
fi
EMBED_STATUS=$API_BODY
note "embed/status: model $(api_json '.model') ($(api_json '.modelId // "no id"') $(api_json '.quant // ""')), installed $(api_json '.installed')"
ROW_4B=$(api_json --arg id "$LARGE" '(.models // [])[] | select(.id == $id) | {available, reason, detail} | tostring')
if [ "$(jq -r '.available' <<<"$ROW_4B" 2>/dev/null)" = false ] && [ "$(jq -r '.reason' <<<"$ROW_4B" 2>/dev/null)" = jetson ]; then
  ok "embed/status offers $LARGE as unavailable on this Jetson: $(jq -r '.detail' <<<"$ROW_4B")"
else
  not_ok "embed/status does not mark $LARGE unavailable for the Jetson reason: ${ROW_4B:-no row}"
fi
if [ "$(api_json --arg id "$SMALL" '(.models // [])[] | select(.id == $id) | .available')" = true ]; then
  ok "embed/status offers $SMALL as available"
else
  not_ok "embed/status does not offer $SMALL: $(printf '%s' "$EMBED_STATUS" | head -c 300)"
fi

board_owner_api GET /setup-api/clawkeep/memory/provider
if [ "$API_STATUS" != 200 ]; then
  not_ok "the provider GET did not answer: $(api_error)"
  finish
fi
BEFORE_SOURCE=$(api_json '.source')
BEFORE_MODEL=$(api_json '.localModel // empty')
if [ "$BEFORE_MODEL" = "$SMALL" ] \
  && [ "$(api_json --arg id "$LARGE" '(.localModels // [])[] | select(.id == $id) | "\(.available) \(.reason)"')" = "false jetson" ]; then
  ok "the provider GET: index on $BEFORE_SOURCE, local model $BEFORE_MODEL, $LARGE unavailable (jetson)"
else
  not_ok "the provider GET does not say local model $SMALL with $LARGE unavailable: $(printf '%s' "$API_BODY" | head -c 400)"
fi

# ---- 2. every way of asking for the 4B is refused -------------------------------

expect_refused() {  # LABEL STATUS KIND
  if [ "$API_STATUS" = "$2" ] && [ "$(api_json '.kind')" = "$3" ]; then
    ok "$1 is refused: $API_STATUS $3 ($(api_json '.reason // empty'): $(api_json '.error' | head -c 160))"
  else
    not_ok "$1 was not refused with $2 $3: $API_STATUS $(printf '%s' "$API_BODY" | head -c 300)"
  fi
}
board_owner_api POST /setup-api/clawkeep/memory/provider "{\"source\":\"local\",\"localModel\":\"$LARGE\"}"
expect_refused "the owner's switch to $LARGE" 409 local_model_unavailable
board_api POST /setup-api/clawkeep/memory/provider "{\"source\":\"local\",\"localModel\":\"$LARGE\",\"confirm\":true}"
expect_refused "the assistant's switch to $LARGE with confirm: true" 409 local_model_unavailable
board_owner_api POST /setup-api/embed/install "{\"model\":\"$LARGE\"}"
expect_refused "the owner's download of $LARGE" 409 local_model_unavailable

# The box's own MCP server, started over stdio as a harness starts it.
# shellcheck disable=SC2016  # JavaScript, not shell
SESSION='
(async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["run", "mcp/clawbox-mcp.ts"], cwd: process.cwd(), stderr: "ignore" });
  const client = new Client({ name: "nano-ci", version: "1.0.0" });
  await client.connect(transport);
  const text = (r) => (Array.isArray(r.content) && r.content[0] && r.content[0].type === "text" ? r.content[0].text : "");
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: text(r) }; };
  const out = {};
  out.get = await call("memory_shard_provider_get", {});
  out.set = await call("memory_shard_provider_set", { source: "local", local_model: "qwen3-embedding-4b", confirm: true });
  console.log(JSON.stringify(out));
  await client.close();
  process.exit(0);
})().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
'
# shellcheck disable=SC2016  # expanded on the board
RAW=$(board 'cd "$REPO" && exec timeout 180 bun -e "$1"' "$SESSION")
MCP=$(printf '%s\n' "$RAW" | grep '^{' | tail -n 1)
if [ -z "$MCP" ] || ! jq -e . >/dev/null 2>&1 <<<"$MCP"; then
  not_ok "the MCP session did not answer: $(printf '%s' "$RAW" | tail -n 3 | tr '\n' ' ' | head -c 300)"
else
  GET_TEXT=$(jq -r '.get.text' <<<"$MCP")
  if [ "$(jq -r '.local_model' <<<"$GET_TEXT" 2>/dev/null)" = "$SMALL" ] \
    && [ "$(jq -r --arg id "$LARGE" '.local_models[]? | select(.model == $id) | .runs_on_this_box' <<<"$GET_TEXT" 2>/dev/null)" = false ]; then
    ok "memory_shard_provider_get: local_model $SMALL; $LARGE runs_on_this_box false — $(jq -r --arg id "$LARGE" '.local_models[]? | select(.model == $id) | .why_not' <<<"$GET_TEXT" | head -c 160)"
  else
    not_ok "memory_shard_provider_get does not report $LARGE as not running here: $(printf '%s' "$GET_TEXT" | head -c 300)"
  fi
  if [ "$(jq -r '.set.isError' <<<"$MCP")" = true ] && grep -qiE "NOT_SUPPORTED_HERE|Jetson" <<<"$(jq -r '.set.text' <<<"$MCP")"; then
    ok "memory_shard_provider_set local_model $LARGE is refused: $(jq -r '.set.text' <<<"$MCP" | tr '\n' ' ' | head -c 200)"
  else
    not_ok "memory_shard_provider_set local_model $LARGE was not refused: $(jq -c '.set' <<<"$MCP" | head -c 300)"
  fi
fi

# Nothing moved: no 4B pick recorded, no 4B file fetched.
# shellcheck disable=SC2016  # expanded on the board
LEFT=$(board '
  pick=$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get(\"memory_shard_local_model\") or \"none\")" "$REPO/data/config.json" 2>/dev/null || echo unreadable)
  files=$(ls "$REPO/data/embed/models" 2>/dev/null | grep -c "Qwen3-Embedding-4B" || true)
  echo "pick=$pick files=$files"
' | tail -n 1)
if [[ $LEFT == "pick=none files=0" || $LEFT == "pick=$SMALL files=0" ]]; then
  ok "nothing was written by the refusals ($LEFT)"
else
  not_ok "a refusal left something behind: $LEFT"
fi

# ---- 3. the 0.6B installs, indexes and searches as before -----------------------

board_owner_api GET /setup-api/clawkeep/memory
WAS_ENABLED=$(api_json '.enabled')
note "Memory Shard before: enabled ${WAS_ENABLED:-?}, location $(api_json '.location // "?"'), model $(api_json '.model // "?"')"

DIR=/home/clawbox/nano-ci-embed-${NANO_RUN_ID:-$$}
PHRASE="The lighthouse keeper on Sveti Ivan paints his bicycle teal every April"
SOURCE_ADDED=0 SWITCHED=0 ENABLED_HERE=0 RESTORED=0
restore() {
  [ "$RESTORED" = 1 ] && return 0
  RESTORED=1
  if [ "$SOURCE_ADDED" = 1 ]; then
    board_owner_api DELETE /setup-api/clawkeep/memory/sources "{\"path\":\"$DIR\"}"
    [ "$API_STATUS" = 200 ] && note "removed the test's folder from Memory Shard" || not_ok "could not remove the test's folder from Memory Shard: $(api_error)"
  fi
  if [ "$SWITCHED" = 1 ] && [ "$BEFORE_SOURCE" = cloud ]; then
    board_owner_api POST /setup-api/clawkeep/memory/provider '{"source":"cloud"}'
    if [ "$API_STATUS" = 200 ]; then
      note "the index is back on the cloud embedder"
      # It belongs to the model that wrote it: the full pass the switch needs.
      board_owner_api POST /setup-api/clawkeep/memory/index '{"mode":"full"}'
      note "full pass for the cloud index asked for: $API_STATUS"
    else
      not_ok "could not put the index back on the cloud: $(api_error)"
    fi
  fi
  if [ "$ENABLED_HERE" = 1 ]; then
    board_owner_api POST /setup-api/clawkeep/memory/enable '{"enabled":false}'
    note "Memory Shard switched off again (this test switched it on): $API_STATUS"
  fi
  # shellcheck disable=SC2016  # expanded on the board
  board 'rm -rf -- "$1"' "$DIR" >/dev/null
}
trap restore EXIT
trap 'restore; exit 143' TERM INT

# shellcheck disable=SC2016  # expanded on the board
board 'mkdir -p "$1" && printf "# Island notes\n\n%s, and logs the ferry times in a green notebook.\n" "$2" > "$1/island-notes.md" && echo made' "$DIR" "$PHRASE" >/dev/null

if [ "$(jq -r '.installed' <<<"$EMBED_STATUS")" != true ]; then
  # The owner's Install: an NDJSON stream whose last line says how it ended.
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board 'API_MAX_TIME=1500 owner_api POST /setup-api/embed/install "$1"' "{\"model\":\"$SMALL\"}")
  last=$(printf '%s\n' "$out" | tail -n +2 | jq -c 'select(.success != null or .error != null)' 2>/dev/null | tail -n 1)
  if [ "$(jq -r '.success // false' <<<"$last" 2>/dev/null)" = true ]; then
    ok "$SMALL installed through the owner's download (embed_model): $(jq -r '.status // ""' <<<"$last")"
  else
    not_ok "the $SMALL download did not finish: ${last:-$(printf '%s' "$out" | tail -n 2 | head -c 300)}"
    finish
  fi
else
  ok "$SMALL is already on the board ($(jq -r '.modelBytes' <<<"$EMBED_STATUS") bytes)"
fi

if [ "$WAS_ENABLED" != true ]; then
  board_owner_api POST /setup-api/clawkeep/memory/enable '{"enabled":true,"setupComplete":true}'
  if [ "$API_STATUS" = 200 ]; then
    ENABLED_HERE=1
  else
    skip "Memory Shard could not be switched on here ($API_STATUS $(api_json '.error // .message // empty' | head -c 160)): the index/search half needs it"
    finish
  fi
fi

board_owner_api POST /setup-api/clawkeep/memory/sources "{\"path\":\"$DIR\"}"
if [ "$API_STATUS" = 200 ]; then
  SOURCE_ADDED=1
else
  not_ok "could not add the test's folder: $(api_error)"
  finish
fi

board_owner_api POST /setup-api/clawkeep/memory/provider "{\"source\":\"local\",\"localModel\":\"$SMALL\"}"
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.model')" = "$SMALL" ]; then
  SWITCHED=1
  ok "memory search is on the box: $(api_json '.provider')/$(api_json '.model') ($(api_json '.engine'))"
else
  not_ok "the switch onto $SMALL did not land: $API_STATUS $(printf '%s' "$API_BODY" | head -c 300)"
  finish
fi

board_owner_api POST /setup-api/clawkeep/memory/index '{"mode":"full"}'
note "full pass asked for: $API_STATUS $(api_json '.run.status // .kind // empty')"
DONE="" STATUS_LINE=""
for _ in $(seq 1 120); do
  sleep 10
  board_owner_api GET /setup-api/clawkeep/memory
  RUN=$(api_json '.run.status // empty')
  STATUS_LINE="run ${RUN:-none} ($(api_json '.run.mode // empty')), location $(api_json '.location // empty'), model $(api_json '.model // empty'), files $(api_json '.files // 0'), chunks $(api_json '.chunks // 0'), identity $(api_json '.indexIdentity // empty')"
  case "$RUN" in
    running|queued|"") ;;
    *) DONE=$RUN; break ;;
  esac
done
note "after the pass: $STATUS_LINE"
if [ "$DONE" = succeeded ] && [ "$(api_json '.model')" = "$SMALL" ] && [ "$(api_json '.chunks // 0')" -gt 0 ]; then
  ok "the full pass on $SMALL succeeded: $STATUS_LINE"
else
  not_ok "the full pass on $SMALL did not succeed: $STATUS_LINE"
fi

# The embedder that answered: the proxy's /models, through the box's own token.
# shellcheck disable=SC2016  # expanded on the board
SERVED=$(board 'curl -sS --max-time 120 -H "Authorization: Bearer $(cat "$REPO/data/.local-ai-token")" "$DASHBOARD/setup-api/local-ai/embed/v1/models"' | tail -n 1)
if [ "$(jq -r '.data[0].id // empty' <<<"$SERVED" 2>/dev/null)" = "$SMALL" ]; then
  ok "the embedder answers as $SMALL"
else
  not_ok "the embedder does not answer as $SMALL: $(printf '%s' "$SERVED" | head -c 200)"
fi

QUERY="who paints a bicycle at the lighthouse"
if [ "$RUNTIME" = hermes ]; then
  board_owner_api GET "/setup-api/clawkeep/memory/search?q=$(jq -rn --arg q "$QUERY" '$q|@uri')&limit=5"
  if [ "$API_STATUS" = 200 ] && api_json '[.hits[]?.path // empty] | join(" ")' | grep -q island-notes.md; then
    ok "the search for \"$QUERY\" finds the test's note on $SMALL (Hermes, ClawBox's index): $(api_json '.hits[0].path')"
  else
    not_ok "the search for \"$QUERY\" did not find the test's note: $API_STATUS $(printf '%s' "$API_BODY" | head -c 300)"
  fi
else
  # shellcheck disable=SC2016  # expanded on the board
  FOUND=$(board 'timeout 300 openclaw memory search --json "$1" 2>/dev/null || timeout 300 openclaw memory search "$1" 2>&1' "$QUERY")
  if grep -q island-notes.md <<<"$FOUND"; then
    ok "openclaw memory search for \"$QUERY\" finds the test's note on $SMALL (OpenClaw's index)"
  else
    not_ok "openclaw memory search for \"$QUERY\" did not find the test's note: $(printf '%s' "$FOUND" | tr '\n' ' ' | head -c 300)"
  fi
fi

restore
finish
