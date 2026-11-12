#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/feature-engine.ts src/lib/local-engine.ts src/lib/token-estimate.ts src/lib/prime-radiant/flash-client.ts src/lib/prime-radiant/writer.ts src/lib/prime-radiant/ingest.ts src/lib/prime-radiant/allowance-meter.ts src/lib/vision-describe.ts src/lib/memory-embedder.ts
#
# Prime Radiant, picture descriptions and Memory Shard's embedder on the box's
# own engine (TASK-2501 PR-C), on the runtime the board runs.
#
# The local-only AI lock (`ai_cloud_lock: true` in data/config.json, the key
# TASK-2501's lock is stored under) is put on for the test's own length — and
# Local AI on llama.cpp too, when it is off and the Gemma GGUF and the binary
# are on disk (the test downloads nothing). Then, in-process from the checkout
# with bun (every fetch recorded — none may reach ClawBox AI's proxy or its
# cloud embedder):
#   - the features' engine is the box's own, and Prime Radiant's client carries
#     its budget (window, one call at a time);
#   - a picture is described by the engine when it can see, and refused in
#     words, asking nothing, when it cannot (llama.cpp runs without its
#     vision projector);
#   - Memory Shard's embedder is the one on the box, and embeds a text through
#     the Local AI proxy when its model is installed.
# And through the running server, as the owner: an ingest of two small
# documents under ~/Documents is written by that engine (pages; every cost row
# under the engine's ref; the Usage meter's `engine: local` with no new
# ClawBox AI call), then every commit it made is undone through the revert
# route. Every key the test set is put back as it was on any way out, and its
# documents are removed.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
note "runtime: $RUNTIME"

