import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import zlib from "zlib";
import {
  STOP_AFTER_OLD_ROWS,
  assistantCall,
  buildReport,
  formatReport,
  gatewayParams,
  main,
  normalizeUsage,
  openReadOnly,
  parseArgs,
  reportFromDatabases,
  reportFromGateway,
  resolveStateDir,
  usageCountedSessionId,
  usageWindow,
} from "../../../scripts/openclaw-token-usage.mjs";

// vite cannot bundle the builtin, so the fixtures reach node:sqlite lazily
// (see openclaw-session-store.test.ts).
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const zstdCompress = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;

// 2026-10-22 12:00 UTC; a 7-day window is 2026-10-16 .. 2026-10-22.
const NOW = Date.UTC(2026, 9, 22, 12);
const IN = Date.UTC(2026, 9, 20, 9);
const BEFORE = Date.UTC(2026, 9, 10, 9);

// The tables this report reads, as the pinned core (agent schema 24) declares them.
const SCHEMA = `
CREATE TABLE session_windows (
  session_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  transcript_updated_at INTEGER DEFAULT NULL
) STRICT;
CREATE TABLE transcript_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT,
  created_at INTEGER NOT NULL,
  event_zstd BLOB,
  event_utf8_bytes INTEGER CHECK (event_utf8_bytes IS NULL OR event_utf8_bytes >= 0),
  navigation_json TEXT,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE,
  CHECK ((event_json IS NOT NULL AND event_zstd IS NULL) OR (event_json IS NULL AND event_zstd IS NOT NULL AND event_utf8_bytes IS NOT NULL AND navigation_json IS NOT NULL))
) STRICT;
CREATE TABLE session_transcript_cold_archives (
  session_id TEXT NOT NULL PRIMARY KEY,
  generation TEXT NOT NULL,
  archive_name TEXT NOT NULL UNIQUE,
  archive_sha256 TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  raw_bytes INTEGER NOT NULL,
  archive_bytes INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('file', 'sqlite')),
  archive_blob BLOB
) STRICT;`;

interface Call {
  ts: number;
  model?: string;
  provider?: string;
  usage: Record<string, unknown>;
  responseId?: string;
  packed?: boolean;
  createdAt?: number;
}

let tmp: string;
let stateDir: string;
const open: Array<{ close(): void }> = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "clawbox-tokens-"));
  stateDir = path.join(tmp, ".openclaw");
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(tmp, { recursive: true, force: true });
});

let ids = 0;
const assistantEvent = (c: Call) => ({
  type: "message",
  id: `e${++ids}`,
  parentId: null,
  timestamp: new Date(c.ts).toISOString(),
  message: {
    role: "assistant",
    content: [{ type: "text", text: "x".repeat(c.packed ? 2000 : 10) }],
    provider: c.provider ?? "anthropic",
    model: c.model ?? "claude-sonnet-4-6",
    ...(c.responseId ? { responseId: c.responseId } : {}),
    usage: c.usage,
    timestamp: c.ts,
  },
});

/** An agent database with the given sessions; returns its path. */
function agentDb(agentId: string, sessions: Record<string, Array<Call | "user" | "tool">>, opts: { wal?: boolean } = {}) {
  const dir = path.join(stateDir, "agents", agentId, "agent");
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "openclaw-agent.sqlite");
  const db = new DatabaseSync(dbPath);
  open.push(db);
  if (opts.wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const win = db.prepare("INSERT INTO session_windows VALUES (?, ?, ?, ?, ?)");
  const plain = db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)");
  const packed = db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json) VALUES (?, ?, NULL, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  for (const [sessionId, events] of Object.entries(sessions)) {
    // The core's watermarks: the last time the window's transcript was written.
    const last = Math.max(0, ...events.map((e) => (typeof e === "string" ? IN : e.createdAt ?? e.ts)));
    win.run(sessionId, `agent:${agentId}:${sessionId}`, Math.min(last, IN), last, events.length ? last : null);
    events.forEach((e, i) => {
      const seq = i + 1;
      if (e === "user" || e === "tool") {
        const role = e === "user" ? "user" : "toolResult";
        plain.run(sessionId, seq, JSON.stringify({ type: "message", id: `e${++ids}`, message: { role, content: "assistant said" } }), IN);
        return;
      }
      const text = JSON.stringify(assistantEvent(e));
      if (e.packed) {
        const nav = { version: 1, report: { kind: "canonical", hasParentId: true, entry: { type: "message", id: "x" } } };
        packed.run(sessionId, seq, e.createdAt ?? e.ts, zstdCompress!(Buffer.from(text)), Buffer.byteLength(text), JSON.stringify(nav));
      } else {
        plain.run(sessionId, seq, text, e.createdAt ?? e.ts);
      }
    });
  }
  db.exec("COMMIT");
  return { db, dbPath };
}

