#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/local-anthropic.ts src/lib/local-anthropic-route.ts src/app/setup-api/local-ai/anthropic/*
# covers: src/lib/coding-provider.ts src/lib/coding-role-models.ts scripts/claude-ds
# covers: scripts/nano-tests/board/coding-engine-mock.mjs scripts/nano-tests/board/run-egress-sampler.mjs
#
# A coding run on the box's own engine under the local-only AI lock
# (TASK-2501 PR-E), on the runtime the board runs.
#
# The lock (`ai_cloud_lock: true` in data/config.json) is put on for the
# test's length, and an OpenAI-compatible engine is started on the board
# (board/coding-engine-mock.mjs, with a key of its own) and recorded as the
# box's External engine. Then, through the running server:
#
#   * the coding agent's status says the lock is on: the box's engine is the
#     only provider (`local`, on the mock's model), and runs make no media;
#   * Codex is refused cleanly, saying why — the pinned Codex speaks only the
#     Responses API, which the engine does not serve — and so is every cloud
#     provider, before anything starts;
#   * one coding run with Claude Code, on the owner's default (which the lock
#     makes `local`), fixes a tiny repository's bug and runs its test through
#     the box's route (/setup-api/local-ai/anthropic): the engine's log holds
#     every turn — Read, Edit, Bash, the closing words — each with the key the
#     BOX holds, none asking for thinking; the test passes on the board after;
#   * while it works, none of the run's processes connects anywhere but this
#     box (board/run-egress-sampler.mjs): no cloud AI host, no telemetry.
#
# Every key it set is put back as it was — the lock, the engine record and its
# key file, the coding agent's switch — and the mock, its files and the
# project folder are removed, on any way out. Refuses to run over an External
# engine the owner set up.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
PORT=18941
MODEL="nano-ci/coder-1"
RUN=${NANO_RUN_ID:-$$}
DIR="/tmp/nano-localcode-$RUN"
note "agent runtime: $RUNTIME"

# The saved keys are the only copy of what the box had: the folder holding them
# goes only once keys.cjs says KEYS_RESTORED. Anything else (a store it could
# not read, a copy it could not parse) keeps the folder and fails the test,
# saying where the copy is.
#
# SC2016: the board script expands on the board; SC2317: run by the EXIT trap.
# shellcheck disable=SC2016,SC2317
cleanup() {
  local out
  out=$(board '
    [ -f "$1/sampler.stop" ] || touch "$1/sampler.stop" 2>/dev/null
    [ -f "$1/mock.pid" ] && kill "$(cat "$1/mock.pid")" 2>/dev/null
    if [ -f "$1/saved.json" ]; then
      restored=$(cd "$REPO" && node "$1/keys.cjs" off data/config.json "$1/saved.json" "$1/saved-key" 2>&1)
      printf "%s\n" "$restored"
      case "$restored" in
        *KEYS_RESTORED*) ;;
        *) echo "KEYS_KEPT $1"; exit 0 ;;
      esac
    fi
    rm -rf "$1"
  ' "$DIR")
  printf '%s\n' "$out" | sed 's/^/# cleanup: /'
  if printf '%s\n' "$out" | grep -q '^KEYS_KEPT '; then
    not_ok "the box's keys were not put back; the saved copy is kept on the board in $DIR"
  fi
  remove_project_dir
}
trap cleanup EXIT

