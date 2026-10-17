/**
 * The semantic contradiction pass: two claims with DIFFERENT ids that cannot
 * both be true.
 *
 * Blocking is by embedding AND subject: every active claim is embedded with
 * Memory Shard's own embedder (its text redacted first), and each claim in
 * scope is paired with its k = 5 nearest neighbours on OTHER pages that are
 * about the SAME thing ({@link sameSubject}: the same entity in their ids, or
 * subjects that share most of their words, or one naming the other's) — on
 * the live test, pairing by wording alone sent a black hole against the US
 * Constitution, and 84 of 85 items were false. Measured on a 50,000-claim
 * vault, embedding blocking found every planted contradiction at k = 5,
 * where pairing claims by shared rare words found three in ten. Two claims
 * with the same text are never a pair. The pairs then go to the Flash judge
 * in small batches ({@link JUDGE_BATCH_PAIRS} a call, several in flight, the
 * answer capped at {@link judgeMaxTokens} — a terse verdict, a reason only
 * for what a person will read), which answers
 * `contradiction | compatible | unsure` for each; the first and the last
 * become review items (a person decides, never the judge). A batch is small
 * so that one answer the model botches costs only that batch: a call that
 * comes back with no readable verdict (or empty, capped before it answered —
 * never resent as it was) is asked once more in calls of
 * {@link JUDGE_RETRY_PAIRS}, so are the pairs a readable answer left out, and
 * what still fails waits for the next pass.
 *
 * Two caches keep a nightly pass cheap: a claim's vector is kept by the hash
 * of its text and the embedder's identity (`claim_embeddings`), and a pair's
 * verdict by the hash of the two texts (`judged_pairs`) — an unchanged vault
 * embeds nothing and judges nothing the next night.
 *
 * Nothing found is lost to a failure: a claim with a pair this pass could not
 * judge is written to `deferred_claims`, and the next pass compares it again
 * whatever that night's scope is, until its pairs are judged. A pass that
 * compared every claim and left nothing deferred records `full_comparison`
 * ({@link fullComparisonDone}) — the nightly pass compares the whole vault
 * until one has. A pass that compared (or deferred) every claim in its scope
 * records the commit it compared (`compared_through`,
 * {@link readComparedThrough}); the next night's scope is every page changed
 * since that commit, so what reached `main` by day is compared too.
 *
 * Every model dependency is injectable; nothing here throws for a model that
 * cannot answer — the pass reports what it skipped.
 *
 * SERVER ONLY.
 */

import { processStore } from "@/lib/process-store";
import { estimateUsd, type CostRates } from "./cost-rates";
import { completeWithRetry, FlashCallError, flashClient, stubEnabled, type FlashClient, type FlashResponse, type RetryOptions } from "./flash-client";
import { recordCost } from "./ingest-store";
import { buildJudgePrompt, JudgeParseError, JUDGE_VERDICTS, parseJudgeResponse, type JudgeVerdict } from "./judge";
import { redactText } from "./redact";
import { addReviewItem, type ReviewItem } from "./review-store";
import { runInTransaction, stateDbExists, withStateDb } from "./state-db";
import { sideIdentifiers, type Identifiers } from "./identifiers";
import { pairable } from "./pairing";
import { claimSubject, type ClaimSubject } from "./subject";
import { fieldValidity, historicalClaim, pageValidity, textValidity, type Validity } from "./validity";
import { ownerVerified, recordStaleClaims, type StaleClaimNote } from "./verify";
import { versionGroups, versionIndex, versionPages } from "./versions";
import type { VaultSnapshot } from "./vault";

export const KNN_K = 5;
/**
 * Pairs a judge call carries. Small on purpose: on a real box one call of 67
 * pairs came back unreadable and the whole pass found nothing, and a call of
 * 12 that ran long lost all twelve.
 */
export const JUDGE_BATCH_PAIRS = 8;
/** The size of the calls a failed batch (or the pairs an answer left out) is asked again in. */
export const JUDGE_RETRY_PAIRS = 2;
/** Judge calls in flight unless the caller says otherwise (the nightly pass passes the settings' parallelism). */
export const JUDGE_PARALLEL = 8;
/** The output ceiling of any judge call (it was 8,000 for every call). */
export const JUDGE_MAX_TOKENS = 4_096;
/** A judge call's output budget: this much, plus {@link JUDGE_TOKENS_PER_PAIR} a pair. */
export const JUDGE_BASE_TOKENS = 512;
/** Room per pair for a model that thinks before it answers; the verdict itself is ~15 tokens. */
export const JUDGE_TOKENS_PER_PAIR = 384;

