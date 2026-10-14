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
export const STATE_SCHEMA_VERSION = 1;

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

/** Open (creating and migrating as needed) the state database for `vault`. Caller closes it. */
export function openStateDb(vault: string): DatabaseSync {
  const file = stateDbPathFor(vault);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = openSqlite(file, false);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const version = row?.user_version ?? 0;
    if (version < 1) {
      db.exec("BEGIN");
      db.exec(SCHEMA_V1);
      db.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION}`);
      db.exec("COMMIT");
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
    db.exec("BEGIN");
    try {
      for (const { id, page } of ids) stmt.run(id, page, at, at);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
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
    db.exec("BEGIN");
    try {
      for (const c of claims) stmt.run(c.id, c.page, c.updatedAt);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
}