# 1. The engine, the lock and the switch — each key saved first, put back by
#    the trap. The store is rewritten atomically, 0600, as the box writes it.
# shellcheck disable=SC2016  # expanded on the board
up=$(board '
  mkdir -p "$1" && chmod 700 "$1"
  cat > "$1/keys.cjs" <<"JS"
const fs = require("fs");
const [mode, cfgPath, savedPath, savedKeyPath, base, model, harness] = process.argv.slice(2);
const KEYS = ["ai_cloud_lock", "external_engine", "coding_agent_enabled"];
const keyFile = require("path").join(require("path").dirname(cfgPath), ".external-engine-key");
const read = () => { const c = JSON.parse(fs.readFileSync(cfgPath, "utf8")); if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("not an object"); return c; };
const write = (c) => { const t = cfgPath + ".nano-tmp"; fs.writeFileSync(t, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(t, cfgPath); };
let c;
try { c = read(); } catch (err) { console.log("CONFIG_UNREADABLE " + (err && err.message)); process.exit(0); }
if (mode === "on") {
  if (c.external_engine) { console.log("OWNER_ENGINE"); process.exit(0); }
  const before = Object.fromEntries(KEYS.map((k) => [k, Object.prototype.hasOwnProperty.call(c, k) ? c[k] : null]));
  fs.writeFileSync(savedPath, JSON.stringify(before), { mode: 0o600 });
  try { fs.copyFileSync(keyFile, savedKeyPath); } catch {}
  fs.writeFileSync(keyFile, fs.readFileSync(require("path").join(require("path").dirname(savedPath), "key"), "utf8"), { mode: 0o600 });
  c.ai_cloud_lock = true;
  c.coding_agent_enabled = true;
  c.external_engine = { baseUrl: base, modelId: model, contextWindow: 131072, maxTokens: 8192, imageInput: false, harness, savedAt: new Date().toISOString(), previous: { store: {} } };
  write(c);
  const after = read();
  if (after.ai_cloud_lock === true && after.external_engine && after.external_engine.modelId === model) console.log("KEYS_SET");
} else {
  let before = null;
  try { before = JSON.parse(fs.readFileSync(savedPath, "utf8")); } catch {}
  if (!before) process.exit(0);
  for (const k of KEYS) { if (before[k] === null || before[k] === undefined) delete c[k]; else c[k] = before[k]; }
  write(c);
  if (fs.existsSync(savedKeyPath)) fs.copyFileSync(savedKeyPath, keyFile); else { try { fs.unlinkSync(keyFile); } catch {} }
  console.log("KEYS_RESTORED");
}
JS
  head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n" > "$1/key"; chmod 600 "$1/key"
  setsid nohup node "$REPO/scripts/nano-tests/board/coding-engine-mock.mjs" --port "$2" --model "$3" \
    --key-file "$1/key" --log "$1/requests.jsonl" > "$1/mock.out" 2>&1 < /dev/null &
  echo $! > "$1/mock.pid"
  for _ in $(seq 1 30); do grep -q READY "$1/mock.out" 2>/dev/null && break; sleep 0.5; done
  grep -q READY "$1/mock.out" || { echo "MOCK_DOWN $(tail -n 3 "$1/mock.out" | tr "\n" " ")"; exit 0; }
  cd "$REPO" && node "$1/keys.cjs" on data/config.json "$1/saved.json" "$1/saved-key" "http://127.0.0.1:$2/v1" "$3" "$4"
' "$DIR" "$PORT" "$MODEL" "$RUNTIME")
case "$up" in
  *MOCK_DOWN*) not_ok "the engine mock did not start: $up"; finish ;;
  *OWNER_ENGINE*) skip "an External engine the owner set up is on this board; this test does not run over it"; finish ;;
  *KEYS_SET*) ok "an OpenAI-compatible engine (mock, key of its own) is the box's External engine, and the local-only AI lock is on" ;;
  *) not_ok "the lock and the engine could not be set in data/config.json: $(printf '%s' "$up" | head -c 300)"; finish ;;
esac

# 2. What the coding agent says under the lock.
board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.cloudAiLocked')" = true ] && [ "$(api_json '.provider')" = local ] \
  && [ "$(api_json '.providers | join(",")')" = local ] && [ "$(api_json '.connectedProviders | join(",")')" = local ] \
  && [ "$(api_json '.localEngineModel')" = "$MODEL" ] && [ "$(api_json '.generateMedia')" = false ]; then
  ok "status: the lock is on, the box's engine ($MODEL) is the only provider, runs make no media"
else
  not_ok "status under the lock: $(api_error) locked=$(api_json '.cloudAiLocked') provider=$(api_json '.provider') providers=$(api_json '.providers|tostring') engine=$(api_json '.localEngineModel') media=$(api_json '.generateMedia')"
