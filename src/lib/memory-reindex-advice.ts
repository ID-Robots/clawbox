// Why the memory index wants a pass, and what a full one would cost.
//
// The status has always carried the FACTS — the index identity, the verdict
// code, `dirty`, the files the last scan saw and the index does not hold — and
// left the reading of them to whoever looked. The Memory Shard card reads one
// of them to pick which button to emphasise; the assistant was handed a bare
// `needs_reindex: true` and had no way to tell "a folder was added, an
// incremental pass picks it up" from "the embedder changed, every file is
// embedded again". This is that reading, once, for both.
//
// PURE: no imports, no I/O. The route adds it to the status it answers; the
// tests feed it synthetic readings.

/** What fixes a reason: a full re-embed, an incremental pass, or no pass at all. */
export type MemoryReindexMode = "full" | "incremental" | "none";

export interface MemoryReindexReason {
  /** Stable, for a caller to branch on. */
  code:
    | "no_index"
    | "keyword_only"
    | "embedder_changed"
    | "index_format_changed"
    | "identity_missing"
    | "files_waiting"
    | "files_changed"
    | "last_pass_stopped"
    | "size_ceiling"
    | "provider_fell_back"
    | "embedder_unavailable";
  mode: MemoryReindexMode;
  /** One plain sentence for a person. */
  detail: string;
}

export interface MemoryReindexAdvice {
  /** True when some reason is fixed by a pass. */
  needed: boolean;
  /** The pass that fixes every reason: full when any reason needs one. Null when none is needed. */
  mode: "full" | "incremental" | null;
  reasons: MemoryReindexReason[];
}

/** The fields of `ClawKeepMemoryStatus` this reads; every one optional, so an older reading still answers. */
export interface MemoryStatusFacts {
  available?: boolean;
  /** The model the index is embedded with now. */
  model?: string;
  location?: string;
  indexIdentity?: string;
  indexIdentityCode?: string;
  errorCode?: string;
  sourceCount?: number;
  files?: number;
  chunks?: number;
  pendingFiles?: number;
  dirty?: boolean;
  run?: { status?: string; mode?: string; errorCode?: string; durationMs?: number };
}

