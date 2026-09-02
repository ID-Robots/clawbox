/**
 * OpenClaw 2's gateway-wide state database, as ClawBox needs to see it.
 *
 * 2026.8 moved the channel pairing store out of
 * `credentials/<channel>-<account>-allowFrom.json` + `<channel>-pairing.json`
 * and into `state/openclaw.sqlite`, shared by every channel:
 *   - `channel_pairing_allow_entries` — one row per approved sender,
 *     `(channel_key, account_id, entry)`, ordered by `sort_order`.
 *   - `channel_pairing_requests`      — one row per pending pairing code, with
 *     the sender's Telegram name in `meta_json`.
 * The gateway reads ONLY this database once it exists; the legacy JSON files
 * are a one-shot migration source. So every reader here answers from the
 * database whenever the file is present and hands back null only when it is
 * not (a v1 box, a Hermes-only box) — the callers keep their legacy-file path
 * for that case. A store that exists but cannot be opened or read also yields
 * null: the caller's fallback then finds nothing (the migration emptied the
 * legacy files), which is the same answer the gateway would give.
 *
 * The database is never created here: an absent file means an OpenClaw that
 * has not migrated yet, and creating an empty store would make the doctor
 * skip the migration that carries the approvals over.
 *
 * OpenClaw resolves the state dir from `OPENCLAW_STATE_DIR`, falling back to
 * its home; the path here follows the same rule so this reads the store the
 * gateway actually writes.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { OPENCLAW_HOME_DEFAULT, openSqlite } from "./openclaw-session-store";

/** The gateway-wide SQLite store, or null when this OpenClaw has not migrated to it. */
export function statePath(home: string = OPENCLAW_HOME_DEFAULT): string | null {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || home;
  const p = path.join(stateDir, "state", "openclaw.sqlite");
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` against the state store; null when there is no store, or when it
 * cannot be opened or queried (logged — a corrupt or locked store must fall
 * through to the caller's fallback, never escape as a 500).
 */
function withStateDb<T>(readOnly: boolean, what: string, fn: (db: DatabaseSyncType) => T): T | null {
  const dbPath = statePath();
  if (!dbPath) return null;
  const log = readOnly ? console.warn : console.error;
  let db: DatabaseSyncType;
  try {
    db = openSqlite(dbPath, readOnly);
  } catch (err) {
    log(`[state-store] could not open ${dbPath} for ${what}:`, err);
    return null;
  }
  try {
    return fn(db);
  } catch (err) {
    log(`[state-store] ${what} failed:`, err);
    return null;
  } finally {
    db.close();
  }
}

/** OpenClaw stores account ids lowercased, and the default account as "default". */
function accountKey(account: string): string {
  return account.trim().toLowerCase() || "default";
}

/**
 * Approved sender ids for one channel account, in the order OpenClaw keeps
 * them. Null when there is no v2 store to read.
 */
export function readPairingAllowEntries(channel: string, account = "default"): string[] | null {
  return withStateDb(true, `${channel} allowlist read`, (db) => {
    const rows = db
      .prepare(
        "SELECT entry FROM channel_pairing_allow_entries WHERE channel_key = ? AND account_id = ? ORDER BY sort_order, entry",
      )
      .all(channel, accountKey(account)) as Array<{ entry?: unknown }>;
    return rows.map((r) => r.entry).filter((e): e is string => typeof e === "string" && e.length > 0);
  });
}

/** The sender metadata OpenClaw attached to a request, or undefined when absent or malformed. */
function parseMeta(metaJson: string | null): Record<string, unknown> | undefined {
  if (typeof metaJson !== "string") return undefined;
  try {
    const meta: unknown = JSON.parse(metaJson);
    return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // a malformed meta only costs the display name
  }
}

/** One pending pairing request, in the shape the legacy `<channel>-pairing.json` entries had. */
export interface PairingRequestRow {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, unknown>;
}

/**
 * Pending pairing requests for one channel account, oldest first. Null when
 * there is no v2 store to read.
 */
export function readPairingRequests(channel: string, account = "default"): PairingRequestRow[] | null {
  return withStateDb(true, `${channel} pairing-request read`, (db) => {
    const rows = db
      .prepare(
        "SELECT request_id AS id, code, created_at AS createdAt, last_seen_at AS lastSeenAt, meta_json AS metaJson " +
          "FROM channel_pairing_requests WHERE channel_key = ? AND account_id = ? ORDER BY created_at, request_id",
      )
      .all(channel, accountKey(account)) as Array<{
      id: string;
      code: string;
      createdAt: string;
      lastSeenAt: string;
      metaJson: string | null;
    }>;
    // The table is STRICT with every column but meta_json NOT NULL, so the
    // only shape to defend is the one the caller matches on.
    const requests: PairingRequestRow[] = [];
    for (const { metaJson, ...row } of rows) {
      if (typeof row.id !== "string" || typeof row.code !== "string") continue;
      const meta = parseMeta(metaJson);
      requests.push(meta ? { ...row, meta } : row);
    }
    return requests;
  });
}

/**
 * Drop one channel account's approvals and pending requests — the two tables
 * OpenClaw itself always rewrites together — in one IMMEDIATE transaction.
 * A no-op without a v2 store; a failed write is logged, not thrown.
 */
export function clearPairingState(channel: string, account = "default"): void {
  const key = accountKey(account);
  withStateDb(false, `${channel} pairing reset`, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM channel_pairing_allow_entries WHERE channel_key = ? AND account_id = ?").run(channel, key);
      db.prepare("DELETE FROM channel_pairing_requests WHERE channel_key = ? AND account_id = ?").run(channel, key);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the connection close releases the transaction anyway */
      }
      throw err;
    }
  });
}
