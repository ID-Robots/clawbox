/**
 * Prime Radiant's state database: `<vault parent>/prime-radiant.sqlite`.
 *
 * Everything that is NOT knowledge lives here, out of the vault's git history:
 * the review queue, nightly runs, model costs, ingest jobs and the claim
 * registry's ledger. Slice 1 uses the ledger; the other tables are created now
 * so later slices add behaviour, not migrations.
 *
 * node:sqlite (the same driver Memory Shard's local index uses), opened per
 * call — every caller is short and synchronous, and a handle kept across
 * requests would be one more thing a second module copy disagrees about.
 *
 * SERVER ONLY.
 */

import fs from "fs";
import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "@/lib/openclaw-session-store";
import path from "@/lib/runtime-path";

export const STATE_DB_FILE = "prime-radiant.sqlite";
export const STATE_SCHEMA_VERSION = 8;

export function stateDbPathFor(vault: string): string {
  return path.join(path.dirname(vault), STATE_DB_FILE);
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS claim_registry (
  id          TEXT PRIMARY KEY,
  page        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  updated_at  TEXT NOT NULL,
  retired_at  TEXT
);
CREATE TABLE IF NOT EXISTS review_items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('contradiction', 'verified-touch', 'lint', 'opus')),
  claim_id     TEXT,
  pages        TEXT NOT NULL DEFAULT '[]',
  candidates   TEXT NOT NULL DEFAULT '[]',
  evidence     TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'later')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT
);
CREATE INDEX IF NOT EXISTS review_items_status ON review_items (status, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  branch       TEXT,
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  summary      TEXT
);
CREATE TABLE IF NOT EXISTS costs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT,
  operation     TEXT NOT NULL,
  model         TEXT NOT NULL,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  usd_estimate  REAL NOT NULL DEFAULT 0,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS costs_run ON costs (run_id);
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  folders      TEXT NOT NULL DEFAULT '[]',
  total        INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT
);
`;

/**
 * v2 — ingest: a job's phase and its tallies, and one row per file the job
 * saw. A file row keeps the SHA-256 of the bytes that were read, so a later
 * job skips a document already turned into pages (hash-first dedupe) and a
 * re-run of the same folder retries exactly the files that failed.
 */
const SCHEMA_V2 = `
ALTER TABLE ingest_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'folders';
ALTER TABLE ingest_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE ingest_jobs ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN duplicates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN commits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN usd_estimate REAL NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN updated_at TEXT;
ALTER TABLE ingest_jobs ADD COLUMN notes TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS ingest_jobs_created ON ingest_jobs (created_at);
CREATE TABLE IF NOT EXISTS ingest_files (
  job_id   TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  label    TEXT NOT NULL,
  sha256   TEXT,
  bytes    INTEGER NOT NULL DEFAULT 0,
  status   TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'duplicate', 'skipped')),
  pages    TEXT NOT NULL DEFAULT '[]',
  error    TEXT,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX IF NOT EXISTS ingest_files_sha ON ingest_files (sha256, status);
`;

/**
 * v3 — the retry queue and dead-letter list: a file row keeps where its bytes
 * can be read again (`source`, an absolute path on this box, never answered
 * by a route), how many rounds it was tried (`attempts`) and which later job
 * took it over (`retried_by`). A job row keeps the job it retries
 * (`retry_of`), how many of its files were put back on its own queue for a
 * second round (`requeued`) and how many are still dead letters
 * (`dead_letter`).
 */
const SCHEMA_V3 = `
ALTER TABLE ingest_jobs ADD COLUMN retry_of TEXT;
ALTER TABLE ingest_jobs ADD COLUMN requeued INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN dead_letter INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_files ADD COLUMN source TEXT;
ALTER TABLE ingest_files ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_files ADD COLUMN retried_by TEXT;
CREATE INDEX IF NOT EXISTS ingest_files_dead ON ingest_files (job_id, status, retried_by);
`;

/**
 * v4 — review and the nightly pass: a review item keeps a `dedupe_key` (the
 * same disputed pair or the same lint finding is ONE open item, however many
 * nights find it) and the run that raised it; a run keeps its trigger and its
 * spend. `claim_embeddings` caches a claim's vector by the hash of its
 * (redacted) text and the embedder's identity, so a nightly pass embeds only
 * what changed; `judged_pairs` remembers the judge's verdict on a pair of
 * claim texts, so the same pair is never paid for twice.
 */
const SCHEMA_V4 = `
ALTER TABLE review_items ADD COLUMN dedupe_key TEXT;
ALTER TABLE review_items ADD COLUMN run_id TEXT;
CREATE INDEX IF NOT EXISTS review_items_dedupe ON review_items (dedupe_key, status);
ALTER TABLE runs ADD COLUMN trigger_kind TEXT;
ALTER TABLE runs ADD COLUMN usd_estimate REAL NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
CREATE TABLE IF NOT EXISTS claim_embeddings (
  claim_id   TEXT NOT NULL,
  text_hash  TEXT NOT NULL,
  identity   TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (claim_id, identity)
);
CREATE TABLE IF NOT EXISTS judged_pairs (
  pair_hash  TEXT PRIMARY KEY,
  verdict    TEXT NOT NULL,
  why        TEXT,
  at         TEXT NOT NULL
);
`;

/**
 * v5 — the contradiction pass's carry-over: `deferred_claims` holds every
 * claim one of whose pairs a pass could not judge (a judge call that failed,
 * an embedder that could not answer, a pass stopped or over its cap), so the
 * next pass compares it again whatever that night changed; a row goes once
 * the claim's pairs are judged or the claim is gone. `pass_state` keeps small
 * named facts about the passes — `full_comparison` is the last time a pass
 * compared EVERY claim and judged every pair it found.
 */
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS deferred_claims (
  claim_id  TEXT PRIMARY KEY,
  page      TEXT NOT NULL,
  reason    TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pass_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL,
  at     TEXT NOT NULL
);
`;

