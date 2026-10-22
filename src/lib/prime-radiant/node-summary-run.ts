/**
 * The summaries pass on a vault (node-summary.ts is the pure plan): who
 * writes each summary, at what cost, and the commits.
 *
 * The cheap model writes the summaries of the first `summaries.maxPages`
 * pages of the plan (entities first), {@link SUMMARY_BATCH} a call, the facts
 * redacted first; each call's WORST-CASE cost (its prompt, its whole answer
 * cap) is checked against what is left of `summaries.capUsd` before it is
 * made, so a run never spends past the cap, and every call is recorded with
 * `recordCost`. Each answer goes through the check step; a page whose every
 * sentence is rejected gets the summary from its facts' own words instead,
 * marked `tried` so the model is not asked again for the same neighbourhood.
 * Pages the model does not reach (off, offline, the cap, a failed call) get
 * the facts' summary when they have none of ours yet or only a facts' one
 * whose neighbourhood changed; a model summary whose neighbourhood changed,
 * and a facts' summary only due an upgrade, wait for the model.
 *
 * Duplicate entities come back as MERGE SUGGESTIONS: counted every run, and
 * — when `mergePreviews` asks (the maintenance action) — each planned by the
 * merge tool on the same snapshot without writing anything (edit.ts
 * `previewMerge`, one claim index for all of them); domain mismatches come
 * back as suggestions too (lint warns with them). Nothing is merged or moved
 * here.
 *
 * A page whose new summary the vault's lint refuses (`blocksCommit`: a
 * secret-pattern hit, say, from a fact or a body that reads like a card) is
 * left as it was and listed in `refused` with the rules that refused it; the
 * rest of its commit is made without it. Anything else that fails a commit
 * (git, the disk, a lint finding on a page this pass did not write) still
 * fails the pass.
 *
 * A dry run asks no model and writes nothing: it answers what would be
 * written, the suggestions and the stats.
 *
 * SERVER ONLY.
 */

import { estimateUsd, type CostRates } from "./cost-rates";
import { mergeClaimIndex, previewMerge } from "./edit";
import { ALLOWANCE_SPENT, allowanceStopOf, completeWithRetry, flashClient, type AllowanceStop, type FlashClient } from "./flash-client";
import { recordCost } from "./ingest-store";
import {
  buildSummaryPrompt,
  checkSentences,
  factsSummary,
  parseSummaryResponse,
  planSummaries,
  shownNeighbourhood,
  SUMMARIES_BY,
  withSummary,
  type DraftSentence,
  type SummaryJob,
  type SummaryPlanStats,
  type SummaryReason,
  type SummaryTier,
} from "./node-summary";
import type { DomainMismatch, DuplicateReason } from "./entity-hygiene";
import type { PageFrontmatter } from "./schema";
import type { PrimeRadiantSettings } from "./settings";
import { VaultLintBlockedError, type VaultSnapshot, type VaultTx } from "./vault";

/** Pages one model call summarises. */
export const SUMMARY_BATCH = 8;
/** Pages one commit of the pass writes. */
export const SUMMARIES_COMMIT_BATCH = 400;
/** Duplicate groups planned as merges a run, at most (each plans over the whole vault). */
export const MAX_MERGE_SUGGESTIONS = 50;
/** Entries a dry run lists. */
const MAX_WOULD = 200;

/** The answer's cap for a call of `pages` pages: three short sentences and their fact ids each, plus slack. */
export function summaryMaxTokens(pages: number): number {
  return 128 + 160 * pages;
}

/** What one call may cost at most: every prompt token uncached (three characters a token, plus slack, as opus.ts reckons) and its whole answer cap. */
export function worstCaseCallUsd(model: string, prompt: { system: string; user: string }, maxTokens: number, rates: CostRates): number {
  const promptTokens = Math.ceil((prompt.system.length + prompt.user.length) / 3) + 500;
  return estimateUsd(model, { promptTokens, completionTokens: maxTokens, cacheHitTokens: 0 }, rates);
}

export interface MergeSuggestion {
  into: string;
  from: string[];
  reason: DuplicateReason;
  /** The merge tool's dry run: what would move, or why it may not happen. */
  ok: boolean;
  claims?: number;
  aliases?: string[];
  links?: number;
  relinked?: number;
  refused?: { code: string; message: string };
}

