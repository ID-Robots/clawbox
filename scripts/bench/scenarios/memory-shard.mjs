// Memory Shard: the memory embedder, the index ClawBox exposes, and one search
// through it — measured on whichever edition the box runs, with every part the
// box cannot offer reported as skipped rather than scored.
//
//   (a) `embed/status` — how fast the box answers about its own embedder, and
//       the facts (installed, model on disk, unit present/active/failed).
//   (b) the on-box embedder (clawbox-embed.service) — exercised only when it is
//       installed AND the index is embedded on this box (`provider.source ===
//       "local"`): the Prime Radiant vault search (`prime-radiant/search`) is
//       the one owner route that embeds a query through the same proxy that
//       wakes the unit, so its first call after a sleep is the cold wake and
//       the next ones are the warm embed. Installed but pinned to the cloud is
//       skipped: nothing exercises the on-box model without moving the index,
//       which this bench never does.
//   (c) `clawkeep/memory/search` — the index ClawBox owns on the edition
//       without OpenClaw: first and warm latency for a fixed query and whether
//       hits come back. 409 `edition` means the index is OpenClaw's and the
//       part is skipped as "owned by OpenClaw"; 409 `disabled` means the owner
//       switched Memory Shard off.
//   (d) what ClawBox exposes about the index on EVERY edition: the status
//       read (`clawkeep/memory`, a two-minute cache over a CLI probe that can
//       take a minute cold on OpenClaw — the first sample is kept in the
//       details), the embedder choice (`provider`, which probes the cloud
//       embedder), the folder list and the schedule.
//
// Reads only. The vault search is the Prime Radiant app's own search and runs
// only when the vault's index already exists and is valid (so it starts no
// index build); a sleeping embedder it wakes goes back to sleep on the unit's
// own idle timer, exactly as after an owner's search. Nothing is enabled,
// disabled, pinned or indexed.
import { median } from "../lib/score.mjs";

export const id = "memory-shard";
export const title = "Memory Shard";
export const weight = 8;
export const order = 45;

const QUERY = "clawbox setup notes";
const SEARCH_LIMIT = 5;
// Server-side deadline on both searches is 60 s; the status probe is 90 s.
const SEARCH_TIMEOUT_MS = 90_000;
const STATUS_TIMEOUT_MS = 120_000;

/** Call one route n times; median latency, the first sample and the last answer. */
async function sample(client, path, n, timeoutMs, errors) {
  const samples = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const r = await client.http(path, { timeoutMs });
    samples.push(r.ms);
    last = r;
    if (!r.ok) errors.push(`${path} → ${r.status}${r.error ? " " + r.error : ""}${r.json?.code ? " " + r.json.code : ""}`);
  }
  return { p50: median(samples), first: samples[0], samples, last };
}

/**
 * A search route called once cold and then n times warm. Only 2xx answers
 * count as samples — a refusal is reported through `errors` and the part is
 * marked, never scored as a fast failure.
 */
async function searchSeries(client, path, warmCalls, errors) {
  const first = await client.http(path, { timeoutMs: SEARCH_TIMEOUT_MS });
  if (!first.ok) {
    errors.push(`${path} → ${first.status}${first.error ? " " + first.error : ""}${first.json?.code ? " " + first.json.code : ""}`);
    return { ok: false, first, warm: [], hits: null };
  }
  const warm = [];
  let last = first;
  for (let i = 0; i < warmCalls; i++) {
    const r = await client.http(path, { timeoutMs: SEARCH_TIMEOUT_MS });
    if (r.ok) { warm.push(r.ms); last = r; } else errors.push(`${path} → ${r.status}${r.json?.code ? " " + r.json.code : ""}`);
  }
  const hits = Array.isArray(last.json?.results) ? last.json.results.length : null;
  return { ok: true, first, warm, hits, firstMs: first.ms, warmMs: warm.length ? median(warm) : null };
}

