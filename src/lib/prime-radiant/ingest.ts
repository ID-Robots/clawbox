/**
 * An ingest job: documents from the owner's folders (or a drop) turned into
 * vault pages with claims.
 *
 *   scan  → walk the folders (exclude list, code projects, boilerplate and
 *           temporary files by name, entry budget), one file row each
 *   write → per file: read once, hash, skip what is already ingested, extract,
 *           leave out machine-generated text (a log, a table export …, never
 *           sent to a model), redact; every {@link WRITER_BATCH_SIZE} files (or a character
 *           budget) one Flash call, up to `parallel` in flight (128 by
 *           default, the settings file's to change); each answered batch
 *           becomes ONE commit through `vaultOperation`
 *   retry → files whose first round failed for a reason that may pass (a
 *           call that kept failing through its jittered backoff, an answer
 *           that could not be read, an item the model dropped) go on the
 *           job's own RETRY QUEUE and are tried once more after a cooldown,
 *           in batches half the size
 *   done  → tallies, notes, the DEAD-LETTER list (what still failed), the job
 *           row settled
 *
 * One job runs at a time per box (the second is refused, never queued), held
 * in `processStore` because the routes and the boot layer are separate module
 * copies. Progress is pushed to subscribers (the SSE route) and persisted per
 * batch; a job whose process went away is settled `interrupted` on the next
 * read, and re-running the same folders retries exactly what did not finish —
 * a document is skipped only once some job has written its pages. A job's
 * dead letters can also be retried on their own (`{ kind: "retry" }`), which
 * is the only way back for a dropped document, whose bytes are kept for it.
 *
 * Failure scopes: a model answer that drops or garbles one item fails that
 * file; a call that keeps failing after its retries fails its batch; a refused
 * credential or plan stops the job (every further call would fail the same
 * way). A spent ClawBox AI allowance (weekly or burst) stops it too, after the
 * one refused call, but fails nothing: the job ends `interrupted` with the
 * allowance and when it frees up as its error, and every document it did not
 * finish stays QUEUED (`pending`, counted as `queued`, never a dead letter) —
 * the next run of the same folders, the nightly pass's included, or a retry
 * takes it.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { processStore } from "@/lib/process-store";
import { buildClaimIndex } from "./claims";
import {
  ALLOWANCE_SPENT,
  FlashCallError,
  abortableSleep,
  allowanceSpentText,
  allowanceStopOf,
  completeWithRetry,
  flashClient,
  type AllowanceStop,
  type FlashClient,
  type RetryOptions,
} from "./flash-client";
import {
  extractText,
  isIngestExtension,
  machineTextFile,
  prepareText,
  readFileOnce,
  redactedLabel,
  scanFolders,
  sourceLabel,
  type Extractor,
  type ScannedFile,
} from "./ingest-sources";
import { estimateUsd, type CostRates } from "./cost-rates";
import { lintSecretsInText, type LintFinding } from "./lint";
import { emptySkipCounts } from "./ingest-exclude";
import { dropKeptCopies, keepFailedUploads, pruneKeptCopies } from "./ingest-dead-letter";
import {
  claimDeadLetter,
  countQueued,
  ingestedHashes,
  ingestLabels,
  insertFiles,
  insertJob,
  listJobs,
  readDeadLetter,
  readFileSources,
  readJob,
  recordCost,
  refreshDeadLetterCount,
  saveJob,
  setFileSources,
  settleOrphanJobs,
  updateFiles,
  type DeadLetterSource,
  type FileStatus,
  type FileUpdate,
  type IngestJob,
} from "./ingest-store";
import { primeRadiantRoot, vaultDir } from "./paths";
import { repairPluginWritesOnce } from "./plugin-repair";
import { DEFAULT_INGEST_PARALLEL, MAX_INGEST_PARALLEL, effectiveCostRates, readSettings } from "./settings";
import { readRetiredLedger, stateDbPathFor, syncActiveClaims } from "./state-db";
import type { VaultAuthor } from "./git";
import { INDEX_FILE, VaultLintBlockedError, ensureVault, readVaultSnapshot, vaultOperation } from "./vault";
import {
  MAX_BATCH_CHARS,
  WRITER_BATCH_SIZE,
  WRITER_MAX_TOKENS,
  WriterParseError,
  addToIndex,
  indexLine,
  buildPage,
  buildWriterPrompt,
  parseWriterResponse,
  type BuildContext,
  type ExistingPage,
  type ItemVerdict,
  type WriterItem,
} from "./writer";

/** Model calls in flight at once, by default (the settings file may say otherwise). */
export const DEFAULT_PARALLEL = DEFAULT_INGEST_PARALLEL;
export const MAX_PARALLEL = MAX_INGEST_PARALLEL;
/** How long the job's retry queue waits before its second round. */
export const REQUEUE_DELAY_MS = 30_000;
/** Events a late subscriber can catch up on. */
const BACKLOG = 300;