export interface SummariesRunResult extends SummaryPlanStats {
  /** Pages the plan wants (re)written, by why. */
  planned: number;
  byReason: Record<SummaryReason, number>;
  written: number;
  /** Of `written`, the summaries the model wrote and the ones the facts did (a page edited since the plan is in neither). */
  byModel: number;
  byFacts: number;
  /** Model summaries whose neighbourhood changed, left until the model can write them. */
  waiting: number;
  /** Sentences the check step rejected. */
  rejected: number;
  /** Pages whose every model sentence was rejected (their facts wrote the summary). */
  rejectedPages: number;
  /** Pages whose new summary the vault's lint refused: each left as it was, with why (e.g. `secret-pattern (CARD)`). */
  refused: Array<{ path: string; reason: string }>;
  /**
   * `skipped` says why the model stopped short (`allowance_spent`: a spent
   * ClawBox AI allowance, named in `allowance`; the pages it did not reach
   * keep or get their facts' summary and are planned for the model again).
   */
  model: { asked: number; calls: number; usdEstimate: number; capUsd: number; maxPages: number; skipped?: string; allowance?: AllowanceStop };
  /** Duplicate entity groups found (each a merge suggestion). */
  mergeGroups: number;
  /** Each group as the merge tool's dry run plans it — only when `mergePreviews` is asked for (the maintenance action; a nightly pass counts them). */
  mergeSuggestions: MergeSuggestion[];
  domainMismatches: DomainMismatch[];
  commits: string[];
  dryRun: boolean;
  /** The pages a dry run would write (at most 200), in plan order. */
  would?: Array<{ path: string; title: string; tier: SummaryTier; reason: SummaryReason }>;
}

interface Planned {
  path: string;
  frontmatter: PageFrontmatter;
  body: string;
  expected: string;
  method: "model" | "facts";
}

/**
 * Plan and write the node summaries over `snapshot` (the nightly branch's, or
 * `main`'s for the maintenance action), each commit through `run`. Never throws
 * for a model failure: the pages it did not reach are written from their facts;
 * nor for a page the lint refuses: it is left out of its commit (`refused`).
 */