fi
LOCAL_READY=$(api_json '.readiness.providers[] | select(.id == "local") | .ready')
if [ "$LOCAL_READY" = true ]; then ok "the local provider is ready"; else not_ok "the local provider is not ready: $(api_json '.readiness.providers[] | select(.id == "local") | .problems | join(" ")') $(api_json '.readiness.problems | join(" ")')"; fi
fresh_project_dir "-localcode" || { not_ok "could not prepare a project folder"; finish; }

# 3. Codex, and every cloud provider, refused before anything starts.
board_api POST /setup-api/coding-agent/run "$(jq -cn --arg dir "$PROJECT_DIR" '{task: "Say hello.", directory: $dir, provider: "openai"}')"
case "$API_STATUS" in
  400|409)
    if api_json '.error' | grep -q 'Responses API'; then ok "Codex is refused cleanly (HTTP $API_STATUS): $(api_json '.error' | head -c 220)"
    else not_ok "Codex was refused without saying why: $(api_error)"; fi ;;
  *) not_ok "a Codex run under the lock was not refused: $(api_error)" ;;
esac
for cloud in anthropic clawbox-ai; do
  board_api POST /setup-api/coding-agent/run "$(jq -cn --arg dir "$PROJECT_DIR" --arg p "$cloud" '{task: "Say hello.", directory: $dir, provider: $p}')"
  if { [ "$API_STATUS" = 400 ] || [ "$API_STATUS" = 409 ]; } && api_json '.error' | grep -q 'local-only AI lock is on'; then
    ok "a run on $cloud is refused under the lock (HTTP $API_STATUS)"
  else
    not_ok "a run on $cloud under the lock: $(api_error)"
  fi
done

# 4. A tiny repository with a bug and a test, and the run that fixes it.
# shellcheck disable=SC2016  # expanded on the board
board '
  cd "$1" || exit 1
  printf "module.exports = (a, b) => a - b;\n" > add.js
  printf "node -e '\''const add = require(\"./add.js\"); if (add(2, 3) !== 5) { console.log(\"TESTS-FAILED\"); process.exit(1); } console.log(\"TESTS-PASS\");'\''\n" > test.sh
  git init -q && git -c user.name=nano-ci -c user.email=nano-ci@example.invalid add -A \
    && git -c user.name=nano-ci -c user.email=nano-ci@example.invalid commit -qm "add with a bug"
  sh test.sh || true
  rm -f "$2/sampler.stop"
  setsid nohup node "$REPO/scripts/nano-tests/board/run-egress-sampler.mjs" --out "$2/egress.json" --stop-file "$2/sampler.stop" --max-seconds 700 \
    > "$2/sampler.out" 2>&1 < /dev/null &
' "$PROJECT_DIR" "$DIR" | sed 's/^/# repo: /'

if start_coding_run "Fix the bug in add.js so that sh test.sh prints TESTS-PASS. Run the test to check."; then
  ok "a run started on the owner's default: $RUN_ID"
else
  not_ok "the run did not start: $(api_error)"
  finish
fi
wait_coding_run 600
expect_completed
note "run account: $(run_account)"
PROVIDER=$(api_json '.run.provider')
RUN_MODEL=$(api_json '.run.model // .run.requestedModel')
RUN_DIR=$(api_json '.run.directory')
if [ "$PROVIDER" = local ]; then ok "the run was on the box's own engine (provider local, model ${RUN_MODEL:-?})"; else not_ok "the run's provider is ${PROVIDER:-none}, not local"; fi