/** The output cap of a judge call carrying `pairs` pairs. */
export function judgeMaxTokens(pairs: number): number {
  return Math.min(JUDGE_MAX_TOKENS, JUDGE_BASE_TOKENS + JUDGE_TOKENS_PER_PAIR * Math.max(1, pairs));
}
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
          v[parseInt(cacheKey(w).slice(0, 8), 16) % dims] += 1;
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
  /** A person verified it (or its page): it wins against any claim the judge finds against it (verify.ts). */
  ownerVerified?: boolean;
  /** What the claim is about (its own subject, else its page's), for {@link sameSubject}. */
  subject: ClaimSubject;
  /** The identifiers its page title and its text carry (waybill, invoice, transfer numbers, dates), and whether its page is a record. */
  ids?: Identifiers;
  /** Its page's version group (the winner's path) when the page is one of several versions of a document (versions.ts). */
  version?: string | null;
  /** When it holds: its own fields, its text, or its snapshot page's date (validity.ts). */
  validity?: Validity | null;
  /** Marked or worded as a past state of things. */
  historical?: boolean;
  /** Its page is deprecated. */
  deprecated?: boolean;
}

/** Every active claim on a valid page, redacted, in page order. */
export function collectClaims(snapshot: Pick<VaultSnapshot, "pages">): PassClaim[] {
  const versions = versionIndex(versionGroups(versionPages(snapshot)));
  const out: PassClaim[] = [];
  for (const page of snapshot.pages) {
    if (!page.parsed.ok) continue;
    const fm = page.parsed.frontmatter;
    const { title, type } = fm;
    // A snapshot page's period, read once for all its claims (validity.ts claimValidity, the page step).
    const pagePeriod = pageValidity(title, type, fm.generated?.at ?? null);
    for (const c of fm.claims) {
      const text = redactText(c.text.slice(0, MAX_CLAIM_CHARS)).text;
      out.push({
        id: c.id,
        page: page.path,
        text,
        verified: !!c.verified,
        ownerVerified: ownerVerified(c, fm),
        subject: claimSubject(c.id, text, title),
        ids: sideIdentifiers(title, text, type),
        version: versions.get(page.path) ?? null,
        validity: fieldValidity(c) ?? textValidity(c.text, c.updatedAt) ?? pagePeriod,
        historical: historicalClaim(c),
        deprecated: fm.status === "deprecated",
      });
    }
  }
  return out;
}

type Comparable = Pick<PassClaim, "text" | "subject" | "ids" | "version" | "validity" | "historical" | "deprecated">;

/**
 * Whether two claims of the pass may be judged as a pair: not the same
 * statement twice (that can never contradict itself), and nothing in
 * pairing.ts parts them — not two versions of one document, not two
 * different subjects (identifiers, or words once template words are out),
 * not an old fact against the current one.
 */
export function comparable(a: Comparable, b: Comparable): boolean {
  return a.text !== b.text && pairable(a, b);
}

export interface CandidatePair {
  a: number;
  b: number;
  score: number;
}

/** Which two claims (indexes) may be a pair at all; absent, any two on different pages with different ids. */
export type PairFilter = (a: number, b: number) => boolean;

/**
 * For each claim in `queries` (indexes into `vectors`), its `k` nearest
 * neighbours on another page with another id — and, given `allow`, only
 * among the claims it allows (the pass: about the same thing) — each
 * unordered pair once.
 */
