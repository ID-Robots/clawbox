/**
 * One profile of the gateway's auth store, read and replaced where the gateway
 * resolves it (the Claude sign-in incident of 2026-10-10) — on real SQLite
 * files shaped like OpenClaw 2026.9.4's, STRICT tables and all.
 *
 * What would make the fix worthless or harmful if it broke:
 *
 *  1. THE STORE THE GATEWAY READS. The shared row only when `auth.sharedStore`
 *     is exactly `{location: "state-db"}`, otherwise the main agent's; the one
 *     it does not read is never written, and nothing is ever created.
 *  2. A FENCE IS NOT A SIGN-IN. Core's own rule, every condition of it, no
 *     fingerprint for a marker — and WHICH fence: a renewal in flight is not a
 *     dead sign-in, and the row's own timestamp is what ages one.
 *  3. THE REPLACE. The new sign-in over whatever is there and its cooldown
 *     gone, every other profile and key as core left them — or nothing at all.
 *  4. NEVER A THROW, NEVER A TOKEN. Every outcome is a returned value, and no
 *     value or log line carries credential text.
 *  5. THE COPY A TURN RESOLVES. Under shared ownership the main agent's own
 *     copy of the id outranks the shared row: it is what the read answers and
 *     what the put must also replace — where it already is, and never made.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { saveEnv } from "@/tests/helpers/env";
import { tokenFingerprint, type GatewayAuthPaths } from "@/lib/anthropic-gateway-auth";
import {
  isOAuthRefreshFence,
  oauthRefreshFenceState,
  putGatewayOAuthProfile,
  readGatewayAuthProfile,
  type GatewayAuthStoreKind,
  type GatewayOAuthBundle,
} from "@/lib/openclaw-auth-store";

const ID = "anthropic:default";
const OLD = "sk-ant-oat01-FAKE-the-sign-in-that-was-there";
const OLD_REFRESH = "sk-ant-ort01-FAKE-the-refresh-that-was-there";
const NEW = "sk-ant-oat01-FAKE-the-new-sign-in";
const NEW_REFRESH = "sk-ant-ort01-FAKE-the-new-refresh";
const API_KEY = "sk-ant-api03-FAKE-a-pasted-key";
const SECRETS = [OLD, OLD_REFRESH, NEW, NEW_REFRESH, API_KEY];
const EXPIRES = 1_900_000_000_000;

/** Bytes sqlite opens and then cannot ask anything of. */
const GARBAGE = "this is not a database ".repeat(64);

const OWNED = { location: "state-db" };
const CLAIM = "0123456789abcdef0123456789abcdef";
const OTHER_CLAIM = "fedcba9876543210fedcba9876543210";

// The DDL core creates these tables with (dist/*.mjs, 2026.9.4).
const SHARED_DDL = "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT";
const AGENT_STORE_DDL = "CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT";
const AGENT_STATE_DDL = "CREATE TABLE auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT";

let home = "";
let paths: GatewayAuthPaths;
let agentDbPath = "";
/** Everything the module handed back in one test; checked for credential text when it ends. */
let returned: unknown[] = [];
let logged: MockInstance<typeof console.error>;

function expectNoToken(value: unknown): void {
  const text = JSON.stringify(value) ?? String(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

function oauth(access: string, refresh: string, expires: number): Record<string, unknown> {
  return { type: "oauth", provider: "anthropic", access, refresh, expires };
}

/** The marker pair core leaves in place of a credential it is refreshing — or could not refresh. */
function fence(opts: { failed?: boolean; refreshClaim?: string; refreshFailed?: boolean } = {}): Record<string, unknown> {
  const failed = opts.failed ?? true;
  const state = (on: boolean) => (on ? "failed:" : "");
  return {
    type: "oauth",
    provider: "anthropic",
    access: `openclaw-oauth-refresh-fence:v1:${CLAIM}:${state(failed)}access:${"a".repeat(64)}`,
    refresh: `openclaw-oauth-refresh-fence:v1:${opts.refreshClaim ?? CLAIM}:${state(opts.refreshFailed ?? failed)}refresh:${"b".repeat(64)}`,
    expires: 1,
  };
}

const OTHERS = {
  "openai:chatgpt": { type: "oauth", provider: "openai", access: "FAKE-openai-access", refresh: "FAKE-openai-refresh", expires: 2_000 },
  "anthropic:manual": { type: "api_key", provider: "anthropic", key: API_KEY },
};

/** A store blob holding `entry` at the profile under test (nothing there when undefined), among other profiles. */
function storeBlob(entry?: unknown) {
  return { version: 1, profiles: { ...(entry === undefined ? {} : { [ID]: entry }), ...OTHERS } };
}

function stateBlob() {
  return {
    version: 1,
    order: { anthropic: [ID] },
    lastGood: { anthropic: ID },
    usageStats: {
      [ID]: { cooldownUntil: 9_999_999_999_999, errorCount: 3 },
      "openai:chatgpt": { errorCount: 1 },
    },
  };
}

function bundle(patch: Record<string, unknown> = {}): GatewayOAuthBundle {
  return { type: "oauth", provider: "anthropic", access: NEW, refresh: NEW_REFRESH, expires: EXPIRES, ...patch } as GatewayOAuthBundle;
}

/** A cell's text: a string goes in as it is (so a test can store what is not JSON), anything else as JSON. */
const cellText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

function sharedDb(rows: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(paths.sharedDb), { recursive: true });
  const db = new DatabaseSync(paths.sharedDb);
  db.exec(SHARED_DDL);
  const insert = db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)");
  for (const [key, value] of Object.entries(rows)) insert.run(key, cellText(value), BUILT_AT);
  db.close();
}