const anthropic = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

/**
 * Move a window to cold storage the way the pinned core's cold-storage worker
 * does (prepareSessionColdArchiveInWorker, OpenClaw 2026.10.3): its transcript
 * becomes zstd of JSON lines — a version-1 `header`, one `event` record per
 * row with the event as a JSON STRING, then the `identity`, `active`, `index`
 * and `fts` records — published as `<sha256>.jsonl.zst` under
 * `agents/<id>/sessions/cold/` (`storage: "file"`) or embedded in the row
 * (`"sqlite"`, as a database snapshot carries it), and the window's
 * `transcript_events` rows are gone.
 */
function coldArchive(
  target: ReturnType<typeof agentDb>,
  sessionId: string,
  events: Array<Call | "user">,
  { archivedAt, storage }: { archivedAt: number; storage: "file" | "sqlite" },
) {
  const rows = events.map((e, i) => {
    const event = e === "user"
      ? { type: "message", id: `e${++ids}`, parentId: null, message: { role: "user", content: "ask the assistant" } }
      : assistantEvent(e);
    return { seq: i + 1, event_json: JSON.stringify(event), created_at: e === "user" ? IN : e.createdAt ?? e.ts };
  });
  const last = rows[rows.length - 1];
  const generation = `generation-${sessionId}`;
  const records = [
    { kind: "header", version: 1, sessionId, generation },
    ...rows.map((row) => ({ kind: "event", row })),
    ...rows.map((row) => ({
      kind: "identity",
      row: { event_id: JSON.parse(row.event_json).id, seq: row.seq, event_type: "message", parent_id: null, message_idempotency_key: null, created_at: row.created_at },
    })),
    ...rows.map((row, i) => ({ kind: "active", row: { active_position: i, event_seq: row.seq, message_position: i, context_eligible: 1 } })),
    {
      kind: "index",
      row: { indexed_seq: last.seq, leaf_event_id: JSON.parse(last.event_json).id, needs_rebuild: 0, active_event_count: rows.length, active_message_count: rows.length, updated_at: last.created_at },
    },
    // The search index's own copy: role "assistant" in the clear, not a call.
    { kind: "fts", row: { text: "x", message_id: JSON.parse(last.event_json).id, role: "assistant", timestamp: last.created_at } },
  ];
  const bytes = zstdCompress!(Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join("")));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = `${sha256}.jsonl.zst`;
  if (storage === "file") {
    const cold = path.join(path.dirname(path.dirname(target.dbPath)), "sessions", "cold");
    mkdirSync(cold, { recursive: true });
    writeFileSync(path.join(cold, name), bytes);
  }
  const rawBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.event_json), 0) + rows.length - 1;
  target.db.prepare("INSERT INTO session_transcript_cold_archives VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sessionId, generation, name, sha256, rows.length, rawBytes, bytes.length, last.seq, archivedAt, storage, storage === "sqlite" ? bytes : null);
  target.db.prepare("INSERT INTO session_windows VALUES (?, ?, ?, ?, ?)")
    .run(sessionId, `agent:main:${sessionId}`, rows[0].created_at, last.created_at, last.created_at);
  return name;
}

/**
 * The transcript a reset or delete leaves beside the database the way the
 * pinned core writes it (its session artifacts module, OpenClaw 2026.10.3 and
 * 2026.10.6): the session's plain transcript lines, zstd-compressed when the
 * name ends in `.zst`, at `agents/<id>/sessions/<name>`.
 */
