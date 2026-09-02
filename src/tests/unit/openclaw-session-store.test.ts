import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { readSessionEntries, sessionStorePath } from "@/lib/openclaw-session-store";

// vite cannot bundle the builtin, so the fixtures reach node:sqlite lazily
// too. createRequire is fine HERE — vitest never bundles a test file — and
// wrong in the lib, where Turbopack compiles it into a throwing stub (see
// openclaw-session-store-loader.test.ts).
const requireNodeSqlite = createRequire(import.meta.url);
const { DatabaseSync } = requireNodeSqlite("node:sqlite");

const tmpRoots: string[] = [];

/** A store shaped like the one OpenClaw 2026.8.1 creates, trigger included. */
function makeAgentStore(entries: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawbox-session-store-"));
  tmpRoots.push(root);
  const agentDir = path.join(root, "main", "agent");
  mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  db.exec("PRAGMA user_version = 19");
  db.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL, entry_valid INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0)");
  db.exec(`CREATE TRIGGER session_nodes_entry_valid_after_entry_update
    AFTER UPDATE OF entry_json ON session_nodes
    BEGIN UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key; END`);
  const insert = db.prepare("INSERT INTO session_nodes (session_key, entry_json) VALUES (?, ?)");
  for (const [key, entry] of Object.entries(entries)) insert.run(key, entry);
  db.close();
  return root;
}

function readValidity(root: string): number[] {
  const db = new DatabaseSync(path.join(root, "main", "agent", "openclaw-agent.sqlite"), { readOnly: true });
  const rows = db.prepare("SELECT entry_valid AS valid FROM session_nodes").all() as Array<{ valid: number }>;
  db.close();
  return rows.map((r) => r.valid);
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("openclaw-session-store", () => {
  it("uses the device home fallback when HOME is present but empty", async () => {
    const originalClawboxHome = process.env.CLAWBOX_OPENCLAW_HOME;
    const originalOpenclawHome = process.env.OPENCLAW_HOME;
    const originalHome = process.env.HOME;
    try {
      delete process.env.CLAWBOX_OPENCLAW_HOME;
      delete process.env.OPENCLAW_HOME;
      process.env.HOME = "";
      vi.resetModules();

      const fresh = await import("@/lib/openclaw-session-store");
      expect(fresh.OPENCLAW_HOME_DEFAULT).toBe("/home/clawbox/.openclaw");
    } finally {
      if (originalClawboxHome === undefined) delete process.env.CLAWBOX_OPENCLAW_HOME;
      else process.env.CLAWBOX_OPENCLAW_HOME = originalClawboxHome;
      if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = originalOpenclawHome;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      vi.resetModules();
    }
  });

  describe("readSessionEntries", () => {
    it("returns every object entry, by key, and skips rows that describe no session", () => {
      const root = makeAgentStore({
        "agent:main:main": JSON.stringify({ sessionId: "s1", modelOverride: "old/model" }),
        "agent:main:clawbox-1": JSON.stringify({ sessionId: "s2" }),
        "agent:main:broken": "{ not json",
        "agent:main:list": "[1, 2]",
      });
      expect(readSessionEntries("main", root)).toEqual([
        { key: "agent:main:clawbox-1", entry: { sessionId: "s2" } },
        { key: "agent:main:main", entry: { sessionId: "s1", modelOverride: "old/model" } },
      ]);
    });

    it("is null for an agent without a store, and for a store that cannot be read", () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "clawbox-session-store-"));
      tmpRoots.push(root);
      expect(readSessionEntries("main", root)).toBeNull();

      const agentDir = path.join(root, "main", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "openclaw-agent.sqlite"), "not a database");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(sessionStorePath("main", root)).not.toBeNull();
      expect(readSessionEntries("main", root)).toBeNull();
      expect(warn).toHaveBeenCalled();
    });

    it("leaves the core's row validity untouched", () => {
      const root = makeAgentStore({ "agent:main:main": JSON.stringify({ sessionId: "s1" }) });
      readSessionEntries("main", root);
      expect(readValidity(root)).toEqual([1]);
    });
  });

  it("carries no write path to the store at all", () => {
    // The core invalidates any row whose entry_json is rewritten by anything
    // but itself (finding M-03: the old sweep here bricked chat on every model
    // switch). Everything that changes an entry goes through the gateway's
    // API; this module only ever opens the store read-only. A tripwire, so the
    // next "small" write cannot come back quietly.
    const source = readFileSync(path.resolve(__dirname, "../../lib/openclaw-session-store.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i);
    // `openSqlite(path, readOnly)` is exported for the gateway-wide state
    // store (a different database); every use INSIDE this module is read-only,
    // and it is the only constructor path, so that covers every open.
    expect(code.match(/\bnew DatabaseSync\(/g) ?? []).toHaveLength(1);
    const uses = (code.match(/openSqlite\([^)]*\)/g) ?? []).filter((call) => !call.startsWith("openSqlite(dbPath: string"));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/,\s*true\)$/);
  });
});
