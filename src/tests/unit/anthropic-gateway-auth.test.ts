/**
 * The gateway's Anthropic profiles, the order core tries them in and the
 * failures it recorded against each, as the account pool reads them
 * (TASK-1260, the chat on the pool) — on real SQLite files shaped like
 * OpenClaw 2026.10.2's.
 *
 * What would make the chat's rotation worthless or harmful if it broke:
 *
 *  1. THE STORE CORE RESOLVES — the main agent's under `legacy-main`, the
 *     shared row ONLY when `auth.sharedStore` says `state-db`, with the main
 *     agent's own copies merged over it the way core merges them.
 *  2. ONE PROVIDER, EVERY KIND — its oauth sign-ins, setup tokens and API
 *     keys (an explicit order is core's whole candidate list, so the pool must
 *     see every one), never another provider's, and never a token.
 *  3. CORE'S OWN BOOKKEEPING — the stored order and the failure windows from
 *     the STATE row beside the credentials; and nothing is ever written.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { tokenFingerprint, type GatewayAuthPaths } from "@/lib/anthropic-gateway-auth";
import { readGatewayProviderAuth } from "@/lib/openclaw-auth-store";

let home = "";
let paths: GatewayAuthPaths;

const OLD = "sk-ant-oat01-old-account-token";

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


beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gw-auth-")));
  paths = { agentsDir: path.join(home, "agents"), sharedDb: path.join(home, "state", "openclaw.sqlite") };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ids = (read: ReturnType<typeof readGatewayProviderAuth>) => (read.kind === "present" ? read.profiles.map((p) => p.profileId).sort() : read.kind);

describe("one provider's profiles, order and failures, as core resolves them", () => {
  it("reads the main agent's store: every kind of anthropic profile, the stored order and core's failure windows — no token", () => {
    writeAgentDb("main", storeBlob({ profiles: { ...storeBlob().profiles, "anthropic:clawbox-0a1b2c3d": { type: "token", provider: "anthropic", token: "sk-ant-oat01-pool", expires: 5 } } }));
    // Another agent's store is not what a chat turn resolves.
    writeAgentDb("pro-agent", { profiles: { "anthropic:other": { type: "token", provider: "anthropic", token: "x" } } });
    const read = readGatewayProviderAuth("anthropic", paths);
    expect(ids(read)).toEqual(["anthropic:clawbox-0a1b2c3d", "anthropic:default", "anthropic:manual"]);
    if (read.kind !== "present") throw new Error(read.kind);
    expect(read.profiles.find((p) => p.profileId === "anthropic:clawbox-0a1b2c3d")).toMatchObject({ type: "token", fingerprint: tokenFingerprint("sk-ant-oat01-pool"), expires: 5 });
    expect(read.profiles.find((p) => p.profileId === "anthropic:default")).toMatchObject({ type: "oauth", fingerprint: tokenFingerprint(OLD) });
    expect(read.order).toEqual(["anthropic:default", "anthropic:manual"]);
    expect(read.failures).toEqual({
      "anthropic:default": { cooldownUntil: 9_999_999_999_999, cooldownReason: null, disabledUntil: null, disabledReason: null, blockedUntil: null, lastFailureAt: null },
    });
    expect(JSON.stringify(read)).not.toContain(OLD);
    expect(JSON.stringify(read)).not.toContain("old-refresh");
  });

  it("reads the shared row only when the gateway does (`auth.sharedStore` is `state-db`), with the main agent's own copies over it", () => {
    const main = writeAgentDb("main", { profiles: { "anthropic:default": { type: "token", provider: "anthropic", token: "main-own-copy" } } }, {
      order: { anthropic: ["anthropic:default"] },
      usageStats: { "anthropic:default": { cooldownUntil: 7, cooldownReason: "rate_limit", lastFailureAt: 3 } },
    });
    writeSharedDb(false, storeBlob());
    // Not owned: the main agent's store is the store.
    expect(ids(readGatewayProviderAuth("anthropic", paths))).toEqual(["anthropic:default"]);
    fs.rmSync(paths.sharedDb);
    writeSharedDb(true, storeBlob());
    const read = readGatewayProviderAuth("anthropic", paths);
    if (read.kind !== "present") throw new Error(read.kind);
    expect(ids(read)).toEqual(["anthropic:default", "anthropic:manual"]);
    expect(read.profiles.find((p) => p.profileId === "anthropic:default")?.fingerprint).toBe(tokenFingerprint("main-own-copy"));
    expect(read.order).toEqual(["anthropic:default"]);
    expect(read.failures["anthropic:default"]).toMatchObject({ cooldownUntil: 7, cooldownReason: "rate_limit", lastFailureAt: 3 });
    expect(fs.existsSync(main)).toBe(true);
  });

  it("answers no-store for a box with no OpenClaw store, unreadable for one it cannot ask — and never writes", () => {
    expect(readGatewayProviderAuth("anthropic", { agentsDir: path.join(home, "none"), sharedDb: path.join(home, "none.sqlite") })).toEqual({ kind: "no-store" });
    const main = writeAgentDb("main", storeBlob());
    const before = fs.readFileSync(main);
    readGatewayProviderAuth("anthropic", paths);
    expect(fs.readFileSync(main).equals(before)).toBe(true);
    expect(readAgentDb(main).profiles["anthropic:default"].access).toBe(OLD);
    fs.writeFileSync(main, "this is not a database");
    expect(readGatewayProviderAuth("anthropic", paths).kind).toBe("unreadable");
  });
});
