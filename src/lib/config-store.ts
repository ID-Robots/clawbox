import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
export const DATA_DIR = path.join(CONFIG_ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "clawbox.db");

// Migrate old JSON config if it exists
const JSON_CONFIG_PATH = path.join(DATA_DIR, "config.json");

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Migrate from JSON if old config exists and DB is empty
  try {
    const count = _db.prepare("SELECT COUNT(*) as c FROM config").get() as { c: number };
    if (count.c === 0 && fs.existsSync(JSON_CONFIG_PATH)) {
      const raw = fs.readFileSync(JSON_CONFIG_PATH, "utf-8");
      const json = JSON.parse(raw);
      const insert = _db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
      const tx = _db.transaction(() => {
        for (const [key, value] of Object.entries(json)) {
          insert.run(key, JSON.stringify(value));
        }
      });
      tx();
      // Rename old file so we don't migrate again
      fs.renameSync(JSON_CONFIG_PATH, JSON_CONFIG_PATH + ".migrated");
      console.log("[config-store] Migrated JSON config to SQLite");
    }
  } catch (err) {
    console.warn("[config-store] JSON migration failed:", err);
  }

  return _db;
}

// Prepared statements (lazy-initialized)
let _stmtGet: Database.Statement | null = null;
let _stmtSet: Database.Statement | null = null;
let _stmtDel: Database.Statement | null = null;
let _stmtAll: Database.Statement | null = null;

function stmtGet() { return _stmtGet ??= getDb().prepare("SELECT value FROM config WHERE key = ?"); }
function stmtSet() { return _stmtSet ??= getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)"); }
function stmtDel() { return _stmtDel ??= getDb().prepare("DELETE FROM config WHERE key = ?"); }
function stmtAll() { return _stmtAll ??= getDb().prepare("SELECT key, value FROM config"); }

export async function get(key: string): Promise<unknown> {
  const row = stmtGet().get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export async function set(key: string, value: unknown): Promise<void> {
  if (value === undefined) {
    stmtDel().run(key);
  } else {
    stmtSet().run(key, JSON.stringify(value));
  }
}

export async function setMany(entries: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) {
        stmtDel().run(key);
      } else {
        stmtSet().run(key, JSON.stringify(value));
      }
    }
  });
  tx();
}

export async function getAll(): Promise<Record<string, unknown>> {
  const rows = stmtAll().all() as { key: string; value: string }[];
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }
  return result;
}
