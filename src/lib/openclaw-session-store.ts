/**
 * The OpenClaw 2 session store, as ClawBox needs to see it.
 *
 * 2026.8 moved sessions and transcripts out of
 * `agents/<id>/sessions/sessions.json` + `<sessionId>.jsonl` and into one
 * SQLite database per agent, `agents/<id>/agent/openclaw-agent.sqlite`:
 *   - `session_nodes`   — one row per session key; `entry_json` is the same
 *                         entry object the old index held (modelOverride,
 *                         thinkingLevel, sessionId, …).
 *   - `transcript_events` — one row per transcript line; `event_json` is the
 *                         same JSON the old .jsonl files carried, ordered by
 *                         `seq` per `session_id`.
 *
 * Every reader/writer here decides per agent: a box the doctor has migrated
 * has the .sqlite file and is served from it; a box still on the legacy
 * files (mid-update, or a downgrade) keeps the old path — the callers all
 * fall back. Writes mirror what the gateway itself does closely enough for
 * the same sweeps the sessions.json writers ran (the gateway reads entries
 * back from the store on demand, exactly as it re-read the JSON file).
 *
 * node:sqlite on purpose: it ships with the Node 22 the box runs, needs no
 * native build on Tegra, and `DatabaseSync` keeps these sweeps as simple as
 * the readFile/writeFile they replace. Opened with a busy timeout so a
 * concurrently writing gateway makes us wait, not fail.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

type NodeSqlite = { DatabaseSync: typeof DatabaseSyncType };

/**
 * node:sqlite, resolved lazily at CALL time through `process.getBuiltinModule`
 * — not imported statically, and not through `createRequire`:
 *   - a static import crashed every jsdom suite whose import graph merely
 *     REACHES this file through openclaw-config (vite cannot bundle the
 *     builtin; it is newer than its externals list);
 *   - `createRequire(import.meta.url)("node:sqlite")` passed every vitest suite
 *     (vitest does not bundle) and was compiled by Turbopack into a stub that
 *     throws "Cannot find module 'node:sqlite': Unsupported external type Url
 *     for commonjs reference" — so on the box, where the builtin exists, every
 *     reader here failed its open() and silently fell back to legacy files
 *     OpenClaw 2 no longer writes. scripts/check-bundled-builtins.sh reads the
 *     built chunks in CI so that shape cannot come back.
 * `getBuiltinModule` is a plain runtime call the bundler leaves alone. It
 * arrived in Node 22.3 and node:sqlite in 22.5 (behind --experimental-sqlite
 * until 22.13), so a runtime missing the one is missing the other too — that
 * case throws here, with the version in the message, and every caller already
 * treats a failed open() as "not migrated".
 * Exported so the next reader of an OpenClaw .sqlite file shares this loader
 * instead of growing a third shape.
 */
export const requireNodeSqlite = (() => {
  let mod: NodeSqlite | null = null;
  return (): NodeSqlite => {
    if (mod) return mod;
    const loaded = process.getBuiltinModule?.("node:sqlite") as NodeSqlite | undefined;
    if (typeof loaded?.DatabaseSync !== "function") {
      throw new Error(
        `node:sqlite is not available on Node ${process.versions.node} (it needs Node >= 22.13, or 22.5+ with --experimental-sqlite)`,
      );
    }
    mod = loaded;
    return mod;
  };
})();

export const OPENCLAW_HOME_DEFAULT = process.env.CLAWBOX_OPENCLAW_HOME
  || process.env.OPENCLAW_HOME
  || path.join(process.env.HOME || "/home/clawbox", ".openclaw");
export const AGENTS_DIR_DEFAULT = path.join(OPENCLAW_HOME_DEFAULT, "agents");

