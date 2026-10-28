/**
 * The ClawBox AI credential slot — `deepseek:default` in the gateway's auth
 * store — on real SQLite files shaped like OpenClaw's, and the three store
 * primitives it is built on.
 *
 * What would make the fix worthless or harmful if it broke:
 *
 *  1. A STALE SIGN-IN IS NOT A KEY. An `oauth` profile at the id (what earlier
 *     ClawBox versions left there) is replaceable, and is what the pinned core
 *     refuses an API key over — so it must be logged out first.
 *  2. THE OWNER'S KEY IS THE OWNER'S. A DeepSeek key that is not a ClawBox AI
 *     token blocks the sign-in unless DeepSeek (or, when DeepSeek cannot be
 *     asked, the gateway's own auth-failure record) says it is refused.
 *  3. THE BACKUP AND THE COOLDOWN. A replaced profile is copied first (0600,
 *     never over another copy), and core's failure state for the id is cleared
 *     without touching any credential, order or other profile's stats.
 *  4. NEVER A TOKEN in an answer or a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { saveEnv } from "@/tests/helpers/env";

const dirs = vi.hoisted(() => ({ data: "" }));
vi.mock("@/lib/config-store", () => ({
  get DATA_DIR() {
    return dirs.data;
  },
}));

import {
  backupGatewayAuthProfile,
  clearGatewayAuthProfileFailures,
  withGatewayAuthProfileCredential,
} from "@/lib/openclaw-auth-store";
import {
  authProfileBackupDir,
  backupClawaiSlot,
  clearClawaiSlotFailures,
  describeClawaiSlot,
  inspectClawaiSlot,
  slotBlocksSignIn,
  slotNeedsBackup,
  slotNeedsLogout,
} from "@/lib/clawai-profile-slot";

const ID = "deepseek:default";
const FRESH = "claw_FAKE-fresh-portal-token";
const PREVIOUS = "claw_FAKE-previous-portal-token";
const OTHER_ACCOUNT = "claw_FAKE-other-account-token";
const OWNER_KEY = "sk-FAKE-owner-deepseek-key";
const SECRETS = [FRESH, PREVIOUS, OTHER_ACCOUNT, OWNER_KEY];

const SHARED_DDL = "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT";
const AGENT_STORE_DDL = "CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT";
const AGENT_STATE_DDL = "CREATE TABLE auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT";

const OTHERS = {
  "anthropic:default": { type: "oauth", provider: "anthropic", access: "FAKE-anthropic-access", refresh: "FAKE-anthropic-refresh", expires: 2_000 },
  "deepseek:manual": { type: "api_key", provider: "deepseek", key: "sk-FAKE-a-second-deepseek-key" },
};

const stale = (access = PREVIOUS) => ({ type: "oauth", provider: "deepseek", access, refresh: "", expires: 5_000 });
const apiKey = (key: string) => ({ type: "api_key", provider: "deepseek", key });

function storeBlob(entry?: unknown) {
  return { version: 1, profiles: { ...(entry === undefined ? {} : { [ID]: entry }), ...OTHERS } };
}

function stateBlob(reason: string | null = "auth") {
  return {
    version: 1,
    order: { deepseek: [ID] },
    usageStats: {
      [ID]: { cooldownUntil: 9_999_999_999_999, errorCount: 4, ...(reason ? { cooldownReason: reason } : {}), lastFailureAt: 1_000 },
      "anthropic:default": { errorCount: 1 },
    },
  };
}

let home = "";
let sharedDb = "";
let agentDb = "";
let restoreEnv: () => void = () => {};
let errors: MockInstance<typeof console.error>;
let returned: unknown[] = [];

function seedShared(store: unknown, state?: unknown): void {
  fs.mkdirSync(path.dirname(sharedDb), { recursive: true });
  const db = new DatabaseSync(sharedDb);
  db.exec(SHARED_DDL);
  const insert = db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)");
  insert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }), 1);
  insert.run("authProfiles.store", JSON.stringify(store), 1);
  if (state !== undefined) insert.run("authProfiles.state", JSON.stringify(state), 1);
  db.close();
}

function seedAgent(store?: unknown, state?: unknown): void {
  fs.mkdirSync(path.dirname(agentDb), { recursive: true });
  const db = new DatabaseSync(agentDb);
  db.exec(AGENT_STORE_DDL);
  db.exec(AGENT_STATE_DDL);
  if (store !== undefined) db.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", JSON.stringify(store), 1);
  if (state !== undefined) db.prepare("INSERT INTO auth_profile_state VALUES (?, ?, ?)").run("primary", JSON.stringify(state), 1);
  db.close();
}

function cell(file: string, sql: string, key: string): Record<string, unknown> | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare(sql).get(key) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Record<string, unknown>) : null;
  } finally {
    db.close();
  }
}
const sharedState = () => cell(sharedDb, "SELECT value_json AS json FROM config_machine_state WHERE state_key = ?", "authProfiles.state");
const sharedStore = () => cell(sharedDb, "SELECT value_json AS json FROM config_machine_state WHERE state_key = ?", "authProfiles.store");
const agentState = () => cell(agentDb, "SELECT state_json AS json FROM auth_profile_state WHERE state_key = ?", "primary");

/** A provider answering `GET /models` with `status`, or a fetch that cannot connect. */
function deepseekAnswers(status: number | "unreachable") {
  const fetchMock = vi.fn(async () => {
    if (status === "unreachable") throw new TypeError("fetch failed");
    return new Response("{}", { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function inspect(options: Parameters<typeof inspectClawaiSlot>[0] = {}) {
  const slot = await inspectClawaiSlot({ token: FRESH, knownTokens: [PREVIOUS], ...options });
  returned.push(slot, describeClawaiSlot(slot));
  return slot;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-clawai-slot-")));
  sharedDb = path.join(home, "state", "openclaw.sqlite");
  agentDb = path.join(home, "agents", "main", "agent", "openclaw-agent.sqlite");
  dirs.data = path.join(home, "data");
  restoreEnv = saveEnv("OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_AGENTS_DIR");
  process.env.CLAWBOX_OPENCLAW_HOME = home;
  process.env.OPENCLAW_STATE_DIR = home;
  process.env.OPENCLAW_AGENTS_DIR = path.join(home, "agents");
  returned = [];
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  const text = JSON.stringify([returned, errors.mock.calls]);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  vi.unstubAllGlobals();
  restoreEnv();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("what holds the slot", () => {
  it("is free on a box with no store, and on one with nothing at the id", async () => {
    expect(await inspect()).toEqual({ kind: "free" });
    seedShared(storeBlob());
    expect(await inspect()).toEqual({ kind: "free" });
  });

  it("calls an oauth profile there stale — ClawBox's own token in the wrong shape — and wants it logged out and kept", async () => {
    seedShared(storeBlob(stale()), stateBlob());
    const slot = await inspect();
    expect(slot).toEqual({ kind: "stale", reason: "oauth", type: "oauth", ours: true });
    expect(slotBlocksSignIn(slot)).toBe(false);
    expect(slotNeedsLogout(slot)).toBe(true);
    expect(slotNeedsBackup(slot)).toBe(true);
  });

  it("calls a profile of another provider or type stale too, and not ClawBox's", async () => {
    seedShared(storeBlob({ type: "api_key", provider: "openai", key: OWNER_KEY }));
    expect(await inspect()).toEqual({ kind: "stale", reason: "foreign", type: "api_key", ours: false });
  });

  it("knows the very token being stored, this box's previous one and another account's", async () => {
    seedShared(storeBlob(apiKey(FRESH)));
    expect(await inspect()).toEqual({ kind: "same" });
    fs.rmSync(path.join(home, "state"), { recursive: true });
    seedShared(storeBlob(apiKey(PREVIOUS)));
    const previous = await inspect();
    expect(previous).toEqual({ kind: "clawai", known: true });
    expect(slotNeedsBackup(previous)).toBe(false);
    fs.rmSync(path.join(home, "state"), { recursive: true });
    seedShared(storeBlob(apiKey(OTHER_ACCOUNT)));
    const other = await inspect();
    expect(other).toEqual({ kind: "clawai", known: false });
    // The paste replaces another API key in place; only a copy is owed.
    expect(slotNeedsLogout(other)).toBe(false);
    expect(slotNeedsBackup(other)).toBe(true);
  });

  it("reads the main agent's own copy where it shadows the shared row, as a turn does", async () => {
    seedShared(storeBlob(apiKey(FRESH)));
    seedAgent({ version: 1, profiles: { [ID]: stale() } });
    expect(await inspect()).toMatchObject({ kind: "stale", reason: "oauth" });
  });
});

describe("the owner's own DeepSeek key", () => {
  it("blocks the sign-in while DeepSeek still takes it", async () => {
    seedShared(storeBlob(apiKey(OWNER_KEY)), stateBlob());
    const asked = deepseekAnswers(200);
    const slot = await inspect({ checkOwnerKey: true });
    expect(slot).toEqual({ kind: "owner-key", type: "api_key", rejected: false, evidence: "provider" });
    expect(slotBlocksSignIn(slot)).toBe(true);
    expect(asked).toHaveBeenCalledTimes(1);
    const [url, init] = asked.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OWNER_KEY}`);
  });

  it("asks the owner's own endpoint when the provider is pointed at one", async () => {
    seedShared(storeBlob(apiKey(OWNER_KEY)));
    const asked = deepseekAnswers(200);
    await inspect({ checkOwnerKey: true, ownerKeyBaseUrl: "https://llm.example.test/v1/" });
    expect((asked.mock.calls[0] as unknown as [string])[0]).toBe("https://llm.example.test/v1/models");
  });

  it("lets the sign-in replace it once DeepSeek refuses it — a key, so pasted over and kept", async () => {
    seedShared(storeBlob(apiKey(OWNER_KEY)));
    deepseekAnswers(401);
    const slot = await inspect({ checkOwnerKey: true });
    expect(slot).toEqual({ kind: "owner-key", type: "api_key", rejected: true, evidence: "provider" });
    expect(slotBlocksSignIn(slot)).toBe(false);
    expect(slotNeedsLogout(slot)).toBe(false);
    expect(slotNeedsBackup(slot)).toBe(true);
  });

  it("falls back on the gateway's own auth-failure record when DeepSeek cannot be asked", async () => {
    seedShared(storeBlob(apiKey(OWNER_KEY)), stateBlob("auth"));
    deepseekAnswers("unreachable");
    expect(await inspect({ checkOwnerKey: true })).toMatchObject({ rejected: true, evidence: "gateway" });
  });

  it("refuses to judge — and so blocks — when nobody can say", async () => {
    seedShared(storeBlob(apiKey(OWNER_KEY)), stateBlob("rate_limit"));
    deepseekAnswers(503);
    const slot = await inspect({ checkOwnerKey: true });
    expect(slot).toEqual({ kind: "owner-key", type: "api_key", rejected: null, evidence: null });
    expect(slotBlocksSignIn(slot)).toBe(true);
  });

  it("never sends the key anywhere on a cheap read", async () => {
    seedShared(storeBlob(apiKey(OWNER_KEY)));
    const asked = deepseekAnswers(401);
    expect(await inspect()).toMatchObject({ kind: "owner-key", rejected: null });
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("backing the slot up", () => {
  it("copies the entry and its usage stats into a 0600 file the answer names, never the credential", () => {
    seedShared(storeBlob(stale()), stateBlob());
    const result = backupClawaiSlot();
    returned.push(result);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.dirname(result.file)).toBe(authProfileBackupDir());
    expect(path.basename(result.file)).toMatch(/^deepseek_default-.*\.json$/);
    expect(fs.statSync(result.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(authProfileBackupDir()).mode & 0o777).toBe(0o700);
    const kept = JSON.parse(fs.readFileSync(result.file, "utf8"));
    expect(kept).toMatchObject({ profileId: ID, store: "shared", copy: "store", profile: stale() });
    expect(kept.usageStats).toMatchObject({ errorCount: 4, cooldownReason: "auth" });
  });

  it("never writes over another backup, and keeps the last twenty of an id", () => {
    seedShared(storeBlob(stale()));
    const files = new Set<string>();
    for (let i = 0; i < 23; i += 1) {
      const result = backupGatewayAuthProfile(ID, authProfileBackupDir());
      expect(result.ok).toBe(true);
      if (result.ok) files.add(result.file);
    }
    expect(files.size).toBe(23);
    expect(fs.readdirSync(authProfileBackupDir()).filter((name) => name.startsWith("deepseek_default-"))).toHaveLength(20);
  });

  it("answers absent when there is nothing to keep, and creates nothing", () => {
    seedShared(storeBlob());
    expect(backupClawaiSlot()).toEqual({ ok: false, reason: "absent" });
    expect(fs.existsSync(authProfileBackupDir())).toBe(false);
  });
});

describe("clearing the slot's cooldown", () => {
  it("drops only the slot's usage stats — every credential, order and other profile's stats stay", () => {
    seedShared(storeBlob(stale()), stateBlob());
    const before = sharedStore();
    expect(clearClawaiSlotFailures()).toEqual({ ok: true, store: "shared" });
    const state = sharedState() as { order: unknown; usageStats: Record<string, unknown> };
    expect(state.usageStats[ID]).toBeUndefined();
    expect(state.usageStats["anthropic:default"]).toEqual({ errorCount: 1 });
    expect(state.order).toEqual({ deepseek: [ID] });
    expect(sharedStore()).toEqual(before);
  });

  it("clears the main agent's own state row too, where core merges it over the shared one", () => {
    seedShared(storeBlob(stale()), stateBlob());
    seedAgent({ version: 1, profiles: {} }, stateBlob());
    expect(clearGatewayAuthProfileFailures([ID])).toEqual({ ok: true, store: "shared" });
    expect((agentState() as { usageStats: Record<string, unknown> }).usageStats[ID]).toBeUndefined();
  });

  it("answers no-store on a box without one, and creates nothing", () => {
    expect(clearClawaiSlotFailures()).toEqual({ ok: false, reason: "no-store" });
    expect(fs.existsSync(sharedDb)).toBe(false);
  });
});

describe("withGatewayAuthProfileCredential", () => {
  it("hands the credential to the check and answers only what the check answers", () => {
    seedShared(storeBlob(apiKey(OWNER_KEY)));
    const answer = withGatewayAuthProfileCredential(ID, (c) => ({ type: c.type, provider: c.provider, long: (c.secret ?? "").length }));
    returned.push(answer);
    expect(answer).toEqual({ type: "api_key", provider: "deepseek", long: OWNER_KEY.length });
  });

  it("answers null where there is no profile, and never calls the check", () => {
    const check = vi.fn();
    expect(withGatewayAuthProfileCredential(ID, check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });
});