export async function runSummaries(
  snapshot: Pick<VaultSnapshot, "pages" | "indexBody"> & Partial<Pick<VaultSnapshot, "vault" | "truncated">>,
  run: (message: string, fn: (tx: VaultTx) => Promise<void>) => Promise<{ commit: string | null }>,
  options: {
    stateVault: string;
    settings: PrimeRadiantSettings;
    rates: CostRates;
    client?: FlashClient;
    /** Whether ClawBox AI can be asked. */
    online: boolean;
    runId?: string | null;
    now?: () => Date;
    dryRun?: boolean;
    /** Plan each duplicate group with the merge tool (a dry run each, over the whole vault): the maintenance action's detail. Default false. */
    mergePreviews?: boolean;
  },
): Promise<SummariesRunResult> {
  const now = options.now ?? (() => new Date());
  const s = options.settings.summaries;
  const modelOn = options.online && s.maxPages > 0 && !options.dryRun;
  const plan = planSummaries(snapshot, { domains: options.settings.domains.map((d) => d.name), modelAvailable: modelOn });
  const byReason: Record<SummaryReason, number> = { new: 0, changed: 0, upgrade: 0 };
  for (const j of plan.jobs) byReason[j.reason]++;
  const result: SummariesRunResult = {
    ...plan.stats,
    planned: plan.jobs.length,
    byReason,
    written: 0,
    byModel: 0,
    byFacts: 0,
    waiting: 0,
    rejected: 0,
    rejectedPages: 0,
    refused: [],
    model: { asked: 0, calls: 0, usdEstimate: 0, capUsd: s.capUsd, maxPages: s.maxPages },
    mergeGroups: plan.duplicates.length,
    mergeSuggestions: options.mergePreviews ? mergeSuggestions(snapshot, plan.duplicates, options.stateVault, now()) : [],
    domainMismatches: plan.mismatches,
    commits: [],
    dryRun: !!options.dryRun,
  };
  if (options.dryRun) {
    result.model.skipped = "dry_run";
    result.would = plan.jobs.slice(0, MAX_WOULD).map((j) => ({ path: j.hood.path, title: j.hood.title, tier: j.hood.tier, reason: j.reason }));
    return result;
  }
  if (!options.online) result.model.skipped = "offline";
  else if (s.maxPages <= 0) result.model.skipped = "disabled";

  const pageOf = new Map(snapshot.pages.map((p) => [p.path, p]));
  const at = now().toISOString();
  const writes: Planned[] = [];
  const write = (job: SummaryJob, accepted: ReturnType<typeof checkSentences>["accepted"], method: "model" | "facts", tried = false) => {
    const page = pageOf.get(job.hood.path);
    if (!page || !page.parsed.ok || accepted.length === 0) return;
    writes.push({ path: page.path, frontmatter: withSummary(page.parsed.frontmatter, accepted, method, job.hood.hash, at, tried), body: page.parsed.body, expected: page.text, method });
  };
  const fromFacts = (job: SummaryJob) => {
    // Due the model and not reached: the facts' summary it has stands as it is (writing it again would change nothing but its date).
    if (job.reason === "upgrade") return;
    // A model summary whose neighbourhood changed is kept until the model can write it again.
    if (job.prior?.method === "model") {
      result.waiting++;
      return;
    }
    write(job, checkSentences(factsSummary(job.hood), job.hood).accepted, "facts");
  };

  const forModel = modelOn ? plan.jobs.slice(0, s.maxPages) : [];
  const rest = modelOn ? plan.jobs.slice(s.maxPages) : plan.jobs;
  const client = forModel.length > 0 ? (options.client ?? flashClient()) : null;
  let stopped = false;
  for (let i = 0; i < forModel.length; i += SUMMARY_BATCH) {
    const batch = forModel.slice(i, i + SUMMARY_BATCH);
    if (stopped || !client) {
      batch.forEach(fromFacts);
      continue;
    }
    const shown = batch.map((j) => shownNeighbourhood(j.hood));
    const prompt = buildSummaryPrompt(shown);
    const maxTokens = summaryMaxTokens(batch.length);
    if (result.model.usdEstimate + worstCaseCallUsd(client.model, prompt, maxTokens, options.rates) > s.capUsd) {
      result.model.skipped = "cost_cap";
      stopped = true;
      batch.forEach(fromFacts);
      continue;
    }
    let answer: Map<number, DraftSentence[]>;
    try {
      const { response } = await completeWithRetry(client, { ...prompt, maxTokens });
      const usd = estimateUsd(response.model, response.usage, options.rates);
      result.model.calls++;
      result.model.asked += batch.length;
      result.model.usdEstimate += usd;
      try {
        recordCost(options.stateVault, {
          runId: options.runId ?? null,
          operation: "node-summaries",
          model: response.model,
          tokensIn: response.usage.promptTokens,
          tokensOut: response.usage.completionTokens,
          usdEstimate: usd,
          at: now().toISOString(),
        });
      } catch {
        /* the answer still counts */
      }
      answer = parseSummaryResponse(response.text, batch.length);
    } catch (err) {
      const spent = allowanceStopOf(err);
      if (spent) {
        result.model.skipped = ALLOWANCE_SPENT;
        result.model.allowance = spent;
      } else result.model.skipped = err instanceof Error ? `failed: ${err.message.slice(0, 120)}` : "failed";
      stopped = true;
      batch.forEach(fromFacts);
      continue;
    }
    batch.forEach((job, k) => {
      const drafts = answer.get(k);
      // No answer for this node (no array, cut at the cap, answered twice): not tried, the model may be asked again.
      if (drafts === undefined) return fromFacts(job);
      const checked = checkSentences(drafts, shown[k]);
      result.rejected += checked.rejected.length;
      if (checked.accepted.length > 0) return write(job, checked.accepted, "model");
      // The model answered and every sentence was rejected (or it wrote none): the facts write it, and the model is not asked again until the neighbourhood changes.
      result.rejectedPages++;
      write(job, checkSentences(factsSummary(job.hood), job.hood).accepted, "facts", true);
    });
  }
  rest.forEach(fromFacts);
  result.model.usdEstimate = Math.round(result.model.usdEstimate * 1e6) / 1e6;

  for (let i = 0; i < writes.length; i += SUMMARIES_COMMIT_BATCH) {
    let batch = writes.slice(i, i + SUMMARIES_COMMIT_BATCH);
    const message = `summaries: node summaries from their connections (${i + 1}-${i + batch.length} of ${writes.length})`;
    // Each refusal takes at least one page out, so this ends; the lint names every refused page of a commit at once, so it is mostly one retry.
    while (batch.length > 0) {
      // Counted once the commit stands: a refused one is put back whole.
      const counts = { written: 0, byModel: 0, byFacts: 0 };
      let commit: string | null;
      try {
        ({ commit } = await run(message, async (tx) => {
          for (const w of batch) {
            // Edited since the plan was made: left as the person left it.
            const current = await tx.read(w.path);
            if ((current?.text ?? null) !== w.expected) continue;
            await tx.writePage(w.path, w.frontmatter, w.body);
            counts.written++;
            // Counted as written, not as planned: a page skipped above is in neither.
            if (w.method === "model") counts.byModel++;
            else counts.byFacts++;
          }
        }));
      } catch (err) {
        const refused = refusedPages(err, batch);
        if (!refused) throw err;
        for (const [path, reason] of refused) result.refused.push({ path, reason });
        batch = batch.filter((w) => !refused.has(w.path));
        continue;
      }
      result.written += counts.written;
      result.byModel += counts.byModel;
      result.byFacts += counts.byFacts;
      if (commit) result.commits.push(commit);
      break;
    }
  }
  return result;
}

