/**
 * The gateway's Claude subscription credential, rewritten in the gateway's own
 * stores (TASK-1260) — on real SQLite files shaped like OpenClaw's.
 *
 * What would make the swap worthless or harmful if it broke:
 *
 *  1. EVERY AGENT, EVERY STORE. The legacy auth-profiles.json, each agent's
 *     `auth_profile_store`, and the shared state-db row when — and only when —
 *     `auth.sharedStore` says the gateway reads it.
 *  2. ONLY THE CREDENTIAL. The profile's type and id stay; other providers'
 *     profiles, and an anthropic API-key profile, are untouched; nothing is
 *     created where there was nothing.
 *  3. NEVER THE REFRESH TOKEN, and the old account's cooldown goes with it —
 *     from the STATE row core 2026.10.2 keeps it in, beside the store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import {
  listGatewayAnthropicProfiles,
  tokenFingerprint,
  writeGatewayAnthropicToken,
  type GatewayAuthPaths,
} from "@/lib/anthropic-gateway-auth";

let home = "";
let paths: GatewayAuthPaths;

const OLD = "sk-ant-oat01-old-account-token";
const NEW = "sk-ant-oat01-new-account-token";

function agentDir(id: string): string {
  const dir = path.join(home, "agents", id, "agent");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The CREDENTIALS as core 2026.10.2 persists them: `{version, profiles}` and
 * nothing else (`buildPersistedAuthProfileSecretsStore`).
 */
function storeBlob(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    profiles: {
      "anthropic:default": { type: "oauth", provider: "anthropic", access: OLD, refresh: "old-refresh", expires: 1_000 },
      "openai:chatgpt": { type: "oauth", provider: "openai", access: "openai-access", refresh: "openai-refresh", expires: 2_000 },
      "anthropic:manual": { type: "api_key", provider: "anthropic", key: "sk-ant-api03-a-key" },
    },
    ...extra,
  };
}

/**
 * The runtime STATE beside them, a row of its own — order, last-good, usage
 * stats and cooldowns (`buildPersistedAuthProfileState`) — which core merges
 * OVER the credentials when it loads the store.
 */
function stateBlob() {
  return {
    version: 1,
    order: { anthropic: ["anthropic:default", "anthropic:manual"] },
    usageStats: {
      "anthropic:default": { cooldownUntil: 9_999_999_999_999, errorCount: 3 },
      "openai:chatgpt": { errorCount: 1 },
    },
  };
}

/** The legacy auth-profiles.json, which carried both in one file. */
function legacyFileBlob() {
  return { ...storeBlob(), usageStats: stateBlob().usageStats };
}

const AGENT_STORE_DDL = "CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT";
const AGENT_STATE_DDL = "CREATE TABLE auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT";
const SHARED_DDL = "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT";

/** An agent database as 2026.10.2 lays it out; `state: null` is one with no state row. */
function writeAgentDb(id: string, blob: unknown, state: unknown = stateBlob()): string {
  const file = path.join(agentDir(id), "openclaw-agent.sqlite");
  const db = new DatabaseSync(file);
  db.exec(AGENT_STORE_DDL);
  db.exec(AGENT_STATE_DDL);
  db.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", JSON.stringify(blob), 1);
  if (state !== null) db.prepare("INSERT INTO auth_profile_state VALUES (?, ?, ?)").run("primary", JSON.stringify(state), 1);
  db.close();
  return file;
}

/** A store or state blob as the assertions read it. */
interface Blob {
  version?: number;
  profiles: Record<string, Record<string, unknown>>;
  order?: unknown;
  usageStats?: Record<string, unknown>;
}

function readJsonCell(file: string, sql: string): Blob | undefined {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare(sql).get() as { json: string } | undefined;
  db.close();
  return row ? JSON.parse(row.json) : undefined;
}

const readAgentDb = (file: string): Blob => readJsonCell(file, "SELECT store_json AS json FROM auth_profile_store WHERE store_key = 'primary'")!;
const readAgentState = (file: string) => readJsonCell(file, "SELECT state_json AS json FROM auth_profile_state WHERE state_key = 'primary'");