# The in-process checks: one JSON line, the last line of the answer.
# shellcheck disable=SC2016  # JavaScript, not shell
CHECKS='
(async () => {
  const R = process.cwd();
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => { urls.push(String(typeof input === "string" ? input : input.url)); return realFetch(input, init); };
  const out = {};
  try {
    const { resolveFeatureEngine } = await import(R + "/src/lib/feature-engine.ts");
    const engine = await resolveFeatureEngine();
    out.engine = engine.kind === "local"
      ? { kind: "local", runtime: engine.engine.kind, model: engine.engine.modelRef, contextTokens: engine.engine.contextTokens, maxOutputTokens: engine.engine.maxOutputTokens, imageInput: engine.engine.imageInput }
      : engine;

    const fc = await import(R + "/src/lib/prime-radiant/flash-client.ts");
    const client = await fc.flashClient();
    out.client = { model: client.model, engine: client.engine ?? null, budget: client.budget ?? null };

    const vd = await import(R + "/src/lib/vision-describe.ts");
    const { CLAWBOX_AI_VISION_PROBE_PNG } = await import(R + "/src/lib/clawbox-ai-vision.ts");
    const described = await vd.describeImage(CLAWBOX_AI_VISION_PROBE_PNG, "What colour is this square? Answer with one word.");
    out.vision = { text: described.text, error: described.error, asked: (described.vision?.attempts ?? []).map((a) => a.requestedModel), blindError: vd.LOCAL_NO_VISION_ERROR };

    const me = await import(R + "/src/lib/memory-embedder.ts");
    const embedder = await me.resolveMemoryEmbedder();
    out.embedder = { source: embedder.source, model: embedder.model, onBox: me.embedEndpointAllowed("local", embedder.baseUrl) };
    const { getEmbedProvisioningStatus } = await import(R + "/src/lib/embed-server.ts");
    const provisioning = await getEmbedProvisioningStatus().catch(() => null);
    if (provisioning && provisioning.installed) {
      const mil = await import(R + "/src/lib/memory-index-local.ts");
      const { vectors } = await mil.embedDocumentsWithShardEmbedder(["Acme Widgets Ltd ships blue widgets to Globex."]);
      out.embedded = { width: vectors[0] ? vectors[0].length : 0 };
    } else {
      out.embedded = null;
    }

    const { clawboxAiProxyUrl } = await import(R + "/src/lib/clawbox-ai-models.ts");
    const { cloudEmbeddingsUrl } = await import(R + "/src/lib/clawai-cloud-embeddings.ts");
    const cloud = [clawboxAiProxyUrl(), cloudEmbeddingsUrl()].filter(Boolean).map((u) => u.replace(/\/+$/, ""));
    out.cloudRequests = urls.filter((u) => cloud.some((c) => u.startsWith(c))).length;
  } catch (err) {
    out.crash = String((err && err.stack) || err).split("\n").slice(0, 4).join(" | ");
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log("INPROC " + JSON.stringify(out));
  process.exit(0);
})().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
'

# The running server's own flow, as the owner (plain JavaScript for node: the
# session cookie minted on the board the way `owner_api` mints it): an ingest
# of two small documents under ~/Documents through the real route, its job
# followed to the end, its costs and the Usage meter read, then every commit
# it made undone through the revert route and its documents removed.
# shellcheck disable=SC2016  # JavaScript, not shell
SERVER_FLOW='
const fs = require("fs"), crypto = require("crypto"), path = require("path"), cp = require("child_process");
const REPO = process.cwd();
const DASH = "http://127.0.0.1";
const secret = fs.readFileSync(path.join(REPO, "data/.session-secret"), "utf8").trim();
let gen = 0;
try { const c = JSON.parse(fs.readFileSync(path.join(REPO, "data/config.json"), "utf8")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, gen })).toString("base64url");
const cookie = payload + "." + crypto.createHmac("sha256", secret).update(payload).digest("hex");
const call = async (method, p, body) => {
  const res = await fetch(DASH + p, { method, headers: { cookie: "clawbox_session=" + cookie, origin: DASH, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
(async () => {
  const out = {};
  // Unique words per run: a document an earlier run ingested is a duplicate, never asked again.
  const tag = process.argv[1] + "-" + Date.now().toString(36);
  const rel = "Documents/nano-ci-local-engine-" + tag;
  const dir = path.join(process.env.HOME, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "acme-delivery.md"), "# Acme delivery terms " + tag + "\n\nAcme Widgets Ltd ships blue widgets to Globex every Tuesday. Orders placed before noon leave the same day. The standard delivery fee is 12 EUR per order. Reference " + tag + ".\n");
  fs.writeFileSync(path.join(dir, "globex-purchasing.md"), "# Globex purchasing " + tag + "\n\nИван Иванов ръководи покупките в Globex. Той одобрява всяка поръчка над 500 EUR. Справка " + tag + ".\n");
  let id = null;
  try {
    const before = await call("GET", "/setup-api/prime-radiant/costs?allowance=1");
    out.before = { status: before.status, engine: before.body?.allowance?.engine ?? null, cloudCalls: before.body?.allowance?.primeRadiant?.calls ?? null, localCalls: before.body?.allowance?.local?.calls ?? 0 };
    const start = await call("POST", "/setup-api/prime-radiant/ingest", { folders: [rel] });
    out.start = { status: start.status, code: start.body?.code ?? null, error: start.body?.error ?? null };
    id = start.body?.job?.id ?? null;
    if (id) {
      const t0 = Date.now();
      let job = start.body.job;
      while (Date.now() - t0 < 7 * 60_000) {
        await new Promise((r) => setTimeout(r, 10_000));
        const got = await call("GET", "/setup-api/prime-radiant/ingest/" + id);
        if (got.body?.job) job = got.body.job;
        if (job.status !== "running") break;
      }
      out.ingest = { id, status: job.status, total: job.total, done: job.done, failed: job.failed, duplicates: job.duplicates, skipped: job.skipped, pages: job.pages, calls: job.calls, error: job.error ?? null, seconds: Math.round((Date.now() - t0) / 1000) };
      const costs = await call("GET", "/setup-api/prime-radiant/costs?runId=" + id);
      out.costModels = (costs.body?.byModel ?? []).map((m) => m.model);
      const after = await call("GET", "/setup-api/prime-radiant/costs?allowance=1");
      out.after = { engine: after.body?.allowance?.engine ?? null, cloudCalls: after.body?.allowance?.primeRadiant?.calls ?? null, localCalls: after.body?.allowance?.local?.calls ?? null };
    }
  } catch (err) {
    out.crash = String((err && err.stack) || err).slice(0, 400);
  } finally {
    // Whatever happened above, the job is stopped if it still runs and every
    // commit it made is undone, before its documents go.
    if (id) {
      try {
        const now = await call("GET", "/setup-api/prime-radiant/ingest/" + id);
        if (now.body?.job?.status === "running") {
          await call("DELETE", "/setup-api/prime-radiant/ingest/" + id);
          for (let k = 0; k < 30; k++) {
            await new Promise((r) => setTimeout(r, 2_000));
            const s = await call("GET", "/setup-api/prime-radiant/ingest/" + id);
            if (s.body?.job?.status !== "running") break;
          }
        }
        const vault = process.env.PRIME_RADIANT_DIR ? path.join(process.env.PRIME_RADIANT_DIR, "vault") : path.join(REPO, "data/prime-radiant/vault");
        let shas = [];
        try { shas = cp.execFileSync("git", ["-C", vault, "log", "--format=%H", "--fixed-strings", "--grep=(" + id + ")"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch {}
        out.commits = shas.length;
        out.reverted = 0;
        for (const sha of shas) {
          const r = await call("POST", "/setup-api/prime-radiant/revert", { commit: sha });
          if (r.status === 200) out.reverted++;
          else out.revertError = r.body?.code ?? r.status;
        }
      } catch (err) {
        out.cleanupCrash = String((err && err.message) || err).slice(0, 200);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("SERVER " + JSON.stringify(out));
})();
'

# On the board: the lock (and Local AI when it is off and Gemma is on disk) on
# for the checks' length, every key put back as it was on any way out — the
# file rewritten atomically, 0600, as the box itself writes it.
# shellcheck disable=SC2016  # expanded on the board
RAW=$(board '
cd "$REPO" || exit 1
SAVED=$(mktemp)
keys() {
  node -e "
    const fs = require(\"fs\");
    const [cfgPath, savedPath, mode, alias] = process.argv.slice(1);
    // Strict: a store that cannot be read or is no JSON object is never written over.
    const read = () => { const c = JSON.parse(fs.readFileSync(cfgPath, \"utf8\")); if (!c || typeof c !== \"object\" || Array.isArray(c)) throw new Error(\"not an object\"); return c; };
    const write = (c) => { const t = cfgPath + \".nano-tmp\"; fs.writeFileSync(t, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(t, cfgPath); };
    const KEYS = [\"ai_cloud_lock\", \"local_ai_configured\", \"local_ai_provider\", \"local_ai_model\"];
    let c;
    try { c = read(); } catch (err) { console.log(\"CONFIG_UNREADABLE \" + (err && err.message)); process.exit(0); }
    if (mode === \"on\") {
      const before = Object.fromEntries(KEYS.map((k) => [k, Object.prototype.hasOwnProperty.call(c, k) ? c[k] : null]));
      fs.writeFileSync(savedPath, JSON.stringify(before));
      c.ai_cloud_lock = true;
      const engineSet = c.external_engine || (c.local_ai_configured === true && (c.local_ai_provider === \"llamacpp\" || c.local_ai_provider === \"ollama\"));
      if (!engineSet && alias) { c.local_ai_configured = true; c.local_ai_provider = \"llamacpp\"; c.local_ai_model = \"llamacpp/\" + alias; console.log(\"LOCAL_AI_SET \" + alias); }
      else if (!engineSet) console.log(\"NO_ENGINE\");
      write(c);
      if (read().ai_cloud_lock === true) console.log(\"LOCK_SET\");
    } else {
      let before = null;
      try { before = JSON.parse(fs.readFileSync(savedPath, \"utf8\")); } catch {}
      if (before) {
        for (const k of KEYS) { if (before[k] === null || before[k] === undefined) delete c[k]; else c[k] = before[k]; }
        write(c);
        console.log(\"KEYS_RESTORED\");
      }
    }
  " data/config.json "$SAVED" "$@"
}
trap "keys off; rm -f \"\$SAVED\"" EXIT
ALIAS=$(timeout 60 bun -e "
  const m = await import(process.cwd() + \"/src/lib/llamacpp-server.ts\");
  const s = await m.getLlamaCppProvisioningStatus();
  console.log(s.installed ? s.alias : \"\");
" 2>/dev/null | tail -n 1)
keys on "$ALIAS"
timeout 200 bun -e "$1" 2>&1 | tail -n 5
timeout 540 node -e "$2" "$3" 2>&1 | tail -n 5
' "$CHECKS" "$SERVER_FLOW" "$NANO_RUN_ID")

if ! printf '%s\n' "$RAW" | grep -qx 'LOCK_SET'; then
  not_ok "the local-only AI lock could not be put on in data/config.json: $(printf '%s' "$RAW" | head -n 5 | tr '\n' ' ' | head -c 400)"
  finish
fi
if printf '%s\n' "$RAW" | grep -qx 'NO_ENGINE'; then
  skip "no engine of the box's own: Local AI is off and the llama.cpp Gemma GGUF is not on this board (the test downloads nothing)"
  finish
fi
if printf '%s\n' "$RAW" | grep -q '^LOCAL_AI_SET '; then
  note "Local AI was off: turned on llama.cpp ($(printf '%s\n' "$RAW" | sed -n 's/^LOCAL_AI_SET //p' | head -n 1)) for the test's length"
fi

INPROC=$(printf '%s\n' "$RAW" | sed -n 's/^INPROC //p' | tail -n 1)
SERVER=$(printf '%s\n' "$RAW" | sed -n 's/^SERVER //p' | tail -n 1)
if [ -z "$INPROC" ] || ! printf '%s' "$INPROC" | jq -e . >/dev/null 2>&1; then
  not_ok "the in-process checks did not answer: $(printf '%s' "$RAW" | tail -n 3 | tr '\n' ' ' | head -c 400)"
  INPROC='{}'
fi
if [ -z "$SERVER" ] || ! printf '%s' "$SERVER" | jq -e . >/dev/null 2>&1; then
  not_ok "the server flow did not answer: $(printf '%s' "$RAW" | tail -n 3 | tr '\n' ' ' | head -c 400)"
  SERVER='{}'
fi
j() { printf '%s' "$INPROC" | jq -r "$@" 2>/dev/null; }
sj() { printf '%s' "$SERVER" | jq -r "$@" 2>/dev/null; }
note "in-process: $(printf '%s' "$INPROC" | head -c 1200)"
note "server: $(printf '%s' "$SERVER" | head -c 1200)"

[ -n "$(j '.crash // empty')" ] && not_ok "the in-process checks crashed: $(j '.crash')"
[ -n "$(sj '.crash // empty')" ] && not_ok "the server flow crashed: $(sj '.crash')"

ENGINE_REF=$(j '.engine.model // empty')
if [ "$(j '.engine.kind')" = local ] && [ -n "$ENGINE_REF" ]; then
  ok "under the lock the features' engine is the box's own: $ENGINE_REF ($(j '.engine.contextTokens') tokens)"
else
  not_ok "the features' engine under the lock is not the box's own: $(j -c '.engine')"
fi

if [ "$(j '.client.engine')" = local ] && [ "$(j '.client.budget.parallel')" = 1 ] && [ "$(j '.client.model')" = "$ENGINE_REF" ]; then
  ok "Prime Radiant's client is the local one, with its budget ($(j -c '.client.budget'))"
else
  not_ok "Prime Radiant's client is not the local one: $(j -c '.client')"
fi

if [ "$(sj '.start.status')" = 202 ] && [ "$(sj '.ingest.status')" = "done" ] && [ "$(sj '.ingest.done')" -ge 1 ] 2>/dev/null && [ "$(sj '.ingest.pages')" -ge 1 ] 2>/dev/null; then
  ok "an ingest through the running server was written by the box's own engine: $(sj '.ingest.done')/$(sj '.ingest.total') documents, $(sj '.ingest.pages') pages, $(sj '.ingest.calls') calls in $(sj '.ingest.seconds') s"
else
  not_ok "the ingest on the box's own engine did not write pages: start $(sj -c '.start'), job $(sj -c '.ingest')"
fi

# shellcheck disable=SC2016  # $r is jq's
if [ "$(sj '.costModels | length')" -ge 1 ] 2>/dev/null && [ "$(sj --arg r "$ENGINE_REF" '[.costModels[] | select(. != $r)] | length')" = 0 ]; then
  ok "every cost row of the job names the engine's own ref ($(sj -c '.costModels'))"
else
  not_ok "the job's cost rows name another model: $(sj -c '.costModels')"
fi

if [ "$(sj '.after.engine')" = local ] && [ "$(sj '.after.cloudCalls')" = "$(sj '.before.cloudCalls')" ] && [ "$(sj '.after.localCalls')" -gt "$(sj '.before.localCalls')" ] 2>/dev/null; then
  ok "the running server's Usage meter names the box's own engine and counts nothing against ClawBox AI (cloud calls $(sj '.before.cloudCalls') → $(sj '.after.cloudCalls'), local $(sj '.before.localCalls') → $(sj '.after.localCalls'))"
else
  not_ok "the running server's Usage meter: before $(sj -c '.before'), after $(sj -c '.after')"
fi

if [ "$(sj '.commits')" -ge 1 ] 2>/dev/null && [ "$(sj '.reverted')" = "$(sj '.commits')" ]; then
  ok "the job's $(sj '.commits') commit(s) were undone through the revert route"
elif [ "$(sj '.commits // 0')" = 0 ]; then
  note "no commit of the job was found to undo"
else
  not_ok "the job's commits were not all undone: $(sj '.reverted')/$(sj '.commits') ($(sj '.revertError // empty'))"
fi

# shellcheck disable=SC2016  # $r is jq's
VISION_ELSEWHERE=$(j --arg r "$ENGINE_REF" '[.vision.asked[] | select(. != $r)] | length')
VISION_ASKED=$(j '.vision.asked | length')
if [ "$VISION_ASKED" = 0 ]; then
  # Nothing asked: only right for an engine that cannot see, refused in words.
  if [ "$(j '.engine.imageInput')" != true ] && [ -n "$(j '.vision.error // empty')" ] && [ -z "$(j '.vision.text // empty')" ]; then
    ok "a picture is refused in words, asking nothing, by an engine that cannot see ($(j '.engine.runtime'): $(j '.vision.error'))"
  else
    not_ok "the picture was not asked of an engine that sees, or not refused in words: $(j -c '.vision')"
  fi
elif [ "$VISION_ELSEWHERE" != 0 ]; then
  not_ok "the picture went to another model: $(j -c '.vision.asked')"
elif [ -n "$(j '.vision.text // empty')" ]; then
  ok "the box's own engine described the picture: $(j '.vision.text' | head -c 80)"
else
  not_ok "the box's own engine was asked and did not describe the picture: $(j -c '.vision')"
fi

if [ "$(j '.embedder.source')" = local ] && [ "$(j '.embedder.onBox')" = true ]; then
  ok "Memory Shard's embedder under the lock is the one on the box ($(j '.embedder.model'))"
else
  not_ok "Memory Shard's embedder under the lock is not the box's: $(j -c '.embedder')"
fi
if [ "$(j '.embedded')" = null ]; then
  skip "the embedding model is not installed on this board: no text embedded"
elif [ "$(j '.embedded.width')" -gt 0 ] 2>/dev/null; then
  ok "a text was embedded through the Local AI proxy ($(j '.embedded.width') dimensions)"
else
  not_ok "the embedder on the box did not embed: $(j -c '.embedded')"
fi

if [ "$(j '.cloudRequests')" = 0 ]; then
  ok "not one in-process request went to ClawBox AI's proxy or its cloud embedder"
else
  not_ok "$(j '.cloudRequests') in-process request(s) went to the cloud"
fi
finish
