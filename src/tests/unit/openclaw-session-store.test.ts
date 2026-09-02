import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { Worker } from "node:worker_threads";
import os from "os";
import path from "path";
import { sweepSessionEntries } from "@/lib/openclaw-session-store";
import { applyModelOverrideToAllAgentSessions } from "@/lib/openclaw-config";

// vite cannot bundle the builtin, so the fixtures reach node:sqlite lazily
// too. createRequire is fine HERE — vitest never bundles a test file — and
// wrong in the lib, where Turbopack compiles it into a throwing stub (see
// openclaw-session-store-loader.test.ts).
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

  it("takes the write reservation before checking schema so a concurrent migration cannot race it", async () => {
    const root = makeAgentStore(19, { "agent:main:main": { modelOverride: "old/model" } });
    const dbPath = path.join(root, "main", "agent", "openclaw-agent.sqlite");
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.dbPath);
      db.exec("BEGIN IMMEDIATE; PRAGMA user_version = 20");
      parentPort.postMessage("migration-started");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
        parentPort.postMessage("migration-complete");
        parentPort.close();
      }, 100);
    `, { eval: true, workerData: { dbPath } });
    const workerError = new Promise<never>((_, reject) => worker.once("error", reject));
    const nextMessage = () => new Promise<string>((resolve) => worker.once("message", resolve));

    expect(await Promise.race([nextMessage(), workerError])).toBe("migration-started");
    const workerExit = new Promise<number>((resolve) => worker.once("exit", resolve));

    // The old ordering read v19 here, then waited for BEGIN IMMEDIATE. Once the
    // worker committed v20 it blindly updated that newer store. The fixed
    // ordering waits for the reservation first and therefore observes v20.
    const result = sweepSessionEntries("main", (_key, entry) => {
      entry.modelOverride = "new/model";
      return true;
    }, root);

    expect(result).toEqual({ updated: 0, ok: false, unsupportedSchema: 20 });
    expect(readEntries(root)["agent:main:main"].modelOverride).toBe("old/model");
    expect(await Promise.race([workerExit, workerError])).toBe(0);
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