function writeSharedDb(owned: boolean, blob: unknown, state: unknown = stateBlob()): string {
  const dir = path.join(home, "state");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "openclaw.sqlite");
  const db = new DatabaseSync(file);
  db.exec(SHARED_DDL);
  const put = db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)");
  if (owned) put.run("auth.sharedStore", JSON.stringify({ location: "state-db" }), 1);
  put.run("authProfiles.store", JSON.stringify(blob), 1);
  if (state !== null) put.run("authProfiles.state", JSON.stringify(state), 1);
  db.close();
  return file;
}

const readSharedDb = (file: string): Blob => readJsonCell(file, "SELECT value_json AS json FROM config_machine_state WHERE state_key = 'authProfiles.store'")!;
const readSharedState = (file: string) => readJsonCell(file, "SELECT value_json AS json FROM config_machine_state WHERE state_key = 'authProfiles.state'");

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gw-auth-")));
  paths = { agentsDir: path.join(home, "agents"), sharedDb: path.join(home, "state", "openclaw.sqlite") };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("finding the gateway's Claude subscription", () => {
  it("lists every anthropic sign-in profile in every agent and store — and no other provider's, and no API key", () => {
    writeAgentDb("main", storeBlob());
    writeAgentDb("pro-agent", storeBlob());
    fs.writeFileSync(path.join(agentDir("legacy"), "auth-profiles.json"), JSON.stringify(storeBlob()));
    writeSharedDb(true, storeBlob());
    const found = listGatewayAnthropicProfiles(paths);
    expect(found.map((p) => [p.store, p.agentId, p.profileId, p.type]).sort()).toEqual([
      ["agent", "main", "anthropic:default", "oauth"],
      ["agent", "pro-agent", "anthropic:default", "oauth"],
      ["json", "legacy", "anthropic:default", "oauth"],
      ["shared", null, "anthropic:default", "oauth"],
    ].sort());
    // The token is never in the answer, only what stands in for it.
    expect(JSON.stringify(found)).not.toContain(OLD);
    expect(found[0].fingerprint).toBe(tokenFingerprint(OLD));
  });

  it("does not read the shared row unless the gateway does (`auth.sharedStore` is `state-db`)", () => {
    writeSharedDb(false, storeBlob());
    expect(listGatewayAnthropicProfiles(paths)).toEqual([]);
  });

  it("finds a setup-token profile too", () => {
    writeAgentDb("main", { profiles: { "anthropic:setup": { type: "token", provider: "anthropic", token: OLD } } });
    expect(listGatewayAnthropicProfiles(paths)).toEqual([
      expect.objectContaining({ profileId: "anthropic:setup", type: "token", fingerprint: tokenFingerprint(OLD) }),
    ]);
  });

  it("answers nothing for a box with no OpenClaw at all", () => {
    expect(listGatewayAnthropicProfiles({ agentsDir: path.join(home, "none"), sharedDb: path.join(home, "none.sqlite") })).toEqual([]);
  });
});

