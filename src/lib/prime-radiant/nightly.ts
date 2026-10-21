/**
 * The nightly pass ("dreaming"): the vault looks at itself while nobody is
 * using it, on a branch of its own, and only lets the result onto `main` when
 * nothing a person must decide is in it.
 *
 *   1. branch    `dream/YYYY-MM-DD` from `main`, checked out in a git worktree
 *                beside the vault (`<root>/dream-worktree`), so the owner's
 *                daytime operations keep committing to `main` meanwhile;
 *   2. ingest    the folders the settings name, into the branch (new and
 *                changed documents only: the ingest's hash-first dedupe);
 *   3. contradictions  claims on every page changed since the last finished
 *                comparison — the branch's and what reached `main` by day —
 *                (every claim, the first night) against their 5 nearest
 *                neighbours, judged by Flash; findings become review items,
 *                they never hold the night;
 *   4. Opus      optional, capped, sampled (opus.ts); its proposals are
 *                review items, its bookkeeping a commit on the branch;
 *   4b. structure  monthly record hubs, domain hubs, the company's root
 *                page, entity enrichment and the decisions register
 *                (structure.ts), written on the branch — deterministic; the
 *                capped cheap-model fallback for record types only online;
 *   4c. summaries  every node's summary written from its connections and
 *                sources (node-summary.ts), entities first, on the branch —
 *                the cheap model within its page and dollar caps when online,
 *                the facts' own words otherwise; unchanged neighbourhoods
 *                are skipped, and a page whose summary the lint refuses is
 *                left as it was (a note names it), the rest still saved;
 *   5. lint      every page the branch changed (after every step that
 *                commits to it); an ERROR holds the night and becomes a
 *                `lint` review item;
 *   6. gate      a verified page the branch touched holds the night and
 *                becomes a `verified-touch` review item;
 *   7. merge     when lint is green and the gate is clean: `main` takes the
 *                branch (fast-forward, else one merge commit), the result is
 *                linted for the blocking rules once more (and put back if it
 *                fails them), the branch is deleted and the changed pages are
 *                handed to Memory Shard's reindex hook;
 *   8. golden    every night that did not fail, merged or not: the golden
 *                questions answered from `main` and judged by Flash, capped
 *                (golden-score.ts) — the score history and its % correct; a
 *                question right last time and wrong now is a `lint` review
 *                item that never holds a night.
 *
 * A held night keeps its branch; once the owner has dealt with its review
 * items, `mergeHeldNight` merges it by hand.
 *
 * Offline-safe: with no ClawBox AI the remote steps are skipped (and said to
 * be), the lint and the gate still run. A spent ClawBox AI allowance (weekly
 * or burst) is neither: each model step it refuses stops at that one call
 * with what it did not reach left queued for the next night, and is recorded
 * as `allowance_spent` — in `summary.allowance` with the steps and when it
 * frees up, and in a note — while the night goes on to lint, gate and merge
 * what was written. `runNightly` NEVER throws: a failure is the run's status
 * and its note.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import { processStore } from "@/lib/process-store";
import { resolveFolderInsideBrowseRoot } from "@/lib/browse-folder";
import path from "@/lib/runtime-path";
import { fullComparisonDone, readComparedThrough, runContradictionPass, type ClaimEmbedder, type ContradictionPassResult } from "./contradictions";
import type { CostRates } from "./cost-rates";
import { ALLOWANCE_SPENT, allowanceSpentText, flashAvailable, type AllowanceStop, type FlashClient } from "./flash-client";
import { verifiedTouches, type VerifiedTouch } from "./gate";
import { changedPaths, git, VAULT_MAIN_BRANCH, withVaultLock } from "./git";
import { runGoldenScore, type GoldenScoreResult } from "./golden-score";
import type { GoldenHit } from "./golden";
import { getIngestJob, ingestFinished, IngestBusyError, startIngest } from "./ingest";
import { isOwnOutput } from "./ingest-sources";
import { lintVault, type LintFinding } from "./lint";
import { isKnowledgePage, vaultDir } from "./paths";
import { adoptPluginPages, repairPluginWritesOnce, restorePluginOnlyEdits } from "./plugin-repair";
import { notifyVaultChanged } from "./reindex-hook";
import { addReviewItem, countWaitingForRuns, listReviewItems } from "./review-store";
import { buildOpusQueue, runOpusTier, type OpusClient, type OpusTierResult } from "./opus";
import { resolveOpusClient } from "./opus-source";
import { insertRun, listRuns, newRunId, saveRun, settleOrphanRuns, type RunRecord, type RunStatus, type RunTrigger } from "./runs";
import { effectiveCostRates, readSettings, type PrimeRadiantSettings } from "./settings";
import { readRetiredLedger, stateDbExists } from "./state-db";
import { rejudgeOpenContradictions } from "./rejudge";
import { runStructure, type StructureNowResult } from "./structure-run";
import { runSummaries, type SummariesRunResult } from "./node-summary-run";
import { readVaultSnapshot, vaultInitialised, vaultOperation } from "./vault";

export const DREAM_BRANCH_PREFIX = "dream/";
export const WORKTREE_DIR = "dream-worktree";
const MAX_SUMMARY_PATHS = 200;

export interface NightlySummary {
  branch: string | null;
  base: string | null;
  merged: boolean;
  mergeCommit: string | null;
  commits: number;
  changed: string[];
  changedCount: number;
  /** `stopped: "allowance_spent"` with `queued`: a spent allowance stopped the import, and that many documents wait for the next night. */
  ingest: { jobId: string; status: string; pages: number; failed: number; stopped?: string; queued?: number } | { skipped: string };
  lint: { errors: number; warnings: number; checked: number };
  contradictions: Pick<ContradictionPassResult, "claims" | "queried" | "embedded" | "pairs" | "judged" | "calls" | "failedBatches" | "capped" | "deferredPairs" | "carried" | "deferredClaims" | "complete" | "usdEstimate" | "skipped" | "allowance"> & {
    findings: number;
  };
  opus: Pick<OpusTierResult, "queued" | "reviewed" | "pending" | "calls" | "usdEstimate" | "capUsd" | "maxPages" | "source" | "stopped"> | { skipped: string };
  structure:
    | (Pick<StructureNowResult, "leaves" | "leavesInHubs" | "recordHubs" | "counterpartyHubs" | "domainHubs" | "root" | "entitiesEnriched" | "claimsAdded" | "decisions" | "registerPages" | "skippedVerified" | "linksMedianBefore" | "linksMedianAfter" | "written" | "created"> & {
        model: StructureNowResult["model"];
      })
    | { skipped: string };
  summaries:
    | (Pick<SummariesRunResult, "planned" | "written" | "byModel" | "byFacts" | "waiting" | "unchanged" | "rejected" | "rejectedPages" | "refused" | "skippedVerified" | "keptPerson" | "model"> & {
        mergeSuggestions: number;
        domainMismatches: number;
      })
    | { skipped: string };
  gate: { touched: string[] };
  golden: Pick<GoldenScoreResult, "scoreId" | "tally" | "capped" | "calls" | "usdEstimate" | "regressions" | "allowance"> | { skipped: string };
  /**
   * The model steps a spent ClawBox AI allowance stopped tonight — each one
   * "allowance spent", neither done nor failed, its remaining work queued —
   * and the allowance with when it frees up (the latest any step was told).
   * Null when none was.
   */
  allowance: (AllowanceStop & { steps: string[] }) | null;
  reviewItems: { raised: number };
  held: string[];
  notes: string[];
}