/** Which edition's indexer wrote the reading: ClawBox's own (`local`) or OpenClaw's. */
export type MemoryIndexArm = "local" | "openclaw";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function memoryReindexAdvice(s: MemoryStatusFacts, arm: MemoryIndexArm): MemoryReindexAdvice {
  const reasons: MemoryReindexReason[] = [];
  // A probe that failed says nothing about the index; inventing a reason from
  // its zeros would send the assistant to rebuild an index that is fine.
  if (s.available === false) return { needed: false, mode: null, reasons };
  // An embedder that does not answer is the ONLY reason worth giving: no pass
  // can embed anything until it does (the core refuses a sync under a remote
  // provider it could not start), so "files are waiting" beside it would send
  // the assistant to start a pass that can only fail. Once the embedder
  // answers, the index reads keyword-only and that reason asks for the pass.
  if (s.errorCode === "embedder_unavailable") {
    reasons.push({
      code: "embedder_unavailable",
      mode: "none",
      detail: "Memory search has fallen back to keyword-only: the embedding model it is set to use did not answer (a refused sign-in or key, or an endpoint that is down). A pass cannot fix that; once the embedder answers, a full pass embeds every file.",
    });
    return { needed: false, mode: null, reasons };
  }

  const chunks = typeof s.chunks === "number" ? s.chunks : null;
  const empty = chunks === 0;
  const hasFolders = (s.sourceCount ?? 0) > 0;
  const code = s.indexIdentityCode ?? "";

  // Empty AND not vouched for. An index whose last pass read the folders and
  // found nothing to index is `valid` with zero chunks (see `identityOf` in
  // memory-index-local.ts): another pass scans the same zero files, so calling
  // it "nothing indexed yet" would ask the owner for a full pass forever.
  if (empty && hasFolders && s.indexIdentity !== "valid") {
    reasons.push({
      code: "no_index",
      mode: "full",
      detail: "Nothing is indexed yet: the first pass reads and embeds every file in the folders.",
    });
  } else if (s.errorCode === "index_keyword_only") {
    // Before the mismatch it usually comes with: the core calls an index it
    // built with no embedder "built for model fts-only" once one is set, and
    // "built for a different model" would have the assistant explain a model
    // change nobody made.
    reasons.push({
      code: "keyword_only",
      mode: "full",
      detail: "The index holds text but no embeddings — it was built while no embedding model answered — so search matches words only. A full pass embeds every file.",
    });
  } else if (s.indexIdentity === "mismatched" && code.startsWith("chunking")) {
    reasons.push({
      code: "index_format_changed",
      mode: "full",
      detail: "An update changed how documents are cut into passages, so the index has to be built again from every file.",
    });
  } else if (s.indexIdentity === "mismatched") {
    reasons.push({
      code: "embedder_changed",
      mode: "full",
      detail: arm === "local"
        // The local identity hashes the provider, the model, its endpoint and
        // the index schema together, so which of them moved is not on record.
        ? "The index was built by a different embedding model, endpoint or index format than the one set now — the provider was switched, or an update changed the format. Passages from two models cannot be searched together, so every file is embedded again."
        : "The index was built for a different embedding model or settings than the ones set now. Passages from two models cannot be searched together, so every file is embedded again.",
    });
  } else if (s.indexIdentity === "missing" && (chunks ?? 0) > 0) {
    reasons.push({
      code: "identity_missing",
      mode: "full",
      detail: "The index does not record which embedding model built it — a full pass that was stopped part-way leaves it so — and only a full pass records it again.",
    });
  }

  if (!empty && (s.pendingFiles ?? 0) > 0) {
    reasons.push({
      code: "files_waiting",
      mode: "incremental",
      detail: `${count(s.pendingFiles as number, "file")} in the folders ${s.pendingFiles === 1 ? "is" : "are"} not in the index yet — a folder or files were added since the last pass.`,
    });
  }
  // `dirty` means two different things by arm: OpenClaw's CLI sets it when
  // files changed since its last pass; ClawBox's own index sets it when the
  // size ceiling made a pass skip files, which another pass will not fix.
  if (s.dirty && arm === "openclaw") {
    reasons.push({ code: "files_changed", mode: "incremental", detail: "Files in the folders changed since the last pass." });
  }
  if (s.dirty && arm === "local") {
    reasons.push({
      code: "size_ceiling",
      mode: "none",
      detail: "The index reached its size limit and left some files out; another pass will not fit them. Fewer or smaller folders would.",
    });
  }
  // Only a pass that was incremental: a stopped FULL pass is completed by
  // another full one, and what it left behind already says so (an empty
  // store or a missing identity, above; OpenClaw keeps its old index whole).
  // A pass the stall watchdog ended (TASK-2431) is one of these too: it
  // committed every file it finished, like any other stopped pass.
  const stopped = s.run?.errorCode === "interrupted" || s.run?.errorCode === "timed_out" || s.run?.errorCode === "stalled";
  if (s.run?.status === "failed" && s.run.mode !== "full" && stopped && !empty) {
    reasons.push({
      code: "last_pass_stopped",
      mode: "incremental",
      detail: "The last pass ended before it finished; an incremental pass carries on from the files already indexed.",
    });
  }
  if (s.errorCode === "provider_mismatch") {
    reasons.push({
      code: "provider_fell_back",
      mode: "none",
      detail: "Memory search is not using the embedding model that was set (it fell back to another). Setting the provider again fixes that; a pass does not.",
    });
  }
  const passes = reasons.filter((r) => r.mode !== "none");
  return {
    needed: passes.length > 0,
    mode: passes.some((r) => r.mode === "full") ? "full" : passes.length ? "incremental" : null,
    reasons,
  };
}

// ── what a full re-embed costs ──────────────────────────────────────────────

/**
 * About 300 tokens a passage: passages are cut at 1,200 characters
 * (`CHUNK_CHARS` in memory-index-local.ts), about 4 characters a token in
 * English.
 */
export const TOKENS_PER_CHUNK = 300;

/**
 * Passages a second, when this box has not timed a full pass of its own yet.
 * Rough on purpose and said to be: the box's own last full pass replaces them
 * the moment there is one.
 */
