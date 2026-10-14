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
 *   3. contradictions  claims the branch changed (every claim, the first
 *                night) against their 5 nearest neighbours, judged by Flash;
 *                findings become review items, they never hold the night;
 *   4. Opus      optional, capped, sampled (opus.ts); its proposals are
 *                review items, its bookkeeping a commit on the branch;
 *   5. lint      every page the branch changed (after every step that
 *                commits to it); an ERROR holds the night and becomes a
 *                `lint` review item;
 *   6. gate      a verified page the branch touched holds the night and
 *                becomes a `verified-touch` review item;
 *   7. merge     when lint is green and the gate is clean: `main` takes the
 *                branch (fast-forward, else one merge commit), the result is
 *                linted for the blocking rules once more (and put back if it
 *                fails them), the branch is deleted and the changed pages are
 *                handed to Memory Shard's reindex hook.
 *
 * A held night keeps its branch; once the owner has dealt with its review
 * items, `mergeHeldNight` merges it by hand.
 *
 * Offline-safe: with no ClawBox AI the remote steps are skipped (and said to
 * be), the lint and the gate still run. `runNightly` NEVER throws: a failure
 * is the run's status and its note.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import { processStore } from "@/lib/process-store";
import { resolveFolderInsideBrowseRoot } from "@/lib/browse-folder";
import path from "@/lib/runtime-path";
import { runContradictionPass, type ClaimEmbedder, type ContradictionPassResult } from "./contradictions";
import type { CostRates } from "./cost-rates";
import { flashAvailable, type FlashClient } from "./flash-client";
import { verifiedTouches, type VerifiedTouch } from "./gate";
import { changedPaths, git, VAULT_MAIN_BRANCH, withVaultLock } from "./git";
import { getIngestJob, ingestFinished, IngestBusyError, startIngest } from "./ingest";
import { isOwnOutput } from "./ingest-sources";
import { lintVault, type LintFinding } from "./lint";
import { isKnowledgePage, vaultDir } from "./paths";
import { notifyVaultChanged } from "./reindex-hook";
import { addReviewItem, countWaitingForRuns, listReviewItems } from "./review-store";
import { buildOpusQueue, opusClient, runOpusTier, type OpusClient, type OpusTierResult } from "./opus";
import { anyFinishedRun, insertRun, listRuns, newRunId, saveRun, settleOrphanRuns, type RunRecord, type RunStatus, type RunTrigger } from "./runs";
import { effectiveCostRates, readSettings, type PrimeRadiantSettings } from "./settings";
import { readRetiredLedger, stateDbExists } from "./state-db";
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
  ingest: { jobId: string; status: string; pages: number; failed: number } | { skipped: string };
  lint: { errors: number; warnings: number; checked: number };
  contradictions: Pick<ContradictionPassResult, "claims" | "queried" | "embedded" | "pairs" | "judged" | "calls" | "failedBatches" | "deferredPairs" | "usdEstimate" | "skipped"> & {
    findings: number;
  };
  opus: Pick<OpusTierResult, "queued" | "reviewed" | "pending" | "calls" | "usdEstimate" | "capUsd" | "stopped"> | { skipped: string };
  gate: { touched: string[] };
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
      deferredPairs: 0,
      usdEstimate: 0,
      skipped: "not_run",
      findings: 0,
    },
    opus: { skipped: "not_run" },
    gate: { touched: [] },
    reviewItems: { raised: 0 },
    held: [],
    notes: [],
  };
}

async function runSteps(run: RunRecord, summary: NightlySummary, deps: NightlyDeps, vault: string): Promise<RunStatus> {
  const now = deps.now ?? (() => new Date());
  const settings = deps.settings ?? readSettings();
  const rates = deps.rates ?? effectiveCostRates();
  const notes = summary.notes;
  const online = await (deps.online ?? flashAvailable)().catch(() => false);
  if (!online) notes.push("ClawBox AI is not reachable from this box; the ingest and the contradiction judge were skipped.");

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
        } catch (err) {
          summary.ingest = { skipped: err instanceof IngestBusyError ? "busy" : "failed" };
          if (!(err instanceof IngestBusyError)) notes.push(`The nightly ingest failed: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
        }
      }
    }

    // What the branch changed so far: the contradiction pass's scope and the Opus queue's.
    let changed = await changedPages(wt, VAULT_MAIN_BRANCH, "HEAD");
    const snapshot = await readVaultSnapshot(wt);

    // 3. contradictions
    if (!settings.contradictions.enabled) summary.contradictions.skipped = "disabled";
    else if (!online) summary.contradictions.skipped = "offline";
    else {
      const firstNight = !anyFinishedRun(vault);
      const pass = await runContradictionPass(snapshot, {
        stateVault: vault,
        scope: firstNight ? null : changed,
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
        deferredPairs: pass.deferredPairs,
        usdEstimate: pass.usdEstimate,
        skipped: pass.skipped,
        findings: pass.findings.length,
      };
      summary.reviewItems.raised += pass.reviewItems.length;
      notes.push(...pass.notes);
      run.usdEstimate += pass.usdEstimate;
    }

    // 4. Opus, optional
    if (!settings.opus.enabled) summary.opus = { skipped: "disabled" };
    else {
      const reviewPages = new Set(listReviewItems(vault, { status: "open", limit: 200 }).items.flatMap((i) => i.pages));
      const queue = buildOpusQueue(snapshot.pages, { changed: new Set(changed), reviewPages, sampleRate: settings.opus.sampleRate, random: deps.random });
      if (queue.length === 0) summary.opus = { skipped: "nothing_queued" };
      else {
        try {
          const op = await vaultOperation(
            "nightly: opus check",
            (tx) =>
              runOpusTier(tx, queue, {
                stateVault: vault,
                capUsd: settings.opus.capUsd,
                rates,
                client: deps.opus ?? opusClient(settings.opus.model),
                runId: run.id,
                now,
              }),
            { vault: wt, now: now() },
          );
          const o = op.result;
          summary.opus = { queued: o.queued, reviewed: o.reviewed, pending: o.pending, calls: o.calls, usdEstimate: o.usdEstimate, capUsd: o.capUsd, stopped: o.stopped };
          summary.reviewItems.raised += o.reviewItems.length;
          notes.push(...o.notes);
          run.usdEstimate += o.usdEstimate;
        } catch (err) {
          summary.opus = { skipped: "failed" };
          notes.push(`The Opus check could not be saved: ${err instanceof Error ? err.message.slice(0, 160) : "error"}.`);
        }
      }
    }
    if (summary.ingest && "jobId" in summary.ingest) {
      const job = getIngestJob(summary.ingest.jobId, vault);
      if (job) run.usdEstimate += job.usdEstimate;
    }

    // 5. lint everything the branch changed — after every step that commits to it
    const finalChanged = await changedPages(wt, VAULT_MAIN_BRANCH, "HEAD");
    const report = lintVault(await readVaultSnapshot(wt), { scope: finalChanged, ledgerRetired: ledger(vault), now: now() });
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
