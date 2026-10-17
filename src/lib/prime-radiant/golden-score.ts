/**
 * The golden questions' nightly check and its score history.
 *
 * `runGoldenScore` answers every golden question from the wiki as `main`
 * holds it — the vault search's hits (when Memory Shard's index is there) and
 * the claims that share the question's words (golden.ts `goldenEvidence`) —
 * and has Flash judge each answer against the one its owner expects, in
 * batches of {@link GOLDEN_LIMITS.batch}. CAPPED: at most `maxQuestions` a
 * night (the ones asked longest ago first, so a big set takes turns) and
 * `goldenMaxTokens` an answer, every call recorded with `recordCost` under the
 * night's run. SKIPPABLE: offline, with no question, or when the model refuses
 * (no credential, auth), the check is skipped and says why — never a failed
 * night. A question answered `correct` last time and `wrong` now becomes a
 * `lint` review item for its owner (no run id: it never holds a night).
 *
 * The history is in the state database (state v9: `golden_scores`,
 * `golden_results`); `goldenStatus` reads it for the status route without
 * creating anything.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import type { CostRates } from "./cost-rates";
import { completeWithRetry, estimateUsd, FlashCallError, flashClient, type FlashClient } from "./flash-client";
import {
  buildGoldenPrompt,
  GOLDEN_LIMITS,
  GOLDEN_VERDICTS,
  goldenEvidence,
  goldenMaxTokens,
  goldenRegressions,
  goldenTally,
  parseGoldenResponse,
  type GoldenEvidence,
  type GoldenHit,
  type GoldenPage,
  type GoldenQuestion,
  type GoldenTally,
  type GoldenVerdict,
} from "./golden";
import { readGoldenQuestions } from "./golden-store";
import { recordCost } from "./ingest-store";
import { vaultDir } from "./paths";
import { redactText } from "./redact";
import { addReviewItem } from "./review-store";
import { DEFAULT_GOLDEN_MAX_QUESTIONS } from "./settings";
import { runInTransaction, stateDbExists, withStateDb } from "./state-db";
import { readVaultSnapshot, type VaultSnapshot } from "./vault";

/** Score rows the status route reads for its trend. */
export const GOLDEN_TREND_POINTS = 14;

/** A refusal no later call of the night can get past: the check stops there. */
const MODEL_REFUSALS = new Set(["no_credential", "auth", "refused", "aborted"]);

export interface GoldenScoreResult {
  /** Why nothing was asked: `offline`, `disabled`, `no_questions`, `model_unavailable`. */
  skipped: string | null;
  scoreId: string | null;
  tally: GoldenTally;
  /** Questions past the night's cap, left for the next nights. */
  capped: number;
  calls: number;
  usdEstimate: number;
  regressions: string[];
  reviewItems: string[];
  notes: string[];
}

export interface GoldenScoreOptions {
  vault?: string;
  runId?: string | null;
  client?: FlashClient;
  rates?: CostRates;
  now?: () => Date;
  maxQuestions?: number;
  /** Whether ClawBox AI can be asked at all (the nightly pass's own check). */
  online?: boolean;
  /** The vault search for one question (default: none — the claims' words alone). */
  search?: (question: string) => Promise<readonly GoldenHit[]>;
  snapshot?: VaultSnapshot;
  signal?: AbortSignal;
}

function emptyResult(skipped: string | null, asked = 0): GoldenScoreResult {
  return { skipped, scoreId: null, tally: goldenTally(new Array(asked).fill(null)), capped: 0, calls: 0, usdEstimate: 0, regressions: [], reviewItems: [], notes: [] };
}

/** Each question's latest verdict and when it was last asked. */
function lastResults(vault: string): Map<string, { verdict: GoldenVerdict | null; at: string }> {
  const out = new Map<string, { verdict: GoldenVerdict | null; at: string }>();
  if (!stateDbExists(vault)) return out;
  withStateDb(vault, (db) => {
    const rows = db
      .prepare("SELECT question_id, verdict, at FROM golden_results ORDER BY at ASC, score_id ASC")
      .all() as Array<{ question_id: string; verdict: string | null; at: string }>;
    for (const r of rows) {
      const verdict = (GOLDEN_VERDICTS as readonly string[]).includes(r.verdict ?? "") ? (r.verdict as GoldenVerdict) : null;
      // A question asked and left unjudged keeps the verdict it had: a failed call is no change of answer.
      const prior = out.get(r.question_id);
      out.set(r.question_id, { verdict: verdict ?? prior?.verdict ?? null, at: r.at });
    }
  });
  return out;
}

function pagesOf(snapshot: VaultSnapshot): GoldenPage[] {
  const out: GoldenPage[] = [];
  for (const p of snapshot.pages) if (p.parsed.ok) out.push({ path: p.path, fm: p.parsed.frontmatter });
  return out;
}