export async function run({ client, opts, log }) {
  const n = opts.quick ? 2 : 4;
  const warmCalls = opts.quick ? 1 : 2;
  const errors = [];
  const skipped = {};
  const metrics = {};
  const details = { query: QUERY, calls: { cheap: n, warmSearches: warmCalls } };

  // (a) the embedder's status route and its facts.
  const embed = await sample(client, "/setup-api/embed/status", n, 30_000, errors);
  const embedFacts = embed.last?.json ?? null;
  details.embedder = embedFacts ? {
    installed: !!embedFacts.installed,
    binaryAvailable: !!embedFacts.binaryAvailable,
    modelAvailable: !!embedFacts.modelAvailable,
    modelBytes: embedFacts.modelBytes ?? null,
    model: embedFacts.model ?? null,
    engine: embedFacts.engine ?? null,
    unit: embedFacts.unit ?? null,
  } : null;
  metrics.embed_status_ms = { value: embed.p50, unit: "ms", dir: "lower", good: 30, bad: 500, label: "embed/status (unit state + model on disk)" };

  // (d) what ClawBox exposes about the index, on every edition.
  const status = await sample(client, "/setup-api/clawkeep/memory", n, STATUS_TIMEOUT_MS, errors);
  const st = status.last?.json ?? null;
  details.index = st ? {
    enabled: st.enabled, setupComplete: st.setupComplete, provider: st.provider, model: st.model, location: st.location,
    health: st.health, semanticAvailable: st.semanticAvailable, indexIdentity: st.indexIdentity, files: st.files, chunks: st.chunks,
    vectors: st.vectors, pendingFiles: st.pendingFiles, failedItems: st.failedItems, indexMb: Math.round((st.indexBytes ?? 0) / 1048576),
    lastRun: st.run ? { status: st.run.status, mode: st.run.mode, trigger: st.run.trigger, durationMs: st.run.durationMs } : null,
    errorCode: st.errorCode || null,
  } : null;
  metrics.memory_status_ms = { value: status.p50, unit: "ms", dir: "lower", good: 50, bad: 3000, label: "clawkeep/memory status read (cached probe)" };
  details.memoryStatusFirstMs = status.first;

  const provider = await sample(client, "/setup-api/clawkeep/memory/provider", n, 60_000, errors);
  const pv = provider.last?.json ?? null;
  details.provider = pv ? { source: pv.source, recorded: pv.recorded, cloudAvailable: pv.cloudAvailable, cloudReason: pv.cloudReason ?? null, localInstalled: pv.localInstalled } : null;
  metrics.provider_ms = { value: provider.p50, unit: "ms", dir: "lower", good: 300, bad: 5000, label: "clawkeep/memory/provider (embedder choice; probes the cloud embedder)" };

  const sources = await sample(client, "/setup-api/clawkeep/memory/sources", n, 30_000, errors);
  details.sources = { folders: Array.isArray(sources.last?.json?.paths) ? sources.last.json.paths.length : null };
  metrics.sources_ms = { value: sources.p50, unit: "ms", dir: "lower", good: 20, bad: 400, label: "clawkeep/memory/sources (folder list)" };

  const schedule = await sample(client, "/setup-api/clawkeep/memory/schedule", n, 30_000, errors);
  const sch = schedule.last?.json ?? null;
  details.schedule = sch ? { enabled: sch.schedule?.enabled, frequency: sch.schedule?.frequency, timeOfDay: sch.schedule?.timeOfDay, nextRunAtMs: sch.nextRunAtMs } : null;
  metrics.schedule_ms = { value: schedule.p50, unit: "ms", dir: "lower", good: 20, bad: 400, label: "clawkeep/memory/schedule" };

  // (c) the index ClawBox owns, where it owns one. One probe call decides.
  const searchPath = `/setup-api/clawkeep/memory/search?q=${encodeURIComponent(QUERY)}&limit=${SEARCH_LIMIT}`;
  const probe = await client.http(searchPath, { timeoutMs: SEARCH_TIMEOUT_MS });
  if (probe.status === 409 && probe.json?.code === "edition") {
    skipped.memory_search = "owned by OpenClaw (ClawBox does not search this box's index)";
  } else if (probe.status === 409 && probe.json?.code === "disabled") {
    skipped.memory_search = "Memory Shard is switched off";
  } else if (!probe.ok) {
    errors.push(`${searchPath} → ${probe.status}${probe.json?.code ? " " + probe.json.code : ""}`);
    skipped.memory_search = `search answered ${probe.status}${probe.json?.code ? " " + probe.json.code : ""}`;
  } else {
    const warm = [];
    for (let i = 0; i < warmCalls; i++) {
      const r = await client.http(searchPath, { timeoutMs: SEARCH_TIMEOUT_MS });
      if (r.ok) warm.push(r.ms); else errors.push(`${searchPath} → ${r.status}${r.json?.code ? " " + r.json.code : ""}`);
    }
    const hits = Array.isArray(probe.json?.results) ? probe.json.results.length : 0;
    details.memorySearch = { firstMs: probe.ms, warmMs: warm, hits };
    metrics.memory_search_first_ms = { value: probe.ms, unit: "ms", dir: "lower", good: 1500, bad: 30000, label: "ClawBox-owned index: first search (may wake the embedder)" };
    if (warm.length) metrics.memory_search_warm_ms = { value: median(warm), unit: "ms", dir: "lower", good: 300, bad: 6000, label: "ClawBox-owned index: warm search" };
    // Hits are a fact worth scoring only over an index that holds something.
    if ((st?.chunks ?? 0) > 0) metrics.memory_search_hits = { value: hits, unit: "", dir: "higher", good: 1, bad: 0, label: "hits for the fixed query (index has chunks)" };
    else details.memorySearch.note = "index holds no chunks yet; hits not scored";
  }

  // (b) the on-box embedder, through the one owner route that embeds a query:
  // the vault search. Also the "search through Memory Shard's engine" that
  // exists on every edition, so it is measured whenever it is safe to call.
  const pr = await client.http("/setup-api/prime-radiant/status", { timeoutMs: 60_000 });
  const prIndex = pr.json?.index ?? null;
  const vaultReady = pr.ok && pr.json?.initialised === true && prIndex?.exists === true && prIndex?.needsFullScan === false && prIndex?.migrationPending !== true;
  details.vault = pr.ok ? { initialised: pr.json?.initialised === true, pages: pr.json?.vault?.pages ?? null, index: prIndex ? { exists: prIndex.exists, chunks: prIndex.chunks, needsFullScan: prIndex.needsFullScan, migrationPending: prIndex.migrationPending } : null } : { status: pr.status };
  const shardOn = st ? st.enabled === true : null;
  const localInstalled = !!embedFacts?.installed;
  const localInUse = pv?.source === "local";
  const unitAsleepBefore = localInstalled ? embedFacts.unit?.active !== true : null;

  if (!pr.ok) {
    skipped.vault_search = `prime-radiant/status answered ${pr.status}`;
  } else if (pr.json?.initialised !== true) {
    skipped.vault_search = "Prime Radiant vault not initialised";
  } else if (shardOn === false) {
    skipped.vault_search = "Memory Shard is switched off (the vault search answers nothing)";
  } else if (!vaultReady) {
    skipped.vault_search = "vault index missing or due a rebuild (a search would start one)";
  } else {
    const vaultPath = `/setup-api/prime-radiant/search?q=${encodeURIComponent(QUERY)}&limit=${SEARCH_LIMIT}`;
    const vs = await searchSeries(client, vaultPath, warmCalls, errors);
    if (!vs.ok) {
      skipped.vault_search = `vault search answered ${vs.first.status}${vs.first.json?.code ? " " + vs.first.json.code : ""}`;
    } else if (vs.first.json?.shardEnabled === false) {
      skipped.vault_search = "Memory Shard is switched off (the vault search answers nothing)";
    } else if (vs.first.json?.indexing === true) {
      skipped.vault_search = "vault index was being rebuilt (no results until it finishes)";
    } else {
      const where = localInUse ? "on-box embedder" : "cloud embedder";
      details.vaultSearch = { embedder: where, firstMs: vs.firstMs, warmMs: vs.warm, hits: vs.hits, unitAsleepBefore };
      metrics.vault_search_first_ms = { value: vs.firstMs, unit: "ms", dir: "lower", good: 1500, bad: 30000, label: `vault search, first call (${localInUse && unitAsleepBefore ? "cold wake of the on-box embedder" : where})` };
      if (vs.warmMs !== null) metrics.vault_search_warm_ms = { value: vs.warmMs, unit: "ms", dir: "lower", good: 300, bad: 6000, label: `vault search, warm (${where})` };
      if ((prIndex?.chunks ?? 0) > 0) metrics.vault_search_hits = { value: vs.hits ?? 0, unit: "", dir: "higher", good: 1, bad: 0, label: "vault hits for the fixed query" };
    }
  }

  // The on-box embedder as a part of its own: say plainly whether it was
  // exercised, and why not when it was not.
  if (!localInstalled) {
    skipped.local_embedder = "embedder not installed on this box (embed/status.installed false)";
  } else if (!localInUse) {
    skipped.local_embedder = `embedder installed but the index is embedded in the cloud (provider.source ${pv?.source ?? "?"}); no owner route exercises the on-box model without moving the index`;
  } else if (!details.vaultSearch) {
    skipped.local_embedder = `embedder installed and in use, but the vault search could not exercise it (${skipped.vault_search ?? "no search ran"})`;
  } else {
    const after = await client.http("/setup-api/embed/status", { timeoutMs: 30_000 });
    details.localEmbedder = { exercised: true, unitAsleepBefore, unitActiveAfter: after.json?.unit?.active === true, unitFailedAfter: after.json?.unit?.failed === true };
    metrics.embed_warm_ms = { value: details.vaultSearch.warmMs.length ? median(details.vaultSearch.warmMs) : details.vaultSearch.firstMs, unit: "ms", dir: "lower", good: 250, bad: 4000, label: "one query through the on-box embedder, warm" };
    if (unitAsleepBefore) metrics.embed_wake_ms = { value: details.vaultSearch.firstMs, unit: "ms", dir: "lower", good: 4000, bad: 40000, label: "cold wake of clawbox-embed.service + first query" };
    else details.localEmbedder.note = "unit was already active; no cold wake measured";
  }

  metrics.errors = { value: errors.length, unit: "", dir: "lower", good: 0, bad: 3, weight: 2, label: "unexpected non-2xx answers" };
  details.errors = errors;
  details.skipped = skipped;

  const parts = Object.entries(skipped).map(([k, v]) => `${k}: ${v}`);
  log(`embed/status ${embed.p50.toFixed(0)} ms (installed ${localInstalled}), status ${status.p50.toFixed(0)} ms, provider ${provider.p50.toFixed(0)} ms (${pv?.source ?? "?"})${details.vaultSearch ? `, vault search ${details.vaultSearch.firstMs.toFixed(0)}/${details.vaultSearch.warmMs.map((m) => m.toFixed(0)).join(",") || "—"} ms, ${details.vaultSearch.hits} hits` : ""}${details.memorySearch ? `, memory search ${details.memorySearch.firstMs.toFixed(0)} ms, ${details.memorySearch.hits} hits` : ""}`);
  if (parts.length) log(`skipped — ${parts.join("; ")}`);

  const measured = Object.keys(metrics).filter((k) => k !== "errors");
  if (!measured.length) return { skipped: "no memory route answered", metrics: {} };
  return { metrics, details };
}
