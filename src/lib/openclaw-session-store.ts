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
 * Every reader here decides per agent: a box the doctor has migrated has the
 * .sqlite file and is served from it; a box still on the legacy files
 * (mid-update, or a downgrade) keeps the old path — the callers all fall back.
 *
 * READ-ONLY for the agent store, without exception. The core owns
 * `session_nodes` with triggers:
 *
 *   CREATE TRIGGER session_nodes_entry_valid_after_entry_update
 *   AFTER UPDATE OF entry_json ON session_nodes
 *   BEGIN UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key; END;
 *
 * and its scan throws SessionCanonicalKeyMigrationRequiredError for any row
 * whose `entry_valid` is not 1 — the gateway then refuses to start until
 * `openclaw doctor --fix`. Only the core's own write path re-validates a row,
 * so an external UPDATE of `entry_json` is never safe, whatever the schema
 * version says (2026.8.1 stamps 19; the sweep this module used to carry
 * checked exactly that and still bricked chat on every model switch — finding
 * M-03). Anything that must change an entry goes through the gateway's own
 * API: see openclaw-session-model.ts.
 *
 * node:sqlite on purpose: it ships with the Node 22 the box runs, needs no
 * native build on Tegra, and `DatabaseSync` keeps these reads as simple as
 * the readFile they replace. Opened with a busy timeout so a concurrently
 * writing gateway makes us wait, not fail.
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

/**
 * Open one of OpenClaw's SQLite stores with the busy timeout every reader and
 * writer relies on. Shared with openclaw-state-store.ts, which serves the
 * gateway-wide `state/openclaw.sqlite` the same way (and may write there —
 * that store has no validity trigger). Inside THIS module every call passes
 * `readOnly: true`; see the module comment for why there is no other mode
 * for the agent store.
 */
export function openSqlite(dbPath: string, readOnly: boolean): DatabaseSyncType {
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
 * {@link open}, with a failed open resolved to null. A corrupt header or a
 * permission error must reach the caller as "no store" — the legacy-file
 * fallback — not escape as a 500 from a chat read.
 */
function openOrNull(dbPath: string): DatabaseSyncType | null {
  try {
    return openSqlite(dbPath, true);
  } catch (err) {
    console.warn(`[session-store] could not open ${dbPath}:`, err);
    return null;
  }
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
  const db = openOrNull(dbPath);
  if (!db) return null;
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

export interface SessionEntryRow {
  key: string;
  /** The parsed `entry_json` object (modelOverride, thinkingLevel, sessionId, …). */
  entry: Record<string, unknown>;
}

/**
 * Every session entry in one agent's SQLite store, parsed, or null when the
 * agent has no store or it cannot be read (logged). Rows whose `entry_json`
 * is not a JSON object are left out — the core keeps `{}` placeholder rows
 * for a retention window, and they describe no session.
 */
export function readSessionEntries(
  agentId: string,
  agentsDir: string = AGENTS_DIR_DEFAULT,
): SessionEntryRow[] | null {
  const dbPath = sessionStorePath(agentId, agentsDir);
  if (!dbPath) return null;
  const db = openOrNull(dbPath);
  if (!db) return null;
  try {
    const rows = db
      .prepare("SELECT session_key AS key, entry_json AS entry FROM session_nodes ORDER BY session_key")
      .all() as Array<{ key?: string | null; entry?: string | null }>;
    const entries: SessionEntryRow[] = [];
    for (const row of rows) {
      if (typeof row.key !== "string" || typeof row.entry !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.entry);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entries.push({ key: row.key, entry: parsed as Record<string, unknown> });
    }
    return entries;
  } catch (err) {
    console.warn(`[session-store] could not read sessions of agent ${agentId}:`, err);
    return null;
  } finally {
    db.close();
  }
}