export interface NightlyDeps {
  vault?: string;
  client?: FlashClient;
  embedder?: ClaimEmbedder;
  opus?: OpusClient;
  settings?: PrimeRadiantSettings;
  rates?: CostRates;
  now?: () => Date;
  random?: () => number;
  /** Whether ClawBox AI can be asked (default: a credential is on the box). */
  online?: () => Promise<boolean>;
  /** The vault search the golden check answers with (default: Memory Shard's index of the vault, when it is there). */
  goldenSearch?: (question: string, signal?: AbortSignal) => Promise<readonly GoldenHit[]>;
}

export class NightlyBusyError extends Error {
  constructor(readonly runningId: string) {
    super("a nightly pass is already running");
    this.name = "NightlyBusyError";
  }
}

export class NightlyNotReadyError extends Error {
  constructor() {
    super("the vault has not been created yet");
    this.name = "NightlyNotReadyError";
  }
}

const store = processStore("prime-radiant:nightly", () => ({
  running: null as { id: string; done: Promise<RunRecord> } | null,
}));

export function runningNightlyId(): string | null {
  return store.running?.id ?? null;
}

/** Local `YYYY-MM-DD`: the night is the owner's night, not UTC's. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function branchExists(vault: string, branch: string): Promise<boolean> {
  return (await git(vault, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true })).code === 0;
}

/** `dream/<date>`, or `dream/<date>-2`, … when a branch of that name is still there. */
export async function dreamBranchName(vault: string, now: Date): Promise<string> {
  const base = `${DREAM_BRANCH_PREFIX}${localDate(now)}`;
  if (!(await branchExists(vault, base))) return base;
  for (let n = 2; n < 100; n++) if (!(await branchExists(vault, `${base}-${n}`))) return `${base}-${n}`;
  throw new Error("too many nightly branches for one day");
}

/** A caller's branch name rebuilt: `dream/YYYY-MM-DD` with an optional `-N`. */
export function safeDreamBranch(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = /^dream\/(\d{4})-(\d{2})-(\d{2})(?:-(\d{1,2}))?$/.exec(input);
  if (!m) return null;
  return `dream/${m[1]}-${m[2]}-${m[3]}${m[4] ? `-${Number(m[4])}` : ""}`;
}

