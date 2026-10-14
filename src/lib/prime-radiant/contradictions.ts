/**
 * The semantic contradiction pass: two claims with DIFFERENT ids that cannot
 * both be true.
 *
 * Blocking is by embedding: every active claim is embedded with Memory
 * Shard's own embedder (its text redacted first), and each claim in scope is
 * paired with its k = 5 nearest neighbours on OTHER pages. Measured on a
 * 50,000-claim vault, that blocking found every planted contradiction at
 * k = 5, where pairing claims by shared rare words found three in ten. The
 * pairs then go to the Flash judge, 40 a call, which answers
 * `contradiction | compatible | unsure` for each; the first and the last
 * become review items (a person decides, never the judge).
 *
 * Two caches keep a nightly pass cheap: a claim's vector is kept by the hash
 * of its text and the embedder's identity (`claim_embeddings`), and a pair's
 * verdict by the hash of the two texts (`judged_pairs`) — an unchanged vault
 * embeds nothing and judges nothing the next night.
 *
 * Every model dependency is injectable; nothing here throws for a model that
 * cannot answer — the pass reports what it skipped.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import { processStore } from "@/lib/process-store";
import { estimateUsd, type CostRates } from "./cost-rates";
import { completeWithRetry, FlashCallError, flashClient, stubEnabled, type FlashClient, type RetryOptions } from "./flash-client";
import { recordCost } from "./ingest-store";
import { buildJudgePrompt, JUDGE_VERDICTS, parseJudgeResponse, type JudgeVerdict } from "./judge";
import { redactText } from "./redact";
import { addReviewItem, type ReviewItem } from "./review-store";
import { stateDbExists, withStateDb } from "./state-db";
import type { VaultSnapshot } from "./vault";

export const KNN_K = 5;
export const JUDGE_BATCH_PAIRS = 40;
export const JUDGE_PARALLEL = 8;
export const JUDGE_MAX_TOKENS = 8_000;
/** The most claims one pass holds vectors for (~80 MiB of float32 at 1,024 dimensions). */
export const MAX_PASS_CLAIMS = 20_000;
/** The most pairs one pass sends to the judge; the rest wait for the next pass. */
export const MAX_JUDGED_PAIRS = 4_000;
const MAX_CLAIM_CHARS = 500;

// ── the embedder ──────────────────────────────────────────────────────────

export interface ClaimEmbedder {
  /** Which model the vectors belong to, before any call. */
  identity(): Promise<string>;
  /** Unit-length vectors, in order. Throws when the embedder cannot answer. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

const store = processStore("prime-radiant:claim-embedder", () => ({ override: null as ClaimEmbedder | null }));

/** Install the embedder every pass uses instead of Memory Shard's (tests). `null` removes it. */
export function setClaimEmbedderOverride(embedder: ClaimEmbedder | null): void {
  store.override = embedder;
}

/**
 * A deterministic stand-in: a bag of hashed words, unit length. Texts that
 * share words are near each other — enough for a test to plant a pair.
 */
export function createHashEmbedder(dims = 256): ClaimEmbedder {
  return {
    async identity() {
      return `hash-${dims}`;
    },
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dims);
        for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
          const h = crypto.createHash("sha256").update(w).digest();
          v[h.readUInt32BE(0) % dims] += 1;
        }
        let sum = 0;
        for (const x of v) sum += x * x;
        const norm = Math.sqrt(sum) || 1;
        for (let i = 0; i < dims; i++) v[i] /= norm;
        return v;
      });
    },
  };
}

function shardEmbedder(): ClaimEmbedder {
  return {
    async identity() {
      const { localEmbeddingIdentity } = await import("@/lib/memory-index-local");
      return localEmbeddingIdentity();
    },
    async embed(texts, signal) {
      const { embedDocumentsWithShardEmbedder } = await import("@/lib/memory-index-local");
      return (await embedDocumentsWithShardEmbedder(texts, signal)).vectors;
    },
  };
}

export function claimEmbedder(): ClaimEmbedder {
  if (store.override) return store.override;
  if (stubEnabled()) return createHashEmbedder();
  return shardEmbedder();
}

// ── claims and pairs (pure) ───────────────────────────────────────────────

export interface PassClaim {
  id: string;
  page: string;
  /** The claim text, redacted — the only form that leaves the box. */
  text: string;
  verified: boolean;
}

/** Every active claim on a valid page, redacted, in page order. */
export function collectClaims(snapshot: Pick<VaultSnapshot, "pages">): PassClaim[] {
  const out: PassClaim[] = [];
  for (const page of snapshot.pages) {
    if (!page.parsed.ok) continue;
    for (const c of page.parsed.frontmatter.claims) {
      out.push({ id: c.id, page: page.path, text: redactText(c.text.slice(0, MAX_CLAIM_CHARS)).text, verified: !!c.verified });
    }
  }
  return out;
}