const redactEvidence = (e: GoldenEvidence): GoldenEvidence => ({ ...e, text: redactText(e.text).text, title: redactText(e.title).text });

/** Ask, judge, store, raise. Never throws for the model; a database that cannot be written does. */
export async function runGoldenScore(options: GoldenScoreOptions = {}): Promise<GoldenScoreResult> {
  const vault = options.vault ?? vaultDir();
  const now = options.now ?? (() => new Date());
  const { questions: all } = await readGoldenQuestions(vault);
  if (all.length === 0) return emptyResult("no_questions");
  if (options.online === false) return emptyResult("offline");

  const max = Math.max(1, Math.floor(options.maxQuestions ?? DEFAULT_GOLDEN_MAX_QUESTIONS));
  const last = lastResults(vault);
  // Never asked first, then the ones asked longest ago; ties keep the file's order.
  const order = all
    .map((q, i) => ({ q, i, at: last.get(q.id)?.at ?? "" }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.i - b.i))
    .map((x) => x.q);
  const asked = order.slice(0, max);
  const result = emptyResult(null, asked.length);
  result.capped = order.length - asked.length;

  const snapshot = options.snapshot ?? (await readVaultSnapshot(vault));
  const pages = pagesOf(snapshot);
  const at = now();
  const evidence = new Map<string, GoldenEvidence[]>();
  for (const q of asked) {
    let hits: readonly GoldenHit[] = [];
    if (options.search) hits = await options.search(redactText(q.question).text).catch(() => []);
    evidence.set(q.id, goldenEvidence(q.question, pages, { hits, now: at }).map(redactEvidence));
  }

  const client = options.client ?? flashClient();
  const verdicts = new Map<string, { verdict: GoldenVerdict; why: string }>();
  let refusal: string | null = null;
  for (let start = 0; start < asked.length && !refusal; start += GOLDEN_LIMITS.batch) {
    if (options.signal?.aborted) break;
    const batch = asked.slice(start, start + GOLDEN_LIMITS.batch);
    const { system, user } = buildGoldenPrompt(
      batch.map((q) => ({ question: redactText(q.question).text, expected: redactText(q.expected).text, evidence: evidence.get(q.id) ?? [] })),
    );
    try {
      const { response } = await completeWithRetry(client, { system, user, maxTokens: goldenMaxTokens(batch.length), signal: options.signal }, { retryOn: (err) => err.kind !== "bad_response" });
      result.calls++;
      const usd = estimateUsd(response.model, response.usage, options.rates);
      result.usdEstimate += usd;
      recordCost(vault, {
        runId: options.runId ?? null,
        operation: "golden",
        model: response.model,
        tokensIn: response.usage.promptTokens,
        tokensOut: response.usage.completionTokens,
        usdEstimate: usd,
        at: now().toISOString(),
      });
      let answers: Map<number, { verdict: GoldenVerdict; why: string }>;
      try {
        answers = parseGoldenResponse(response.text, batch.length);
      } catch {
        result.notes.push("The golden-question judge answered with no verdict for one batch; those questions count as not judged.");
        continue;
      }
      batch.forEach((q, i) => {
        const a = answers.get(i);
        if (a) verdicts.set(q.id, { verdict: a.verdict, why: redactText(a.why).text });
      });
    } catch (err) {
      const kind = err instanceof FlashCallError ? err.kind : "network";
      if (MODEL_REFUSALS.has(kind)) refusal = kind;
      else result.notes.push(`A golden-question judge call failed (${kind}); its questions count as not judged.`);
    }
  }
  if (refusal && verdicts.size === 0) {
    const skipped = emptyResult("model_unavailable");
    skipped.calls = result.calls;
    skipped.usdEstimate = result.usdEstimate;
    skipped.notes.push(`ClawBox AI refused the golden-question judge (${refusal}); the check was skipped.`);
    return skipped;
  }
  if (refusal) result.notes.push(`ClawBox AI refused the golden-question judge part way (${refusal}); the rest count as not judged.`);

  result.tally = goldenTally(asked.map((q) => verdicts.get(q.id)?.verdict ?? null));
  const scoreId = options.runId ?? `gs-${crypto.randomBytes(6).toString("hex")}`;
  result.scoreId = scoreId;
  const atIso = now().toISOString();
  withStateDb(vault, (db) =>
    runInTransaction(db, () => {
      const t = result.tally;
      db.prepare(
        "INSERT OR REPLACE INTO golden_scores (id, run_id, at, asked, correct, wrong, missing, stale, failed, percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(scoreId, options.runId ?? null, atIso, t.asked, t.correct, t.wrong, t.missing, t.stale, t.failed, t.percent);
      const put = db.prepare("INSERT OR REPLACE INTO golden_results (score_id, question_id, verdict, why, claim_ids, at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const q of asked) {
        const v = verdicts.get(q.id);
        put.run(scoreId, q.id, v?.verdict ?? null, v?.why ?? null, JSON.stringify((evidence.get(q.id) ?? []).map((e) => e.claimId)), atIso);
      }
    }),
  );

  const previous = new Map<string, GoldenVerdict>();
  for (const [id, r] of last) if (r.verdict) previous.set(id, r.verdict);
  const current = new Map<string, GoldenVerdict>();
  for (const [id, v] of verdicts) current.set(id, v.verdict);
  result.regressions = goldenRegressions(previous, current);
  for (const id of result.regressions) {
    const q = asked.find((x) => x.id === id) as GoldenQuestion;
    const ev = evidence.get(id) ?? [];
    const item = addReviewItem(
      vault,
      {
        kind: "lint",
        claimId: q.claimId,
        pages: [...new Set([...(q.page ? [q.page] : []), ...ev.map((e) => e.page)])].slice(0, 5),
        candidates: [
          { text: q.expected, page: q.page, ...(q.claimId ? { claimId: q.claimId } : {}), evidence: [{ kind: "golden-expected", note: `Expected by ${q.owner}` }] },
          ...ev.slice(0, 3).map((e) => ({ text: e.text, page: e.page, claimId: e.claimId, evidence: [{ kind: "golden-answer", page: e.page }] })),
        ],
        evidence: [
          {
            kind: "golden",
            verdict: "wrong",
            note: `Golden question "${q.question.slice(0, 160)}" was answered right last time and wrong now${verdicts.get(id)?.why ? `: ${verdicts.get(id)?.why}` : "."}`,
            source: q.id,
          },
        ],
        dedupeKey: `golden:${q.id}`,
        runId: null,
      },
      atIso,
    );
    if (item.created) result.reviewItems.push(item.item.id);
  }
  result.usdEstimate = Math.round(result.usdEstimate * 1e6) / 1e6;
  return result;
}

// ── the history ───────────────────────────────────────────────────────────

export interface GoldenScorePoint {
  id: string;
  runId: string | null;
  at: string;
  asked: number;
  correct: number;
  wrong: number;
  missing: number;
  stale: number;
  failed: number;
  percent: number | null;
}

/** The latest checks, newest first. Never creates the database. */
export function readGoldenHistory(vault: string = vaultDir(), limit = GOLDEN_TREND_POINTS): GoldenScorePoint[] {
  if (!stateDbExists(vault)) return [];
  return withStateDb(vault, (db) =>
    (db.prepare("SELECT * FROM golden_scores ORDER BY at DESC, id DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      runId: (r.run_id as string | null) ?? null,
      at: String(r.at),
      asked: Number(r.asked),
      correct: Number(r.correct),
      wrong: Number(r.wrong),
      missing: Number(r.missing),
      stale: Number(r.stale),
      failed: Number(r.failed),
      percent: typeof r.percent === "number" ? r.percent : null,
    })),
  );
}