/**
 * v6 — what a job left out and why: `skips` is a JSON object of counts by
 * reason (code projects and excluded folders not gone into; boilerplate,
 * temporary, machine-generated, too-large and other-kind files), so nothing a
 * job drops is dropped silently.
 */
const SCHEMA_V6 = `
ALTER TABLE ingest_jobs ADD COLUMN skips TEXT NOT NULL DEFAULT '{}';
`;

/**
 * v7 — what a cost row's dollar figure IS: `estimate` (priced from the rates in
 * force, every row before v7) or `subscription` (a call the owner's Claude
 * subscription answered: its tokens are real, its marginal cost is $0).
 */
const SCHEMA_V7 = `
ALTER TABLE costs ADD COLUMN basis TEXT NOT NULL DEFAULT 'estimate';
`;

/**
 * v8 — what an owner-verified claim left behind: `stale_claims` holds every
 * claim the judge found against a claim the owner verified. The verified one
 * wins, so the other is no question for the owner but a lint warning on its
 * own page (lint.ts `stale-against-verified`), until it is rewritten or gone.
 */
const SCHEMA_V8 = `
CREATE TABLE IF NOT EXISTS stale_claims (
  claim_id           TEXT NOT NULL,
  page               TEXT NOT NULL,
  verified_claim_id  TEXT NOT NULL,
  verified_page      TEXT NOT NULL,
  why                TEXT,
  at                 TEXT NOT NULL,
  PRIMARY KEY (claim_id, verified_claim_id)
);
`;

/**
 * Run `fn` in one transaction. A failed ROLLBACK (SQLite may already have
 * ended the transaction after an I/O or disk-full error) is logged and never
 * replaces the error that caused it.
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErr) {
      console.warn(`[prime-radiant] rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : "error"}`);
    }
    throw err;
  }
}

/** Open (creating and migrating as needed) the state database for `vault`. Caller closes it. */
export function openStateDb(vault: string): DatabaseSync {
  const file = stateDbPathFor(vault);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = openSqlite(file, false);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const version = row?.user_version ?? 0;
    const steps: Array<[number, string]> = [
      [1, SCHEMA_V1],
      [2, SCHEMA_V2],
      [3, SCHEMA_V3],
      [4, SCHEMA_V4],
      [5, SCHEMA_V5],
      [6, SCHEMA_V6],
      [7, SCHEMA_V7],
      [8, SCHEMA_V8],
    ];
    for (const [target, sql] of steps) {
      if (version >= target) continue;
      runInTransaction(db, () => {
        db.exec(sql);
        db.exec(`PRAGMA user_version = ${target}`);
      });
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      /* already failing */
    }
    throw err;
  }
  return db;
}

/** Whether the state database exists. A read route asks this first, so it never creates one. */
export function stateDbExists(vault: string): boolean {
  return fs.existsSync(stateDbPathFor(vault));
}

export function withStateDb<T>(vault: string, fn: (db: DatabaseSync) => T): T {
  const db = openStateDb(vault);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Every id the ledger has seen retired. */
export function readRetiredLedger(vault: string): string[] {
  if (!fs.existsSync(stateDbPathFor(vault))) return [];
  return withStateDb(vault, (db) =>
    (db.prepare("SELECT id FROM claim_registry WHERE state = 'retired' ORDER BY id").all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
}

/** Record retirements. A retired id stays retired whatever is recorded later. */
export function recordRetired(vault: string, ids: ReadonlyArray<{ id: string; page: string }>, at: string = new Date().toISOString()): void {
  if (ids.length === 0) return;
  withStateDb(vault, (db) => {
    const stmt = db.prepare(
      `INSERT INTO claim_registry (id, page, state, updated_at, retired_at) VALUES (?, ?, 'retired', ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = 'retired', updated_at = excluded.updated_at,
         retired_at = COALESCE(claim_registry.retired_at, excluded.retired_at)`,
    );
    runInTransaction(db, () => {
      for (const { id, page } of ids) stmt.run(id, page, at, at);
    });
  });
}

/**
 * Record the active claims the vault holds now (id -> page, updatedAt). A row
 * already retired is never brought back.
 */
export function syncActiveClaims(vault: string, claims: ReadonlyArray<{ id: string; page: string; updatedAt: string }>): void {
  withStateDb(vault, (db) => {
    const stmt = db.prepare(
      `INSERT INTO claim_registry (id, page, state, updated_at) VALUES (?, ?, 'active', ?)
       ON CONFLICT(id) DO UPDATE SET page = excluded.page, updated_at = excluded.updated_at
       WHERE claim_registry.state = 'active'`,
    );
    runInTransaction(db, () => {
      for (const c of claims) stmt.run(c.id, c.page, c.updatedAt);
    });
  });
}