export function worktreePath(vault: string): string {
  return path.join(path.dirname(vault), WORKTREE_DIR);
}

async function removeWorktree(vault: string, wt: string): Promise<void> {
  await git(vault, ["worktree", "remove", "--force", wt], { allowFail: true });
  await fs.rm(wt, { recursive: true, force: true }).catch(() => undefined);
  await git(vault, ["worktree", "prune"], { allowFail: true });
}

function ledger(vault: string): string[] {
  try {
    return readRetiredLedger(vault);
  } catch {
    return [];
  }
}

async function resolveFolders(folders: readonly string[], notes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of folders) {
    const r = await resolveFolderInsideBrowseRoot(f);
    if (!r.ok || isOwnOutput(r.dir)) {
      notes.push("A folder in the nightly ingest list is missing or not allowed; it was skipped.");
      continue;
    }
    if (!out.includes(r.dir)) out.push(r.dir);
  }
  return out;
}

/** The knowledge pages `head` changed since it left `base`. */
async function changedPages(vault: string, base: string, head: string): Promise<string[]> {
  return (await changedPaths(vault, base, head)).filter((p) => isKnowledgePage(p)).sort();
}

/**
 * The contradiction pass's scope: every knowledge page changed since the
 * commit the last finished comparison compared, up to the branch's HEAD — the
 * night's own ingest, and what reached `main` by day (Add documents, an edit,
 * the assistant) since. Null — compare every claim — when no comparison is
 * recorded or its commit is gone.
 */
async function pagesSinceComparison(vault: string, wt: string): Promise<string[] | null> {
  let through: string | null;
  try {
    through = readComparedThrough(vault);
  } catch {
    return null;
  }
  if (!through) return null;
  if ((await git(wt, ["cat-file", "-e", `${through}^{commit}`], { allowFail: true })).code !== 0) return null;
  return changedPages(wt, through, "HEAD");
}

/** Keyed by branch as {@link touchItem} is: an item another night raised must not stand in for this night's. */
function lintItem(vault: string, f: LintFinding, branch: string, runId: string, at: string): boolean {
  return addReviewItem(
    vault,
    {
      kind: "lint",
      pages: [f.path],
      evidence: [{ kind: "lint", verdict: f.rule, note: f.message, page: f.path, source: branch }],
      dedupeKey: `lint:${branch}:${f.rule}:${f.path}`,
      runId,
    },
    at,
  ).created;
}

function touchItem(vault: string, t: VerifiedTouch, branch: string, runId: string, at: string): number {
  let raised = 0;
  const note = t.deleted ? `The nightly branch ${branch} deletes this verified page.` : `The nightly branch ${branch} changes this verified page.`;
  if (t.claims.length === 0) {
    if (addReviewItem(vault, { kind: "verified-touch", pages: [t.path], evidence: [{ kind: "gate", note, source: branch }], dedupeKey: `touch:${branch}:${t.path}`, runId }, at).created) {
      raised++;
    }
    return raised;
  }
  for (const c of t.claims) {
    const created = addReviewItem(
      vault,
      {
        kind: "verified-touch",
        claimId: c.claimId,
        pages: [t.path],
        candidates: [
          { text: c.before, page: t.path, claimId: c.claimId, evidence: [{ kind: "verified-claim", page: t.path }] },
          ...(c.after ? [{ text: c.after, page: t.path, evidence: [{ kind: "nightly-proposal", source: branch }] }] : []),
        ],
        evidence: [{ kind: "gate", note: c.after ? note : `${note} It removes this verified claim.`, source: branch }],
        dedupeKey: `touch:${branch}:${c.claimId}`,
        runId,
      },
      at,
    ).created;
    if (created) raised++;
  }
  return raised;
}

/**
 * Merge `branch` into `main` under the vault's lock: fast-forward when
 * possible, else one merge commit; refused (and put back) on a conflict or a
 * blocking lint finding in the result. Answers the merge commit and the pages
 * it changed, or a reason it did not.
 */