function agentDb(store?: unknown, state?: unknown): void {
  fs.mkdirSync(path.dirname(agentDbPath), { recursive: true });
  const db = new DatabaseSync(agentDbPath);
  db.exec(AGENT_STORE_DDL);
  db.exec(AGENT_STATE_DDL);
  if (store !== undefined) db.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", cellText(store), BUILT_AT);
  if (state !== undefined) db.prepare("INSERT INTO auth_profile_state VALUES (?, ?, ?)").run("primary", cellText(state), BUILT_AT);
  db.close();
}

function exec(file: string, sql: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

interface Row {
  json: string;
  stamp: number;
}

function row(file: string, sql: string, key: string): Row | undefined {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).get(key) as Row | undefined;
  } finally {
    db.close();
  }
}

const sharedRow = (key: string) => row(paths.sharedDb, "SELECT value_json AS json, updated_at_ms AS stamp FROM config_machine_state WHERE state_key = ?", key);
const agentStoreRow = () => row(agentDbPath, "SELECT store_json AS json, updated_at AS stamp FROM auth_profile_store WHERE store_key = ?", "primary");
const agentStateRow = () => row(agentDbPath, "SELECT state_json AS json, updated_at AS stamp FROM auth_profile_state WHERE state_key = ?", "primary");

/** The same scenarios against either store the gateway can resolve. */
const STORES: Record<GatewayAuthStoreKind, {
  file(): string;
  build(store: unknown, state?: unknown): void;
  store(): Row | undefined;
  state(): Row | undefined;
  /** Make sqlite refuse any write of the state row. */
  refuseStateWrites(): void;
}> = {
  shared: {
    file: () => paths.sharedDb,
    build: (store, state) => sharedDb({ "auth.sharedStore": OWNED, "authProfiles.store": store, ...(state === undefined ? {} : { "authProfiles.state": state }) }),
    store: () => sharedRow("authProfiles.store"),
    state: () => sharedRow("authProfiles.state"),
    refuseStateWrites: () => exec(paths.sharedDb, "CREATE TRIGGER refuse BEFORE UPDATE ON config_machine_state WHEN NEW.state_key = 'authProfiles.state' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END"),
  },
  agent: {
    file: () => agentDbPath,
    build: (store, state) => agentDb(store, state),
    store: agentStoreRow,
    state: agentStateRow,
    refuseStateWrites: () => exec(agentDbPath, "CREATE TRIGGER refuse BEFORE UPDATE ON auth_profile_state BEGIN SELECT RAISE(ABORT, 'refused by the test'); END"),
  },
};

function read(profileId: string = ID) {
  const result = readGatewayAuthProfile(profileId, paths);
  returned.push(result);
  return result;
}

function put(given: unknown = bundle(), profileId: string = ID) {
  const result = putGatewayOAuthProfile(profileId, given as GatewayOAuthBundle, paths);
  returned.push(result);
  return result;
}

/** The row timestamp the fixtures are built with; a put leaves its own clock there instead. */
const BUILT_AT = 1;

/** What a read answers once the new sign-in is what the store holds. */
const signedIn = (store: GatewayAuthStoreKind) => ({
  kind: "present",
  store,
  type: "oauth",
  fingerprint: tokenFingerprint(NEW),
  refreshFingerprint: tokenFingerprint(NEW_REFRESH),
  expires: EXPIRES,
  fenced: false,
  fence: null,
  storeUpdatedAtMs: expect.any(Number),
});

