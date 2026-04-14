// Generic key-value store backed by SQLite via bun:sqlite. Used for desktop
// state that should persist server-side (across browsers, devices, and
// incognito sessions) — e.g. dismissed update-notification fingerprints.
//
// `bun:sqlite` is a Bun-only builtin and is not understood by Next.js's
// Turbopack/Webpack bundler. We dodge static analysis with an indirect eval
// so the import is only resolved at runtime, where the production server
// runs under Bun (`bun run production-server.js`).

import path from "path";
import fs from "fs";
import { DATA_DIR } from "./runtime-paths";

const DB_PATH = path.join(DATA_DIR, "clawbox.db");

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

let dbPromise: Promise<BunSqliteDatabase> | null = null;

async function getDb(): Promise<BunSqliteDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    // Indirect eval keeps the bundler from trying to resolve "bun:sqlite"
    // at build time. At runtime (under Bun) this becomes a normal dynamic
    // import of the builtin module.
    const sqlite = (await (0, eval)('import("bun:sqlite")')) as BunSqliteModule;
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const handle = new sqlite.Database(DB_PATH, { create: true });
    // WAL gives concurrent reads while a write is in progress; matters
    // because multiple desktop tabs may poll these endpoints in parallel.
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
  const row = db
    .query<{ value: string }>("SELECT value FROM kv WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export async function sqliteSet(key: string, value: string): Promise<void> {
  const db = await getDb();
  db.query(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, Date.now());
}

export async function sqliteDelete(key: string): Promise<void> {
  const db = await getDb();
  db.query("DELETE FROM kv WHERE key = ?").run(key);
}