async function mergeIntoMain(
  vault: string,
  branch: string,
): Promise<{ ok: true; commit: string; changed: string[] } | { ok: false; reason: string }> {
  return withVaultLock(vault, async () => {
    // A "## Related" block memory-wiki wrote into a page is not a change of the owner's to protect.
    await restorePluginOnlyEdits(vault);
    const status = await git(vault, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.stdout.trim() !== "") return { ok: false, reason: "the vault had uncommitted changes" };
    const before = (await git(vault, ["rev-parse", "HEAD"])).stdout.trim();
    const merged = await git(vault, ["merge", "--no-edit", "-m", `nightly: merge ${branch}`, branch], { allowFail: true, timeoutMs: 120_000 });
    if (merged.code !== 0) {
      await git(vault, ["merge", "--abort"], { allowFail: true });
      await git(vault, ["reset", "--quiet", "--hard", before], { allowFail: true });
      return { ok: false, reason: "the branch no longer merges cleanly with main" };
    }
    const after = (await git(vault, ["rev-parse", "HEAD"])).stdout.trim();
    const changed = await changedPaths(vault, before, after);
    const scope = changed.filter(isKnowledgePage);
    const report = lintVault(await readVaultSnapshot(vault), { scope, ledgerRetired: ledger(vault) });
    const blocking = report.findings.filter((f) => f.blocksCommit);
    if (blocking.length > 0) {
      await git(vault, ["reset", "--quiet", "--hard", before]);
      return { ok: false, reason: `the merged result breaks a rule (${blocking.map((f) => f.rule).join(", ")})` };
    }
    await git(vault, ["branch", "-D", branch], { allowFail: true });
    return { ok: true, commit: after, changed };
  });
}

function emptySummary(): NightlySummary {
  return {
    branch: null,
    base: null,
    merged: false,
    mergeCommit: null,
    commits: 0,
    changed: [],
    changedCount: 0,
    ingest: { skipped: "not_run" },
    lint: { errors: 0, warnings: 0, checked: 0 },
    contradictions: {
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
      skipped: "not_run",
      allowance: null,
      findings: 0,
    },
    opus: { skipped: "not_run" },
    structure: { skipped: "not_run" },
    summaries: { skipped: "not_run" },
    gate: { touched: [] },
    golden: { skipped: "not_run" },
    allowance: null,
    reviewItems: { raised: 0 },
    held: [],
    notes: [],
  };
}

/**
 * Record that a spent ClawBox AI allowance stopped `step`: the step joins
 * `summary.allowance`, and — unless `waits` is null because the step wrote
 * its own — a note says "ClawBox AI allowance spent, frees up at …" and what
 * waits.
 */
function allowanceSpent(summary: NightlySummary, step: string, stop: AllowanceStop, now: Date, waits: string | null): void {
  const prior = summary.allowance;
  const later = !prior || (stop.resetAt !== null && (prior.resetAt === null || Date.parse(stop.resetAt) > Date.parse(prior.resetAt)));
  summary.allowance = {
    kind: later ? stop.kind : prior.kind,
    resetAt: later ? stop.resetAt : prior.resetAt,
    steps: [...(prior?.steps ?? []), step],
  };
  if (waits !== null) summary.notes.push(`The ${step} step stopped: ${allowanceSpentText(stop, { now: now.getTime() })}. ${waits}`);
}

