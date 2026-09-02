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
 * legacy files), which is the same answer the gateway would give. The one
 * writer, `clearPairingState`, reports such a store instead of yielding null:
 * a reset that silently did nothing would leave the approvals in force behind
 * a success.
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
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { OPENCLAW_HOME_DEFAULT, openSqlite } from "./openclaw-session-store";

/**
 * The state directory the way OpenClaw resolves it (`resolveStateDir`): an
 * `OPENCLAW_STATE_DIR` override is trimmed, a leading `~` is the user's home
 * and a relative path is taken from the cwd; without one it is the OpenClaw
 * home. A literal `~/...` here would stat a path the gateway never writes.
 */
function stateDir(home: string): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (!override) return home;
  return path.resolve(override.replace(/^~(?=$|[\\/])/, () => process.env.HOME || os.homedir()));
}

/** The gateway-wide SQLite store, or null when this OpenClaw has not migrated to it. */
export function statePath(home: string = OPENCLAW_HOME_DEFAULT): string | null {
  const p = path.join(stateDir(home), "state", "openclaw.sqlite");
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * The last failure logged per operation. The desktop polls the pairing store
 * every 20 s, so a store that stays unreadable (schema drift, corruption)
 * would otherwise repeat the same line ~4000 times a day and bury the one
 * that matters; a failure is logged when it first appears or changes, and the
 * slate is wiped by the next success so a relapse is logged again.
 */
const lastFailure = new Map<string, string>();

function logOnce(readOnly: boolean, what: string, line: string, err: unknown): void {
  const message = `${line}: ${err instanceof Error ? err.message : String(err)}`;
  if (lastFailure.get(what) === message) return;
  lastFailure.set(what, message);
  (readOnly ? console.warn : console.error)(`[state-store] ${line}:`, err);
}

/**
 * Run `fn` against the store at `dbPath`; null when it cannot be opened or
 * queried (logged — a corrupt or locked store must never escape as a 500: a
 * reader falls through to its fallback, a writer reports the failure).
 */
function withOpenStore<T>(
  dbPath: string,
  readOnly: boolean,
  what: string,
  fn: (db: DatabaseSyncType) => T,
): T | null {
  let db: DatabaseSyncType;
  try {
    db = openSqlite(dbPath, readOnly);
  } catch (err) {
    logOnce(readOnly, what, `could not open ${dbPath} for ${what}`, err);
    return null;
  }
  try {
    const result = fn(db);
    lastFailure.delete(what);
    return result;
  } catch (err) {
    logOnce(readOnly, what, `${what} failed`, err);
    return null;
  } finally {
    db.close();
  }
}

/** Run `fn` against the state store; null when there is no store, or when it cannot be used. */
function withStateDb<T>(readOnly: boolean, what: string, fn: (db: DatabaseSyncType) => T): T | null {
  const dbPath = statePath();
  return dbPath ? withOpenStore(dbPath, readOnly, what, fn) : null;
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
 * True when the account's rows are gone: cleared, or there is no v2 store to
 * hold them. False when a store exists and could not be cleared (logged): a
 * locked, corrupt or read-only store keeps every approved sender, so the
 * caller has to report that rather than carry on as if the reset happened.
 */
export function clearPairingState(channel: string, account = "default"): boolean {
  const dbPath = statePath();
  if (!dbPath) return true;
  const key = accountKey(account);
  const done = withOpenStore(dbPath, false, `${channel} pairing reset`, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM channel_pairing_allow_entries WHERE channel_key = ? AND account_id = ?").run(channel, key);
      db.prepare("DELETE FROM channel_pairing_requests WHERE channel_key = ? AND account_id = ?").run(channel, key);
      db.exec("COMMIT");
      return true;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the connection close releases the transaction anyway */
      }
      throw err;
    }
  });
  return done === true;
}