function transcriptArchive(agentId: string, name: string, events: Array<Call | "user">, { mtimeMs }: { mtimeMs?: number } = {}) {
  const dir = path.join(stateDir, "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 4, id: name.split(".")[0], timestamp: new Date(IN).toISOString() }),
    ...events.map((e) => JSON.stringify(e === "user"
      ? { type: "message", id: `e${++ids}`, parentId: null, message: { role: "user", content: "ask the assistant" } }
      : assistantEvent(e))),
  ];
  const text = Buffer.from(`${lines.join("\n")}\n`);
  const file = path.join(dir, name);
  writeFileSync(file, name.endsWith(".zst") ? zstdCompress!(text) : text);
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe("arguments and window", () => {
  it("defaults to every agent over the last 7 days from the best source", () => {
    expect(parseArgs([])).toMatchObject({ days: 7, agent: null, json: false, source: "auto" });
    expect(parseArgs(["--days", "30", "--agent=work", "--json", "--source", "db"])).toMatchObject({
      days: 30,
      agent: "work",
      json: true,
      source: "db",
    });
  });

  it.each([["--days", "0"], ["--days", "7d"], ["--source", "cloud"], ["--agent", "../main"], ["--bogus"], ["--days"]])(
    "refuses %s %s",
    (...argv) => {
      expect(() => parseArgs(argv)).toThrow();
    },
  );

  it("covers whole UTC days, today included, the way sessions.usage reads startDate/endDate", () => {
    const w = usageWindow(7, NOW);
    expect(w).toMatchObject({ startDate: "2026-10-16", endDate: "2026-10-22" });
    expect(w.startMs).toBe(Date.UTC(2026, 9, 16));
    expect(w.endMs).toBe(Date.UTC(2026, 9, 23) - 1);
    expect(gatewayParams(w, null)).toEqual({ agentScope: "all", startDate: "2026-10-16", endDate: "2026-10-22", mode: "utc", limit: 100000 });
    expect(gatewayParams(w, "work")).toMatchObject({ agentId: "work" });
  });

  it("finds the state dir the way the core does", () => {
    expect(resolveStateDir({ OPENCLAW_STATE_DIR: "/srv/oc" })).toBe("/srv/oc");
    expect(resolveStateDir({ OPENCLAW_HOME: "/srv/home" })).toBe("/srv/home/.openclaw");
    expect(resolveStateDir({ HOME: "/srv/owner" })).toBe("/srv/owner/.openclaw");
  });
});

describe("usage normalisation (the core's normalizeUsage)", () => {
  it("reads OpenClaw's own fields as they are", () => {
    expect(normalizeUsage({ input: 10, output: 5, cacheRead: 100, cacheWrite: 7 })).toEqual({
      input: 10, output: 5, cacheRead: 100, cacheWrite: 7, totalTokens: 122,
    });
  });

  it("takes an OpenAI-style cached prompt count out of input", () => {
    expect(normalizeUsage({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } })).toEqual({
      input: 200, output: 20, cacheRead: 800, cacheWrite: 0, totalTokens: 1020,
    });
  });

  it("keeps a recorded total and ignores nothing-at-all", () => {
    expect(normalizeUsage({ input_tokens: 3, output_tokens: 4, total_tokens: 9 })?.totalTokens).toBe(9);
    expect(normalizeUsage({})).toBeNull();
    expect(assistantCall({ type: "message", message: { role: "user", usage: { input: 1 } } })).toBeNull();
  });
});