export type IngestEvent =
  | { type: "job"; job: IngestJob }
  | { type: "file"; seq: number; label: string; status: FileStatus; pages?: string[]; reason?: string };

export type IngestListener = (event: IngestEvent) => void;

export type IngestInput =
  | { kind: "folders"; folders: string[] }
  /** A drop: the staged folder and the batch it was uploaded under. */
  | { kind: "upload"; dir: string; batch: string }
  /** The dead letters of an earlier job, tried again. */
  | { kind: "retry"; retryOf: string };

export interface IngestDeps {
  vault?: string;
  /** Who the job's commits name as their author: the assistant, for an import it started. Default Prime Radiant. */
  author?: VaultAuthor;
  client?: FlashClient;
  parallel?: number;
  batchSize?: number;
  maxBatchChars?: number;
  retry?: RetryOptions;
  extractor?: Extractor;
  now?: () => Date;
  ownerFor?: (domain: string) => string | undefined;
  /** Folder-name patterns never walked into (default: the settings file's list). */
  exclude?: readonly string[];
  /** Leave out code projects found during the walk (default: the settings file's choice). */
  skipCodeProjects?: boolean;
  /** The wait before the retry queue's second round (default {@link REQUEUE_DELAY_MS}). */
  requeueDelayMs?: number;
  /** The rates calls are priced with (default: the settings file's). */
  costRates?: CostRates;
}

interface LiveJob {
  job: IngestJob;
  listeners: Set<IngestListener>;
  backlog: IngestEvent[];
  abort: AbortController;
  done: Promise<void>;
}

const store = processStore("prime-radiant:ingest", () => ({ live: new Map<string, LiveJob>() }));

export class IngestBusyError extends Error {
  constructor(readonly runningId: string) {
    super("an ingest is already running");
    this.name = "IngestBusyError";
  }
}

/** A retry of a job this box has no record of. */
export class UnknownJobError extends Error {
  constructor() {
    super("no such ingest job");
    this.name = "UnknownJobError";
  }
}

/** A retry of a job with no dead letters left. */
export class NothingToRetryError extends Error {
  constructor() {
    super("nothing to retry");
    this.name = "NothingToRetryError";
  }
}

const JOB_ID_ALPHABET = "0123456789abcdef";
const JOB_ID_HEX = 12;

export function newJobId(): string {
  return `ing-${crypto.randomBytes(JOB_ID_HEX / 2).toString("hex")}`;
}

/** A caller's job id rebuilt from the id alphabet, or null when it cannot be one. */
export function safeJobId(input: unknown): string | null {
  if (typeof input !== "string" || !input.startsWith("ing-") || input.length !== 4 + JOB_ID_HEX) return null;
  let hex = "";
  for (const ch of input.slice(4)) {
    const at = JOB_ID_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    hex += JOB_ID_ALPHABET[at];
  }
  return `ing-${hex}`;
}

function liveIds(): Set<string> {
  return new Set(store.live.keys());
}

/** The running job's id, or null. */
export function runningJobId(): string | null {
  for (const [id, live] of store.live) if (live.job.status === "running") return id;
  return null;
}

/** One job: live when it is running here, else from the database (settling an orphan first). */
export function getIngestJob(id: string, vault: string = vaultDir()): IngestJob | null {
  const live = store.live.get(id);
  if (live) return { ...live.job };
  // A read never creates the state database.
  if (!existsSync(stateDbPathFor(vault))) return null;
  try {
    settleOrphanJobs(vault, liveIds(), new Date().toISOString());
    return readJob(vault, id);
  } catch {
    return null;
  }
}

export function listIngestJobs(vault: string = vaultDir(), limit = 20): IngestJob[] {
  if (!existsSync(stateDbPathFor(vault))) return [];
  try {
    settleOrphanJobs(vault, liveIds(), new Date().toISOString());
    return listJobs(vault, limit).map((j) => (store.live.get(j.id) ? { ...store.live.get(j.id)!.job } : j));
  } catch {
    return [];
  }
}

/**
 * Subscribe to a live job's events. The listener first receives the backlog
 * (the job's current state last), then every event until the job ends.
 * Returns the unsubscribe function, or null when the job is not live here.
 */
export function subscribeIngest(id: string, listener: IngestListener): (() => void) | null {
  const live = store.live.get(id);
  if (!live) return null;
  for (const e of live.backlog) listener(e);
  listener({ type: "job", job: { ...live.job } });
  live.listeners.add(listener);
  return () => live.listeners.delete(listener);
}

/** Resolves when the job has finished (immediately for one not running here). */
export function ingestFinished(id: string): Promise<void> {
  return store.live.get(id)?.done ?? Promise.resolve();
}

function emit(live: LiveJob, event: IngestEvent): void {
  if (event.type === "file") {
    live.backlog.push(event);
    if (live.backlog.length > BACKLOG) live.backlog.splice(0, live.backlog.length - BACKLOG);
  }
  for (const l of [...live.listeners]) {
    try {
      l(event);
    } catch {
      // A subscriber that throws (a closed stream) must not stop the job.
    }
  }
}

