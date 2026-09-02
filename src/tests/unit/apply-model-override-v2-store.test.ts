import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { applyModelOverrideToAllAgentSessions } from "@/lib/openclaw-config";

// The OpenClaw 2 (2026.8.x) agent store, as the installed core creates it. The
// trigger is copied from the dist: the core owns `session_nodes`, and ANY
// external rewrite of `entry_json` flips `entry_valid` to 0. The core's scan
// then throws SessionCanonicalKeyMigrationRequiredError for that row at the
// next gateway start, and the box is dead until `openclaw doctor --fix`.
// Finding M-03: a model switch swept every row with a direct UPDATE, so one
// switch invalidated every session.
const requireNodeSqlite = createRequire(import.meta.url);
const { DatabaseSync } = requireNodeSqlite("node:sqlite");

const tmpRoots: string[] = [];

function makeV2AgentStore(agentId: string, entries: Record<string, object>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawbox-v2-store-"));
  tmpRoots.push(root);
  const agentDir = path.join(root, agentId, "agent");
  mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  db.exec("PRAGMA user_version = 19");
  db.exec(`CREATE TABLE session_nodes (
    session_key TEXT PRIMARY KEY,
    entry_json TEXT NOT NULL,
    current_session_id TEXT,
    entry_valid INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_entry_update
    AFTER UPDATE OF entry_json ON session_nodes
    BEGIN UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key; END`);
  const insert = db.prepare(
    "INSERT INTO session_nodes (session_key, entry_json, current_session_id, entry_valid, updated_at) VALUES (?, ?, ?, 1, 1000)",
  );
  for (const [key, entry] of Object.entries(entries)) {
    const sessionId = (entry as { sessionId?: string }).sessionId ?? null;
    insert.run(key, JSON.stringify(entry), sessionId);
  }
  db.close();
  return root;
}

function readRows(root: string, agentId = "main") {
  const db = new DatabaseSync(path.join(root, agentId, "agent", "openclaw-agent.sqlite"), { readOnly: true });
  const rows = db
    .prepare("SELECT session_key AS key, entry_json AS entry, entry_valid AS valid FROM session_nodes ORDER BY session_key")
    .all() as Array<{ key: string; entry: string; valid: number }>;
  db.close();
  return rows;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("applyModelOverrideToAllAgentSessions on an OpenClaw 2 (SQLite) agent store", () => {
  const seed = {
    "agent:main:main": { sessionId: "sid-main", modelOverride: "old-model", providerOverride: "openai", modelOverrideSource: "user" },
    "agent:main:clawbox-abc": { sessionId: "sid-abc", modelOverride: "old-model", providerOverride: "openai", modelOverrideSource: "auto" },
  };

  it("never rewrites session_nodes: every row keeps entry_valid = 1 and its entry_json", async () => {
    const root = makeV2AgentStore("main", seed);
    const before = readRows(root);
    const callGateway = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
      outcomes: (params.targets as Array<{ key: string }>).map((t) => ({ ok: true, key: t.key })),
    }));

    await applyModelOverrideToAllAgentSessions(
      { provider: "deepseek", modelId: "deepseek-v4-pro" },
      { agentsDir: root, callGateway },
    );

    const after = readRows(root);
    expect(after.map((r) => r.valid)).toEqual([1, 1]);
    expect(after).toEqual(before);
  });

  it("applies the override through the gateway's sessions.patchMany, one target per real session", async () => {
    const root = makeV2AgentStore("main", {
      ...seed,
      // A `{}` placeholder row (the core keeps these with entry_valid = -1 for
      // a retention window) has no session to patch; patching it would create one.
      "agent:main:retained": {},
    });
    const callGateway = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
      outcomes: (params.targets as Array<{ key: string }>).map((t) => ({ ok: true, key: t.key })),
    }));

    const result = await applyModelOverrideToAllAgentSessions(
      { provider: "deepseek", modelId: "deepseek-v4-pro", source: "user" },
      { agentsDir: root, callGateway },
    );

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      "sessions.patchMany",
      {
        targets: [
          { key: "agent:main:clawbox-abc", agentId: "main" },
          { key: "agent:main:main", agentId: "main" },
        ],
        patch: { model: "deepseek/deepseek-v4-pro" },
      },
      expect.anything(),
    );
    expect(result).toEqual({ filesUpdated: 1, sessionsUpdated: 2, sessionsSkipped: 0 });
  });

  it("reports a session the gateway refused instead of falling back to SQL", async () => {
    const root = makeV2AgentStore("main", seed);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callGateway = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
      outcomes: (params.targets as Array<{ key: string }>).map((t) =>
        t.key === "agent:main:main"
          ? { ok: false, key: t.key, error: { code: "INVALID_REQUEST", message: "model selection is locked" } }
          : { ok: true, key: t.key },
      ),
    }));

    const result = await applyModelOverrideToAllAgentSessions(
      { provider: "deepseek", modelId: "deepseek-v4-pro" },
      { agentsDir: root, callGateway },
    );

    expect(result).toEqual({ filesUpdated: 1, sessionsUpdated: 1, sessionsSkipped: 1 });
    expect(readRows(root).map((r) => r.valid)).toEqual([1, 1]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent:main:main"), expect.stringContaining("model selection is locked"));
  });

  it("keeps the legacy sessions.json rewrite for a v1 agent and never calls the gateway for it", async () => {
    const root = makeV2AgentStore("main", seed);
    const legacyDir = path.join(root, "legacy", "sessions");
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "sessions.json");
    writeFileSync(legacyPath, JSON.stringify({ "agent:legacy:main": { sessionId: "sid-l", modelOverride: "old" } }));
    const callGateway = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
      outcomes: (params.targets as Array<{ key: string }>).map((t) => ({ ok: true, key: t.key })),
    }));

    const result = await applyModelOverrideToAllAgentSessions(
      { provider: "deepseek", modelId: "deepseek-v4-pro" },
      { agentsDir: root, callGateway },
    );

    expect(result).toEqual({ filesUpdated: 2, sessionsUpdated: 3, sessionsSkipped: 0 });
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
    expect(legacy["agent:legacy:main"].modelOverride).toBe("deepseek-v4-pro");
    expect(legacy["agent:legacy:main"].providerOverride).toBe("deepseek");
    // Only the v2 agent's sessions went through the gateway.
    const targets = callGateway.mock.calls.flatMap(([, params]) => (params.targets as Array<{ agentId: string }>).map((t) => t.agentId));
    expect(targets).toEqual(["main", "main"]);
  });
});
