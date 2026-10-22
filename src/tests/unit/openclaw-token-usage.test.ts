import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
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
  });

  it.skipIf(!zstdCompress)("decodes compressed rows and reads cold archives archived inside the window", () => {
    const { db } = agentDb("main", { s1: [{ ts: IN, usage: anthropic(40, 4), packed: true }] });
    const cold = [JSON.stringify({ type: "session", id: "s9" }), JSON.stringify(assistantEvent({ ts: IN, usage: anthropic(1, 1), model: "m-cold" }))].join("\n");
    db.prepare("INSERT INTO session_windows VALUES ('s9', 'agent:main:s9', 0, ?, NULL)").run(IN + 10);
    db.prepare("INSERT INTO session_transcript_cold_archives VALUES ('s9', 'g', 'a.jsonl.zst', ?, 1, ?, 1, 2, ?, 'sqlite', ?)")
      .run("0".repeat(64), Buffer.byteLength(cold), IN + 10, zstdCompress!(Buffer.from(cold)));

    const report = reportFromDatabases({ stateDir, window: usageWindow(7, NOW), agent: null });

    expect(report.totals).toMatchObject({ sessions: 2, calls: 2, input: 41, output: 5 });
    expect(report.scanned[0]).toMatchObject({ decoded: 1, coldRead: 1, undecodable: 0 });
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
