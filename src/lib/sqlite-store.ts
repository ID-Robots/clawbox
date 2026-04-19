// Key-value store for desktop state that should persist server-side
// (dismissed update-notification fingerprints, chat model selection,
// browser enable toggle).
//
// The production server now runs under Node (see config/clawbox-setup.service
// — Bun's WebSocket client is incompatible with Playwright CDP), so
// `bun:sqlite` isn't available. When the Bun builtin can't be resolved the
// store falls back transparently to the JSON-backed config-store. All
// callers use the simple get/set/delete API, so the backend swap is
// invisible to them.

import path from "path";
import fs from "fs";
import { get as configGet, set as configSet } from "./config-store";

// Prefix for fallback entries so they don't collide with other pref: keys.
const FALLBACK_PREFIX = "sqlite-kv:";

const DB_PATH = path.join(
  process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox",
  "data",
  "clawbox.db",
);

// Minimal structural types — we don't depend on bun-types directly because
// the file is also walked by Vitest under Node, where bun:sqlite types are
// unavailable. Only the methods we actually call are typed.
interface BunSqliteStatement<TRow = unknown> {
  get(...params: unknown[]): TRow | null;
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): TRow[];
}
interface BunSqliteDatabase {
  query<TRow = unknown>(sql: string): BunSqliteStatement<TRow>;
  exec(sql: string): void;
}
type BunSqliteModule = {
  Database: new (path: string, options?: { create?: boolean }) => BunSqliteDatabase;
};

let dbPromise: Promise<BunSqliteDatabase | null> | null = null;
let fallbackLogged = false;

async function getDb(): Promise<BunSqliteDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    // Only wrap the indirect-eval import in try/catch — a genuine SQLite
    // error (corrupt DB, PRAGMA failure, missing table) should propagate
    // and surface rather than silently swallowing writes to JSON.
    let sqlite: BunSqliteModule;
    try {
      sqlite = (await (0, eval)('import("bun:sqlite")')) as BunSqliteModule;
    } catch {
      if (!fallbackLogged) {
        fallbackLogged = true;
        console.info("[sqlite-store] bun:sqlite unavailable (running under Node); falling back to JSON config-store");
      }
      return null;
    }
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const handle = new sqlite.Database(DB_PATH, { create: true });
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    return handle;
  })();
  return dbPromise;
}

export async function sqliteGet(key: string): Promise<string | null> {
  const db = await getDb();
  if (db) {
    const row = db
      .query<{ value: string }>("SELECT value FROM kv WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }
  const val = await configGet(`${FALLBACK_PREFIX}${key}`);
  return typeof val === "string" ? val : null;
}

export async function sqliteSet(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (db) {
    db.query(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value, Date.now());
    return;
  }
  await configSet(`${FALLBACK_PREFIX}${key}`, value);
}

export async function sqliteDelete(key: string): Promise<void> {
  const db = await getDb();
  if (db) {
    db.query("DELETE FROM kv WHERE key = ?").run(key);
    return;
  }
  await configSet(`${FALLBACK_PREFIX}${key}`, undefined);
}
