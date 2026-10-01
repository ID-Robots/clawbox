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
 *  3. NEVER THE REFRESH TOKEN, and the old account's cooldown goes with it.
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

function storeBlob(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    profiles: {
      "anthropic:default": { type: "oauth", provider: "anthropic", access: OLD, refresh: "old-refresh", expires: 1_000 },
      "openai:chatgpt": { type: "oauth", provider: "openai", access: "openai-access", refresh: "openai-refresh", expires: 2_000 },
      "anthropic:manual": { type: "api_key", provider: "anthropic", key: "sk-ant-api03-a-key" },
    },
    usageStats: {
      "anthropic:default": { cooldownUntil: 9_999_999_999_999, errorCount: 3 },
      "openai:chatgpt": { errorCount: 1 },
    },
    ...extra,
  };
}

function writeAgentDb(id: string, blob: unknown): string {
  const file = path.join(agentDir(id), "openclaw-agent.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", JSON.stringify(blob), 1);
  db.close();
  return file;
}

/** A store blob as the assertions read it. */
interface Blob {
  version?: number;
  profiles: Record<string, Record<string, unknown>>;
  usageStats: Record<string, unknown>;
}

function readAgentDb(file: string): Blob {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'").get() as { store_json: string };
  db.close();
  return JSON.parse(row.store_json);
}

function writeSharedDb(owned: boolean, blob: unknown): string {
  const dir = path.join(home, "state");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "openclaw.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
  if (owned) db.prepare("INSERT INTO config_machine_state VALUES (?, ?)").run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
  db.prepare("INSERT INTO config_machine_state VALUES (?, ?)").run("authProfiles.store", JSON.stringify(blob));
  db.close();
  return file;
}

function readSharedDb(file: string): Blob {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get() as { value_json: string };
  db.close();
  return JSON.parse(row.value_json);
}

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
    fs.writeFileSync(legacy, JSON.stringify(storeBlob()), { mode: 0o600 });
    const shared = writeSharedDb(true, storeBlob());
    const expires = Date.now() + 8 * 3_600_000;

    expect(writeGatewayAnthropicToken({ access: NEW, expires }, paths)).toEqual({ written: 3, failed: 0 });

    for (const blob of [readAgentDb(main), JSON.parse(fs.readFileSync(legacy, "utf-8")) as Blob, readSharedDb(shared)]) {
      expect(blob.profiles["anthropic:default"]).toEqual({ type: "oauth", provider: "anthropic", access: NEW, refresh: "", expires });
      // Everything else exactly as core left it.
      expect(blob.profiles["openai:chatgpt"]).toEqual({ type: "oauth", provider: "openai", access: "openai-access", refresh: "openai-refresh", expires: 2_000 });
      expect(blob.profiles["anthropic:manual"]).toEqual({ type: "api_key", provider: "anthropic", key: "sk-ant-api03-a-key" });
      expect(blob.usageStats["anthropic:default"]).toBeUndefined();
      expect(blob.usageStats["openai:chatgpt"]).toEqual({ errorCount: 1 });
      expect(blob.version).toBe(1);
    }
    expect((fs.statSync(legacy).mode & 0o777).toString(8)).toBe("600");
    expect(listGatewayAnthropicProfiles(paths).every((p) => p.fingerprint === tokenFingerprint(NEW))).toBe(true);
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