describe("db source: the agent databases, read-only", () => {
  it("sums every agent and model inside the window, each response once", () => {
    agentDb("main", {
      s1: ["user", { ts: IN, usage: anthropic(100, 20, 1000, 50), responseId: "r1" }, "tool", { ts: IN + 1, usage: anthropic(10, 2), responseId: "r2" }],
      // a fork copies r1 into its own transcript: one call, not two
      s2: [{ ts: IN, usage: anthropic(100, 20, 1000, 50), responseId: "r1" }, { ts: IN + 5, provider: "deepseek", model: "deepseek-chat", usage: { prompt_tokens: 500, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } } }],
      old: [{ ts: BEFORE, usage: anthropic(9999, 9999) }],
    });
    agentDb("work", { w1: [{ ts: IN, provider: "openai", model: "gpt-5.1", usage: anthropic(7, 3) }] });

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.agents).toEqual([
      { agentId: "main", sessions: 2, calls: 3, input: 210, output: 72, cacheRead: 1400, cacheWrite: 50, totalTokens: 1732 },
      { agentId: "work", sessions: 1, calls: 1, input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
    ]);
    expect(report.models.map((m: { provider: string; model: string; sessions: number; calls: number }) => [`${m.provider}/${m.model}`, m.sessions, m.calls])).toEqual([
      ["anthropic/claude-sonnet-4-6", 1, 2],
      ["deepseek/deepseek-chat", 1, 1],
      ["openai/gpt-5.1", 1, 1],
    ]);
    expect(report.agentModels).toHaveLength(3);
    expect(report.totals).toMatchObject({ sessions: 3, calls: 4, totalTokens: 1742 });
    expect(report.notes).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it.skipIf(!zstdCompress)("decodes compressed rows and reads cold archives archived inside the window", () => {
    const main = agentDb("main", { s1: [{ ts: IN, usage: anthropic(40, 4), packed: true }] });
    coldArchive(main, "s9", ["user", { ts: IN, usage: anthropic(1, 1), model: "m-cold" }], { archivedAt: IN + 10, storage: "sqlite" });

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.totals).toMatchObject({ sessions: 2, calls: 2, input: 41, output: 5 });
    expect(report.scanned[0]).toMatchObject({ decoded: 1, coldRead: 1, coldSkipped: 0, undecodable: 0 });
    expect(report.notes).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it.skipIf(!zstdCompress)("counts the calls of a window the core moved to cold storage inside the window", () => {
    const main = agentDb("main", {
      live: [{ ts: IN + 1, usage: anthropic(100, 10), responseId: "r-forked" }],
    });
    // Archived the day after its last call: its rows left transcript_events.
    coldArchive(main, "archived", [
      "user",
      { ts: BEFORE, usage: anthropic(9999, 9999), responseId: "r-old" },
      { ts: IN, usage: anthropic(30, 3, 300, 7), responseId: "r-cold" },
      "user",
      { ts: IN + 1, usage: anthropic(100, 10), responseId: "r-forked" },
      { ts: IN + 2, provider: "deepseek", model: "deepseek-chat", usage: { prompt_tokens: 50, completion_tokens: 5 } },
    ], { archivedAt: IN + 24 * 60 * 60 * 1000, storage: "file" });
    // Archived before the window began: nothing in it can be inside the window.
    coldArchive(main, "long-gone", [{ ts: BEFORE, usage: anthropic(7, 7) }], { archivedAt: BEFORE + 1, storage: "file" });

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.models.map((m: { provider: string; model: string; sessions: number; calls: number }) => [`${m.provider}/${m.model}`, m.sessions, m.calls])).toEqual([
      ["anthropic/claude-sonnet-4-6", 2, 2],
      ["deepseek/deepseek-chat", 1, 1],
    ]);
    // r-cold, r-forked once (the live fork copied it), the deepseek call.
    expect(report.totals).toMatchObject({ sessions: 2, calls: 3, input: 180, output: 18, cacheRead: 300, cacheWrite: 7 });
    expect(report.scanned[0]).toMatchObject({ coldRead: 1, coldSkipped: 0 });
    expect(report.notes).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it.skipIf(!zstdCompress)("names a cold archive it cannot read instead of counting none of it in silence", () => {
    const main = agentDb("main", {});
    // Plain transcript events, not the core's records: not an archive it writes.
    const plain = [JSON.stringify({ type: "session", id: "s9" }), JSON.stringify(assistantEvent({ ts: IN, usage: anthropic(1, 1) }))].join("\n");
    const bytes = zstdCompress!(Buffer.from(plain));
    main.db.prepare("INSERT INTO session_transcript_cold_archives VALUES ('s9', 'g', ?, ?, 1, ?, ?, 2, ?, 'sqlite', ?)")
      .run(`${"0".repeat(64)}.jsonl.zst`, "0".repeat(64), Buffer.byteLength(plain), bytes.length, IN + 10, bytes);
    // A file archive whose file is missing.
    const name = coldArchive(main, "s10", [{ ts: IN, usage: anthropic(2, 2) }], { archivedAt: IN + 10, storage: "file" });
    rmSync(path.join(stateDir, "agents", "main", "sessions", "cold", name));

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.totals).toMatchObject({ calls: 0 });
    expect(report.scanned[0]).toMatchObject({ coldRead: 0, coldSkipped: 2 });
    expect(report.notes).toEqual([expect.stringMatching(/^agent main: 2 cold archive\(s\) not read: /)]);
    expect(report.complete).toBe(false);
  });

  it.skipIf(!zstdCompress)("counts a reset or deleted session from its transcript archive, as the core's own report does", () => {
    agentDb("main", { live: [{ ts: IN, usage: anthropic(100, 10), responseId: "r-live" }] });
    const hex = "0123456789abcdef".repeat(2);
    // Deleted inside the window: the window's rows are gone, the archive stays.
    transcriptArchive("main", `gone.jsonl.deleted.2026-10-21T08-00-00.000Z.${hex}.zst`, [
      "user",
      { ts: IN, usage: anthropic(30, 3, 300, 7), responseId: "r-del" },
      { ts: BEFORE, usage: anthropic(9999, 9999), responseId: "r-before" },
      // a fork of the live session copied r-live: one call, not two
      { ts: IN, usage: anthropic(100, 10), responseId: "r-live" },
    ]);
    // Reset, written plain, no generation suffix.
    transcriptArchive("main", "reset1.jsonl.reset.2026-10-21T09-00-00Z", [
      { ts: IN + 5, provider: "deepseek", model: "deepseek-v4-pro", usage: { prompt_tokens: 50, completion_tokens: 5 }, responseId: "r-reset" },
    ]);
    // A file-era transcript the core still counts.
    transcriptArchive("main", "legacy.jsonl", [{ ts: IN + 6, usage: anthropic(1, 1), responseId: "r-legacy" }]);
    // The live session's own archive: the core reads its SQLite transcript instead.
    transcriptArchive("main", `live.jsonl.reset.2026-10-21T10-00-00.000Z.zst`, [{ ts: IN, usage: anthropic(5000, 5000), responseId: "r-live-old" }]);
    // Last written before the window began: nothing in it can be inside the window.
    transcriptArchive("main", `old.jsonl.deleted.2026-10-01T08-00-00.000Z.zst`, [{ ts: IN, usage: anthropic(7000, 7000) }], { mtimeMs: BEFORE });
    // Not transcripts the core counts in usage.
    for (const name of ["t1.trajectory.jsonl", "c1.checkpoint.0b6f1a3e-2c4d-4e5f-8a9b-0c1d2e3f4a5b.jsonl", "b1.jsonl.bak.2026-10-21T08-00-00Z", "sessions.json"]) {
      transcriptArchive("main", name, [{ ts: IN, usage: anthropic(8000, 8000) }]);
    }

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.models.map((m: { provider: string; model: string; sessions: number; calls: number }) => [`${m.provider}/${m.model}`, m.sessions, m.calls])).toEqual([
      ["anthropic/claude-sonnet-4-6", 3, 3],
      ["deepseek/deepseek-v4-pro", 1, 1],
    ]);
    // r-live once, r-del, r-reset, r-legacy.
    expect(report.totals).toMatchObject({ sessions: 4, calls: 4, input: 181, output: 19, cacheRead: 300, cacheWrite: 7 });
    expect(report.scanned[0]).toMatchObject({ archivesRead: 3, archivesSkipped: 0 });
    expect(report.notes).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it.skipIf(!zstdCompress)("names a transcript archive it cannot read and calls the count short", () => {
    agentDb("main", {});
    const dir = path.join(stateDir, "agents", "main", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bad.jsonl.deleted.2026-10-21T08-00-00.000Z.zst"), Buffer.from("not zstd"));

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.totals).toMatchObject({ calls: 0 });
    expect(report.scanned[0]).toMatchObject({ archivesRead: 0, archivesSkipped: 1 });
    expect(report.notes).toEqual(["agent main: 1 reset/deleted transcript archive(s) not read: bad.jsonl.deleted.2026-10-21T08-00-00.000Z.zst"]);
    expect(report.complete).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("calls the count short when it cannot look into the sessions directory", () => {
    agentDb("main", { live: [{ ts: IN, usage: anthropic(1, 1) }] });
    transcriptArchive("main", "gone.jsonl.deleted.2026-10-21T08-00-00Z", [{ ts: IN, usage: anthropic(2, 2) }]);
    const dir = path.join(stateDir, "agents", "main", "sessions");
    chmodSync(dir, 0o000);
    try {
      const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });
      expect(report.totals).toMatchObject({ calls: 1 });
      expect(report.scanned[0]).toMatchObject({ archivesRead: 0, archivesSkipped: 1 });
      expect(report.complete).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("knows the transcript file names the core counts in usage", () => {
    expect(usageCountedSessionId("s1.jsonl")).toBe("s1");
    expect(usageCountedSessionId("s1.jsonl.reset.2026-10-21T08-00-00Z")).toBe("s1");
    expect(usageCountedSessionId(`s1.jsonl.deleted.2026-10-21T08-00-00.123Z.${"a".repeat(32)}.zst`)).toBe("s1");
    expect(usageCountedSessionId("s1.jsonl.deleted.2026-10-21T08-00-00Z.nothex.zst")).toBeNull();
    expect(usageCountedSessionId("s1.jsonl.bak.2026-10-21T08-00-00Z")).toBeNull();
    expect(usageCountedSessionId("s1.jsonl.zst")).toBeNull();
    expect(usageCountedSessionId("s1.trajectory.jsonl")).toBeNull();
    expect(usageCountedSessionId("s1.trajectory.jsonl.reset.2026-10-21T08-00-00Z")).toBeNull();
  });

  it("stops each session's newest-first walk soon after the window instead of reading its history", () => {
    const history: Call[] = Array.from({ length: 2000 }, (_, i) => ({ ts: BEFORE + i, usage: anthropic(1, 1) }));
    agentDb("main", { long: [...history, { ts: IN, usage: anthropic(5, 5) }] });

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.totals).toMatchObject({ calls: 1, input: 5 });
    expect(report.scanned[0].rowsRead).toBe(1 + STOP_AFTER_OLD_ROWS);
  });

  it("does not open a session the core has not written to since the window began", () => {
    const history: Call[] = Array.from({ length: 500 }, (_, i) => ({ ts: BEFORE + i, usage: anthropic(1, 1) }));
    agentDb("main", { idle: history, busy: [{ ts: IN, usage: anthropic(5, 5) }] });

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.totals).toMatchObject({ sessions: 1, calls: 1 });
    expect(report.scanned[0]).toMatchObject({ windows: 2, sessions: 1, rowsRead: 1 });
  });

  it("does not end the walk at one row a wrong clock stamped in the past", () => {
    agentDb("main", { s: [{ ts: IN, usage: anthropic(1, 0) }, { ts: IN + 1, usage: anthropic(2, 0), createdAt: 0 }, { ts: IN + 2, usage: anthropic(4, 0) }] });
    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });
    // The middle row's created_at is bogus, so that row is passed over; the
    // walk goes on and still counts the row written before it.
    expect(report.totals.input).toBe(5);
  });

  it("sees rows still in the WAL of a live writer, and never writes the database", () => {
    const { db, dbPath } = agentDb("main", { s1: [{ ts: IN, usage: anthropic(3, 3) }] }, { wal: true });
    // `db` is the "gateway": it keeps the database open, nothing checkpointed.
    const before = readFileSync(dbPath);
    const mtime = statSync(dbPath).mtimeMs;

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: "main" });

    expect(report.totals.calls).toBe(1);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(statSync(dbPath).mtimeMs).toBe(mtime);
    const ro = openReadOnly(dbPath);
    expect(ro.immutable).toBe(false);
    expect(() => ro.db.exec("DELETE FROM transcript_events")).toThrow(/readonly|query_only|read-only/i);
    ro.db.close();
    // the writer still writes
    db.prepare("INSERT INTO session_windows VALUES ('s2', 'k', 0, 0, NULL)").run();
  });

  it("never reads a database a writer holds without its lock: it waits, then refuses", () => {
    const { db, dbPath } = agentDb("main", { s1: [{ ts: IN, usage: anthropic(3, 3) }] });
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("INSERT INTO session_windows VALUES ('s2', 'k', 0, 0, NULL)").run();

    // Before: no busy timeout on the first read, and an immutable read of a
    // main file mid-transaction.
    expect(() => openReadOnly(dbPath, { busyTimeoutMs: 50 })).toThrow(/locked|busy/i);
    // …and the report says it is short of that agent instead of claiming a full count.
    const held = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null, busyTimeoutMs: 50 });
    expect(held.complete).toBe(false);
    expect(held.notes.join(" ")).toMatch(/agent main: could not open its database read-only: .*locked/i);

    db.exec("COMMIT");
    const ro = openReadOnly(dbPath, { busyTimeoutMs: 50 });
    expect(ro.immutable).toBe(false);
    ro.db.close();
  });

  it("says so when there is nothing to read", () => {
    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });
    expect(report.totals.calls).toBe(0);
    expect(report.notes[0]).toMatch(/no OpenClaw agent database/);
    expect(formatReport({ ...report, window: usageWindow(7, NOW), source: "db" })).toContain("No model calls in this window.");
  });
});