/** The same sign-in as one copy of a profile, without the row it was read from. */
const NEW_COPY = {
  type: "oauth",
  fingerprint: tokenFingerprint(NEW),
  refreshFingerprint: tokenFingerprint(NEW_REFRESH),
  expires: EXPIRES,
  fenced: false,
  fence: null,
};
const OLD_COPY = {
  type: "oauth",
  fingerprint: tokenFingerprint(OLD),
  refreshFingerprint: tokenFingerprint(OLD_REFRESH),
  expires: 5_000,
  fenced: false,
  fence: null,
};
const FAILED_FENCE_COPY = { type: "oauth", fingerprint: null, refreshFingerprint: null, expires: 1, fenced: true, fence: "failed" };

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-auth-store-")));
  paths = { agentsDir: path.join(home, "agents"), sharedDb: path.join(home, "state", "openclaw.sqlite") };
  agentDbPath = path.join(paths.agentsDir, "main", "agent", "openclaw-agent.sqlite");
  returned = [];
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  expectNoToken(returned);
  expectNoToken(logged.mock.calls);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("which store the gateway reads", () => {
  it("answers no-store, and creates nothing, on a box with no OpenClaw sqlite at all", () => {
    expect(read()).toEqual({ kind: "no-store" });
    expect(put()).toEqual({ ok: false, reason: "no-store" });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("reads the shared row when `auth.sharedStore` says the gateway does — not another profile the main agent holds beside it", () => {
    sharedDb({ "auth.sharedStore": OWNED, "authProfiles.store": storeBlob(oauth(OLD, OLD_REFRESH, 5_000)) });
    // The main agent's own row is there, as core makes it, and holds no copy of THIS id.
    agentDb({ version: 1, profiles: { "anthropic:elsewhere": oauth(NEW, NEW_REFRESH, EXPIRES) } });
    const answer = read();
    expect(answer).toEqual({ kind: "present", store: "shared", ...OLD_COPY, storeUpdatedAtMs: BUILT_AT });
    expect(answer).not.toHaveProperty("sharedCopy");
    expect(read("anthropic:nobody")).toEqual({ kind: "absent", store: "shared" });
  });

  it.each<[string, unknown]>([
    ["absent", undefined],
    ["`legacy-main`", { location: "legacy-main" }],
    ["`state-db` beside another key", { location: "state-db", since: 1 }],
    ["a bare string", '"state-db"'],
    ["not JSON at all", "state-db"],
  ])("falls to the main agent's store when the ownership row is %s", (_label, ownership) => {
    // The shared row holds a sign-in too; core never consults it without the ownership row.
    sharedDb({ ...(ownership === undefined ? {} : { "auth.sharedStore": ownership }), "authProfiles.store": storeBlob(oauth(OLD, OLD_REFRESH, 5_000)) });
    agentDb(storeBlob(oauth(NEW, NEW_REFRESH, EXPIRES)));
    expect(read()).toEqual(signedIn("agent"));
    expect(read("anthropic:nobody")).toEqual({ kind: "absent", store: "agent" });
  });

  it("falls to the main agent's store when the state database has no `config_machine_state` table", () => {
    fs.mkdirSync(path.dirname(paths.sharedDb), { recursive: true });
    exec(paths.sharedDb, "CREATE TABLE something_else (x TEXT)");
    agentDb(storeBlob(oauth(NEW, NEW_REFRESH, EXPIRES)));
    expect(read()).toEqual(signedIn("agent"));
  });

  it("answers no-store when ownership is absent and there is no main agent database", () => {
    sharedDb({ "authProfiles.store": storeBlob(oauth(OLD, OLD_REFRESH, 5_000)) });
    expect(read()).toEqual({ kind: "no-store" });
    expect(put()).toEqual({ ok: false, reason: "no-store" });
    expect(fs.existsSync(agentDbPath)).toBe(false);
  });

  it("answers no-store, and makes no row, when the shared store the gateway owns has none — the agent's is no fallback for it", () => {
    sharedDb({ "auth.sharedStore": OWNED });
    agentDb(storeBlob(oauth(OLD, OLD_REFRESH, 5_000)));
    const before = agentStoreRow();
    expect(read()).toEqual({ kind: "no-store" });
    expect(put()).toEqual({ ok: false, reason: "no-store" });
    expect(sharedRow("authProfiles.store")).toBeUndefined();
    expect(agentStoreRow()).toEqual(before);
  });

  it("answers no-store, and makes neither table nor row, for a main agent database without them", () => {
    fs.mkdirSync(path.dirname(agentDbPath), { recursive: true });
    exec(agentDbPath, "CREATE TABLE session_nodes (session_key TEXT)");
    expect(read()).toEqual({ kind: "no-store" });
    expect(put()).toEqual({ ok: false, reason: "no-store" });
    exec(agentDbPath, AGENT_STORE_DDL);
    expect(read()).toEqual({ kind: "no-store" });
    expect(put()).toEqual({ ok: false, reason: "no-store" });
    expect(agentStoreRow()).toBeUndefined();
  });

  it("resolves the box's own store through gatewayAuthPaths() when it is handed no paths", () => {
    const restore = saveEnv("OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_AGENTS_DIR");
    try {
      process.env.OPENCLAW_HOME = home;
      process.env.CLAWBOX_OPENCLAW_HOME = "";
      process.env.OPENCLAW_STATE_DIR = "";
      delete process.env.OPENCLAW_AGENTS_DIR;
      STORES.shared.build(storeBlob(fence()));
      expect(readGatewayAuthProfile(ID)).toMatchObject({ kind: "present", store: "shared", fenced: true, fence: "failed" });
      expect(putGatewayOAuthProfile(ID, bundle())).toEqual({ ok: true, store: "shared" });
      expect(readGatewayAuthProfile(ID)).toEqual(signedIn("shared"));
    } finally {
      restore();
    }
  });
});

describe("a refresh fence", () => {
  it("is core's marker pair — one claim, one state, an expiry of exactly 1 — failed or still pending", () => {
    expect(isOAuthRefreshFence(fence())).toBe(true);
    expect(isOAuthRefreshFence(fence({ failed: false }))).toBe(true);
    // core keeps the profile's other fields on the marker; they change nothing.
    expect(isOAuthRefreshFence({ ...fence(), email: "someone@example.test" })).toBe(true);
  });

  it("says WHICH: a renewal in flight is `pending`, one that errored is `failed`", () => {
    // What core's `parseOAuthRefreshFence` answers as `state`, off the same group.
    expect(oauthRefreshFenceState(fence({ failed: false }))).toBe("pending");
    expect(oauthRefreshFenceState(fence())).toBe("failed");
    expect(oauthRefreshFenceState({ ...fence({ failed: false }), email: "someone@example.test" })).toBe("pending");
    // Halves in two different states are no fence at all, so they have no state.
    expect(oauthRefreshFenceState(fence({ failed: true, refreshFailed: false }))).toBeNull();
    expect(oauthRefreshFenceState(fence({ failed: false, refreshFailed: true }))).toBeNull();
    expect(oauthRefreshFenceState(oauth(OLD, OLD_REFRESH, 1))).toBeNull();
  });

  it.each<[string, unknown]>([
    ["an expiry of 2", { ...fence(), expires: 2 }],
    ["an expiry that is the string 1", { ...fence(), expires: "1" }],
    ["a marker access token beside a real refresh token", { ...fence(), refresh: OLD_REFRESH }],
    ["a real access token beside a marker refresh token", { ...fence(), access: OLD }],
    ["markers of two different claims", fence({ refreshClaim: OTHER_CLAIM })],
    ["a failed half beside a pending one", fence({ failed: true, refreshFailed: false })],
    ["the two markers swapped", { ...fence(), access: fence().refresh, refresh: fence().access }],
    ["a `token` profile wearing the markers", { ...fence(), type: "token" }],
    ["a profile with no refresh field", { ...fence(), refresh: undefined }],
    ["null", null],
    ["a string", String(fence().access)],
    ["nothing", undefined],
  ])("is not %s", (_label, entry) => {
    expect(isOAuthRefreshFence(entry)).toBe(false);
    expect(oauthRefreshFenceState(entry)).toBeNull();
  });

  describe.each(["shared", "agent"] as const)("read from the %s store", (kind) => {
    it("is present and fenced, with no fingerprint — a marker is not a token", () => {
      STORES[kind].build(storeBlob(fence()));
      expect(read()).toEqual({ kind: "present", store: kind, ...FAILED_FENCE_COPY, storeUpdatedAtMs: BUILT_AT });
    });

    it("is told apart from a renewal in flight, which core will settle by itself", () => {
      STORES[kind].build(storeBlob(fence({ failed: false })));
      expect(read()).toEqual({ kind: "present", store: kind, ...FAILED_FENCE_COPY, fence: "pending", storeUpdatedAtMs: BUILT_AT });
    });

    it("carries the store row's own timestamp, which is what a pending fence is aged by", () => {
      STORES[kind].build(storeBlob(fence({ failed: false })), stateBlob());
      const writtenAt = 1_791_637_495_210;
      exec(STORES[kind].file(), kind === "shared"
        // The state row beside it is another row with another clock; only the store row's counts.
        ? `UPDATE config_machine_state SET updated_at_ms = ${writtenAt} WHERE state_key = 'authProfiles.store'`
        : `UPDATE auth_profile_store SET updated_at = ${writtenAt}`);
      expect(read()).toMatchObject({ fence: "pending", storeUpdatedAtMs: writtenAt });
      // A put stamps the row with its own clock, as core's writes do.
      const before = Date.now();
      expect(put()).toEqual({ ok: true, store: kind });
      const after = read();
      expect(after).toMatchObject({ kind: "present", fence: null });
      expect((after as { storeUpdatedAtMs: number }).storeUpdatedAtMs).toBeGreaterThanOrEqual(before);
    });
  });

  it("reads a near-miss as an ordinary profile: not fenced, and still no fingerprint for the half that is a marker", () => {
    STORES.shared.build(storeBlob({ ...fence(), refresh: OLD_REFRESH }));
    expect(read()).toEqual({
      kind: "present",
      store: "shared",
      type: "oauth",
      fingerprint: null,
      refreshFingerprint: tokenFingerprint(OLD_REFRESH),
      expires: 1,
      fenced: false,
      fence: null,
      storeUpdatedAtMs: BUILT_AT,
    });
  });
});

describe("what a profile is read as", () => {
  it("fingerprints the credential each profile type holds", () => {
    STORES.agent.build({
      profiles: {
        "anthropic:setup": { type: "token", provider: "anthropic", token: OLD, expires: 7 },
        "anthropic:manual": { type: "api_key", provider: "anthropic", key: API_KEY },
      },
    });
    const unfenced = { fenced: false, fence: null, storeUpdatedAtMs: BUILT_AT };
    expect(read("anthropic:setup")).toEqual({ kind: "present", store: "agent", type: "token", fingerprint: tokenFingerprint(OLD), refreshFingerprint: null, expires: 7, ...unfenced });
    expect(read("anthropic:manual")).toEqual({ kind: "present", store: "agent", type: "api_key", fingerprint: tokenFingerprint(API_KEY), refreshFingerprint: null, expires: null, ...unfenced });
  });

  it("answers null where there is nothing to fingerprint, and the type as stored", () => {
    STORES.agent.build({
      profiles: {
        "anthropic:empty": { type: "oauth", provider: "anthropic", access: "", refresh: "", expires: "soon" },
        "anthropic:odd": { type: "passkey", provider: "anthropic", access: OLD },
        "anthropic:untyped": { provider: "anthropic", access: OLD },
      },
    });
    expect(read("anthropic:empty")).toEqual({ kind: "present", store: "agent", type: "oauth", fingerprint: null, refreshFingerprint: null, expires: null, fenced: false, fence: null, storeUpdatedAtMs: BUILT_AT });
    expect(read("anthropic:odd")).toMatchObject({ kind: "present", type: "passkey", fingerprint: null });
    expect(read("anthropic:untyped")).toMatchObject({ kind: "present", type: "", fingerprint: null });
  });

  it("answers absent for an id the store holds no profile at", () => {
    STORES.shared.build({ version: 1, profiles: { "anthropic:null": null, "anthropic:text": "oauth", "anthropic:list": [] } });
    for (const id of ["anthropic:null", "anthropic:text", "anthropic:list", "anthropic:nobody", "toString", "__proto__", ""]) {
      expect(read(id)).toEqual({ kind: "absent", store: "shared" });
    }
  });

  it("reads a store blob with no profile map as an empty store", () => {
    STORES.agent.build({ version: 1 });
    expect(read()).toEqual({ kind: "absent", store: "agent" });
    expect(put()).toEqual({ ok: true, store: "agent" });
    expect(JSON.parse(agentStoreRow()!.json)).toEqual({ version: 1, profiles: { [ID]: bundle() } });
  });

  describe.each(["shared", "agent"] as const)("in a %s store row it cannot make sense of", (kind) => {
    it.each<[string, string]>([
      ["text that is not JSON", "not json"],
      ["a JSON list", "[]"],
      ["a profile map that is a list", '{"version":1,"profiles":[]}'],
      ["a profile map that is a string", '{"version":1,"profiles":"none"}'],
      ["a null profile map", '{"version":1,"profiles":null}'],
    ])("answers unreadable for %s, and leaves it as it is", (_label, text) => {
      STORES[kind].build(text, stateBlob());
      const before = [STORES[kind].store(), STORES[kind].state()];
      expect(read()).toEqual({ kind: "unreadable" });
      expect(put()).toEqual({ ok: false, reason: "unreadable" });
      expect([STORES[kind].store(), STORES[kind].state()]).toEqual(before);
    });
  });
});

describe.each(["shared", "agent"] as const)("putting a sign-in in the %s store", (kind) => {
  const s = STORES[kind];

  it.each<[string, unknown]>([
    ["a failed fence", fence()],
    ["a healthy profile holding another account's sign-in", { ...oauth(OLD, OLD_REFRESH, 5_000), email: "previous@example.test" }],
    ["an api_key profile", { type: "api_key", provider: "anthropic", key: API_KEY }],
    ["nothing at this id", undefined],
  ])("puts it over %s, clears that id's cooldown and leaves everything else as core wrote it", (_label, before) => {
    s.build(storeBlob(before), stateBlob());
    const startedAt = Date.now();

    expect(put()).toEqual({ ok: true, store: kind });

    expect(read()).toEqual(signedIn(kind));
    const store = s.store()!;
    // The whole blob: the profile is the bundle and nothing of what was there, the rest untouched.
    expect(JSON.parse(store.json)).toEqual({ version: 1, profiles: { [ID]: bundle(), ...OTHERS } });
    expect(Number.isInteger(store.stamp)).toBe(true);
    expect(store.stamp).toBeGreaterThanOrEqual(startedAt);
    const state = s.state()!;
    expect(JSON.parse(state.json)).toEqual({ ...stateBlob(), usageStats: { "openai:chatgpt": { errorCount: 1 } } });
    expect(state.stamp).toBeGreaterThanOrEqual(startedAt);
    expect(logged).not.toHaveBeenCalled();
  });

  it("keeps the bundle's own extra fields, and accepts an empty refresh token — what a sign-in that returned none is written as", () => {
    s.build(storeBlob(fence()));
    expect(put(bundle({ refresh: "", email: "owner@example.test" }))).toEqual({ ok: true, store: kind });
    expect(read()).toEqual({ ...signedIn(kind), refreshFingerprint: null });
    expect(JSON.parse(s.store()!.json).profiles[ID]).toEqual({ type: "oauth", provider: "anthropic", access: NEW, refresh: "", expires: EXPIRES, email: "owner@example.test" });
  });

  it("reads and writes a WAL database, which is how core keeps its stores", () => {
    s.build(storeBlob(fence()), stateBlob());
    exec(s.file(), "PRAGMA journal_mode = WAL");
    expect(read()).toMatchObject({ kind: "present", store: kind, fenced: true, fence: "failed" });
    expect(put()).toEqual({ ok: true, store: kind });
    expect(read()).toEqual(signedIn(kind));
    expect(JSON.parse(s.state()!.json).usageStats).toEqual({ "openai:chatgpt": { errorCount: 1 } });
  });

  it("needs no state row, and makes none", () => {
    s.build(storeBlob(fence()));
    expect(put()).toEqual({ ok: true, store: kind });
    expect(read()).toEqual(signedIn(kind));
    expect(s.state()).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ["holds no stats for this id", { version: 1, usageStats: { "openai:chatgpt": { errorCount: 1 } } }],
    ["has no usage stats at all", { version: 1, lastGood: { anthropic: ID } }],
    ["is not JSON", "not json"],
  ])("leaves a state row alone when it %s", (_label, state) => {
    s.build(storeBlob(fence()), state);
    const before = s.state();
    expect(put()).toEqual({ ok: true, store: kind });
    expect(read()).toEqual(signedIn(kind));
    expect(s.state()).toEqual(before);
  });

  it("lands the sign-in and the cleared cooldown together or not at all", () => {
    s.build(storeBlob(fence()), stateBlob());
    s.refuseStateWrites();
    const before = [s.store(), s.state()];
    expect(put()).toEqual({ ok: false, reason: "write-failed" });
    expect([s.store(), s.state()]).toEqual(before);
    expect(read()).toMatchObject({ kind: "present", fenced: true });
    // sqlite's own words reach the journal, once.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][1])).toContain("refused by the test");
  });

  it.each<[string, unknown]>([
    ["no access token", bundle({ access: "" })],
    ["an access token that is not a string", bundle({ access: 7 })],
    ["a refresh token that is not a string", bundle({ refresh: null })],
    ["no refresh field", bundle({ refresh: undefined })],
    ["an expiry of zero", bundle({ expires: 0 })],
    ["a negative expiry", bundle({ expires: -1 })],
    ["an expiry that is not a number", bundle({ expires: "soon" })],
    ["an infinite expiry", bundle({ expires: Infinity })],
    ["an expiry that is NaN", bundle({ expires: NaN })],
    ["another profile type", bundle({ type: "token" })],
    ["no provider", bundle({ provider: "" })],
    ["a fence marker where the access token belongs", bundle({ access: fence().access })],
    ["a fence marker where the refresh token belongs", bundle({ refresh: fence().refresh })],
    ["nothing in it at all", null],
    ["a list", [bundle()]],
    ["a bare token string", NEW],
  ])("writes nothing for a bundle with %s", (_label, given) => {
    s.build(storeBlob(fence()), stateBlob());
    const before = [s.store(), s.state()];
    expect(put(given)).toEqual({ ok: false, reason: "write-failed" });
    expect([s.store(), s.state()]).toEqual(before);
  });

  it.each(["", "__proto__"])("writes nothing for the profile id %j, which core could not have written", (profileId) => {
    s.build(storeBlob(fence()), stateBlob());
    const before = [s.store(), s.state()];
    expect(put(bundle(), profileId)).toEqual({ ok: false, reason: "write-failed" });
    expect([s.store(), s.state()]).toEqual(before);
  });
});

describe("the store the gateway does not read", () => {
  it("is never written: with shared ownership a main agent's row that holds no copy of the id stays as it was", () => {
    STORES.shared.build(storeBlob(fence()), stateBlob());
    // Core's own `models auth order set --agent main` leaves exactly this: the row, and no profile in it.
    agentDb({ version: 1, profiles: { "openai:chatgpt": OTHERS["openai:chatgpt"] } }, stateBlob());
    const before = [agentStoreRow(), agentStateRow()];
    expect(put()).toEqual({ ok: true, store: "shared" });
    expect(read()).toEqual(signedIn("shared"));
    // Byte for byte, timestamp included: no profile is made there, and stats under the id with no copy are not this module's.
    expect([agentStoreRow(), agentStateRow()]).toEqual(before);
  });

  it("is never written: without ownership the shared rows stay as they were", () => {
    sharedDb({ "authProfiles.store": storeBlob(fence()), "authProfiles.state": stateBlob() });
    agentDb(storeBlob(fence()), stateBlob());
    const before = [sharedRow("authProfiles.store"), sharedRow("authProfiles.state")];
    expect(put()).toEqual({ ok: true, store: "agent" });
    expect([sharedRow("authProfiles.store"), sharedRow("authProfiles.state")]).toEqual(before);
    expect(sharedRow("auth.sharedStore")).toBeUndefined();
  });
});

/**
 * Under `state-db` ownership core still merges the main agent's own auth row
 * OVER the shared one, id by id. Proven against the installed 2026.9.4 in
 * isolated homes: a fenced copy there makes the resolver throw the incident's
 * sentence whatever the shared row holds, core's own writes and `doctor --fix`
 * leave it standing — and a gate that read and wrote the shared row alone
 * answered "stored" over a chat that stayed dead.
 */
describe("the main agent's own copy, under shared ownership", () => {
  /** Shared ownership, `shared` at the id in the shared row and `local` in the main agent's own. */
  function both(shared: unknown, local: unknown, states: { shared?: unknown; local?: unknown } = {}): void {
    STORES.shared.build(storeBlob(shared), states.shared);
    agentDb(storeBlob(local), states.local);
  }

  it("is what the read answers: a fence there is the incident, whatever the shared row holds", () => {
    both(oauth(OLD, OLD_REFRESH, 5_000), fence());
    expect(read()).toEqual({ kind: "present", store: "shared", ...FAILED_FENCE_COPY, storeUpdatedAtMs: BUILT_AT, sharedCopy: OLD_COPY });
  });

  it("is what the read answers the other way round too: a sign-in there works over a fence in the shared row", () => {
    both(fence(), oauth(OLD, OLD_REFRESH, 5_000));
    expect(read()).toEqual({ kind: "present", store: "shared", ...OLD_COPY, storeUpdatedAtMs: BUILT_AT, sharedCopy: FAILED_FENCE_COPY });
  });

  it("says the shared row holds nothing at the id beside it", () => {
    both(undefined, fence({ failed: false }));
    expect(read()).toEqual({ kind: "present", store: "shared", ...FAILED_FENCE_COPY, fence: "pending", storeUpdatedAtMs: BUILT_AT, sharedCopy: null });
  });

  it("is aged by its OWN row's timestamp, not the shared row's", () => {
    STORES.shared.build(storeBlob(oauth(OLD, OLD_REFRESH, 5_000)));
    agentDb({ version: 1, profiles: { [ID]: fence({ failed: false }) } });
    exec(paths.sharedDb, "UPDATE config_machine_state SET updated_at_ms = 111");
    exec(agentDbPath, "UPDATE auth_profile_store SET updated_at = 222");
    expect(read()).toMatchObject({ fence: "pending", storeUpdatedAtMs: 222 });
    // An id only the shared row holds is answered from it, and aged by it.
    const shared = read("openai:chatgpt");
    expect(shared).toMatchObject({ kind: "present", store: "shared", storeUpdatedAtMs: 111 });
    expect(shared).not.toHaveProperty("sharedCopy");
  });

  it.each<[string, () => void]>([
    ["a row holding other profiles only", () => agentDb({ version: 1, profiles: { "openai:chatgpt": OTHERS["openai:chatgpt"] } }, stateBlob())],
    ["null at the id", () => agentDb({ version: 1, profiles: { [ID]: null } }, stateBlob())],
    ["a string at the id", () => agentDb({ version: 1, profiles: { [ID]: "oauth" } }, stateBlob())],
    ["a row with no profile map", () => agentDb({ version: 1 }, stateBlob())],
    ["a row whose profile map is a list", () => agentDb('{"version":1,"profiles":[]}', stateBlob())],
    ["a row that is not JSON", () => agentDb("not json", stateBlob())],
    ["a table with no row", () => agentDb(undefined, stateBlob())],
    ["a database without the auth tables", () => {
      fs.mkdirSync(path.dirname(agentDbPath), { recursive: true });
      exec(agentDbPath, "CREATE TABLE session_nodes (session_key TEXT)");
    }],
  ])("is not %s: the shared row answers alone, and the put leaves the main agent's database as it was", (_label, buildAgent) => {
    STORES.shared.build(storeBlob(fence()), stateBlob());
    buildAgent();
    const hasTables = () => {
      const db = new DatabaseSync(agentDbPath, { readOnly: true });
      try {
        return db.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_profile_store'").get() !== undefined;
      } finally {
        db.close();
      }
    };
    const rows = () => (hasTables() ? [agentStoreRow(), agentStateRow()] : "no auth tables");
    const before = rows();

    const answer = read();
    expect(answer).toEqual({ kind: "present", store: "shared", ...FAILED_FENCE_COPY, storeUpdatedAtMs: BUILT_AT });
    expect(answer).not.toHaveProperty("sharedCopy");

    expect(put()).toEqual({ ok: true, store: "shared" });
    const after = read();
    expect(after).toEqual(signedIn("shared"));
    expect(after).not.toHaveProperty("sharedCopy");
    // No profile, row or table is made for it, and stats filed under the id with no copy are left alone.
    expect(rows()).toEqual(before);
  });

  it("makes no database where the main agent has none", () => {
    STORES.shared.build(storeBlob(fence()), stateBlob());
    expect(put()).toEqual({ ok: true, store: "shared" });
    expect(read()).toEqual(signedIn("shared"));
    expect(fs.existsSync(paths.agentsDir)).toBe(false);
  });

  it.each<[string, unknown]>([
    ["a failed fence", fence()],
    ["another account's sign-in", { ...oauth(OLD, OLD_REFRESH, 5_000), email: "previous@example.test" }],
    ["an api_key profile", { type: "api_key", provider: "anthropic", key: API_KEY }],
  ])("is replaced by the put when it holds %s — with its own cooldown cleared, and nothing else of the main agent's touched", (_label, local) => {
    both(fence(), local, { shared: stateBlob(), local: stateBlob() });
    const startedAt = Date.now();

    // What the route's gate does: the copy a turn resolves is not the sign-in…
    expect(read()).not.toMatchObject(NEW_COPY);
    expect(put()).toEqual({ ok: true, store: "shared" });
    // …and afterwards BOTH copies are.
    expect(read()).toEqual({ ...signedIn("shared"), sharedCopy: NEW_COPY });

    for (const store of [sharedRow("authProfiles.store")!, agentStoreRow()!]) {
      expect(JSON.parse(store.json)).toEqual({ version: 1, profiles: { [ID]: bundle(), ...OTHERS } });
      expect(store.stamp).toBeGreaterThanOrEqual(startedAt);
    }
    for (const state of [sharedRow("authProfiles.state")!, agentStateRow()!]) {
      expect(JSON.parse(state.json)).toEqual({ ...stateBlob(), usageStats: { "openai:chatgpt": { errorCount: 1 } } });
      expect(state.stamp).toBeGreaterThanOrEqual(startedAt);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("is replaced where the shared row held nothing at the id, which then holds the sign-in too", () => {
    both(undefined, fence());
    expect(put()).toEqual({ ok: true, store: "shared" });
    expect(read()).toEqual({ ...signedIn("shared"), sharedCopy: NEW_COPY });
    // No state row was there for either, and none is made.
    expect(sharedRow("authProfiles.state")).toBeUndefined();
    expect(agentStateRow()).toBeUndefined();
  });

  it("is replaced in a WAL database, which is how core keeps the agent's", () => {
    both(fence(), fence(), { shared: stateBlob(), local: stateBlob() });
    exec(paths.sharedDb, "PRAGMA journal_mode = WAL");
    exec(agentDbPath, "PRAGMA journal_mode = WAL");
    expect(put()).toEqual({ ok: true, store: "shared" });
    expect(read()).toEqual({ ...signedIn("shared"), sharedCopy: NEW_COPY });
  });

  it("never MAKES the copy: one that went away between the put's look and its write is not put back", async () => {
    both(fence(), fence(), { shared: stateBlob(), local: stateBlob() });
    const emptied = { version: 1, profiles: { "openai:chatgpt": OTHERS["openai:chatgpt"] } };
    vi.resetModules();
    const real = await vi.importActual<typeof import("@/lib/openclaw-session-store")>("@/lib/openclaw-session-store");
    // Another writer — the CLI, the gateway being stopped — drops the copy
    // after the put has seen it and before the put holds the agent's lock.
    vi.doMock("@/lib/openclaw-session-store", () => ({
      ...real,
      openSqlite: (file: string, readOnly: boolean) => {
        if (file === agentDbPath && !readOnly) {
          const db = new DatabaseSync(agentDbPath);
          db.prepare("UPDATE auth_profile_store SET store_json = ?").run(JSON.stringify(emptied));
          db.close();
        }
        return real.openSqlite(file, readOnly);
      },
    }));
    try {
      const raced = await import("@/lib/openclaw-auth-store");
      const result = raced.putGatewayOAuthProfile(ID, bundle(), paths);
      returned.push(result);
      expect(result).toEqual({ ok: true, store: "shared" });
    } finally {
      vi.doUnmock("@/lib/openclaw-session-store");
      vi.resetModules();
    }
    // The shared row took the sign-in; the agent's row is as the other writer left it, stats and all.
    expect(read()).toEqual(signedIn("shared"));
    expect(JSON.parse(agentStoreRow()!.json)).toEqual(emptied);
    expect(JSON.parse(agentStateRow()!.json)).toEqual(stateBlob());
  });

  it("fails the put WHOLE when the main agent's database cannot be asked — nothing is written anywhere", () => {
    STORES.shared.build(storeBlob(fence()), stateBlob());
    fs.mkdirSync(path.dirname(agentDbPath), { recursive: true });
    fs.writeFileSync(agentDbPath, GARBAGE);
    const before = [sharedRow("authProfiles.store"), sharedRow("authProfiles.state")];

    // Whether a copy there outranks the shared row cannot be known, so neither can what a turn resolves.
    expect(read()).toEqual({ kind: "unreadable", cause: expect.stringMatching(/not a database/i) });
    expect(put()).toEqual({ ok: false, reason: "unreadable" });

    expect([sharedRow("authProfiles.store"), sharedRow("authProfiles.state")]).toEqual(before);
    expect(fs.readFileSync(agentDbPath, "utf-8")).toBe(GARBAGE);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("answers write-failed, and says which half, when the copy refuses the write the shared row took", () => {
    both(fence(), fence(), { shared: stateBlob(), local: stateBlob() });
    STORES.agent.refuseStateWrites();
    const before = [agentStoreRow(), agentStateRow()];

    expect(put()).toEqual({ ok: false, reason: "write-failed" });

    // The copy's two rows moved together or not at all…
    expect([agentStoreRow(), agentStateRow()]).toEqual(before);
    // …and two databases do not commit as one: the shared row holds the
    // sign-in, and the copy a turn resolves is still the fence. The read says
    // exactly that, which is what keeps the caller from calling it stored.
    expect(read()).toEqual({ kind: "present", store: "shared", ...FAILED_FENCE_COPY, storeUpdatedAtMs: BUILT_AT, sharedCopy: NEW_COPY });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain("the main agent's own copy");
    expect(String(logged.mock.calls[0][1])).toContain("refused by the test");
  });

  it("is not a thing under legacy-main, where the main agent's row IS the store", () => {
    // A shared row with no ownership beside it: core never consults it.
    sharedDb({ "authProfiles.store": storeBlob(oauth(OLD, OLD_REFRESH, 5_000)) });
    agentDb(storeBlob(fence()), stateBlob());
    const answer = read();
    expect(answer).toEqual({ kind: "present", store: "agent", ...FAILED_FENCE_COPY, storeUpdatedAtMs: BUILT_AT });
    expect(answer).not.toHaveProperty("sharedCopy");
    expect(put()).toEqual({ ok: true, store: "agent" });
    const after = read();
    expect(after).toEqual(signedIn("agent"));
    expect(after).not.toHaveProperty("sharedCopy");
  });
});

describe("a store that cannot be used", () => {
  it.each(["shared", "agent"] as const)("answers unreadable for a corrupt %s database, and does not touch the file", (kind) => {
    const file = STORES[kind].file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, GARBAGE);
    const answer = read();
    // WHY it could not be read travels with the answer, in sqlite's own words…
    expect(answer).toEqual({ kind: "unreadable", cause: expect.stringMatching(/\S/) });
    expect((answer as { cause: string }).cause).toMatch(/not a database/i);
    // …and is not logged from a read: the status strip and the chat header ask on every poll.
    expect(logged).not.toHaveBeenCalled();
    expect(put()).toEqual({ ok: false, reason: "unreadable" });
    expect(fs.readFileSync(file, "utf-8")).toBe(GARBAGE);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("does not take a corrupt state database for 'no shared store' and write the agent's instead", () => {
    fs.mkdirSync(path.dirname(paths.sharedDb), { recursive: true });
    fs.writeFileSync(paths.sharedDb, GARBAGE);
    agentDb(storeBlob(fence()), stateBlob());
    const before = [agentStoreRow(), agentStateRow()];
    expect(read()).toMatchObject({ kind: "unreadable" });
    expect(put()).toEqual({ ok: false, reason: "unreadable" });
    expect([agentStoreRow(), agentStateRow()]).toEqual(before);
  });

  it("never throws, whatever it is handed for paths", () => {
    const junk = {} as GatewayAuthPaths;
    expect(() => returned.push(readGatewayAuthProfile(ID, junk))).not.toThrow();
    expect(() => returned.push(putGatewayOAuthProfile(ID, bundle(), junk))).not.toThrow();
    expect(returned).toEqual([{ kind: "unreadable", cause: expect.any(String) }, { ok: false, reason: "unreadable" }]);
  });

  it("still answers, rather than throwing, in a suite that replaced anthropic-gateway-auth with a partial mock", async () => {
    STORES.shared.build(storeBlob(fence()), stateBlob());
    const before = [STORES.shared.store(), STORES.shared.state()];
    vi.resetModules();
    vi.doMock("@/lib/anthropic-gateway-auth", () => ({ tokenFingerprint }));
    try {
      const mocked = await import("@/lib/openclaw-auth-store");
      returned.push(mocked.readGatewayAuthProfile(ID, paths), mocked.putGatewayOAuthProfile(ID, bundle(), paths));
      expect(returned).toEqual([{ kind: "unreadable", cause: expect.any(String) }, { ok: false, reason: "unreadable" }]);
      // The rule itself needs nothing from that module.
      expect(mocked.isOAuthRefreshFence(fence())).toBe(true);
      expect(mocked.oauthRefreshFenceState(fence({ failed: false }))).toBe("pending");
    } finally {
      vi.doUnmock("@/lib/anthropic-gateway-auth");
      vi.resetModules();
    }
    expect([STORES.shared.store(), STORES.shared.state()]).toEqual(before);
  });
});

/**
 * Every suite that reaches `claudeSignInFenced` or the configure gate with the
 * real module resolves its store through `gatewayAuthPaths()`, which reads
 * FOUR variables. A shell that exports one the config does not floor sends
 * those suites to whatever store it names: with `OPENCLAW_AGENTS_DIR` pointed
 * at a real agents directory, `routes/providers/status.test.ts` read a fenced
 * profile out of it and failed. Pinned as text, because a floor that is
 * missing only shows on a machine that happens to export the variable.
 */
describe("the suite's own floor under the store", () => {
  it("names every variable gatewayAuthPaths() reads in vitest.config.ts's `test.env`", () => {
    const config = fs.readFileSync(path.resolve(__dirname, "../../../vitest.config.ts"), "utf-8");
    const start = config.indexOf("\n    env: {\n");
    expect(start).toBeGreaterThan(-1);
    const block = config.slice(start, config.indexOf("\n    },\n", start));
    for (const name of ["OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_AGENTS_DIR"]) {
      expect([name, new RegExp(`^      ${name}: `, "m").test(block)]).toEqual([name, true]);
    }
    // And the module reads no fifth: a new one belongs in that block too.
    const source = fs.readFileSync(path.resolve(__dirname, "../../lib/anthropic-gateway-auth.ts"), "utf-8");
    const body = source.slice(source.indexOf("export function gatewayAuthPaths()"), source.indexOf("export function tokenFingerprint"));
    const read = [...body.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]).filter((name) => name !== "HOME");
    expect([...new Set(read)].sort()).toEqual(["CLAWBOX_OPENCLAW_HOME", "OPENCLAW_AGENTS_DIR", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
  });
});