export function nearestPairs(
  claims: readonly Pick<PassClaim, "id" | "page">[],
  vectors: readonly Float32Array[],
  queries: readonly number[],
  k = KNN_K,
  allow?: PairFilter,
): CandidatePair[] {
  const seen = new Map<string, CandidatePair>();
  for (const q of queries) {
    const qv = vectors[q];
    const best: Array<{ at: number; score: number }> = [];
    for (let i = 0; i < vectors.length; i++) {
      if (i === q || claims[i].page === claims[q].page || claims[i].id === claims[q].id) continue;
      if (allow && !allow(q, i)) continue;
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

/**
 * A cache key for a claim text: cyrb128 (four 32-bit lanes, 128 bits). Not a
 * cryptographic hash and not meant as one — it only names an already-redacted
 * text in the vector and verdict caches, where a collision costs one stale
 * cache hit, never a secret.
 */
function cacheKey(text: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}

export function textHash(text: string): string {
  return cacheKey(text);
}

/** One key per unordered pair of TEXTS: the same two statements are judged once. */
export function pairHash(a: string, b: string): string {
  const [x, y] = [textHash(a), textHash(b)].sort();
  return cacheKey(`${x}|${y}`);
}

/** Queries per slice of the kNN search; the event loop is yielded between slices. */
export const KNN_QUERY_CHUNK = 64;

/**
 * {@link nearestPairs} in slices of queries, yielding to the event loop
 * between them: a first night's full pass is tens of thousands of queries,
 * and one synchronous call would stall every request the web server answers.
 * Same pairs, same order as one call; stops early when `signal` aborts.
 */
export async function nearestPairsYielding(
  claims: readonly Pick<PassClaim, "id" | "page">[],
  vectors: readonly Float32Array[],
  queries: readonly number[],
  k = KNN_K,
  signal?: AbortSignal,
  chunk = KNN_QUERY_CHUNK,
  allow?: PairFilter,
): Promise<CandidatePair[]> {
  const merged = new Map<string, CandidatePair>();
  for (let at = 0; at < queries.length; at += chunk) {
    if (signal?.aborted) break;
    for (const p of nearestPairs(claims, vectors, queries.slice(at, at + chunk), k, allow)) {
      const key = `${p.a}:${p.b}`;
      if (!merged.has(key)) merged.set(key, p);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return [...merged.values()].sort((x, y) => y.score - x.score);
}

// ── the pass ──────────────────────────────────────────────────────────────

export interface ContradictionFinding {
  a: { id: string; page: string; text: string; verified: boolean; ownerVerified?: boolean };
  b: { id: string; page: string; text: string; verified: boolean; ownerVerified?: boolean };
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
  /** Judge calls that failed (a batch, or a smaller retry of one); their pairs wait for the next pass. */
  failedBatches: number;
  /** Judge answers cut at their output cap ({@link judgeMaxTokens}); what they left out was asked again smaller. */
  capped: number;
  /** Pairs left unjudged this pass (failed batches, pairs an answer left out or garbled, pairs over the cap, a stopped judge). */
  deferredPairs: number;
  /** Claims an earlier pass deferred that this pass compared again (outside its own scope). */
  carried: number;
  /** Claims left in the deferred set for the next pass. */
  deferredClaims: number;
  /** Every claim in scope was compared and every pair found was judged and kept. */
  complete: boolean;
  usdEstimate: number;
  findings: ContradictionFinding[];
  /** Review items raised (new ones and ones already waiting). */
  reviewItems: ReviewItem[];
  /** Findings against an owner-verified claim: the verified claim wins, the other became a stale note (no review item). */
  staleNotes: number;
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
  /** Judge calls in flight (default {@link JUDGE_PARALLEL}). */
  parallel?: number;
  /** Raise review items for the findings (default true). */
  raiseItems?: boolean;
  /**
   * The commit whose pages `snapshot` holds. Recorded ({@link readComparedThrough})
   * once every claim in scope was compared or deferred to the next pass, so
   * the next pass's scope can be everything changed since.
   */
  comparedThrough?: string | null;
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
    runInTransaction(db, () => {
      for (const r of rows) stmt.run(r.id, r.hash, identity, r.vec.length, new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength), at);
    });
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
    runInTransaction(db, () => {
      for (const r of rows) stmt.run(r.hash, r.verdict, r.why, at);
    });
  });
}

// ── the carry-over ────────────────────────────────────────────────────────

const FULL_COMPARISON_KEY = "full_comparison";
/** The `pass_state` key holding the commit the last finished comparison compared. */
const COMPARED_THROUGH_KEY = "compared_through";
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The commit the last finished comparison compared — every claim in its scope
 * was compared or deferred — or null when none is recorded. Never creates the
 * database.
 */
export function readComparedThrough(vault: string): string | null {
  if (!stateDbExists(vault)) return null;
  const row = withStateDb(vault, (db) => db.prepare("SELECT value FROM pass_state WHERE key = ?").get(COMPARED_THROUGH_KEY)) as
    | { value: string | null }
    | undefined;
  return row?.value && FULL_SHA.test(row.value) ? row.value : null;
}

/** Ids of the claims an earlier pass could not finish judging. Never creates the database. */
export function readDeferredClaims(vault: string): Set<string> {
  if (!stateDbExists(vault)) return new Set();
  return withStateDb(vault, (db) => new Set((db.prepare("SELECT claim_id FROM deferred_claims").all() as Array<{ claim_id: string }>).map((r) => r.claim_id)));
}

/** Whether any pass has compared every claim and judged every pair it found. Never creates the database. */
export function fullComparisonDone(vault: string): boolean {
  if (!stateDbExists(vault)) return false;
  return withStateDb(vault, (db) => !!db.prepare("SELECT 1 AS one FROM pass_state WHERE key = ?").get(FULL_COMPARISON_KEY));
}

/**
 * Settle the deferred set after a pass: the claims it compared leave it (their
 * pairs were judged, or are written back below), claims the vault no longer
 * holds leave it, and every claim with an unjudged pair goes (back) in. One
 * transaction, so a failure leaves the set as it was.
 */
function settleDeferred(
  vault: string,
  input: {
    compared: readonly string[];
    present: ReadonlySet<string>;
    deferred: ReadonlyArray<{ id: string; page: string }>;
    reason: string;
    full: boolean;
    /** The commit to record as compared through, or null to leave the mark where it is. */
    through: string | null;
  },
  at: string,
): void {
  withStateDb(vault, (db) => {
    const existing = (db.prepare("SELECT claim_id FROM deferred_claims").all() as Array<{ claim_id: string }>).map((r) => r.claim_id);
    const drop = db.prepare("DELETE FROM deferred_claims WHERE claim_id = ?");
    const add = db.prepare(
      `INSERT INTO deferred_claims (claim_id, page, reason, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(claim_id) DO UPDATE SET page = excluded.page, reason = excluded.reason, at = excluded.at`,
    );
    const mark = db.prepare(`INSERT INTO pass_state (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at`);
    runInTransaction(db, () => {
      for (const id of input.compared) drop.run(id);
      for (const id of existing) if (!input.present.has(id)) drop.run(id);
      for (const c of input.deferred) add.run(c.id, c.page, input.reason, at);
      if (input.full) mark.run(FULL_COMPARISON_KEY, at, at);
      if (input.through) mark.run(COMPARED_THROUGH_KEY, input.through, at);
    });
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
    failedBatches: 0,
    capped: 0,
    deferredPairs: 0,
    carried: 0,
    deferredClaims: 0,
    complete: false,
    usdEstimate: 0,
    findings: [],
    reviewItems: [],
    staleNotes: 0,
    skipped: null,
    notes: [],
  };
  const all = collectClaims(snapshot);
  const present = new Set(all.map((c) => c.id));
  let deferredBefore: Set<string>;
  try {
    deferredBefore = readDeferredClaims(options.stateVault);
  } catch {
    deferredBefore = new Set();
    result.notes.push("The claims an earlier pass left unjudged could not be read; they are compared on a later pass.");
  }
  const scope = options.scope ? new Set(options.scope) : null;
  const wanted = (c: PassClaim) => !scope || scope.has(c.page) || deferredBefore.has(c.id);
  let claims = all;
  let overCap = false;
  if (claims.length > MAX_PASS_CLAIMS) {
    // Scope (and what an earlier pass left unjudged) first, so those claims are always among those compared.
    claims = [...claims.filter(wanted), ...claims.filter((c) => !wanted(c))].slice(0, MAX_PASS_CLAIMS);
    overCap = true;
    result.notes.push(`Only ${MAX_PASS_CLAIMS} claims were compared; the rest wait for a later pass.`);
  }
  result.claims = claims.length;
  const queries = claims.flatMap((c, i) => (wanted(c) ? [i] : []));
  result.queried = queries.length;
  result.carried = scope ? queries.filter((i) => !scope.has(claims[i].page)).length : 0;
  if (result.carried > 0) result.notes.push(`${result.carried} claim(s) an earlier pass could not finish judging were compared again.`);

  /** Write the carry-over and decide whether this pass was a full comparison. Never throws. */
  const finish = (unjudged: ReadonlySet<number>, reason: string): ContradictionPassResult => {
    const deferred = [...unjudged].map((i) => ({ id: claims[i].id, page: claims[i].page }));
    result.deferredClaims = deferred.length;
    // Nothing to compare is not a failure: a vault of one claim has compared everything.
    result.complete = (!result.skipped || result.skipped === "nothing_to_compare") && unjudged.size === 0 && result.deferredPairs === 0 && !overCap;
    // Every claim in scope was compared or is deferred (and so carried): the
    // next pass may start from this commit. Over the cap, some were neither.
    const through = !overCap && options.comparedThrough && FULL_SHA.test(options.comparedThrough) ? options.comparedThrough : null;
    try {
      settleDeferred(
        options.stateVault,
        { compared: queries.map((i) => claims[i].id), present, deferred, reason, full: result.complete && !scope, through },
        now().toISOString(),
      );
    } catch {
      result.complete = false;
      result.notes.push("The claims left unjudged could not be recorded; the next pass compares the whole vault.");
    }
    return result;
  };

  if (queries.length === 0 || claims.length < 2) {
    result.skipped = "nothing_to_compare";
    return finish(new Set(), "nothing_to_compare");
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
    return finish(new Set(queries), "embedder_unavailable");
  }
  const dims = vectors[0]?.length ?? 0;
  if (!vectors.every((v) => v.length === dims)) {
    result.skipped = "embedder_unavailable";
    result.notes.push("The claim vectors have different widths; run the pass again after the embedder settles.");
    return finish(new Set(queries), "embedder_unavailable");
  }

  const pairs = await nearestPairsYielding(claims, vectors, queries, options.k ?? KNN_K, options.signal, KNN_QUERY_CHUNK, (a, b) =>
    comparable(claims[a], claims[b]),
  );
  result.pairs = pairs.length;
  if (options.signal?.aborted) {
    result.skipped = "aborted";
    return finish(new Set(queries), "aborted");
  }
  const hashes = pairs.map((p) => pairHash(claims[p.a].text, claims[p.b].text));
  const known = readJudged(options.stateVault, hashes);
  let ask = pairs.flatMap((p, n) => (known.has(hashes[n]) ? [] : [n]));
  // The cap is on what the judge is ASKED (a cached verdict costs nothing), so
  // every pass makes progress; the pairs over it are carried to the next one.
  const overflow = ask.slice(MAX_JUDGED_PAIRS);
  if (overflow.length > 0) {
    ask = ask.slice(0, MAX_JUDGED_PAIRS);
    result.notes.push(`Only ${MAX_JUDGED_PAIRS} pairs were judged this pass; the other ${overflow.length} are judged next pass.`);
  }

  // The judge, a small batch a call, a few calls in flight.
  const client = options.client ?? flashClient();
  const rates = options.rates;
  const batches: number[][] = [];
  for (let at = 0; at < ask.length; at += JUDGE_BATCH_PAIRS) batches.push(ask.slice(at, at + JUDGE_BATCH_PAIRS));
  const learned: Array<{ hash: string; verdict: JudgeVerdict; why: string }> = [];
  const failures = new Map<string, number>();
  let stop: string | null = null;

  // An empty or capped answer is asked again in smaller calls, never resent as it was.
  const retry: RetryOptions = {
    ...options.retry,
    retryOn: (err) => err.kind !== "bad_response" && (options.retry?.retryOn?.(err) ?? true),
  };

  /**
   * One call: the pairs a readable answer left out, or why there was none.
   * Only a refused credential, plan or abort throws.
   */
  async function judgeOnce(batch: readonly number[]): Promise<{ ok: true; missing: number[] } | { ok: false; kind: string }> {
    const { system, user } = buildJudgePrompt(batch.map((n) => ({ a: claims[pairs[n].a].text, b: claims[pairs[n].b].text })));
    let response: FlashResponse;
    try {
      ({ response } = await completeWithRetry(client, { system, user, maxTokens: judgeMaxTokens(batch.length), signal: options.signal }, retry));
    } catch (err) {
      const e = err instanceof FlashCallError ? err : null;
      if (e && (e.kind === "no_credential" || e.kind === "auth" || e.kind === "refused" || e.kind === "aborted")) throw e;
      return { ok: false, kind: e?.kind ?? "error" };
    }
    const usd = estimateUsd(response.model, response.usage, rates);
    result.calls += 1;
    result.usdEstimate += usd;
    if (response.finishReason === "length") result.capped += 1;
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
    let verdicts: ReturnType<typeof parseJudgeResponse>;
    try {
      verdicts = parseJudgeResponse(response.text, batch.length);
    } catch (err) {
      if (err instanceof JudgeParseError) return { ok: false, kind: "bad_response" };
      throw err;
    }
    for (const [i, v] of verdicts) {
      const n = batch[i];
      known.set(hashes[n], v);
      learned.push({ hash: hashes[n], verdict: v.verdict, why: v.why });
    }
    result.judged += verdicts.size;
    return { ok: true, missing: batch.filter((_, i) => !verdicts.has(i)) };
  }

  function batchFailed(kind: string): void {
    result.failedBatches += 1;
    failures.set(kind, (failures.get(kind) ?? 0) + 1);
  }

  await pool(
    batches.map((batch) => async () => {
      if (stop || options.signal?.aborted) return;
      try {
        const first = await judgeOnce(batch);
        // An unreadable (or empty, or capped) answer, and the pairs a readable
        // one left out, are asked once more in small calls; a call that failed
        // for another reason waits for the next pass.
        if (!first.ok && first.kind !== "bad_response") {
          batchFailed(first.kind);
          return;
        }
        const again = first.ok ? first.missing : batch;
        for (let at = 0; at < again.length; at += JUDGE_RETRY_PAIRS) {
          if (stop || options.signal?.aborted) return;
          const small = await judgeOnce(again.slice(at, at + JUDGE_RETRY_PAIRS));
          if (!small.ok) batchFailed(small.kind);
        }
      } catch (err) {
        // A refused credential or plan, or an abort, stops the pass.
        stop = err instanceof FlashCallError ? err.kind : "error";
      }
    }),
    Math.max(1, options.parallel ?? JUDGE_PARALLEL),
  );
  for (const [kind, count] of failures) {
    result.notes.push(
      count === 1
        ? `A judge call failed (${kind}); its pairs are judged next pass.`
        : `${count} judge calls failed (${kind}); their pairs are judged next pass.`,
    );
  }
  if (result.capped > 0) {
    result.notes.push(`${result.capped} judge answer(s) reached the output cap; the pairs they left out were asked again in smaller calls.`);
  }
  if (stop) {
    result.skipped = stop === "aborted" ? "aborted" : "judge_unavailable";
    result.notes.push(`The judge stopped: ${stop}.`);
  }
  let unkept: readonly number[] = [];
  try {
    storeJudged(options.stateVault, learned, now().toISOString());
  } catch {
    // Judged, but not remembered: the pairs stay owed so a later pass asks again.
    unkept = ask.filter((n) => known.has(hashes[n]));
    result.notes.push("The verdicts could not be cached; the next pass asks again.");
  }

  const unjudgedPairs = [...ask.filter((n) => !known.has(hashes[n])), ...overflow];
  result.deferredPairs = unjudgedPairs.length;
  const unjudged = new Set<number>();
  for (const n of [...unjudgedPairs, ...unkept]) {
    unjudged.add(pairs[n].a);
    unjudged.add(pairs[n].b);
  }

  pairs.forEach((p, n) => {
    const v = known.get(hashes[n]);
    if (!v || v.verdict === "compatible") return;
    const a = claims[p.a];
    const b = claims[p.b];
    const side = (c: PassClaim) => ({ id: c.id, page: c.page, text: c.text, verified: c.verified, ownerVerified: !!c.ownerVerified });
    result.findings.push({ a: side(a), b: side(b), verdict: v.verdict, why: v.why, score: Math.round(p.score * 1000) / 1000 });
  });

  if (options.raiseItems !== false) {
    // The owner already answered one side: the verified claim wins, the other is a stale note on its page, not a question.
    const oneVerified = (f: ContradictionFinding) => !!f.a.ownerVerified !== !!f.b.ownerVerified;
    const stale: StaleClaimNote[] = result.findings.filter(oneVerified).map((f) => {
      const [won, lost] = f.a.ownerVerified ? [f.a, f.b] : [f.b, f.a];
      return { claimId: lost.id, page: lost.page, verifiedClaimId: won.id, verifiedPage: won.page, why: f.why, at: now().toISOString() };
    });
    let staleKept = false;
    try {
      result.staleNotes = recordStaleClaims(options.stateVault, stale);
      staleKept = true;
    } catch {
      // Not recorded: those findings are raised as items instead, so nothing is lost.
      result.notes.push("The claims found against a verified claim could not be marked stale; they were raised for review instead.");
    }
    if (result.staleNotes > 0) result.notes.push(`${result.staleNotes} claim(s) disagree with an owner-verified claim: marked stale on their pages, no review item.`);
    for (const f of result.findings) {
      if (staleKept && oneVerified(f)) continue;
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
  return finish(unjudged, stop ? "judge_stopped" : overflow.length > 0 ? "over_cap" : "judge_failed");
}