export interface CandidatePair {
  a: number;
  b: number;
  score: number;
}

/**
 * For each claim in `queries` (indexes into `vectors`), its `k` nearest
 * neighbours on another page with another id — each unordered pair once.
 */
export function nearestPairs(
  claims: readonly Pick<PassClaim, "id" | "page">[],
  vectors: readonly Float32Array[],
  queries: readonly number[],
  k = KNN_K,
): CandidatePair[] {
  const seen = new Map<string, CandidatePair>();
  for (const q of queries) {
    const qv = vectors[q];
    const best: Array<{ at: number; score: number }> = [];
    for (let i = 0; i < vectors.length; i++) {
      if (i === q || claims[i].page === claims[q].page || claims[i].id === claims[q].id) continue;
      const v = vectors[i];
      let score = 0;
      for (let d = 0; d < qv.length && d < v.length; d++) score += qv[d] * v[d];
      if (best.length < k) {
        best.push({ at: i, score });
        best.sort((x, y) => y.score - x.score);
      } else if (score > best[best.length - 1].score) {
        best[best.length - 1] = { at: i, score };
        best.sort((x, y) => y.score - x.score);
      }
    }
    for (const { at, score } of best) {
      const a = Math.min(q, at);
      const b = Math.max(q, at);
      const key = `${a}:${b}`;
      if (!seen.has(key)) seen.set(key, { a, b, score });
    }
  }
  return [...seen.values()].sort((x, y) => y.score - x.score);
}

export function textHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** One key per unordered pair of TEXTS: the same two statements are judged once. */
export function pairHash(a: string, b: string): string {
  const [x, y] = [textHash(a), textHash(b)].sort();
  return crypto.createHash("sha256").update(`${x}|${y}`).digest("hex").slice(0, 32);
}

// ── the pass ──────────────────────────────────────────────────────────────

export interface ContradictionFinding {
  a: { id: string; page: string; text: string; verified: boolean };
  b: { id: string; page: string; text: string; verified: boolean };
  verdict: "contradiction" | "unsure";
  why: string;
  score: number;
}

export interface ContradictionPassResult {
  claims: number;
  queried: number;
  embedded: number;
  pairs: number;
  /** Pairs the judge was asked about this pass (the rest came from the cache). */
  judged: number;
  calls: number;
  usdEstimate: number;
  findings: ContradictionFinding[];
  /** Review items raised (new ones and ones already waiting). */
  reviewItems: ReviewItem[];
  /** Why the pass did nothing or stopped short, when it did. */
  skipped: string | null;
  notes: string[];
}

export interface ContradictionPassOptions {
  /** Where the state database lives (the main vault; a nightly worktree reads pages, not state). */
  stateVault: string;
  /** Pages whose claims are the queries; null = every claim. */
  scope: readonly string[] | null;
  runId?: string | null;
  client?: FlashClient;
  embedder?: ClaimEmbedder;
  rates?: CostRates;
  retry?: RetryOptions;
  signal?: AbortSignal;
  now?: () => Date;
  k?: number;
  /** Raise review items for the findings (default true). */
  raiseItems?: boolean;
}

interface CachedVector {
  hash: string;
  vec: Float32Array;
}

function readCachedVectors(vault: string, identity: string): Map<string, CachedVector> {
  const out = new Map<string, CachedVector>();
  if (!stateDbExists(vault)) return out;
  withStateDb(vault, (db) => {
    const rows = db.prepare("SELECT claim_id, text_hash, dims, vec FROM claim_embeddings WHERE identity = ?").all(identity) as Array<{
      claim_id: string;
      text_hash: string;
      dims: number;
      vec: Uint8Array;
    }>;
    for (const r of rows) {
      const bytes = r.vec;
      if (bytes.byteLength !== r.dims * 4) continue;
      const copy = new Float32Array(r.dims);
      new Uint8Array(copy.buffer).set(bytes);
      out.set(r.claim_id, { hash: r.text_hash, vec: copy });
    }
  });
  return out;
}