// The shape the pinned core's sessions.usage answers with (usage-*.mjs:
// sessions[].agentId, sessions[].usage.modelUsage[], cacheStatus).
const gatewayAnswer = (over: Record<string, unknown> = {}) => ({
  startDate: "2026-10-16",
  endDate: "2026-10-22",
  sessions: [
    {
      key: "agent:main:main", sessionId: "a", agentId: "main",
      usage: {
        input: 110, output: 22, cacheRead: 1000, cacheWrite: 50, totalTokens: 1182,
        modelUsage: [
          { provider: "anthropic", model: "claude-sonnet-4-6", count: 2, totals: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50, totalTokens: 1170 } },
          { provider: "deepseek", model: "deepseek-chat", count: 1, totals: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } },
        ],
      },
    },
    { key: "agent:work:main", sessionId: "b", agentId: "work", usage: { input: 7, output: 3, totalTokens: 10, modelUsage: [{ provider: "openai", model: "gpt-5.1", count: 1, totals: { input: 7, output: 3, totalTokens: 10 } }] } },
  ],
  cacheStatus: { status: "fresh", cachedFiles: 2, pendingFiles: 0, staleFiles: 0 },
  ...over,
});

describe("gateway source: the core's sessions.usage", () => {
  it("turns the per-session model usage into agent and model rows", () => {
    const report = reportFromGateway(gatewayAnswer(), usageWindow(7, NOW));
    expect(report.complete).toBe(true);
    expect(report.agents.map((a: { agentId: string; sessions: number; calls: number; totalTokens: number }) => [a.agentId, a.sessions, a.calls, a.totalTokens])).toEqual([
      ["main", 1, 3, 1182],
      ["work", 1, 1, 10],
    ]);
    expect(report.models).toHaveLength(3);
  });

  it("calls an answer still computing incomplete", () => {
    const answer = gatewayAnswer({ cacheStatus: { status: "refreshing", pendingFiles: 4 } });
    (answer.sessions as unknown[]).push({ key: "k", sessionId: "c", agentId: "main", usage: null, computing: true });
    const report = reportFromGateway(answer, usageWindow(7, NOW));
    expect(report.complete).toBe(false);
    expect(report.notes.join(" ")).toMatch(/cache is refreshing \(4 transcript\(s\) pending\)/);
    expect(report.notes.join(" ")).toMatch(/1 session\(s\) still being computed/);
  });

  it.each([
    ["a clamped start", { startDate: "2026-10-18" }],
    ["a shifted end", { endDate: "2026-10-21" }],
  ])("calls an answer for another range incomplete (%s), and auto counts the databases", (_, range) => {
    const report = reportFromGateway(gatewayAnswer(range), usageWindow(7, NOW));
    expect(report.complete).toBe(false);
    expect(report.notes.join(" ")).toMatch(/the gateway answered for .* not 2026-10-16 \.\. 2026-10-22/);

    agentDb("main", { s1: [{ ts: IN, usage: anthropic(1, 1) }] });
    const auto = buildReport({ ...parseArgs([]), stateDir }, { nowMs: NOW, gateway: () => gatewayAnswer(range) });
    expect(auto.source).toBe("db");
    expect(auto.notes[0]).toMatch(/gateway answer incomplete \(the gateway answered for/);
  });

  it("takes an answer for exactly the window asked as complete", () => {
    expect(reportFromGateway(gatewayAnswer(), usageWindow(7, NOW)).complete).toBe(true);
  });

  it("auto takes a complete gateway answer, and counts the databases when it is not", () => {
    agentDb("main", { s1: [{ ts: IN, usage: anthropic(1, 1) }] });
    const opts = { ...parseArgs([]), stateDir };
    const fromGateway = buildReport(opts, { nowMs: NOW, gateway: () => gatewayAnswer() });
    expect(fromGateway.source).toBe("gateway");
    expect(fromGateway.totals.calls).toBe(4);

    const partial = buildReport(opts, { nowMs: NOW, gateway: () => gatewayAnswer({ cacheStatus: { status: "partial", pendingFiles: 1 } }) });
    expect(partial.source).toBe("db");
    expect(partial.totals.calls).toBe(1);
    expect(partial.notes[0]).toMatch(/gateway answer incomplete/);

    const down = buildReport(opts, { nowMs: NOW, gateway: () => { throw new Error("gateway call failed: connect ECONNREFUSED"); } });
    expect(down.source).toBe("db");
    expect(down.notes[0]).toMatch(/gateway not used \(gateway call failed/);
  });

  it("--source gateway reports the gateway's failure instead of falling back", () => {
    agentDb("main", { s1: [{ ts: IN, usage: anthropic(1, 1) }] });
    const opts = { ...parseArgs(["--source", "gateway"]), stateDir };
    expect(() => buildReport(opts, { nowMs: NOW, gateway: () => { throw new Error("down"); } })).toThrow("down");
    let asked = 0;
    buildReport({ ...opts, source: "db" }, { nowMs: NOW, gateway: () => { asked += 1; return gatewayAnswer(); } });
    expect(asked).toBe(0);
  });

  it("asks the gateway through the core's CLI with the window's params", () => {
    agentDb("main", {});
    const bin = path.join(tmp, "openclaw");
    const argsFile = path.join(tmp, "args.json");
    writeFileSync(bin, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({argv: process.argv.slice(2), state: process.env.OPENCLAW_STATE_DIR}));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(gatewayAnswer()))});\n`, { mode: 0o755 });
    const out: string[] = [];
    const code = main(["--json", "--state-dir", stateDir], {
      out: { write: (s: string) => out.push(s) },
      err: { write: (s: string) => out.push(s) },
      env: { ...process.env, OPENCLAW_BIN: bin },
    });
    expect(code).toBe(0);
    const json = JSON.parse(out.join(""));
    expect(json.source).toBe("gateway");
    expect(json.totals.calls).toBe(4);
    const called = JSON.parse(readFileSync(argsFile, "utf8"));
    expect(called.argv.slice(0, 3)).toEqual(["gateway", "call", "sessions.usage"]);
    expect(JSON.parse(called.argv[4])).toMatchObject({ agentScope: "all", mode: "utc", startDate: json.window.startDate });
    expect(called.state).toBe(stateDir);
  });
});

describe("command line", () => {
  it("prints the agent, model and agent × model tables", () => {
    agentDb("main", { s1: [{ ts: Date.now(), usage: anthropic(1200, 300, 45000, 0) }] });
    const out: string[] = [];
    const code = main(["--source", "db", "--state-dir", stateDir], { out: { write: (s: string) => out.push(s) }, err: { write: (s: string) => out.push(s) }, env: process.env });
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toMatch(/source: agent databases \(read-only\)/);
    expect(text).toMatch(/AGENT\s+SESSIONS\s+CALLS\s+INPUT\s+OUTPUT\s+CACHE READ\s+CACHE WRITE\s+TOTAL/);
    expect(text).toMatch(/main\s+1\s+1\s+1,200\s+300\s+45,000\s+0\s+46,500/);
    expect(text).toMatch(/anthropic\/claude-sonnet-4-6/);
  });

  it("exits 2 with the usage on a bad argument", () => {
    const err: string[] = [];
    expect(main(["--days", "-1"], { out: { write: () => true }, err: { write: (s: string) => err.push(s) }, env: process.env })).toBe(2);
    expect(err.join("")).toMatch(/Usage: clawbox tokens/);
  });
});