const ROUGH_CHUNKS_PER_SECOND = { local: 8, cloud: 25 } as const;

/**
 * The on-box models that are not the default, at the rate measured for them
 * (TASK-2411). The 4B runs only on an x86 PC with an NVIDIA GPU; its figure is
 * below the GPU-offloaded rate measured on an RTX 2080 with the unit's
 * 1024-token batch (8.7 passages a second at Q8_0, 8.9 at Q4_K_M; the 0.6B
 * did 17 on the same card), because a 6 GB card is the floor, not the norm.
 */
const ROUGH_LOCAL_CHUNKS_PER_SECOND_BY_MODEL: Readonly<Record<string, number>> = {
  "qwen3-embedding-4b": 6,
};

export interface MemoryReindexEstimate {
  /** Files the pass reads: those indexed plus those waiting. Null when the box has not scanned yet. */
  files: number | null;
  /** Passages it embeds, as the index holds now. Null when nothing is indexed yet. */
  chunks: number | null;
  embedder: "cloud" | "local";
  /** Tokens sent to the embedder, at {@link TOKENS_PER_CHUNK}. */
  tokens: number | null;
  /** How long, as a range in minutes. Null when nothing is known to scale from. */
  minutes: { low: number; high: number } | null;
  /** What the time is based on, in words. */
  basis: string;
  /** What it costs, in words. */
  cost: string;
}

const roundMinutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * What a full re-embed of what is indexed now would take, on `embedder`
 * (where it is embedded now, unless a provider change is being priced).
 */
export function estimateFullReindex(
  s: MemoryStatusFacts,
  embedder: "cloud" | "local",
  model?: string,
): MemoryReindexEstimate {
  const files = typeof s.files === "number" ? s.files + (s.pendingFiles ?? 0) : null;
  const chunks = typeof s.chunks === "number" && s.chunks > 0 ? s.chunks : null;
  const tokens = chunks === null ? null : chunks * TOKENS_PER_CHUNK;
  const current = s.location === "cloud" ? "cloud" : "local";

  let minutes: MemoryReindexEstimate["minutes"] = null;
  let basis: string;
  const lastFull = s.run?.status === "succeeded" && s.run.mode === "full" && (s.run.durationMs ?? 0) > 0 ? s.run.durationMs as number : null;
  // The box's own timing is for the model it timed: a pass on the 0.6B says
  // nothing about the 4B, which is several times slower per passage.
  const sameModel = !model || !s.model || s.model === model;
  if (lastFull !== null && embedder === current && sameModel) {
    // The box's own measure. ±30% for whatever has been added or removed since.
    minutes = { low: roundMinutes(lastFull * 0.7), high: roundMinutes(lastFull * 1.3) };
    basis = `this box's last full pass took about ${roundMinutes(lastFull)} min`;
  } else if (chunks !== null) {
    const modelRate = embedder === "local" && model ? ROUGH_LOCAL_CHUNKS_PER_SECOND_BY_MODEL[model] : undefined;
    const ms = (chunks / (modelRate ?? ROUGH_CHUNKS_PER_SECOND[embedder])) * 1000;
    minutes = { low: roundMinutes(ms * 0.5), high: roundMinutes(ms * 2) };
    const who = embedder === "cloud" ? "ClawBox AI cloud" : modelRate !== undefined ? `on-box ${model}` : "on-box";
    basis = `a rough rate for the ${who} embedder over ${count(chunks, "passage")}; no full pass on it has been timed here yet`;
  } else {
    basis = "nothing is indexed yet, so the box has no measure of how much text the folders hold";
  }
  if (files !== null && files > 0) basis += `; PDFs and office documents are converted to text first, which adds to it`;

  const cost = embedder === "cloud"
    ? `Sent to the ClawBox AI cloud embedder${model ? ` (${model})` : ""}${tokens !== null ? `: about ${tokens.toLocaleString("en-US")} tokens` : ""}, counted against the owner's ClawBox AI plan. The box shows no per-token price.`
    : "No money: the model runs on this box, which is busier than usual until the pass ends.";

  return { files, chunks, embedder, tokens, minutes, basis, cost };
}