async function runSteps(run: RunRecord, summary: NightlySummary, deps: NightlyDeps, vault: string): Promise<RunStatus> {
  const now = deps.now ?? (() => new Date());
  const settings = deps.settings ?? readSettings();
  const rates = deps.rates ?? effectiveCostRates();
  const notes = summary.notes;
  const online = await (deps.online ?? flashAvailable)().catch(() => false);
  if (!online) notes.push("ClawBox AI is not reachable from this box; the ingest and the contradiction judge were skipped.");

  // Once per vault, before the branch is cut: what memory-wiki wrote into main goes first.
  try {
    const repair = await repairPluginWritesOnce(vault, now);
    if (repair.cleaned.length + repair.removed.length > 0) {
      notes.push(`memory-wiki's generated blocks and files were taken out of the vault (${repair.cleaned.length} page(s), ${repair.removed.length} file(s)).`);
    }
  } catch (err) {
    notes.push(`memory-wiki's generated files could not be taken out of the vault: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
  }
  // Every night, before the branch is cut: a page memory-wiki wrote in its own format becomes a Prime Radiant page.
  try {
    const adopt = await adoptPluginPages(vault, now);
    if (adopt.adopted.length > 0) notes.push(`${adopt.adopted.length} page(s) memory-wiki wrote in its own format were made Prime Radiant pages.`);
  } catch (err) {
    notes.push(`The pages memory-wiki wrote in its own format could not be converted: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
  }

  const branch = await dreamBranchName(vault, now());
  const wt = worktreePath(vault);
  const base = await withVaultLock(vault, async () => {
    await removeWorktree(vault, wt);
    const head = (await git(vault, ["rev-parse", VAULT_MAIN_BRANCH])).stdout.trim();
    await git(vault, ["branch", branch, head]);
    await git(vault, ["worktree", "add", "--quiet", wt, branch]);
    return head;
  });
  summary.branch = branch;
  summary.base = base;
  run.branch = branch;
  saveRun(vault, run);

  try {
    // 2. ingest into the branch
    if (!online) summary.ingest = { skipped: "offline" };
    else if (settings.ingest.folders.length === 0) summary.ingest = { skipped: "no_folders" };
    else {
      const folders = await resolveFolders(settings.ingest.folders, notes);
      if (folders.length === 0) summary.ingest = { skipped: "no_folders" };
      else {
        try {
          const job = await startIngest({ kind: "folders", folders }, { vault: wt, client: deps.client, costRates: rates });
          await ingestFinished(job.id);
          const done = getIngestJob(job.id, vault) ?? job;
          summary.ingest = { jobId: done.id, status: done.status, pages: done.pages, failed: done.failed };
          if (done.allowance) {
            summary.ingest = { ...summary.ingest, stopped: ALLOWANCE_SPENT, queued: done.queued };
            allowanceSpent(summary, "ingest", done.allowance, now(), `${done.queued} document(s) wait for the next night.`);
          }
        } catch (err) {
          summary.ingest = { skipped: err instanceof IngestBusyError ? "busy" : "failed" };
          if (!(err instanceof IngestBusyError)) notes.push(`The nightly ingest failed: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
        }
      }
    }

    // What the branch changed so far: the Opus queue's scope.
    let changed = await changedPages(wt, VAULT_MAIN_BRANCH, "HEAD");
    const compared = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    const snapshot = await readVaultSnapshot(wt);

    // 3. contradictions
    if (!settings.contradictions.enabled) summary.contradictions.skipped = "disabled";
    else if (!online) summary.contradictions.skipped = "offline";
    else {
      // Every claim until one pass has compared them all and judged every pair:
      // a night that merely finished (offline, a judge that failed) does not count.
      // After that, every page changed since the last finished comparison — not
      // only the branch's: a page added by day went straight to main.
      // Claims an earlier pass left unjudged are added to a scoped pass by the pass itself.
      const firstNight = !fullComparisonDone(vault);
      const scope = firstNight ? null : await pagesSinceComparison(vault, wt);
      const byDay = scope ? scope.filter((p) => !changed.includes(p)).length : 0;
      if (byDay > 0) notes.push(`${byDay} page(s) changed since the last comparison outside this night's branch were compared too.`);
      const pass = await runContradictionPass(snapshot, {
        stateVault: vault,
        scope,
        comparedThrough: compared,
        runId: run.id,
        client: deps.client,
        embedder: deps.embedder,
        rates,
        now,
        parallel: settings.ingest.parallel,
      });
      summary.contradictions = {
        claims: pass.claims,
        queried: pass.queried,
        embedded: pass.embedded,
        pairs: pass.pairs,
        judged: pass.judged,
        calls: pass.calls,
        failedBatches: pass.failedBatches,
        capped: pass.capped,
        deferredPairs: pass.deferredPairs,
        carried: pass.carried,
        deferredClaims: pass.deferredClaims,
        complete: pass.complete,
        usdEstimate: pass.usdEstimate,
        skipped: pass.skipped,
        allowance: pass.allowance,
        findings: pass.findings.length,
      };
      summary.reviewItems.raised += pass.reviewItems.length;
      notes.push(...pass.notes);
      // The pass's own note says it, with what waits.
      if (pass.allowance) allowanceSpent(summary, "contradictions", pass.allowance, now(), null);
      run.usdEstimate += pass.usdEstimate;
    }

    // 3b. open contradiction items today's rules would not raise (different subjects, superseded, one document's
    // versions, an owner-verified side) are closed, each with a reason
    try {
      const re = rejudgeOpenContradictions(vault, snapshot, { now });
      if (re.closed > 0) {
        const why = Object.entries(re.byFamily)
          .map(([family, n]) => `${family} ${n}`)
          .join(", ");
        notes.push(`${re.closed} open contradiction item(s) were closed: ${why}.`);
      }
    } catch (err) {
      notes.push(`The open contradiction items could not be re-checked: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
    }

    // 4. Opus, optional
    if (!settings.opus.enabled) summary.opus = { skipped: "disabled" };
    else {
      const reviewPages = new Set(listReviewItems(vault, { status: "open", limit: 200 }).items.flatMap((i) => i.pages));
      const queue = buildOpusQueue(snapshot.pages, { changed: new Set(changed), reviewPages, sampleRate: settings.opus.sampleRate, random: deps.random });
      if (queue.length === 0) summary.opus = { skipped: "nothing_queued" };
      else {
        try {
          // Resolved once for the night: an API key, else the Claude subscription, else none.
          const client = deps.opus ?? (await resolveOpusClient(settings.opus.model));
          const op = await vaultOperation(
            "nightly: opus check",
            (tx) =>
              runOpusTier(tx, queue, {
                stateVault: vault,
                capUsd: settings.opus.capUsd,
                maxPages: settings.opus.maxPages,
                rates,
                client,
                runId: run.id,
                now,
              }),
            { vault: wt, now: now() },
          );
          const o = op.result;
          summary.opus = {
            queued: o.queued,
            reviewed: o.reviewed,
            pending: o.pending,
            calls: o.calls,
            usdEstimate: o.usdEstimate,
            capUsd: o.capUsd,
            maxPages: o.maxPages,
            source: o.source,
            stopped: o.stopped,
          };
          summary.reviewItems.raised += o.reviewItems.length;
          notes.push(...o.notes);
          run.usdEstimate += o.usdEstimate;
        } catch (err) {
          summary.opus = { skipped: "failed" };
          notes.push(`The Opus check could not be saved: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
        }
      }
    }
    // 4b. structure: hubs, the root, enrichment and the register, on the branch
    if (!settings.structure.enabled) summary.structure = { skipped: "disabled" };
    else {
      try {
        const s = await runStructure(
          await readVaultSnapshot(wt),
          async (message, fn) => ({ commit: (await vaultOperation(message, fn, { vault: wt, now: now() })).commit }),
          { stateVault: vault, settings, rates, client: deps.client, online, runId: run.id, now },
        );
        summary.structure = {
          leaves: s.leaves,
          leavesInHubs: s.leavesInHubs,
          recordHubs: s.recordHubs,
          counterpartyHubs: s.counterpartyHubs,
          domainHubs: s.domainHubs,
          root: s.root,
          entitiesEnriched: s.entitiesEnriched,
          claimsAdded: s.claimsAdded,
          decisions: s.decisions,
          registerPages: s.registerPages,
          skippedVerified: s.skippedVerified,
          linksMedianBefore: s.linksMedianBefore,
          linksMedianAfter: s.linksMedianAfter,
          written: s.written,
          created: s.created,
          model: s.model,
        };
        run.usdEstimate += s.model.usdEstimate;
        if (s.model.allowance) allowanceSpent(summary, "structure", s.model.allowance, now(), "The record types it did not ask wait for the next night; the rest of the pass was written.");
        if (s.written > 0) notes.push(`The structure pass wrote ${s.written} page(s): ${s.recordHubs} record hub(s), ${s.domainHubs} domain hub(s), ${s.entitiesEnriched} enriched entit${s.entitiesEnriched === 1 ? "y" : "ies"}.`);
      } catch (err) {
        summary.structure = { skipped: "failed" };
        notes.push(`The structure pass could not be saved: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
      }
    }
    // 4c. summaries: every node's summary from its connections and sources, on the branch (after the structure pass, whose hubs and enrichment it reads);
    // a page whose summary the lint refuses is left out (`refused`), only a failed commit fails the step
    if (!settings.summaries.enabled) summary.summaries = { skipped: "disabled" };
    else {
      try {
        const s = await runSummaries(
          await readVaultSnapshot(wt),
          async (message, fn) => ({ commit: (await vaultOperation(message, fn, { vault: wt, now: now() })).commit }),
          { stateVault: vault, settings, rates, client: deps.client, online, runId: run.id, now },
        );
        summary.summaries = {
          planned: s.planned,
          written: s.written,
          byModel: s.byModel,
          byFacts: s.byFacts,
          waiting: s.waiting,
          unchanged: s.unchanged,
          rejected: s.rejected,
          rejectedPages: s.rejectedPages,
          refused: s.refused.slice(0, MAX_SUMMARY_PATHS),
          skippedVerified: s.skippedVerified,
          keptPerson: s.keptPerson,
          model: s.model,
          mergeSuggestions: s.mergeGroups,
          domainMismatches: s.domainMismatches.length,
        };
        run.usdEstimate += s.model.usdEstimate;
        if (s.model.allowance) allowanceSpent(summary, "summaries", s.model.allowance, now(), "The pages it did not reach got their facts' summary or kept theirs, and wait for the model the next night.");
        if (s.written > 0) notes.push(`The summaries pass wrote ${s.written} summar${s.written === 1 ? "y" : "ies"} (${s.byModel} by the model, ${s.byFacts} from facts).`);
        if (s.refused.length > 0) {
          const shown = s.refused.slice(0, 5).map((r) => `${r.path} (${r.reason})`).join(", ");
          const more = s.refused.length > 5 ? ` and ${s.refused.length - 5} more` : "";
          notes.push(`The lint refused the new summary of ${s.refused.length} page${s.refused.length === 1 ? "" : "s"}, each left as it was: ${shown}${more}.`);
        }
        if (s.mergeGroups > 0) notes.push(`${s.mergeGroups} duplicate entit${s.mergeGroups === 1 ? "y looks" : "ies look"} worth merging (the Checks tab lists them as duplicate-entity warnings, each naming the page to merge into).`);
      } catch (err) {
        summary.summaries = { skipped: "failed" };
        notes.push(`The summaries pass could not be saved: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
      }
    }
    if (summary.ingest && "jobId" in summary.ingest) {
      const job = getIngestJob(summary.ingest.jobId, vault);
      if (job) run.usdEstimate += job.usdEstimate;
    }

    // 5. lint everything the branch changed — after every step that commits to it
    const finalChanged = await changedPages(wt, VAULT_MAIN_BRANCH, "HEAD");
    const report = lintVault(await readVaultSnapshot(wt), { scope: finalChanged, ledgerRetired: ledger(vault), domains: settings.domains.map((d) => d.name), now: now() });
    const errors = report.findings.filter((f) => f.severity === "error");
    summary.lint = { errors: report.errors, warnings: report.warnings, checked: report.checked };
    const at = now().toISOString();
    for (const f of errors) if (lintItem(vault, f, branch, run.id, at)) summary.reviewItems.raised++;

    // 6. gate
    const touches = await verifiedTouches(vault, VAULT_MAIN_BRANCH, branch);
    summary.gate.touched = touches.map((t) => t.path);
    for (const t of touches) summary.reviewItems.raised += touchItem(vault, t, branch, run.id, now().toISOString());

    changed = await changedPaths(vault, VAULT_MAIN_BRANCH, branch);
    summary.changedCount = changed.length;
    summary.changed = changed.slice(0, MAX_SUMMARY_PATHS);
    summary.commits = Number((await git(vault, ["rev-list", "--count", `${VAULT_MAIN_BRANCH}..${branch}`])).stdout.trim()) || 0;
    if (summary.commits === 0) {
      await removeWorktree(vault, wt);
      await git(vault, ["branch", "-D", branch], { allowFail: true });
      summary.branch = null;
      run.branch = null;
      return "nothing";
    }
    if (errors.length > 0) summary.held.push("lint");
    if (touches.length > 0) summary.held.push("verified");
    if (summary.held.length > 0) return "held";

    // 7. merge
    await removeWorktree(vault, wt);
    const merged = await mergeIntoMain(vault, branch);
    if (!merged.ok) {
      summary.held.push("merge");
      notes.push(`The night was not merged: ${merged.reason}.`);
      return "held";
    }
    summary.merged = true;
    summary.mergeCommit = merged.commit;
    await notifyVaultChanged(merged.changed);
    return "merged";
  } finally {
    await removeWorktree(vault, wt).catch(() => undefined);
  }
}

/** The longest the golden step may take; past it the questions not judged yet wait for the next night. */
const GOLDEN_STEP_MS = 20 * 60_000;

/** Memory Shard's index of the vault, when it is there; else no hits (the claims' words alone answer). */
async function shardSearch(vault: string, question: string, signal?: AbortSignal): Promise<readonly GoldenHit[]> {
  const { searchPrimeRadiant, vaultIndexingAllowed } = await import("./shard-index");
  if (!(await vaultIndexingAllowed(vault))) return [];
  return searchPrimeRadiant(question, 8, signal, vault);
}

/** 8. the golden questions, against `main` as the night left it. Never throws. */
async function goldenStep(run: RunRecord, summary: NightlySummary, deps: NightlyDeps, vault: string): Promise<void> {
  const settings = deps.settings ?? readSettings();
  if (!settings.golden.enabled) {
    summary.golden = { skipped: "disabled" };
    return;
  }
  try {
    const online = await (deps.online ?? flashAvailable)().catch(() => false);
    const g = await runGoldenScore({
      vault,
      runId: run.id,
      client: deps.client,
      rates: deps.rates ?? effectiveCostRates(),
      now: deps.now,
      maxQuestions: settings.golden.maxQuestions,
      online,
      search: deps.goldenSearch ?? ((q, signal) => shardSearch(vault, q, signal)),
      // A model that hangs must not keep the night (and the busy flag every manual run waits on) for hours.
      signal: AbortSignal.timeout(GOLDEN_STEP_MS),
    });
    summary.golden = g.skipped
      ? { skipped: g.skipped }
      : { scoreId: g.scoreId, tally: g.tally, capped: g.capped, calls: g.calls, usdEstimate: g.usdEstimate, regressions: g.regressions, allowance: g.allowance };
    summary.reviewItems.raised += g.reviewItems.length;
    summary.notes.push(...g.notes);
    // The check's own note says it, with what waits.
    if (g.allowance) allowanceSpent(summary, "golden", g.allowance, (deps.now ?? (() => new Date()))(), null);
    if (g.capped > 0) summary.notes.push(`${g.capped} golden question(s) were left for the next nights (the cap is ${settings.golden.maxQuestions} a night).`);
    run.usdEstimate += g.usdEstimate;
  } catch (err) {
    summary.golden = { skipped: "failed" };
    summary.notes.push(`The golden questions could not be checked: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
  }
}

async function execute(run: RunRecord, deps: NightlyDeps, vault: string): Promise<RunRecord> {
  const now = deps.now ?? (() => new Date());
  const summary = emptySummary();
  try {
    run.status = await runSteps(run, summary, deps, vault);
  } catch (err) {
    run.status = "failed";
    summary.notes.push(`The pass stopped: ${err instanceof Error ? err.message.slice(0, 200) : "error"}.`);
    console.warn("[prime-radiant] nightly pass failed:", err instanceof Error ? err.message : err);
  }
  if (run.status !== "failed") await goldenStep(run, summary, deps, vault);
  run.finishedAt = now().toISOString();
  run.usdEstimate = Math.round(run.usdEstimate * 1e6) / 1e6;
  run.summary = summary as unknown as Record<string, unknown>;
  try {
    saveRun(vault, run);
  } catch (err) {
    console.warn("[prime-radiant] nightly run could not be saved:", err instanceof Error ? err.message : err);
  }
  return run;
}

/**
 * Start a nightly pass and answer its record at once; the work runs on.
 * Throws {@link NightlyBusyError} while one runs, {@link NightlyNotReadyError}
 * when the vault does not exist yet.
 */
export async function startNightly(trigger: RunTrigger, deps: NightlyDeps = {}): Promise<{ run: RunRecord; done: Promise<RunRecord> }> {
  if (store.running) throw new NightlyBusyError(store.running.id);
  const vault = deps.vault ?? vaultDir();
  const now = deps.now ?? (() => new Date());
  const run: RunRecord = {
    id: newRunId(),
    kind: "nightly",
    branch: null,
    status: "running",
    trigger,
    startedAt: now().toISOString(),
    finishedAt: null,
    usdEstimate: 0,
    summary: null,
  };
  // Claimed before the first await, so two starts that arrive together cannot both pass.
  let release!: (r: RunRecord) => void;
  const claim = { id: run.id, done: new Promise<RunRecord>((resolve) => (release = resolve)) };
  store.running = claim;
  if (!(await vaultInitialised(vault).catch(() => false))) {
    store.running = null;
    release({ ...run, status: "skipped" });
    throw new NightlyNotReadyError();
  }
  const done = (async () => {
    settleOrphanRuns(vault, new Set([run.id]), run.startedAt);
    insertRun(vault, run);
    return execute(run, deps, vault);
  })()
    .catch((err) => {
      console.warn("[prime-radiant] nightly pass could not start:", err instanceof Error ? err.message : err);
      return { ...run, status: "failed" as RunStatus, finishedAt: now().toISOString() };
    })
    .then((finished) => {
      release(finished);
      return finished;
    })
    .finally(() => {
      if (store.running === claim) store.running = null;
    });
  return { run: { ...run }, done };
}

/**
 * The scheduler's entry: run one pass to its end. Never throws; a vault that
 * does not exist yet, or a pass already running, is a skip.
 */
export async function runNightly(trigger: RunTrigger, deps: NightlyDeps = {}): Promise<RunRecord | null> {
  try {
    const { done } = await startNightly(trigger, deps);
    return await done;
  } catch (err) {
    if (err instanceof NightlyNotReadyError || err instanceof NightlyBusyError) return null;
    console.warn("[prime-radiant] nightly pass failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Recent passes, newest first (a pass a dead server left `running` reads `interrupted`). Never creates the database. */
export function listNightlyRuns(vault: string = vaultDir(), limit = 20): RunRecord[] {
  if (!stateDbExists(vault)) return [];
  try {
    settleOrphanRuns(vault, new Set(store.running ? [store.running.id] : []), new Date().toISOString());
    return listRuns(vault, limit);
  } catch {
    return [];
  }
}

export class HeldNightError extends Error {
  constructor(
    readonly code: "not_found" | "open_items" | "not_merged",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HeldNightError";
  }
}

/**
 * The owner merges a held night by hand, once every review item its pass
 * raised has been resolved (a resolved item IS the owner's answer, so the
 * gate's question has been asked and answered). The merge itself is the same
 * guarded merge the pass uses.
 */
export async function mergeHeldNight(branchInput: unknown, vault: string = vaultDir()): Promise<{ branch: string; commit: string; changed: string[] }> {
  const branch = safeDreamBranch(branchInput);
  if (!branch || !(await vaultInitialised(vault)) || !(await branchExists(vault, branch))) {
    throw new HeldNightError("not_found", "There is no such nightly branch.", 404);
  }
  if (store.running) throw new HeldNightError("not_merged", "A nightly pass is running; try again when it ends.", 409);
  const runs = listNightlyRuns(vault, 200).filter((r) => r.branch === branch);
  if (countWaitingForRuns(vault, runs.map((r) => r.id)) > 0) throw new HeldNightError("open_items", "Resolve this night's review items first.", 409);
  const merged = await mergeIntoMain(vault, branch);
  if (!merged.ok) throw new HeldNightError("not_merged", `The night was not merged: ${merged.reason}.`, 409);
  for (const r of runs) {
    r.summary = { ...(r.summary ?? {}), merged: true, mergeCommit: merged.commit, mergedByOwner: true };
    r.status = "merged";
    try {
      saveRun(vault, r);
    } catch {
      /* the merge itself is what counts */
    }
  }
  await notifyVaultChanged(merged.changed);
  return { branch, commit: merged.commit, changed: merged.changed };
}
