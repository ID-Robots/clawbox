import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { sweepSessionEntries } from "@/lib/openclaw-session-store";
import { applyModelOverrideToAllAgentSessions } from "@/lib/openclaw-config";

// The store lib reaches node:sqlite the same lazy way (vite cannot bundle the
// builtin); the fixtures here do too.
const requireNodeSqlite = createRequire(import.meta.url);
const { DatabaseSync } = requireNodeSqlite("node:sqlite");

const tmpRoots: string[] = [];

function makeAgentStore(userVersion: number, entries: Record<string, object>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawbox-session-store-"));
  tmpRoots.push(root);
  const agentDir = path.join(root, "main", "agent");
  mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT, updated_at INTEGER)");
  const insert = db.prepare("INSERT INTO session_nodes (session_key, entry_json, updated_at) VALUES (?, ?, 0)");
  for (const [key, entry] of Object.entries(entries)) insert.run(key, JSON.stringify(entry));
  db.close();
  return root;
}

function readEntries(root: string): Record<string, Record<string, unknown>> {
  const db = new DatabaseSync(path.join(root, "main", "agent", "openclaw-agent.sqlite"), { readOnly: true });
  const rows = db.prepare("SELECT session_key AS key, entry_json AS entry FROM session_nodes").all() as Array<{ key: string; entry: string }>;
  db.close();
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.entry)]));
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sweepSessionEntries schema guard", () => {
  it("sweeps a store at the schema it knows (2026.8.1 stamps v19)", () => {
    const root = makeAgentStore(19, { "agent:main:main": { modelOverride: "old/model" } });
    const result = sweepSessionEntries("main", (_key, entry) => {
      entry.modelOverride = "new/model";
      return true;
    }, root);
    expect(result).toEqual({ updated: 1, ok: true });
    expect(readEntries(root)["agent:main:main"].modelOverride).toBe("new/model");
  });

  it("refuses to write a NEWER schema than it knows, the way OpenClaw's own store code does", () => {
    // OpenClaw hard-refuses user_version above its build's cap
    // (createNewerSqliteSchemaVersionError); a blind UPDATE from ClawBox
    // against a newer core could corrupt what it no longer understands —
    // the auth-profiles lesson, one store over.
    const root = makeAgentStore(20, { "agent:main:main": { modelOverride: "old/model" } });
    const result = sweepSessionEntries("main", (_key, entry) => {
      entry.modelOverride = "new/model";
      return true;
    }, root);
    expect(result).toEqual({ updated: 0, ok: false, unsupportedSchema: 20 });
    expect(readEntries(root)["agent:main:main"].modelOverride).toBe("old/model");
  });

  it("does not mutate a leftover sessions.json after a newer SQLite schema refuses the sweep", async () => {
    const root = makeAgentStore(20, { "agent:main:main": { modelOverride: "sqlite/old" } });
    const sessionsDir = path.join(root, "main", "sessions");
    const legacyPath = path.join(sessionsDir, "sessions.json");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      "agent:main:main": { modelOverride: "legacy/old" },
    }));

    const result = await applyModelOverrideToAllAgentSessions({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    }, { agentsDir: root });

    expect(result).toEqual({ filesUpdated: 0, sessionsUpdated: 0 });
    expect(readEntries(root)["agent:main:main"].modelOverride).toBe("sqlite/old");
    expect(JSON.parse(readFileSync(legacyPath, "utf8"))["agent:main:main"].modelOverride)
      .toBe("legacy/old");
  });
});