# 5. The engine's side, the result on disk, and where the run connected.
# shellcheck disable=SC2016  # expanded on the board
CHECK=$(board '
  touch "$1/sampler.stop"; sleep 1
  for _ in $(seq 1 20); do [ -s "$1/egress.json" ] && break; sleep 0.5; done
  node -e "
    const fs = require(\"fs\");
    const raw = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], \"utf8\") : \"\";
    const lines = raw.trim().split(\"\n\").filter(Boolean).map((l) => JSON.parse(l));
    const chat = lines.filter((l) => l.path === \"/v1/chat/completions\");
    const loop = chat.filter((l) => l.mainLoop);
    console.log(\"ENGINE \" + JSON.stringify({
      chat: chat.length,
      unauthorized: lines.filter((l) => !l.authorized).length,
      steps: [...new Set(loop.map((l) => l.step))],
      models: [...new Set(chat.map((l) => l.model))],
      streamed: chat.filter((l) => l.stream).length,
      thinking: chat.filter((l) => l.thinking).length,
      other: lines.filter((l) => l.path !== \"/v1/chat/completions\").map((l) => l.path),
    }));
  " "$1/requests.jsonl"
  echo "EGRESS $(cat "$1/egress.json" 2>/dev/null || echo "{}")"
  for d in "$2" "$3"; do
    [ -n "$d" ] && [ -f "$d/add.js" ] || continue
    echo "ADDJS $d $(tr -d "\n" < "$d/add.js")"
    echo "TEST $d $(cd "$d" && sh test.sh 2>&1 | tail -n 1)"
  done
' "$DIR" "$PROJECT_DIR" "$RUN_DIR")
ENGINE=$(printf '%s\n' "$CHECK" | sed -n 's/^ENGINE //p' | head -n1)
EGRESS=$(printf '%s\n' "$CHECK" | sed -n 's/^EGRESS //p' | head -n1)
note "engine log: $ENGINE"
note "run egress: $EGRESS"
STEPS=$(printf '%s' "$ENGINE" | jq -r '.steps | join(",")' 2>/dev/null)
case ",$STEPS," in
  *,read,*edit,*test,*done,*) ok "the engine drove the run's tool loop through the box's route: $STEPS" ;;
  *) not_ok "the engine did not see the whole tool loop (steps: ${STEPS:-none})" ;;
esac
if [ "$(printf '%s' "$ENGINE" | jq -r '.unauthorized')" = 0 ] && [ "$(printf '%s' "$ENGINE" | jq -r '.chat')" -ge 4 ] 2>/dev/null; then
  ok "every request reached the engine with the key the box holds ($(printf '%s' "$ENGINE" | jq -r '.chat') chat requests, $(printf '%s' "$ENGINE" | jq -r '.streamed') streamed)"
else
  not_ok "the engine's log: $ENGINE"
fi
if [ "$(printf '%s' "$ENGINE" | jq -r '.models | join(",")')" = "$MODEL" ] && [ "$(printf '%s' "$ENGINE" | jq -r '.thinking')" = 0 ]; then
  ok "every request named the engine's model ($MODEL), none asked for thinking"
else
  not_ok "models/thinking in the engine's log: $ENGINE"
fi
if printf '%s\n' "$CHECK" | grep -q '^TEST .* TESTS-PASS$' && printf '%s\n' "$CHECK" | grep -q '^ADDJS .*a + b'; then
  ok "add.js is fixed and sh test.sh prints TESTS-PASS on the board"
else
  not_ok "the fix is not on disk: $(printf '%s\n' "$CHECK" | grep -E '^(ADDJS|TEST) ' | tr '\n' ' ' | head -c 300)"
fi
SAMPLES=$(printf '%s' "$EGRESS" | jq -r '.samples // 0' 2>/dev/null)
EXTERNAL=$(printf '%s' "$EGRESS" | jq -r '.external | length' 2>/dev/null)
# At least one connection the sampler pinned on a run process — to the box's
# own route counts — or "zero off the box" would hold for a sampler that never
# saw the run at all.
SEEN=$(printf '%s' "$EGRESS" | jq -r '.endpoints // {} | length' 2>/dev/null)
if [ "${SAMPLES:-0}" -gt 0 ] && [ "$EXTERNAL" = 0 ] && [ "${SEEN:-0}" -gt 0 ] 2>/dev/null; then
  ok "zero connections off the box from the run's processes ($SAMPLES samples; endpoints: $(printf '%s' "$EGRESS" | jq -c '.endpoints'))"
elif [ "$EXTERNAL" = 0 ]; then
  not_ok "the sampler saw no connection from the run's processes at all, so it proves nothing ($SAMPLES samples)"
else
  not_ok "the run's processes connected off the box: $(printf '%s' "$EGRESS" | jq -c '.external') ($SAMPLES samples)"
fi

finish
