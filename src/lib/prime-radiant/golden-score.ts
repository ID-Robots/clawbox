/**
 * The golden questions' nightly check and its score history.
 *
 * `runGoldenScore` answers every golden question from the wiki as `main`
 * holds it — the vault search's hits (when Memory Shard's index is there) and
 * the claims that share the question's words (golden.ts `goldenEvidence`) —
 * and has Flash judge each answer against the one its owner expects, in
 * batches of {@link GOLDEN_LIMITS.batch}. CAPPED: at most `maxQuestions` a
 * night (the ones asked longest ago first, so a big set takes turns),
 * `goldenMaxTokens` an answer and `GOLDEN_LIMITS.usdPerNight` a night, every
 * call recorded with `recordCost` under the night's run. An empty, cut-off or
 * unreadable answer is asked again in halves, down to one question a call
 * (as the contradiction judge does), and never stops the later batches; only
 * two calls in a row the provider fails (unreachable, 5xx, busy) stop the
 * night's check. SKIPPABLE: offline, with no question,
 * when the model refuses (no credential, auth) or when no call of the night
 * judged anything, the check is skipped, says why and stores no score — never
 * a failed night, never a 0 % in the history. A spent ClawBox AI allowance
 * stops the check at the one refused call (`allowance_spent`): what was judged
 * before it is scored, the questions it did not reach are not stored, so they
 * keep their turn for the next night. A question answered `correct`
 * last time and `wrong` now becomes a `lint` review item for its owner (no run
 * id: it never holds a night) — unless the search failed for it that night:
 * an answer from the claims' words alone is no proof the wiki changed. Such
 * a verdict is stored (`search_failed`) and shown, but it is never the
 * baseline the next night compares with: that stays the last verdict a
 * working search gave, so a real regression is still raised once the search
 * works again. The night's signal reaches every search, and none starts once
 * it has fired.
 *
 * The history is in the state database (state v9: `golden_scores`,
 * `golden_results`); `goldenStatus` reads it for the status route without
 * creating anything.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import type { CostRates } from "./cost-rates";
import {
  ALLOWANCE_SPENT,
  allowanceSpentText,
  allowanceStopOf,
  completeWithRetry,
  estimateUsd,
  FlashCallError,
  flashClient,
  type AllowanceStop,
  type FlashClient,
  type FlashResponse,
  type RetryOptions,
} from "./flash-client";
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
const MODEL_REFUSALS = new Set(["no_credential", "auth", "refused", "allowance", "aborted"]);

export interface GoldenScoreResult {
  /** Why nothing was asked: `offline`, `disabled`, `no_questions`, `model_unavailable`, `allowance_spent`. */
  skipped: string | null;
  /**
   * The spent ClawBox AI allowance the judge stopped on. The questions it did
   * not judge are neither stored nor scored: they keep their turn, first in
   * line the next night.
   */
  allowance: AllowanceStop | null;
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
  /** The vault search for one question (default: none — the claims' words alone); handed the night's signal. */
  search?: (question: string, signal?: AbortSignal) => Promise<readonly GoldenHit[]>;
  snapshot?: VaultSnapshot;
  signal?: AbortSignal;
  /** The judge calls' retries (tests pass a sleep that does not wait). */
  retry?: RetryOptions;
}

function emptyResult(skipped: string | null, asked = 0): GoldenScoreResult {
  return { skipped, allowance: null, scoreId: null, tally: goldenTally(new Array(asked).fill(null)), capped: 0, calls: 0, usdEstimate: 0, regressions: [], reviewItems: [], notes: [] };
}

