/**
 * Ingest jobs, their files, and model costs in the state database.
 *
 * A job row is what the app shows after the fact (and what the events stream
 * answers for a job that is no longer running); a file row keeps the SHA-256
 * of what was read so a later job skips documents already turned into pages
 * and retries the ones that failed. Every model call is one `costs` row.
 *
 * The DEAD-LETTER list of a job is its files that still failed after the
 * job's own second round and that no later job has taken over: `failed`, a
 * readable `source` kept, `retried_by` empty. `POST ingest/<id>/retry` starts
 * a job over exactly those ({@link claimDeadLetter} hands them over in one
 * transaction, so two retries can never take the same file).
 *
 * SERVER ONLY.
 */

import type { DatabaseSync } from "node:sqlite";
import { readSkipCounts, type SkipCounts } from "./ingest-exclude";
import { withStateDb } from "./state-db";

export const INGEST_STATUSES = ["running", "done", "failed", "interrupted"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

export const INGEST_PHASES = ["queued", "scan", "write", "done"] as const;
export type IngestPhase = (typeof INGEST_PHASES)[number];

export type IngestKind = "folders" | "upload" | "retry";

export type FileStatus = "pending" | "done" | "failed" | "duplicate" | "skipped";

export interface IngestJob {
  id: string;
  kind: IngestKind;
  status: IngestStatus;
  phase: IngestPhase;
  /** Source labels (home folded, redacted), never absolute paths. */
  folders: string[];
  total: number;
  /** Files whose page was written. */
  done: number;
  failed: number;
  /** Files with nothing to keep, or whose page is verified (never overwritten). */
  skipped: number;
  /** Files already turned into pages by this job or an earlier one. */
  duplicates: number;
  pages: number;
  commits: number;
  calls: number;
  usdEstimate: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  notes: string[];
  /** The job whose dead letters this one retries, or null. */
  retryOf: string | null;
  /** Files put back on this job's own queue for a second round. */
  requeued: number;
  /** Files still failed after both rounds and not taken over by a later job. */
  deadLetter: number;
  /** Files and folders left out, by reason (see `SkipCounts`). */
  skips: SkipCounts;
}

export interface FileRow {
  seq: number;
  label: string;
  sha256: string | null;
  bytes: number;
  status: FileStatus;
  pages: string[];
  error: string | null;
  attempts: number;
  retriedBy: string | null;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  phase: string;
  folders: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  duplicates: number;
  pages: number;
  commits: number;
  calls: number;
  usd_estimate: number;
  created_at: string;
  updated_at: string | null;
  finished_at: string | null;
  error: string | null;
  notes: string;
  retry_of: string | null;
  requeued: number;
  dead_letter: number;
  skips?: string | null;
}

function jsonList(text: string): string[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function jsonObject(text: string | null | undefined): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function rowToJob(r: JobRow): IngestJob {
  return {
    id: r.id,
    kind: r.kind === "upload" || r.kind === "retry" ? r.kind : "folders",
    status: (INGEST_STATUSES as readonly string[]).includes(r.status) ? (r.status as IngestStatus) : "failed",
    phase: (INGEST_PHASES as readonly string[]).includes(r.phase) ? (r.phase as IngestPhase) : "done",
    folders: jsonList(r.folders),
    total: r.total,
    done: r.done,
    failed: r.failed,
    skipped: r.skipped,
    duplicates: r.duplicates,
    pages: r.pages,
    commits: r.commits,
    calls: r.calls,
    usdEstimate: r.usd_estimate,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    finishedAt: r.finished_at,
    error: r.error,
    notes: jsonList(r.notes),
    retryOf: r.retry_of ?? null,
    requeued: r.requeued ?? 0,
    deadLetter: r.dead_letter ?? 0,
    skips: readSkipCounts(jsonObject(r.skips)),
  };
}

export function insertJob(vault: string, job: IngestJob): void {
  withStateDb(vault, (db) => {
    db.prepare(
      `INSERT INTO ingest_jobs (id, kind, status, phase, folders, total, done, failed, skipped, duplicates, pages, commits,
         calls, usd_estimate, created_at, updated_at, finished_at, error, notes, retry_of, requeued, dead_letter, skips)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.kind,
      job.status,
      job.phase,
      JSON.stringify(job.folders),
      job.total,
      job.done,
      job.failed,
      job.skipped,
      job.duplicates,
      job.pages,
      job.commits,
      job.calls,
      job.usdEstimate,
      job.createdAt,
      job.updatedAt,
      job.finishedAt,
      job.error,
      JSON.stringify(job.notes),
      job.retryOf,
      job.requeued,
      job.deadLetter,
      JSON.stringify(job.skips),
    );
  });
}

export function saveJob(vault: string, job: IngestJob): void {
  withStateDb(vault, (db) => {
    db.prepare(
      `UPDATE ingest_jobs SET status = ?, phase = ?, total = ?, done = ?, failed = ?, skipped = ?, duplicates = ?, pages = ?,
         commits = ?, calls = ?, usd_estimate = ?, updated_at = ?, finished_at = ?, error = ?, notes = ?, requeued = ?,
         dead_letter = ?, skips = ? WHERE id = ?`,
    ).run(
      job.status,
      job.phase,
      job.total,
      job.done,
      job.failed,
      job.skipped,
      job.duplicates,
      job.pages,
      job.commits,
      job.calls,
      job.usdEstimate,
      job.updatedAt,
      job.finishedAt,
      job.error,
      JSON.stringify(job.notes),
      job.requeued,
      job.deadLetter,
      JSON.stringify(job.skips),
      job.id,
    );
  });
}

export function readJob(vault: string, id: string): IngestJob | null {
  return withStateDb(vault, (db) => {
    const row = db.prepare("SELECT * FROM ingest_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  });
}

export function listJobs(vault: string, limit = 20): IngestJob[] {
  return withStateDb(vault, (db) =>
    (db.prepare("SELECT * FROM ingest_jobs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as unknown as JobRow[]).map(rowToJob),
  );
}

/**
 * Jobs the database says are running but no process is running: the web
 * server stopped under them. Settled as `interrupted`; re-running the same
 * folders picks up exactly what they did not finish.
 */
export function settleOrphanJobs(vault: string, live: ReadonlySet<string>, at: string): number {
  return withStateDb(vault, (db) => {
    const rows = db.prepare("SELECT id FROM ingest_jobs WHERE status = 'running'").all() as Array<{ id: string }>;
    const stmt = db.prepare(
      `UPDATE ingest_jobs SET status = 'interrupted', phase = 'done', finished_at = ?, updated_at = ?,
         error = 'The box restarted while this ingest ran. Run it again to finish it.' WHERE id = ?`,
    );
    // What it never reached is retryable like any other failure.
    const pending = db.prepare(
      "UPDATE ingest_files SET status = 'failed', error = 'interrupted' WHERE job_id = ? AND status = 'pending'",
    );
    let n = 0;
    for (const { id } of rows) {
      if (live.has(id)) continue;
      inTransaction(db, () => {
        stmt.run(at, at, id);
        pending.run(id);
        recountDeadLetter(db, id);
      });
      n += 1;
    }
    return n;
  });
}

function inTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertFiles(
  vault: string,
  jobId: string,
  files: ReadonlyArray<{ seq: number; label: string; source?: string | null }>,
): void {
  if (files.length === 0) return;
  withStateDb(vault, (db) => {
    const stmt = db.prepare("INSERT INTO ingest_files (job_id, seq, label, source, status) VALUES (?, ?, ?, ?, 'pending')");
    inTransaction(db, () => {
      for (const f of files) stmt.run(jobId, f.seq, f.label, f.source ?? null);
    });
  });
}

export interface FileUpdate {
  seq: number;
  status: FileStatus;
  sha256?: string | null;
  bytes?: number;
  pages?: string[];
  error?: string | null;
  /** Rounds this file was tried in (the job's own retry queue is the second). */
  attempts?: number;
}

export function updateFiles(vault: string, jobId: string, updates: readonly FileUpdate[]): void {
  if (updates.length === 0) return;
  withStateDb(vault, (db) => {
    const stmt = db.prepare(
      `UPDATE ingest_files SET status = ?, sha256 = COALESCE(?, sha256), bytes = COALESCE(?, bytes),
         pages = COALESCE(?, pages), error = ?, attempts = COALESCE(?, attempts) WHERE job_id = ? AND seq = ?`,
    );
    inTransaction(db, () => {
      for (const u of updates) {
        stmt.run(
          u.status,
          u.sha256 ?? null,
          u.bytes ?? null,
          u.pages ? JSON.stringify(u.pages) : null,
          u.error ?? null,
          u.attempts ?? null,
          jobId,
          u.seq,
        );
      }
    });
  });
}

export function readFiles(vault: string, jobId: string): FileRow[] {
  return withStateDb(vault, (db) =>
    (db
      .prepare(
        `SELECT seq, label, sha256, bytes, status, pages, error, attempts, retried_by AS retriedBy
           FROM ingest_files WHERE job_id = ? ORDER BY seq`,
      )
      .all(jobId) as Array<Omit<FileRow, "pages"> & { pages: string }>).map((r) => ({ ...r, pages: jsonList(r.pages) })),
  );
}

// ── the dead-letter list ──────────────────────────────────────────────────

const DEAD_LETTER_WHERE = "job_id = ? AND status = 'failed' AND retried_by IS NULL AND source IS NOT NULL";

/** A dead letter as a route may answer it: no absolute path. */
export interface DeadLetter {
  seq: number;
  label: string;
  error: string | null;
  attempts: number;
  bytes: number;
}

/** A dead letter as a retry job reads it: where its bytes are. */
export interface DeadLetterSource extends DeadLetter {
  source: string;
}

function recountDeadLetter(db: DatabaseSync, jobId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ingest_files WHERE ${DEAD_LETTER_WHERE}`).get(jobId) as { n: number };
  db.prepare("UPDATE ingest_jobs SET dead_letter = ? WHERE id = ?").run(row.n, jobId);
  return row.n;
}

/** Recount a job's dead letters into its row and answer the number. */
export function refreshDeadLetterCount(vault: string, jobId: string): number {
  return withStateDb(vault, (db) => recountDeadLetter(db, jobId));
}

export function readDeadLetter(vault: string, jobId: string, limit = 500): DeadLetter[] {
  return withStateDb(vault, (db) =>
    db
      .prepare(`SELECT seq, label, error, attempts, bytes FROM ingest_files WHERE ${DEAD_LETTER_WHERE} ORDER BY seq LIMIT ?`)
      .all(jobId, limit) as unknown as DeadLetter[],
  );
}

/**
 * Hand a job's dead letters to `retryJobId`: every row is marked
 * `retried_by` in one transaction and answered with its source, so a second
 * retry of the same job finds nothing left to take. The original job's
 * count drops to zero.
 */
export function claimDeadLetter(vault: string, jobId: string, retryJobId: string): DeadLetterSource[] {
  return withStateDb(vault, (db) => {
    let rows: DeadLetterSource[] = [];
    inTransaction(db, () => {
      rows = db
        .prepare(`SELECT seq, label, error, attempts, bytes, source FROM ingest_files WHERE ${DEAD_LETTER_WHERE} ORDER BY seq`)
        .all(jobId) as unknown as DeadLetterSource[];
      db.prepare(`UPDATE ingest_files SET retried_by = ? WHERE ${DEAD_LETTER_WHERE}`).run(retryJobId, jobId);
      recountDeadLetter(db, jobId);
    });
    return rows;
  });
}

/** Where a file's bytes can be read again (null: nowhere). */
export function setFileSources(vault: string, jobId: string, sources: ReadonlyArray<{ seq: number; source: string | null }>): void {
  if (sources.length === 0) return;
  withStateDb(vault, (db) => {
    const stmt = db.prepare("UPDATE ingest_files SET source = ? WHERE job_id = ? AND seq = ?");
    inTransaction(db, () => {
      for (const s of sources) stmt.run(s.source, jobId, s.seq);
    });
  });
}

/** Every source a job's rows still point at, with their status (cleanup of kept upload copies). */
export function readFileSources(vault: string, jobId: string): Array<{ seq: number; status: FileStatus; source: string }> {
  return withStateDb(vault, (db) =>
    db
      .prepare("SELECT seq, status, source FROM ingest_files WHERE job_id = ? AND source IS NOT NULL ORDER BY seq")
      .all(jobId) as unknown as Array<{ seq: number; status: FileStatus; source: string }>,
  );
}

/** Hashes of every document some job already turned into pages. */
export function ingestedHashes(vault: string): Set<string> {
  return withStateDb(vault, (db) => {
    const rows = db.prepare("SELECT DISTINCT sha256 FROM ingest_files WHERE status = 'done' AND sha256 IS NOT NULL").all() as Array<{
      sha256: string;
    }>;
    return new Set(rows.map((r) => r.sha256));
  });
}

export interface CostRecord {
  runId: string | null;
  operation: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  usdEstimate: number;
  at: string;
}

export function recordCost(vault: string, cost: CostRecord): void {
  withStateDb(vault, (db) => {
    db.prepare("INSERT INTO costs (run_id, operation, model, tokens_in, tokens_out, usd_estimate, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      cost.runId,
      cost.operation,
      cost.model,
      cost.tokensIn,
      cost.tokensOut,
      cost.usdEstimate,
      cost.at,
    );
  });
}

export function readCosts(vault: string, runId: string): CostRecord[] {
  return withStateDb(vault, (db) =>
    (db.prepare("SELECT run_id, operation, model, tokens_in, tokens_out, usd_estimate, at FROM costs WHERE run_id = ? ORDER BY id").all(runId) as Array<{
      run_id: string | null;
      operation: string;
      model: string;
      tokens_in: number;
      tokens_out: number;
      usd_estimate: number;
      at: string;
    }>).map((r) => ({
      runId: r.run_id,
      operation: r.operation,
      model: r.model,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      usdEstimate: r.usd_estimate,
      at: r.at,
    })),
  );
}
