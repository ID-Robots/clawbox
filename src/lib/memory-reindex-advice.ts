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
    | "embedder_changed"
    | "index_format_changed"
    | "identity_missing"
    | "files_waiting"
    | "files_changed"
    | "last_pass_stopped"
    | "size_ceiling"
    | "provider_fell_back";
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
  if (s.run?.status === "failed" && (s.run.errorCode === "interrupted" || s.run.errorCode === "timed_out") && !empty) {
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
  if (lastFull !== null && embedder === current) {
    // The box's own measure. ±30% for whatever has been added or removed since.
    minutes = { low: roundMinutes(lastFull * 0.7), high: roundMinutes(lastFull * 1.3) };
    basis = `this box's last full pass took about ${roundMinutes(lastFull)} min`;
  } else if (chunks !== null) {
    const ms = (chunks / ROUGH_CHUNKS_PER_SECOND[embedder]) * 1000;
    minutes = { low: roundMinutes(ms * 0.5), high: roundMinutes(ms * 2) };
    basis = `a rough rate for the ${embedder === "cloud" ? "ClawBox AI cloud" : "on-box"} embedder over ${count(chunks, "passage")}; no full pass on it has been timed here yet`;
  } else {
    basis = "nothing is indexed yet, so the box has no measure of how much text the folders hold";
  }
  if (files !== null && files > 0) basis += `; PDFs and office documents are converted to text first, which adds to it`;

  const cost = embedder === "cloud"
    ? `Sent to the ClawBox AI cloud embedder${model ? ` (${model})` : ""}${tokens !== null ? `: about ${tokens.toLocaleString("en-US")} tokens` : ""}, counted against the owner's ClawBox AI plan. The box shows no per-token price.`
    : "No money: the model runs on this box, which is busier than usual until the pass ends.";

  return { files, chunks, embedder, tokens, minutes, basis, cost };
}