/** Each question's baseline verdict (the regression check's) and when it was last asked. */
function lastResults(vault: string): Map<string, { verdict: GoldenVerdict | null; at: string }> {
  const out = new Map<string, { verdict: GoldenVerdict | null; at: string }>();
  if (!stateDbExists(vault)) return out;
  withStateDb(vault, (db) => {
    const rows = db
      .prepare("SELECT question_id, verdict, at, search_failed FROM golden_results ORDER BY at ASC, score_id ASC")
      .all() as Array<{ question_id: string; verdict: string | null; at: string; search_failed: number }>;
    for (const r of rows) {
      const judged = (GOLDEN_VERDICTS as readonly string[]).includes(r.verdict ?? "") ? (r.verdict as GoldenVerdict) : null;
      // A verdict given without the search is no baseline: the question still counts as asked then (its turn).
      const verdict = r.search_failed ? null : judged;
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
  const searchFailed = new Set<string>();
  for (const q of asked) {
    // Past the night's budget no search starts: the judge loop stops on the same signal.
    if (options.signal?.aborted) break;
    let hits: readonly GoldenHit[] = [];
    if (options.search) {
      hits = await options.search(redactText(q.question).text, options.signal).catch(() => {
        searchFailed.add(q.id);
        return [];
      });
    }
    evidence.set(q.id, goldenEvidence(q.question, pages, { hits, now: at, answeredBy: { claimId: q.claimId, page: q.page } }).map(redactEvidence));
  }
  if (searchFailed.size > 0) {
    result.notes.push(`The vault search failed for ${searchFailed.size} golden question(s); they were answered from the claims' words alone and raise no regression tonight.`);
  }

  const client = options.client ?? flashClient();
  const verdicts = new Map<string, { verdict: GoldenVerdict; why: string }>();
  // An empty or cut-off answer is asked again in smaller calls, never resent as it was.
  const retry: RetryOptions = {
    ...options.retry,
    retryOn: (err) => err.kind !== "bad_response" && (options.retry?.retryOn?.(err) ?? true),
  };
  let refusal: string | null = null;
  let spent: AllowanceStop | null = null;
  let stop: string | null = null;
  let failuresInRow = 0;
  let askedAgain = 0;
  let unanswered = 0;
  const outages = new Map<string, number>();

  /** Whether no further call may start: a refusal, the signal, the provider down for calls in a row, the night's spend. */
  const halted = (): boolean => {
    if (refusal || stop || options.signal?.aborted) return true;
    if (failuresInRow >= GOLDEN_LIMITS.failuresInRow) stop = `${failuresInRow} golden-question judge calls in a row failed; the rest of tonight's questions wait for the next night.`;
    else if (result.usdEstimate >= GOLDEN_LIMITS.usdPerNight) stop = `The golden questions reached tonight's spending cap ($${GOLDEN_LIMITS.usdPerNight}); the rest wait for the next night.`;
    return stop !== null;
  };

  /** One call: the questions a readable answer left out (`cut`: it reached the output cap), or why there was none. Never throws for the model. */
  async function judgeOnce(batch: readonly GoldenQuestion[]): Promise<{ ok: true; missing: GoldenQuestion[]; cut: boolean } | { ok: false; kind: string }> {
    const { system, user } = buildGoldenPrompt(
      batch.map((q) => ({ question: redactText(q.question).text, expected: redactText(q.expected).text, evidence: evidence.get(q.id) ?? [] })),
    );
    const maxTokens = goldenMaxTokens(batch.length);
    const charge = (model: string, usage: FlashResponse["usage"]) => {
      result.calls++;
      const usd = estimateUsd(model, usage, options.rates);
      result.usdEstimate += usd;
      recordCost(vault, {
        runId: options.runId ?? null,
        operation: "golden",
        model,
        tokensIn: usage.promptTokens,
        tokensOut: usage.completionTokens,
        usdEstimate: usd,
        at: now().toISOString(),
      });
    };
    let response: FlashResponse;
    try {
      ({ response } = await completeWithRetry(client, { system, user, maxTokens, signal: options.signal }, retry));
    } catch (err) {
      const kind = err instanceof FlashCallError ? err.kind : "network";
      if (MODEL_REFUSALS.has(kind)) {
        refusal = kind;
        spent = spent ?? allowanceStopOf(err);
      }
      else if (kind === "bad_response") {
        // The provider answered (no outage), and an empty or capped answer still spent its tokens: no usage
        // came with it, so it is charged as the whole prompt (~4 characters a token) plus the whole output cap.
        failuresInRow = 0;
        charge(client.model, { promptTokens: Math.ceil((system.length + user.length) / 4), completionTokens: maxTokens, cacheHitTokens: 0 });
      } else {
        failuresInRow++;
        outages.set(kind, (outages.get(kind) ?? 0) + 1);
      }
      return { ok: false, kind };
    }
    failuresInRow = 0;
    charge(response.model, response.usage);
    let answers: Map<number, { verdict: GoldenVerdict; why: string }>;
    try {
      answers = parseGoldenResponse(response.text, batch.length);
    } catch {
      return { ok: false, kind: "bad_response" };
    }
    batch.forEach((q, i) => {
      const a = answers.get(i);
      if (a) verdicts.set(q.id, { verdict: a.verdict, why: redactText(a.why).text });
    });
    return { ok: true, missing: batch.filter((_, i) => !answers.has(i)), cut: response.finishReason === "length" };
  }

  /**
   * Judge `batch`. An empty, cut-off or unreadable answer is asked again in
   * halves, down to one question a call, and the questions a cut-off answer
   * left out in one smaller call; only then is a question not judged. A
   * refusal or an outage leaves the batch for the next night.
   */
  async function judge(batch: readonly GoldenQuestion[]): Promise<void> {
    if (halted()) return;
    const out = await judgeOnce(batch);
    if (!out.ok && out.kind !== "bad_response") return;
    const again = out.ok ? (out.cut ? out.missing : []) : batch;
    if (again.length === 0) return;
    if (again.length < batch.length) {
      askedAgain++;
      await judge(again);
    } else if (batch.length === 1) {
      unanswered++;
    } else {
      askedAgain++;
      const half = Math.ceil(batch.length / 2);
      await judge(batch.slice(0, half));
      await judge(batch.slice(half));
    }
  }

  // A batch that fails is split, never a reason to leave the later batches unasked.
  for (let start = 0; start < asked.length && !halted(); start += GOLDEN_LIMITS.batch) {
    await judge(asked.slice(start, start + GOLDEN_LIMITS.batch));
  }
  for (const [kind, count] of outages) {
    result.notes.push(
      count === 1
        ? `A golden-question judge call failed (${kind}); its questions count as not judged.`
        : `${count} golden-question judge calls failed (${kind}); their questions count as not judged.`,
    );
  }
  if (askedAgain > 0) result.notes.push(`${askedAgain} golden-question judge answer(s) came back empty, cut off or unreadable; their questions were asked again in smaller calls.`);
  if (unanswered > 0) result.notes.push(`The golden-question judge gave no verdict for ${unanswered} question(s) even asked alone; they count as not judged.`);
  if (stop) result.notes.push(stop);
  const spentText = spent ? allowanceSpentText(spent, { now: now().getTime() }) : "";
  if (verdicts.size === 0) {
    // Nothing judged is no score: an outage must not read as 0 % correct, nor hide the last real score.
    const skipped = emptyResult(spent ? ALLOWANCE_SPENT : "model_unavailable");
    skipped.allowance = spent;
    skipped.calls = result.calls;
    skipped.usdEstimate = Math.round(result.usdEstimate * 1e6) / 1e6;
    skipped.notes.push(...result.notes);
    skipped.notes.push(
      spent
        ? `The golden-question judge stopped: ${spentText}. Tonight's questions wait for the next night.`
        : refusal
          ? `ClawBox AI refused the golden-question judge (${refusal}); the check was skipped.`
          : "No golden question could be judged tonight; the check was skipped.",
    );
    return skipped;
  }
  // Past a spent allowance the questions not judged keep their turn: neither stored nor scored tonight.
  const scored = spent ? asked.filter((q) => verdicts.has(q.id)) : asked;
  if (spent) {
    result.allowance = spent;
    result.notes.push(`The golden-question judge stopped part way: ${spentText}. The ${asked.length - scored.length} question(s) it did not judge wait for the next night.`);
  } else if (refusal) result.notes.push(`ClawBox AI refused the golden-question judge part way (${refusal}); the rest count as not judged.`);

  result.tally = goldenTally(scored.map((q) => verdicts.get(q.id)?.verdict ?? null));
  const scoreId = options.runId ?? `gs-${crypto.randomBytes(6).toString("hex")}`;
  const atIso = now().toISOString();

  // The review items first: once the score below is stored, tonight's `wrong` is the verdict the next
  // night compares with, so an item lost to an error after it would never be raised again. Raising is
  // idempotent (one open item a question, by its dedupe key).
  const previous = new Map<string, GoldenVerdict>();
  for (const [id, r] of last) if (r.verdict) previous.set(id, r.verdict);
  const current = new Map<string, GoldenVerdict>();
  for (const [id, v] of verdicts) if (!searchFailed.has(id)) current.set(id, v.verdict);
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

  withStateDb(vault, (db) =>
    runInTransaction(db, () => {
      const t = result.tally;
      db.prepare(
        "INSERT OR REPLACE INTO golden_scores (id, run_id, at, asked, correct, wrong, missing, stale, failed, percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(scoreId, options.runId ?? null, atIso, t.asked, t.correct, t.wrong, t.missing, t.stale, t.failed, t.percent);
      const put = db.prepare("INSERT OR REPLACE INTO golden_results (score_id, question_id, verdict, why, claim_ids, at, search_failed) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const q of scored) {
        const v = verdicts.get(q.id);
        put.run(scoreId, q.id, v?.verdict ?? null, v?.why ?? null, JSON.stringify((evidence.get(q.id) ?? []).map((e) => e.claimId)), atIso, searchFailed.has(q.id) ? 1 : 0);
      }
    }),
  );
  result.scoreId = scoreId;
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

/**
 * Each question's latest verdict, for the list beside it: a night that left
 * it unjudged keeps the verdict (and its why) from before, as the nightly
 * check itself does. Never creates the database.
 */
export function readLatestVerdicts(vault: string = vaultDir()): Record<string, { verdict: GoldenVerdict | null; why: string | null; at: string }> {
  const out: Record<string, { verdict: GoldenVerdict | null; why: string | null; at: string }> = {};
  if (!stateDbExists(vault)) return out;
  withStateDb(vault, (db) => {
    const rows = db
      .prepare("SELECT question_id, verdict, why, at FROM golden_results ORDER BY at ASC, score_id ASC")
      .all() as Array<{ question_id: string; verdict: string | null; why: string | null; at: string }>;
    for (const r of rows) {
      const verdict = (GOLDEN_VERDICTS as readonly string[]).includes(r.verdict ?? "") ? (r.verdict as GoldenVerdict) : null;
      const prior = out[r.question_id];
      out[r.question_id] = verdict === null && prior ? { ...prior, at: r.at } : { verdict, why: r.why, at: r.at };
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