/** Each question's latest verdict, for the list beside it. Never creates the database. */
export function readLatestVerdicts(vault: string = vaultDir()): Record<string, { verdict: GoldenVerdict | null; why: string | null; at: string }> {
  const out: Record<string, { verdict: GoldenVerdict | null; why: string | null; at: string }> = {};
  if (!stateDbExists(vault)) return out;
  withStateDb(vault, (db) => {
    const rows = db
      .prepare("SELECT question_id, verdict, why, at FROM golden_results ORDER BY at ASC, score_id ASC")
      .all() as Array<{ question_id: string; verdict: string | null; why: string | null; at: string }>;
    for (const r of rows) {
      const verdict = (GOLDEN_VERDICTS as readonly string[]).includes(r.verdict ?? "") ? (r.verdict as GoldenVerdict) : null;
      out[r.question_id] = { verdict, why: r.why, at: r.at };
    }
  });
  return out;
}

export interface GoldenStatus {
  questions: number;
  /** The latest check, or null before the first. */
  last: GoldenScorePoint | null;
  /** % correct of the latest checks, oldest first (nulls left out). */
  trend: Array<{ at: string; percent: number }>;
  /** The latest % correct minus the one before; null with fewer than two. */
  change: number | null;
}

/** What Status shows: the question count, the latest % correct and its trend. Never creates anything. */
export async function goldenStatus(vault: string = vaultDir()): Promise<GoldenStatus> {
  const { questions } = await readGoldenQuestions(vault);
  let history: GoldenScorePoint[] = [];
  try {
    history = readGoldenHistory(vault);
  } catch {
    history = [];
  }
  const trend = history
    .filter((h) => h.percent !== null)
    .map((h) => ({ at: h.at, percent: h.percent as number }))
    .reverse();
  const change = trend.length >= 2 ? Math.round((trend[trend.length - 1].percent - trend[trend.length - 2].percent) * 10) / 10 : null;
  return { questions: questions.length, last: history[0] ?? null, trend, change };
}