function storeVectors(vault: string, identity: string, rows: ReadonlyArray<{ id: string; hash: string; vec: Float32Array }>, at: string): void {
  if (rows.length === 0) return;
  withStateDb(vault, (db) => {
    const stmt = db.prepare(
      `INSERT INTO claim_embeddings (claim_id, text_hash, identity, dims, vec, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(claim_id, identity) DO UPDATE SET text_hash = excluded.text_hash, dims = excluded.dims, vec = excluded.vec, at = excluded.at`,
    );
    db.exec("BEGIN");
    try {
      for (const r of rows) stmt.run(r.id, r.hash, identity, r.vec.length, new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength), at);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
}

function readJudged(vault: string, hashes: readonly string[]): Map<string, { verdict: JudgeVerdict; why: string }> {
  const out = new Map<string, { verdict: JudgeVerdict; why: string }>();
  if (hashes.length === 0 || !stateDbExists(vault)) return out;
  withStateDb(vault, (db) => {
    const stmt = db.prepare("SELECT verdict, why FROM judged_pairs WHERE pair_hash = ?");
    for (const h of hashes) {
      const row = stmt.get(h) as { verdict: string; why: string | null } | undefined;
      if (row && (JUDGE_VERDICTS as readonly string[]).includes(row.verdict)) out.set(h, { verdict: row.verdict as JudgeVerdict, why: row.why ?? "" });
    }
  });
  return out;
}

function storeJudged(vault: string, rows: ReadonlyArray<{ hash: string; verdict: JudgeVerdict; why: string }>, at: string): void {
  if (rows.length === 0) return;
  withStateDb(vault, (db) => {
    const stmt = db.prepare(
      `INSERT INTO judged_pairs (pair_hash, verdict, why, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(pair_hash) DO UPDATE SET verdict = excluded.verdict, why = excluded.why, at = excluded.at`,
    );
    db.exec("BEGIN");
    try {
      for (const r of rows) stmt.run(r.hash, r.verdict, r.why, at);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
}

/** Run `tasks` with at most `limit` in flight, in order of start. */
async function pool<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const at = next++;
      out[at] = await tasks[at]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

export async function runContradictionPass(snapshot: Pick<VaultSnapshot, "pages">, options: ContradictionPassOptions): Promise<ContradictionPassResult> {
  const now = options.now ?? (() => new Date());
  const result: ContradictionPassResult = {
    claims: 0,
    queried: 0,
    embedded: 0,
    pairs: 0,
    judged: 0,
    calls: 0,
    usdEstimate: 0,
    findings: [],
    reviewItems: [],
    skipped: null,
    notes: [],
  };
  let claims = collectClaims(snapshot);
  if (claims.length > MAX_PASS_CLAIMS) {
    // Scope first, so the claims a night changed are always among those compared.
    const inScope = new Set(options.scope ?? []);
    claims = [...claims.filter((c) => inScope.has(c.page)), ...claims.filter((c) => !inScope.has(c.page))].slice(0, MAX_PASS_CLAIMS);
    result.notes.push(`Only ${MAX_PASS_CLAIMS} claims were compared; the rest wait for a later pass.`);
  }
  result.claims = claims.length;
  const scope = options.scope ? new Set(options.scope) : null;
  const queries = claims.flatMap((c, i) => (!scope || scope.has(c.page) ? [i] : []));
  result.queried = queries.length;
  if (queries.length === 0 || claims.length < 2) {
    result.skipped = "nothing_to_compare";
    return result;
  }

  // Embed what the cache does not hold for this embedder.
  const embedder = options.embedder ?? claimEmbedder();
  let vectors: Float32Array[];
  try {
    const identity = await embedder.identity();
    const cached = readCachedVectors(options.stateVault, identity);
    const hashes = claims.map((c) => textHash(c.text));
    const missing = claims.flatMap((c, i) => (cached.get(c.id)?.hash === hashes[i] ? [] : [i]));
    const fresh = missing.length > 0 ? await embedder.embed(missing.map((i) => claims[i].text), options.signal) : [];
    if (fresh.length !== missing.length) throw new Error("the embedder answered a different number of vectors");
    result.embedded = missing.length;
    const byIndex = new Map<number, Float32Array>(missing.map((i, n) => [i, fresh[n]]));
    vectors = claims.map((c, i) => byIndex.get(i) ?? cached.get(c.id)!.vec);
    try {
      storeVectors(options.stateVault, identity, missing.map((i, n) => ({ id: claims[i].id, hash: hashes[i], vec: fresh[n] })), now().toISOString());
    } catch {
      result.notes.push("The claim vectors could not be cached; the next pass embeds them again.");
    }
  } catch (err) {
    result.skipped = "embedder_unavailable";
    result.notes.push(`The embedder could not answer: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
    return result;
  }
  const dims = vectors[0]?.length ?? 0;
  if (!vectors.every((v) => v.length === dims)) {
    result.skipped = "embedder_unavailable";
    result.notes.push("The claim vectors have different widths; run the pass again after the embedder settles.");
    return result;
  }

  let pairs = nearestPairs(claims, vectors, queries, options.k ?? KNN_K);
  result.pairs = pairs.length;
  if (pairs.length > MAX_JUDGED_PAIRS) {
    pairs = pairs.slice(0, MAX_JUDGED_PAIRS);
    result.notes.push(`Only the ${MAX_JUDGED_PAIRS} closest pairs were judged this pass.`);
  }
  const hashes = pairs.map((p) => pairHash(claims[p.a].text, claims[p.b].text));
  const known = readJudged(options.stateVault, hashes);
  const ask = pairs.flatMap((p, n) => (known.has(hashes[n]) ? [] : [n]));

  // The judge, 40 pairs a call, a few calls in flight.
  const client = options.client ?? flashClient();
  const rates = options.rates;
  const batches: number[][] = [];
  for (let at = 0; at < ask.length; at += JUDGE_BATCH_PAIRS) batches.push(ask.slice(at, at + JUDGE_BATCH_PAIRS));
  const learned: Array<{ hash: string; verdict: JudgeVerdict; why: string }> = [];
  let stop: string | null = null;
  await pool(
    batches.map((batch) => async () => {
      if (stop || options.signal?.aborted) return;
      const { system, user } = buildJudgePrompt(batch.map((n) => ({ a: claims[pairs[n].a].text, b: claims[pairs[n].b].text })));
      try {
        const { response } = await completeWithRetry(client, { system, user, maxTokens: JUDGE_MAX_TOKENS, signal: options.signal }, options.retry);
        const usd = estimateUsd(response.model, response.usage, rates);
        result.calls += 1;
        result.usdEstimate += usd;
        try {
          recordCost(options.stateVault, {
            runId: options.runId ?? null,
            operation: "contradiction-judge",
            model: response.model,
            tokensIn: response.usage.promptTokens,
            tokensOut: response.usage.completionTokens,
            usdEstimate: usd,
            at: now().toISOString(),
          });
        } catch {
          /* the cost table is a record, not a gate */
        }
        const verdicts = parseJudgeResponse(response.text, batch.length);
        for (const [i, v] of verdicts) {
          const n = batch[i];
          known.set(hashes[n], v);
          learned.push({ hash: hashes[n], verdict: v.verdict, why: v.why });
        }
        result.judged += verdicts.size;
      } catch (err) {
        const e = err instanceof FlashCallError ? err : null;
        // A refused credential or plan stops the pass; a batch that kept failing is retried next pass.
        if (e && (e.kind === "no_credential" || e.kind === "auth" || e.kind === "refused" || e.kind === "aborted")) stop = e.kind;
        else result.notes.push(`A judge call failed (${e?.kind ?? "error"}); its pairs are judged next pass.`);
      }
    }),
    JUDGE_PARALLEL,
  );
  if (stop) {
    result.skipped = stop === "aborted" ? "aborted" : "judge_unavailable";
    result.notes.push(`The judge stopped: ${stop}.`);
  }
  try {
    storeJudged(options.stateVault, learned, now().toISOString());
  } catch {
    result.notes.push("The verdicts could not be cached; the next pass asks again.");
  }

  pairs.forEach((p, n) => {
    const v = known.get(hashes[n]);
    if (!v || v.verdict === "compatible") return;
    const a = claims[p.a];
    const b = claims[p.b];
    result.findings.push({ a: { ...a }, b: { ...b }, verdict: v.verdict, why: v.why, score: Math.round(p.score * 1000) / 1000 });
  });

  if (options.raiseItems !== false) {
    for (const f of result.findings) {
      // The claim the item is about: the one that is NOT verified (a person
      // already settled the other), else the newer side of the pair.
      const [subject, other] = f.a.verified && !f.b.verified ? [f.b, f.a] : [f.a, f.b];
      try {
        const { item } = addReviewItem(
          options.stateVault,
          {
            kind: "contradiction",
            claimId: subject.id,
            pages: [subject.page, other.page],
            candidates: [
              { text: subject.text, page: subject.page, claimId: subject.id, evidence: [{ kind: "claim", page: subject.page }] },
              {
                text: other.text,
                page: other.page,
                claimId: other.id,
                evidence: [{ kind: other.verified ? "verified-claim" : "claim", page: other.page }],
              },
            ],
            evidence: [{ kind: "judge", verdict: f.verdict, note: f.why, source: "flash" }],
            dedupeKey: `contradiction:${[f.a.id, f.b.id].sort().join("|")}`,
            runId: options.runId ?? null,
          },
          now().toISOString(),
        );
        result.reviewItems.push(item);
      } catch {
        result.notes.push("A review item could not be saved.");
      }
    }
  }
  result.usdEstimate = Math.round(result.usdEstimate * 1e6) / 1e6;
  return result;
}