describe("putting the active account in", () => {
  it("replaces the access token everywhere, empties the refresh token and drops the old account's cooldown", () => {
    const main = writeAgentDb("main", storeBlob());
    const legacy = path.join(agentDir("legacy"), "auth-profiles.json");
    fs.writeFileSync(legacy, JSON.stringify(legacyFileBlob()), { mode: 0o600 });
    const shared = writeSharedDb(true, storeBlob());
    const expires = Date.now() + 8 * 3_600_000;

    expect(writeGatewayAnthropicToken({ access: NEW, expires }, paths)).toEqual({ written: 3, failed: 0 });

    const legacyAfter = JSON.parse(fs.readFileSync(legacy, "utf-8")) as Blob;
    for (const blob of [readAgentDb(main), legacyAfter, readSharedDb(shared)]) {
      expect(blob.profiles["anthropic:default"]).toEqual({ type: "oauth", provider: "anthropic", access: NEW, refresh: "", expires });
      // Everything else exactly as core left it.
      expect(blob.profiles["openai:chatgpt"]).toEqual({ type: "oauth", provider: "openai", access: "openai-access", refresh: "openai-refresh", expires: 2_000 });
      expect(blob.profiles["anthropic:manual"]).toEqual({ type: "api_key", provider: "anthropic", key: "sk-ant-api03-a-key" });
      expect(blob.version).toBe(1);
    }
    // The cooldown is where core reads it: the state row beside each store
    // (and, in the legacy file, the file itself). The new account must not sit
    // out the old one's; nothing else in that row moves.
    for (const state of [readAgentState(main), readSharedState(shared), legacyAfter]) {
      expect(state?.usageStats?.["anthropic:default"]).toBeUndefined();
      expect(state?.usageStats?.["openai:chatgpt"]).toEqual({ errorCount: 1 });
    }
    expect(readAgentState(main)?.order).toEqual(stateBlob().order);
    expect(readSharedState(shared)?.order).toEqual(stateBlob().order);
    expect((fs.statSync(legacy).mode & 0o777).toString(8)).toBe("600");
    expect(listGatewayAnthropicProfiles(paths).every((p) => p.fingerprint === tokenFingerprint(NEW))).toBe(true);
  });

  it("makes no state row where core keeps none", () => {
    const main = writeAgentDb("main", storeBlob(), null);
    const shared = writeSharedDb(true, storeBlob(), null);
    expect(writeGatewayAnthropicToken({ access: NEW, expires: 1 }, paths)).toEqual({ written: 2, failed: 0 });
    expect(readAgentState(main)).toBeUndefined();
    expect(readSharedState(shared)).toBeUndefined();
  });

  it("leaves `expires` out when the account did not say, rather than keeping the old account's", () => {
    const main = writeAgentDb("main", storeBlob());
    writeGatewayAnthropicToken({ access: NEW, expires: null }, paths);
    expect(readAgentDb(main).profiles["anthropic:default"]).not.toHaveProperty("expires");
  });

  it("writes a setup-token profile's token field", () => {
    const main = writeAgentDb("main", { profiles: { "anthropic:setup": { type: "token", provider: "anthropic", token: OLD, expires: 5 } } });
    writeGatewayAnthropicToken({ access: NEW, expires: 7 }, paths);
    expect(readAgentDb(main).profiles["anthropic:setup"]).toEqual({ type: "token", provider: "anthropic", token: NEW, expires: 7 });
  });

  it("creates nothing where the gateway holds no Claude subscription", () => {
    const main = writeAgentDb("main", { profiles: { "openai:chatgpt": { type: "oauth", provider: "openai", access: "x" } } });
    expect(writeGatewayAnthropicToken({ access: NEW, expires: 1 }, paths)).toEqual({ written: 0, failed: 0 });
    expect(readAgentDb(main).profiles).toEqual({ "openai:chatgpt": { type: "oauth", provider: "openai", access: "x" } });
    expect(fs.existsSync(path.join(home, "agents", "main", "agent", "auth-profiles.json"))).toBe(false);
    expect(fs.existsSync(paths.sharedDb)).toBe(false);
  });

  it("never writes the shared row the gateway does not read", () => {
    const shared = writeSharedDb(false, storeBlob());
    writeGatewayAnthropicToken({ access: NEW, expires: 1 }, paths);
    expect(readSharedDb(shared).profiles["anthropic:default"].access).toBe(OLD);
    expect(readSharedState(shared)).toEqual(stateBlob());
  });

  it("counts a store it cannot write and still writes the rest", () => {
    writeAgentDb("main", storeBlob());
    const broken = path.join(agentDir("broken"), "openclaw-agent.sqlite");
    fs.writeFileSync(broken, "this is not a database");
    const result = writeGatewayAnthropicToken({ access: NEW, expires: 1 }, paths);
    expect(result.written).toBe(1);
    expect(result.failed).toBe(1);
  });
});