/**
 * The pages of `batch` the vault's lint refused in `err`, each with the rules
 * (and secret kinds) that refused it — or null when `err` is anything else,
 * or names a page this batch did not write: that is no page to leave out but
 * a failure of the commit.
 */
function refusedPages(err: unknown, batch: readonly Planned[]): Map<string, string> | null {
  if (!(err instanceof VaultLintBlockedError) || err.findings.length === 0) return null;
  const paths = new Set(batch.map((w) => w.path));
  const refused = new Map<string, string[]>();
  for (const f of err.findings) {
    if (!paths.has(f.path)) return null;
    const kinds = Array.isArray(f.details?.kinds) ? (f.details.kinds as unknown[]).filter((k): k is string => typeof k === "string") : [];
    const why = kinds.length > 0 ? `${f.rule} (${kinds.join(", ")})` : f.rule;
    const list = refused.get(f.path) ?? [];
    if (!list.includes(why)) list.push(why);
    refused.set(f.path, list);
  }
  return new Map([...refused].map(([p, why]) => [p, why.join(", ")]));
}

/** Each duplicate group as the merge tool would fold it, planned on `snapshot`, written nowhere. */
function mergeSuggestions(
  snapshot: Pick<VaultSnapshot, "pages" | "indexBody"> & Partial<Pick<VaultSnapshot, "vault" | "truncated">>,
  groups: ReturnType<typeof planSummaries>["duplicates"],
  stateVault: string,
  now: Date,
): MergeSuggestion[] {
  if (groups.length === 0) return [];
  const full: VaultSnapshot = { vault: snapshot.vault ?? stateVault, pages: snapshot.pages, indexBody: snapshot.indexBody, truncated: snapshot.truncated ?? false };
  // One claim index (and one read of the retired ledger) for every preview: the merges plan against the same snapshot.
  const claimIndex = mergeClaimIndex(full, stateVault);
  return groups.slice(0, MAX_MERGE_SUGGESTIONS).map((g) => {
    const from = g.duplicates.slice(0, 20);
    let preview: ReturnType<typeof previewMerge>;
    try {
      preview = previewMerge(full, { into: g.canonical, from }, { by: SUMMARIES_BY }, { vault: stateVault, now, claimIndex });
    } catch (err) {
      preview = { ok: false, code: "failed", message: err instanceof Error ? err.message.slice(0, 200) : "failed" };
    }
    if (!preview.ok) return { into: g.canonical, from, reason: g.reason, ok: false, refused: { code: preview.code, message: preview.message } };
    const r = preview.result;
    return { into: g.canonical, from, reason: g.reason, ok: true, claims: r.claims.length, aliases: r.aliases, links: r.links, relinked: r.relinked.length };
  });
}