/**
 * Start a job and answer it at once; the work runs on. Throws
 * {@link IngestBusyError} while another job runs.
 */
export async function startIngest(input: IngestInput, deps: IngestDeps = {}): Promise<IngestJob> {
  const running = runningJobId();
  if (running) throw new IngestBusyError(running);
  const vault = deps.vault ?? vaultDir();
  const now = deps.now ?? (() => new Date());
  await ensureVault(vault);
  // The box's own vault (not a nightly worktree): what memory-wiki wrote into it goes first, once.
  if (!deps.vault) {
    await repairPluginWritesOnce(vault, now).catch((err) => {
      console.warn(`[prime-radiant] memory-wiki repair failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  // Checked again after the await: two starts that arrived together both passed the first look.
  const raced = runningJobId();
  if (raced) throw new IngestBusyError(raced);
  if (input.kind === "retry") {
    settleOrphanJobs(vault, liveIds(), now().toISOString());
    if (!readJob(vault, input.retryOf)) throw new UnknownJobError();
    if (readDeadLetter(vault, input.retryOf, 1).length === 0 && countQueued(vault, input.retryOf) === 0) throw new NothingToRetryError();
  }

  const at = now().toISOString();
  const job: IngestJob = {
    id: newJobId(),
    kind: input.kind,
    status: "running",
    phase: "queued",
    folders:
      input.kind === "folders"
        ? input.folders.map(sourceLabel)
        : input.kind === "upload"
          ? [`upload/${input.batch}`]
          : [`retry/${input.retryOf}`],
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    duplicates: 0,
    pages: 0,
    commits: 0,
    calls: 0,
    usdEstimate: 0,
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
    error: null,
    notes: [],
    retryOf: input.kind === "retry" ? input.retryOf : null,
    requeued: 0,
    deadLetter: 0,
    queued: 0,
    skips: emptySkipCounts(),
  };
  settleOrphanJobs(vault, liveIds(), at);
  insertJob(vault, job);
  // Taken over in one transaction AFTER the job row exists, so the rows always name a job.
  const claimed = input.kind === "retry" ? claimDeadLetter(vault, input.retryOf, job.id) : [];
  if (input.kind === "retry") {
    // The original may still be held in memory for its late subscribers.
    const original = store.live.get(input.retryOf);
    if (original) {
      original.job.deadLetter = 0;
      original.job.queued = 0;
    }
  }
  // Registered before the next await: until it is, a second start passes the
  // busy check and an orphan sweep would settle this job as interrupted.
  const live: LiveJob = { job, listeners: new Set(), backlog: [], abort: new AbortController(), done: Promise.resolve() };
  store.live.set(job.id, live);
  await pruneKeptCopies(now().getTime()).catch(() => 0);
  live.done = runJob(live, input, claimed, vault, deps).finally(() => {
    // Kept a little after the end so a stream opened right as it finished still
    // gets the closing state from memory; the database has it either way.
    const t = setTimeout(() => {
      if (store.live.get(job.id) === live) store.live.delete(job.id);
    }, 60_000);
    t.unref?.();
  });
  return { ...job };
}

/**
 * Stop a running job. Files it did not reach are marked failed and become its
 * dead letters; re-running the same folders (or retrying the job) picks them up.
 */
export function stopIngest(id: string): boolean {
  const live = store.live.get(id);
  if (!live || live.job.status !== "running") return false;
  live.abort.abort();
  return true;
}

interface PreparedFile {
  seq: number;
  file: ScannedFile;
  sha256: string;
  bytes: number;
  text: string;
}

/**
 * An upload's files by the name the owner gave them — the page's source says
 * `Price list.md`, not the staging folder's `upload/<batch>/…`. Two drops of
 * a `notes.md` are still two documents, not one page: a name an earlier
 * document already goes by (`taken`) is numbered the way the staging folder
 * numbers a clash, `notes (2).md`. The name is the owner's and goes to
 * ClawBox AI with the text, so it is redacted like a folder file's path —
 * with the same keyed tag when that folded something away.
 */
function uploadLabel(dir: string, taken: Set<string>): (abs: string) => string {
  const given = new Map<string, string>();
  return (abs) => {
    const known = given.get(abs);
    if (known !== undefined) return known;
    const rel = path.relative(dir, abs).split(path.sep).join("/");
    const ext = path.posix.extname(rel);
    const stem = rel.slice(0, rel.length - ext.length);
    let label = redactedLabel(rel, abs);
    for (let n = 2; taken.has(label) && n < 10_000; n++) label = redactedLabel(`${stem} (${n})${ext}`, abs);
    taken.add(label);
    given.set(abs, label);
    return label;
  };
}

/** The labels documents already go by: every page's sources and every file an ingest recorded. Read once, before a drop is named. */
async function labelsInUse(vault: string): Promise<Set<string>> {
  const taken = new Set<string>();
  try {
    for (const label of ingestLabels(vault)) taken.add(label);
  } catch {
    // The pages still say which names are taken.
  }
  try {
    for (const p of (await readVaultSnapshot(vault)).pages) if (p.parsed.ok) for (const s of p.parsed.frontmatter.sources) taken.add(s);
  } catch {
    // An unreadable vault fails the job's own write later; the names are the ingest store's.
  }
  return taken;
}

/** Dead letters as files to read again; one whose kind is not ingestible any more is left out. */
function retryFiles(claimed: readonly DeadLetterSource[]): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const r of claimed) {
    const ext = path.extname(r.source).toLowerCase();
    if (isIngestExtension(ext)) files.push({ abs: r.source, label: r.label, ext });
  }
  return files;
}

async function runJob(
  live: LiveJob,
  input: IngestInput,
  claimed: readonly DeadLetterSource[],
  vault: string,
  deps: IngestDeps,
): Promise<void> {
  const { job } = live;
  const now = deps.now ?? (() => new Date());
  const client = deps.client ?? flashClient();
  const settings = readSettings();
  const rates = deps.costRates ?? effectiveCostRates();
  const parallel = Math.min(MAX_PARALLEL, Math.max(1, Math.floor(deps.parallel ?? settings.ingest.parallel)));
  const batchSize = Math.min(WRITER_BATCH_SIZE, Math.max(1, Math.floor(deps.batchSize ?? WRITER_BATCH_SIZE)));
  const maxBatchChars = deps.maxBatchChars ?? MAX_BATCH_CHARS;
  const scratch = path.join(primeRadiantRoot(), "tmp", job.id);
  const signal = live.abort.signal;
  let fatal: string | null = null;
  /** The spent allowance that stopped the job: what it did not finish stays queued. */
  let spent: AllowanceStop | null = null;

  const touch = () => {
    job.updatedAt = now().toISOString();
  };
  const publish = () => {
    touch();
    emit(live, { type: "job", job: { ...job } });
  };
  const persist = () => {
    try {
      saveJob(vault, job);
    } catch (err) {
      console.error("[prime-radiant] ingest: saving the job failed:", err instanceof Error ? err.message : err);
    }
  };
  const settledSeqs = new Set<number>();
  const settle = (updates: FileUpdate[], labels: Map<number, string>) => {
    for (const u of updates) {
      settledSeqs.add(u.seq);
      if (u.status === "done") job.done += 1;
      else if (u.status === "failed") job.failed += 1;
      else if (u.status === "duplicate") job.duplicates += 1;
      else if (u.status === "skipped") job.skipped += 1;
      emit(live, {
        type: "file",
        seq: u.seq,
        label: labels.get(u.seq) ?? "",
        status: u.status,
        ...(u.pages ? { pages: u.pages } : {}),
        ...(u.error ? { reason: u.error } : {}),
      });
    }
    try {
      updateFiles(vault, job.id, updates);
    } catch (err) {
      console.error("[prime-radiant] ingest: saving file rows failed:", err instanceof Error ? err.message : err);
    }
  };

  try {
    // ── scan ──
    job.phase = "scan";
    publish();
    // A drop's files were each chosen by the owner: nothing is left out by name or content.
    const chosen = input.kind === "upload";
    const scan =
      input.kind === "retry"
        ? { files: retryFiles(claimed), notes: [] as string[], skips: emptySkipCounts(), truncated: false }
        : await scanFolders(input.kind === "folders" ? input.folders : [input.dir], {
            labelOf: chosen ? uploadLabel(input.dir, await labelsInUse(vault)) : undefined,
            folderLabelOf: chosen ? () => `upload/${input.batch}` : undefined,
            signal,
            exclude: deps.exclude ?? settings.ingest.exclude,
            skipCodeProjects: deps.skipCodeProjects ?? settings.ingest.skipCodeProjects,
            skipByName: !chosen,
          });
    job.total = scan.files.length;
    job.skips = { ...scan.skips };
    job.notes.push(...scan.notes);
    const s = scan.skips;
    if (s.unsupported > 0) job.notes.push(`${s.unsupported} file(s) of a kind Prime Radiant does not read were left out.`);
    if (s.excludedFolder > 0) job.notes.push(`${s.excludedFolder} folder(s) were left out by the exclude list.`);
    if (s.codeProject > 0) job.notes.push(`${s.codeProject} code project(s) were left out.`);
    if (s.boilerplate > 0) job.notes.push(`${s.boilerplate} licence, changelog or other boilerplate file(s) were left out.`);
    if (s.temp > 0) job.notes.push(`${s.temp} temporary or partial file(s) were left out.`);
    const labels = new Map<number, string>(scan.files.map((f, seq) => [seq, f.label]));
    insertFiles(vault, job.id, scan.files.map((f, seq) => ({ seq, label: f.label, source: f.abs })));
    job.phase = "write";
    publish();
    persist();

    // ── write ──
    const known = ingestedHashes(vault);
    const seenInJob = new Map<string, number>();
    const inFlight = new Set<Promise<void>>();
    /** Files whose first round failed for a reason that may pass: the job's retry queue. */
    const requeue: PreparedFile[] = [];
    let batch: PreparedFile[] = [];
    let batchChars = 0;

    const dispatch = async (files: PreparedFile[], round: 1 | 2) => {
      if (files.length === 0) return;
      while (inFlight.size >= parallel) await Promise.race(inFlight);
      // Past a spent allowance nothing more is asked: the files stay unsettled, queued below.
      if (spent) return;
      if (fatal || signal.aborted) {
        settle(
          files.map((f) => ({ seq: f.seq, status: "failed" as const, sha256: f.sha256, bytes: f.bytes, error: fatal ?? "stopped", attempts: round - 1 })),
          labels,
        );
        publish();
        return;
      }
      const p = writeBatch(files, round).finally(() => inFlight.delete(p));
      inFlight.add(p);
    };

    const writeBatch = async (files: PreparedFile[], round: 1 | 2) => {
      let results: BatchResult;
      try {
        results = await processBatch(files, { client, vault, deps, job, signal, now, rates });
      } catch (err) {
        // Anything processBatch did not expect fails its own batch, never the job.
        console.error("[prime-radiant] ingest: a batch failed:", err instanceof Error ? err.message : err);
        results = {
          updates: files.map((f) => ({ seq: f.seq, status: "failed", sha256: f.sha256, bytes: f.bytes, error: "the batch could not be written" })),
          transient: new Set(files.map((f) => f.seq)),
          pagesWritten: 0,
          commit: null,
          cost: null,
          fatal: null,
        };
      }
      if (results.fatal && !fatal) fatal = results.fatal;
      if (results.allowance && !spent) spent = results.allowance;
      let updates = results.updates.map((u) => ({ ...u, attempts: round }));
      if (round === 1 && !fatal && !signal.aborted && results.transient.size > 0) {
        const bySeq = new Map(files.map((f) => [f.seq, f]));
        updates = updates.filter((u) => {
          const f = u.status === "failed" && results.transient.has(u.seq) ? bySeq.get(u.seq) : undefined;
          if (f) requeue.push(f);
          return !f;
        });
      }
      settle(updates, labels);
      if (results.cost) {
        job.calls += results.cost.calls;
        job.usdEstimate = Math.round((job.usdEstimate + results.cost.usd) * 1_000_000) / 1_000_000;
      }
      if (results.commit) job.commits += 1;
      job.pages += results.pagesWritten;
      publish();
      persist();
    };

    const gone: Array<{ seq: number; source: null }> = [];
    for (let seq = 0; seq < scan.files.length; seq++) {
      const file = scan.files[seq];
      if (signal.aborted || fatal || spent) break;
      const read = await readFileOnce(file.abs);
      if (!read.ok) {
        // A file that is no longer there cannot be retried: it leaves the dead-letter list.
        const missing = read.reason === "unreadable" && !existsSync(file.abs);
        if (missing) gone.push({ seq, source: null });
        if (read.reason === "too-large") job.skips.tooLarge += 1;
        settle(
          [{ seq, status: read.reason === "too-large" ? "skipped" : "failed", bytes: read.bytes, error: missing ? "gone" : read.reason, attempts: 1 }],
          labels,
        );
        publish();
        continue;
      }
      const bytes = read.data.length;
      if (known.has(read.sha256) || seenInJob.has(read.sha256)) {
        settle([{ seq, status: "duplicate", sha256: read.sha256, bytes, error: null }], labels);
        publish();
        continue;
      }
      seenInJob.set(read.sha256, seq);
      const raw = await extractText(read.data, file.ext, scratch, deps.extractor);
      if (raw === null) {
        settle([{ seq, status: "failed", sha256: read.sha256, bytes, error: "extract-failed" }], labels);
        publish();
        continue;
      }
      // Before anything is sent to a model: a log or a data dump is no document.
      if (input.kind === "folders" && machineTextFile(file.ext, raw)) {
        job.skips.machineText += 1;
        settle([{ seq, status: "skipped", sha256: read.sha256, bytes, error: "machine-text" }], labels);
        publish();
        continue;
      }
      const prepared = prepareText(raw);
      if (prepared.text.trim() === "") {
        settle([{ seq, status: "skipped", sha256: read.sha256, bytes, error: "empty" }], labels);
        publish();
        continue;
      }
      if (batch.length > 0 && (batch.length >= batchSize || batchChars + prepared.text.length > maxBatchChars)) {
        await dispatch(batch, 1);
        batch = [];
        batchChars = 0;
      }
      batch.push({ seq, file, sha256: read.sha256, bytes, text: prepared.text });
      batchChars += prepared.text.length;
    }
    await dispatch(batch, 1);
    batch = [];
    while (inFlight.size > 0) await Promise.race(inFlight);
    if (gone.length > 0) setFileSources(vault, job.id, gone);
    if (job.skips.machineText > 0) job.notes.push(`${job.skips.machineText} machine-generated text file(s) (logs, data exports) were left out.`);
    if (job.skips.tooLarge > 0) job.notes.push(`${job.skips.tooLarge} file(s) too large to read were left out.`);

    // ── the retry queue: one more round, after a cooldown, in smaller batches ──
    if (requeue.length > 0) {
      const queued = requeue.splice(0, requeue.length).sort((a, b) => a.seq - b.seq);
      job.requeued = queued.length;
      if (!fatal && !spent && !signal.aborted) {
        job.notes.push(`${queued.length} document(s) failed their first round and were tried once more.`);
        publish();
        try {
          await (deps.retry?.sleep ?? abortableSleep)(Math.max(0, deps.requeueDelayMs ?? REQUEUE_DELAY_MS), signal);
        } catch {
          // Stopped during the cooldown: dispatch below settles the queue as stopped.
        }
      }
      const half = Math.max(1, Math.ceil(batchSize / 2));
      let chunk: PreparedFile[] = [];
      let chunkChars = 0;
      for (const f of queued) {
        if (chunk.length > 0 && (chunk.length >= half || chunkChars + f.text.length > maxBatchChars)) {
          await dispatch(chunk, 2);
          chunk = [];
          chunkChars = 0;
        }
        chunk.push(f);
        chunkChars += f.text.length;
      }
      await dispatch(chunk, 2);
      while (inFlight.size > 0) await Promise.race(inFlight);
    }

    // Files the loop never reached (stopped, or a fatal error) are failed —
    // dead letters like any other; a document is skipped only once some job
    // wrote its pages, so the next run of the same folders picks them up too.
    // Past a spent allowance they are QUEUED instead (`pending`), never failed:
    // nothing was wrong with them, and the next run takes them once it frees up.
    const missing: FileUpdate[] = [];
    for (let seq = 0; seq < scan.files.length; seq++) {
      if (settledSeqs.has(seq)) continue;
      missing.push(spent ? { seq, status: "pending", error: ALLOWANCE_SPENT } : { seq, status: "failed", error: fatal ?? "stopped" });
    }
    settle(missing, labels);
    job.status = spent ? "interrupted" : fatal && job.done === 0 ? "failed" : "done";
    if (spent) {
      job.allowance = spent;
      job.error = `${allowanceSpentText(spent)}. The documents not written yet wait for the next run${input.kind === "folders" ? " of these folders" : ""}, or Retry, once it frees up.`;
    } else if (fatal) job.error = fatal;
    else if (signal.aborted) job.error = "The ingest was stopped.";
  } catch (err) {
    job.status = "failed";
    job.error = signal.aborted ? "The ingest was stopped." : "The ingest could not finish.";
    console.error("[prime-radiant] ingest failed:", err instanceof Error ? err.message : err);
  } finally {
    // Cleaned up BEFORE the closing event, so whoever hears "end" finds it done.
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await settleSources(vault, job.id, input).catch((err) => {
      console.error("[prime-radiant] ingest: keeping the dead letters failed:", err instanceof Error ? err.message : err);
    });
    if (input.kind === "upload") await fs.rm(input.dir, { recursive: true, force: true }).catch(() => undefined);
    try {
      job.deadLetter = refreshDeadLetterCount(vault, job.id);
    } catch {
      /* the tally stays as it was */
    }
    if (job.deadLetter > 0) job.notes.push(`${job.deadLetter} document(s) still failed; they can be retried.`);
    if (spent) {
      try {
        job.queued = countQueued(vault, job.id, { ended: true });
      } catch {
        /* the tally stays as it was */
      }
      if (job.queued > 0) job.notes.push(`${job.queued} document(s) wait for the ClawBox AI allowance; they were not tried and did not fail.`);
    }
    job.phase = "done";
    job.finishedAt = now().toISOString();
    publish();
    persist();
  }
}

/**
 * Where each file of a finished job can be read again. An upload's failed
 * files are moved out of the batch before it is removed (its other files
 * point nowhere); a retry removes the kept copies it no longer needs.
 */
async function settleSources(vault: string, jobId: string, input: IngestInput): Promise<void> {
  const rows = readFileSources(vault, jobId);
  if (input.kind === "upload") {
    // A queued file (left by a spent allowance) is kept like a failed one: a retry reads it from there.
    const owed = rows.filter((r) => r.status === "failed" || r.status === "pending");
    const kept = await keepFailedUploads(jobId, input.dir, owed);
    const cleared = rows.filter((r) => r.status !== "failed" && r.status !== "pending").map((r) => ({ seq: r.seq, source: null }));
    setFileSources(vault, jobId, [...kept, ...cleared]);
  } else if (input.kind === "retry") {
    const done = rows.filter((r) => r.status !== "failed" && r.status !== "pending");
    await dropKeptCopies(done.map((r) => r.source));
  }
}

interface BatchResult {
  updates: FileUpdate[];
  /** Failed files whose reason may pass on a second round. */
  transient: Set<number>;
  pagesWritten: number;
  commit: string | null;
  cost: { calls: number; usd: number } | null;
  fatal: string | null;
  /** A spent allowance refused the batch's call: it stops the job, and the batch's files (left out of `updates`) stay queued. */
  allowance?: AllowanceStop | null;
}

const FATAL_MESSAGES: Partial<Record<FlashCallError["kind"], string>> = {
  no_credential: "This box is not signed in to ClawBox AI.",
  auth: "ClawBox AI refused this box's sign-in. Sign in again in Settings.",
  refused: "ClawBox AI refused the request. Check the plan this box is on.",
};

/**
 * The files of a batch a lint refusal blames: a finding on a page this batch
 * wrote names that page's file; a secret in index.md names every file whose
 * index line (its title) carries one. Empty when the refusal is about none of
 * this batch's pages, so the caller knows dropping files would not help.
 */
export function lintCulprits(
  findings: readonly LintFinding[],
  pageOf: ReadonlyMap<string, number>,
  titleOf: ReadonlyMap<number, string>,
): Map<number, string> {
  const rules = new Map<number, Set<string>>();
  const blame = (i: number, rule: string) => {
    const set = rules.get(i) ?? new Set<string>();
    set.add(rule);
    rules.set(i, set);
  };
  for (const f of findings) {
    const i = pageOf.get(f.path);
    if (i !== undefined) {
      blame(i, f.rule);
    } else if (f.path === INDEX_FILE) {
      for (const [path, idx] of pageOf) {
        if (lintSecretsInText(INDEX_FILE, indexLine(path, titleOf.get(idx) ?? "")).length > 0) blame(idx, f.rule);
      }
    }
  }
  return new Map([...rules].map(([i, set]) => [i, `its page was refused by lint: ${[...set].sort().join(", ")}`]));
}

/** One batch: a model call (with retries, and one more call for an unreadable answer), then one commit. */
function ownerLookup(domains: ReadonlyArray<{ name: string; owner: string }>): (domain: string) => string | undefined {
  const byName = new Map(domains.map((d) => [d.name, d.owner]));
  return (domain) => byName.get(domain);
}

async function processBatch(
  files: PreparedFile[],
  ctx: { client: FlashClient; vault: string; deps: IngestDeps; job: IngestJob; signal: AbortSignal; now: () => Date; rates: CostRates },
): Promise<BatchResult> {
  const { client, vault, deps, job, signal, now, rates } = ctx;
  const items: WriterItem[] = files.map((f, i) => ({ i, path: f.file.label, kind: f.file.ext.slice(1), text: f.text }));
  const prompt = buildWriterPrompt(items);
  const failAll = (
    reason: string,
    fatal: string | null = null,
    cost: BatchResult["cost"] = null,
    transient = false,
  ): BatchResult => ({
    updates: files.map((f) => ({ seq: f.seq, status: "failed", sha256: f.sha256, bytes: f.bytes, error: reason })),
    transient: new Set(transient ? files.map((f) => f.seq) : []),
    pagesWritten: 0,
    commit: null,
    cost,
    fatal,
  });

  let verdicts: Map<number, ItemVerdict> | null = null;
  const cost = { calls: 0, usd: 0 };
  for (let parseAttempt = 1; parseAttempt <= 2 && !verdicts; parseAttempt++) {
    let outcome;
    try {
      outcome = await completeWithRetry(
        client,
        { system: prompt.system, user: prompt.user, maxTokens: WRITER_MAX_TOKENS, signal },
        deps.retry,
      );
    } catch (err) {
      // A spent allowance fails nothing: the batch is left unsettled, queued with the rest of the job.
      const allowance = allowanceStopOf(err);
      if (allowance) return { updates: [], transient: new Set(), pagesWritten: 0, commit: null, cost: cost.calls ? cost : null, fatal: null, allowance };
      const e = err instanceof FlashCallError ? err : null;
      const fatal = e ? (FATAL_MESSAGES[e.kind] ?? null) : null;
      return failAll(
        e?.kind === "aborted" ? "stopped" : `model call failed${e ? ` (${e.kind})` : ""}`,
        fatal,
        cost.calls ? cost : null,
        e ? e.retryable : true,
      );
    }
    const usd = estimateUsd(outcome.response.model, outcome.response.usage, rates);
    cost.calls += 1;
    cost.usd += usd;
    try {
      recordCost(vault, {
        runId: job.id,
        operation: "ingest.write",
        model: outcome.response.model,
        tokensIn: outcome.response.usage.promptTokens,
        tokensOut: outcome.response.usage.completionTokens,
        usdEstimate: usd,
        at: now().toISOString(),
      });
    } catch (err) {
      console.error("[prime-radiant] ingest: recording a cost failed:", err instanceof Error ? err.message : err);
    }
    try {
      verdicts = parseWriterResponse(outcome.response.text, items);
    } catch (err) {
      if (!(err instanceof WriterParseError) || parseAttempt === 2) return failAll("the model's answer could not be read", null, cost, true);
    }
  }
  if (!verdicts) return failAll("the model's answer could not be read", null, cost, true);

  let updates: FileUpdate[] = [];
  let transient = new Set<number>();
  let pagesWritten = 0;
  let commit: string | null = null;
  let written: Array<{ id: string; page: string; updatedAt: string }> = [];
  // Files whose page lint refused, with why. They fail alone; the rest of the
  // batch is written again without them (the vault is put back after a refusal,
  // and index.md is rebuilt from it, so a dropped page leaves no trace there).
  const refused = new Map<number, string>();
  for (;;) {
    updates = [];
    transient = new Set<number>();
    pagesWritten = 0;
    written = [];
    const pageOf = new Map<string, number>();
    const titleOf = new Map<number, string>();
    try {
      const op = await vaultOperation(
        `ingest: ${files.length - refused.size} document(s) (${job.id})`,
        async (tx) => {
          const snapshot = await tx.snapshot();
          const valid = snapshot.pages.flatMap((p) => (p.parsed.ok ? [{ path: p.path, frontmatter: p.parsed.frontmatter }] : []));
          let ledger: string[] = [];
          try {
            ledger = readRetiredLedger(tx.vault);
          } catch {
            ledger = [];
          }
          const pagesBySource = new Map<string, ExistingPage>();
          for (const p of valid) for (const s of p.frontmatter.sources) if (!pagesBySource.has(s)) pagesBySource.set(s, p);
          const build: BuildContext = {
            takenPaths: new Set(snapshot.pages.map((p) => p.path)),
            pagesBySource,
            claimIndex: buildClaimIndex(valid, ledger),
            now: now(),
            // The owner a domain's new pages get: the settings' domain list, unless the caller names one.
            ownerFor: deps.ownerFor ?? ownerLookup(readSettings().domains),
          };
          const indexed: Array<{ path: string; title: string }> = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const why = refused.get(i);
            if (why !== undefined) {
              updates.push({ seq: f.seq, status: "failed", sha256: f.sha256, bytes: f.bytes, error: why });
              continue;
            }
            const v = verdicts!.get(i);
            if (!v || !v.ok) {
              updates.push({ seq: f.seq, status: "failed", sha256: f.sha256, bytes: f.bytes, error: v && !v.ok ? v.reason : "missing" });
              transient.add(f.seq);
              continue;
            }
            if (!v.draft.useful) {
              updates.push({ seq: f.seq, status: "skipped", sha256: f.sha256, bytes: f.bytes, error: "nothing to keep" });
              continue;
            }
            const built = buildPage(v.draft, f.file.label, build);
            if (!built.ok) {
              updates.push({ seq: f.seq, status: "skipped", sha256: f.sha256, bytes: f.bytes, error: "its page is verified" });
              continue;
            }
            await tx.writePage(built.path, built.frontmatter, built.body);
            pageOf.set(built.path, i);
            titleOf.set(i, built.frontmatter.title);
            for (const c of built.frontmatter.claims) written.push({ id: c.id, page: built.path, updatedAt: c.updatedAt });
            indexed.push({ path: built.path, title: built.frontmatter.title });
            updates.push({ seq: f.seq, status: "done", sha256: f.sha256, bytes: f.bytes, pages: [built.path], error: null });
            pagesWritten += 1;
          }
          if (indexed.length > 0) {
            const next = addToIndex(snapshot.indexBody, indexed);
            if (next !== snapshot.indexBody) await tx.write(INDEX_FILE, next);
          }
        },
        { vault, now: now(), author: deps.author },
      );
      commit = op.commit;
      break;
    } catch (err) {
      const blocked = err instanceof VaultLintBlockedError;
      console.error("[prime-radiant] ingest: batch commit failed:", err instanceof Error ? err.message : err);
      const culprits = blocked ? lintCulprits(err.findings, pageOf, titleOf) : new Map<number, string>();
      if (culprits.size === 0) {
        // Not a page of this batch to blame (or not lint at all): the batch fails
        // as a whole. Lint will refuse the same pages again; a failed save may not.
        return failAll(blocked ? "the pages were refused by lint" : "the pages could not be saved", null, cost, !blocked);
      }
      for (const [i, why] of culprits) refused.set(i, why);
      console.error(`[prime-radiant] ingest: dropping ${culprits.size} refused page(s), committing the rest of the batch`);
    }
  }
  if (written.length > 0) {
    try {
      syncActiveClaims(vault, written);
    } catch {
      // The ledger is a second copy; the pages hold the claims.
    }
  }
  return { updates, transient, pagesWritten, commit, cost, fatal: null };
}