/** The per-agent SQLite store, or null when this agent is not migrated. */
export function sessionStorePath(agentId: string, agentsDir: string = AGENTS_DIR_DEFAULT): string | null {
  const p = path.join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function open(dbPath: string, readOnly: boolean): DatabaseSyncType {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch {
    /* busy_timeout is advisory; a refusal changes nothing below */
  }
  return db;
}

/**
 * The transcript of one session, rebuilt as the newline-joined text the old
 * .jsonl file held, or null when the store or session is unknown. `identity`
 * changes whenever the transcript does — it is the cache key material the
 * legacy path derived from the file's stat.
 */
export function readTranscriptRaw(
  sessionKey: string,
  agentId: string,
  maxBytes: number,
  agentsDir: string = AGENTS_DIR_DEFAULT,
): { raw: string; identity: string } | null {
  const dbPath = sessionStorePath(agentId, agentsDir);
  if (!dbPath) return null;
  // open() sits INSIDE the guarded region: a corrupt header or permission
  // error must resolve to null (the legacy-file fallback), not escape as a
  // 500 from a chat-history read.
  let db: DatabaseSyncType;
  try {
    db = open(dbPath, true);
  } catch (err) {
    console.warn(`[session-store] could not open ${dbPath}:`, err);
    return null;
  }
  try {
    const node = db
      .prepare("SELECT current_session_id AS sid, updated_at AS updatedAt FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { sid?: string | null; updatedAt?: number | null } | undefined;
    const sid = typeof node?.sid === "string" && node.sid ? node.sid : null;
    if (!sid) return null;
    // Newest-first, stopping once the byte budget is met: a long-lived main
    // session holds megabytes of transcript, and the caller only ever reads
    // the tail — exactly what the legacy path did with a bounded file read.
    const rows = db
      .prepare("SELECT event_json AS line, seq FROM transcript_events WHERE session_id = ? ORDER BY seq DESC")
      .iterate(sid) as Iterable<{ line?: string | null; seq?: number | null }>;
    const lines: string[] = [];
    let bytes = 0;
    let lastSeq = -1;
    for (const row of rows) {
      if (typeof row.seq === "number" && row.seq > lastSeq) lastSeq = row.seq;
      if (typeof row.line !== "string" || !row.line) continue;
      lines.push(row.line);
      // A byte budget, counted in bytes: .length is UTF-16 units and a CJK
      // transcript would blow past maxBytes threefold on this hardware.
      bytes += Buffer.byteLength(row.line, "utf8") + 1;
      if (bytes > maxBytes) break;
    }
    lines.reverse();
    return {
      raw: lines.join("\n"),
      identity: `sqlite:${sid}:${lastSeq}:${node?.updatedAt ?? 0}`,
    };
  } catch (err) {
    console.warn(`[session-store] could not read transcript for ${sessionKey}:`, err);
    return null;
  } finally {
    db.close();
  }
}

/** Agent ids that have any session state at all (either backend). */
export function listAgentIds(agentsDir: string = AGENTS_DIR_DEFAULT): string[] {
  try {
    return fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The newest agent-store schema this sweep has been verified against —
 * OpenClaw 2026.8.1 stamps PRAGMA user_version 19 and its own maintenance
 * code hard-refuses anything newer, so ours does too.
 */
const KNOWN_SESSION_SCHEMA_VERSION = 19;

export interface SessionEntrySweepResult {
  /** Entries the mutator changed and that were written back. */
  updated: number;
  /** False when the sweep died (a contended or corrupt store): nothing can
   *  be said about what was written, and a caller must not treat the pass
   *  as done — record no backup, count no update. */
  ok: boolean;
  /** Present only when the store is from a newer OpenClaw generation. The
   *  caller must not reinterpret that refusal as permission to mutate a
   *  leftover legacy sessions.json for the same migrated agent. */
  unsupportedSchema?: number;
}

/**
 * Read every session entry in one agent's SQLite store, hand each to the
 * mutator, and write back the ones it changed. The mutator receives the
 * parsed `entry_json` object keyed by session key and returns true to
 * persist its mutation. One IMMEDIATE transaction per store: the sweep the
 * sessions.json writers did with a whole-file rewrite stays just as atomic.
 */
export function sweepSessionEntries(
  agentId: string,
  mutate: (sessionKey: string, entry: Record<string, unknown>) => boolean,
  agentsDir: string = AGENTS_DIR_DEFAULT,
): SessionEntrySweepResult | null {
  const dbPath = sessionStorePath(agentId, agentsDir);
  if (!dbPath) return null;
  let db: DatabaseSyncType;
  try {
    db = open(dbPath, false);
  } catch (err) {
    console.error(`[session-store] could not open ${dbPath} for sweep:`, err);
    return { updated: 0, ok: false };
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    let updated = 0;
    try {
      // Inspect the schema only AFTER taking the write reservation. Otherwise
      // another OpenClaw process can migrate v19 → v20 between this read and
      // BEGIN IMMEDIATE, leaving this old writer to mutate a schema it never
      // understood. OpenClaw's own store code refuses versions above its cap;
      // this sweep must be no braver. 2026.8.1 stamps user_version 19.
      const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      const schemaVersion = typeof versionRow?.user_version === "number" ? versionRow.user_version : 0;
      if (schemaVersion > KNOWN_SESSION_SCHEMA_VERSION) {
        console.error(
          `[session-store] ${dbPath} carries schema v${schemaVersion}, newer than the v${KNOWN_SESSION_SCHEMA_VERSION} this sweep knows; refusing to write`,
        );
        db.exec("ROLLBACK");
        return { updated: 0, ok: false, unsupportedSchema: schemaVersion };
      }

      const rows = db
        .prepare("SELECT session_key AS key, entry_json AS entry FROM session_nodes")
        .all() as Array<{ key?: string | null; entry?: string | null }>;
      const write = db.prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?");
      for (const row of rows) {
        if (typeof row.key !== "string" || typeof row.entry !== "string") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.entry);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const entry = parsed as Record<string, unknown>;
        if (!mutate(row.key, entry)) continue;
        write.run(JSON.stringify(entry), Date.now(), row.key);
        updated += 1;
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the connection close below releases the transaction anyway */
      }
      throw err;
    }
    return { updated, ok: true };
  } catch (err) {
    console.error(`[session-store] sweep failed for agent ${agentId}:`, err);
    return { updated: 0, ok: false };
  } finally {
    db.close();
  }
}
