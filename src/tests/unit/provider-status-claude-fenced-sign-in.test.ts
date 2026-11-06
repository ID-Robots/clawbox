import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { saveEnv } from "@/tests/helpers/env";
import type { GatewayAuthProfileRead } from "@/lib/openclaw-auth-store";

/**
 * A Claude sign-in the gateway will never use must not read "Connected" (the
 * incident of 2026-10-10).
 *
 * The strip derived the Anthropic row from openclaw.json's `auth.profiles`
 * alone — metadata that says a sign-in was filed. The credential is in the
 * gateway's own store, where core had swapped it for a refresh FENCE and made
 * the fence terminal on a DNS failure. Every turn died, the chat told the owner
 * to reconnect Anthropic in Settings, and Settings said Connected.
 *
 * What would make the fix worthless or harmful if it broke:
 *
 *  1. A DEAD FENCE IS NOT A SIGN-IN: the row says needs-reauth, default or not.
 *  2. POSITIVE EVIDENCE ONLY: no store, an unreadable one, no profile there, a
 *     healthy profile — each keeps the answer the strip gave before. This is
 *     never a second way to say "disconnected".
 *  3. ONLY WHEN THE SIGN-IN IS ALL THERE IS: a key of any kind beside a fenced
 *     leftover keeps the row connected, and the store is not even opened.
 *  4. THE READ IS NOT A TAX ON EVERYONE: a box with no Claude sign-in, and a
 *     Hermes box, never ask.
 *  5. A RENEWAL IN FLIGHT IS NOT A DEAD SIGN-IN: core commits a PENDING fence
 *     before every token refresh, so a healthy box holds one for a moment
 *     about three times a day. Only the fence core made terminal counts — or
 *     a pending one left longer than core lets a refresh run, whose owner is
 *     gone and which nothing will ever settle.
 */

const storeRead = vi.hoisted(() => vi.fn());

vi.mock("@/lib/openclaw-auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-auth-store")>()),
  readGatewayAuthProfile: storeRead,
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/clawbox-ai-portal-tier", () => ({ clawaiTokenRejectedByPortal: vi.fn(() => false) }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: vi.fn() }));
vi.mock("@/lib/hermes-model-options", () => ({ getModelOptions: vi.fn(), probeStillOwed: vi.fn(async () => false) }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) }));
vi.mock("@/lib/plugin-repair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugin-repair")>()),
  readPluginRepairs: vi.fn(async () => ({})),
}));
vi.mock("@/lib/provider-runnable", () => ({ readProviderRunnable: vi.fn(async () => new Map()) }));
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(async () => null),
}));

const ID = "anthropic:default";
const CLAIM = "0123456789abcdef0123456789abcdef";

/** The clock every case reads: `claudeSignInFenced` ages a pending fence against `Date.now()`. */
const NOW = 1_791_640_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** The fence core made terminal — what the box of the incident held, a day on. */
const FENCED: GatewayAuthProfileRead = {
  kind: "present", store: "shared", type: "oauth", fingerprint: null, refreshFingerprint: null, expires: 1, fenced: true,
  fence: "failed", storeUpdatedAtMs: NOW - 24 * 60 * MINUTE,
};
/** The same markers while core is still renewing, their row last written `ago` before now (null: no timestamp). */
const pending = (ago: number | null): GatewayAuthProfileRead => ({
  ...FENCED, fence: "pending", storeUpdatedAtMs: ago === null ? null : NOW - ago,
});
const HEALTHY: GatewayAuthProfileRead = {
  kind: "present", store: "shared", type: "oauth", fingerprint: "0011223344556677", refreshFingerprint: "8899aabbccddeeff", expires: 1_900_000_000_000, fenced: false,
  fence: null, storeUpdatedAtMs: NOW - 60 * MINUTE,
};

/** A Claude SUBSCRIPTION box as the configure route leaves openclaw.json: the profile's metadata and no provider definition. */
function subscriptionConfig(patch: Record<string, unknown> = {}) {
  return {
    auth: { profiles: { [ID]: { provider: "anthropic", mode: "oauth" } } },
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    ...patch,
  };
}

let readProviderStatus: typeof import("@/lib/provider-status").readProviderStatus;
let claudeSignInFenced: typeof import("@/lib/provider-status").claudeSignInFenced;
let getActiveHarness: Mock;
let readConfig: Mock;
let getModelOptions: Mock;

beforeEach(async () => {
  vi.resetModules();
  storeRead.mockReset();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ readConfig } = (await import("@/lib/openclaw-config")) as unknown as { readConfig: Mock });
  ({ getModelOptions } = (await import("@/lib/hermes-model-options")) as unknown as { getModelOptions: Mock });
  const credentials = (await import("@/lib/harness/credentials")) as unknown as { hasClawaiToken: Mock };
  credentials.hasClawaiToken.mockResolvedValue(false);
  getActiveHarness.mockResolvedValue("openclaw");
  readConfig.mockResolvedValue(subscriptionConfig());
  storeRead.mockReturnValue(FENCED);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  ({ readProviderStatus, claudeSignInFenced } = await import("@/lib/provider-status"));
});

async function claudeRow() {
  const summary = await readProviderStatus();
  expect(summary.degraded).toBe(false);
  const row = summary.providers.find((r) => r.id === "anthropic");
  expect(row).toBeDefined();
  return row!;
}

describe("Settings → Providers and a Claude sign-in the gateway cannot use", () => {
  it("says needs-reauth when the gateway's store holds a refresh fence where the sign-in was", async () => {
    const row = await claudeRow();

    expect(row.state).toBe("needs-reauth");
    expect(row.isDefault).toBe(false);
    // The profile the config names is the one asked about, once.
    expect(storeRead).toHaveBeenCalledTimes(1);
    expect(storeRead).toHaveBeenCalledWith(ID);
  });

  it("says it of the DEFAULT provider too — the box whose every turn was dying", async () => {
    readConfig.mockResolvedValue(subscriptionConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    }));

    const row = await claudeRow();

    expect(row.isDefault).toBe(true);
    expect(row.state).toBe("needs-reauth");
  });

  it("leaves every other row exactly as it was", async () => {
    const fenced = await readProviderStatus();
    storeRead.mockReturnValue(HEALTHY);
    const healthy = await readProviderStatus();

    const others = (summary: typeof fenced) => summary.providers.filter((r) => r.id !== "anthropic");
    expect(others(fenced)).toEqual(others(healthy));
    expect(fenced.defaultProvider).toBe(healthy.defaultProvider);
  });

  it.each<[string, GatewayAuthProfileRead]>([
    ["a healthy sign-in", HEALTHY],
    ["a store with no profile at that id", { kind: "absent", store: "shared" }],
    ["no store at all (a v1 box, a fresh home)", { kind: "no-store" }],
    ["a store that could not be read", { kind: "unreadable" }],
    // Not a fence by core's rule, so not one here: a sign-in with a spent expiry is core's to renew.
    ["an expired sign-in that is not a fence", { ...HEALTHY, expires: 1 }],
    // A healthy sign-in caught mid-renewal: measured on 2026.9.4, the pending
    // fence is in the row from the claim until the token endpoint answers.
    ["a renewal in flight — a pending fence written two seconds ago", pending(2 * SECOND)],
    ["a pending fence as old as core lets one refresh run", pending(2 * MINUTE)],
    ["a pending fence exactly at the margin", pending(150 * SECOND)],
    // Nothing to age it by is no evidence that it is old.
    ["a pending fence whose row carries no timestamp", pending(null)],
    // The box has no RTC: a clock that stepped BACK must not read as an age.
    ["a pending fence written 'after' now", pending(-10 * MINUTE)],
  ])("keeps Connected over %s", async (_name, answer) => {
    storeRead.mockReturnValue(answer);

    expect((await claudeRow()).state).toBe("connected");
    expect(storeRead).toHaveBeenCalledTimes(1);
  });

  // Core gives one refresh two minutes and then settles its marker. One still
  // pending past that lost its owner — a gateway stopped mid-renewal — and is
  // never settled: every turn waits the two minutes out on it and throws.
  it.each<[string, GatewayAuthProfileRead]>([
    ["just past the margin", pending(150 * SECOND + 1)],
    ["for five minutes", pending(5 * MINUTE)],
    ["since yesterday", pending(24 * 60 * MINUTE)],
  ])("says needs-reauth over a pending fence nobody has settled %s", async (_name, answer) => {
    storeRead.mockReturnValue(answer);

    expect((await claudeRow()).state).toBe("needs-reauth");
  });

  it("reads the clock at each look, so the same pending fence turns once it has been left too long", async () => {
    const writtenAt = NOW - 2 * SECOND;
    storeRead.mockReturnValue({ ...FENCED, fence: "pending", storeUpdatedAtMs: writtenAt });
    expect((await claudeRow()).state).toBe("connected");

    vi.spyOn(Date, "now").mockReturnValue(writtenAt + 5 * MINUTE);
    expect((await claudeRow()).state).toBe("needs-reauth");
  });

  it.each<[string, Record<string, unknown>]>([
    ["an API key under the provider definition", {
      models: { providers: { anthropic: { apiKey: "sk-ant-api03-FAKE-a-pasted-key", baseUrl: "https://api.anthropic.com/v1" } } },
    }],
    // What core resolves as `env: MY_CLAUDE_KEY (models.json secretref)`: a key
    // ClawBox cannot read the value of, and a key all the same.
    ["a SecretRef where the provider definition's key goes", {
      models: { providers: { anthropic: { apiKey: { source: "env", provider: "default", id: "MY_CLAUDE_KEY" }, baseUrl: "https://api.anthropic.com/v1" } } },
    }],
    ["an api_key profile beside it", {
      auth: { profiles: { [ID]: { provider: "anthropic", mode: "oauth" }, "anthropic:manual": { provider: "anthropic", mode: "api_key" } } },
    }],
    ["a setup-token profile beside it", {
      auth: { profiles: { [ID]: { provider: "anthropic", mode: "oauth" }, "anthropic:token": { provider: "anthropic", mode: "token" } } },
    }],
    // A profile whose mode the config does not state is not known to be a sign-in.
    ["a profile of no stated mode beside it", {
      auth: { profiles: { [ID]: { provider: "anthropic", mode: "oauth" }, "anthropic:legacy": { provider: "anthropic" } } },
    }],
  ])("stays Connected, and does not open the store, when the box also holds %s", async (_name, patch) => {
    readConfig.mockResolvedValue(subscriptionConfig(patch));

    expect((await claudeRow()).state).toBe("connected");
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("needs EVERY sign-in fenced when the box holds more than one", async () => {
    const two = subscriptionConfig({
      auth: { profiles: { [ID]: { provider: "anthropic", mode: "oauth" }, "anthropic:work": { provider: "anthropic", mode: "oauth" } } },
    });
    readConfig.mockResolvedValue(two);

    storeRead.mockImplementation((id: string) => (id === ID ? FENCED : HEALTHY));
    expect((await claudeRow()).state).toBe("connected");

    // One dead, the other only renewing: the box still has a sign-in.
    storeRead.mockImplementation((id: string) => (id === ID ? FENCED : pending(2 * SECOND)));
    expect((await claudeRow()).state).toBe("connected");

    storeRead.mockReturnValue(FENCED);
    expect((await claudeRow()).state).toBe("needs-reauth");
    expect(storeRead.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining([ID, "anthropic:work"]));
  });

  it("asks about the profile id the config names, whatever it is called", async () => {
    readConfig.mockResolvedValue(subscriptionConfig({
      // No `provider` field: the id's own prefix says whose it is.
      auth: { profiles: { "anthropic:claude-max": { mode: "oauth" } } },
    }));

    expect((await claudeRow()).state).toBe("needs-reauth");
    expect(storeRead).toHaveBeenCalledWith("anthropic:claude-max");
  });

  it("does not open the store on a box with no Claude sign-in", async () => {
    readConfig.mockResolvedValue({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    });

    expect((await claudeRow()).state).toBe("disconnected");
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("does not open the store on Hermes, whose rows come from its own dashboard", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue({
      stale: false,
      current: { provider: "anthropic", model: "claude-sonnet-5" },
      providers: [{ id: "anthropic", name: "Anthropic", authenticated: true, isUserDefined: false, source: "d", total: 3, models: [] }],
    });

    const summary = await readProviderStatus();

    expect(summary.harness).toBe("hermes");
    expect(summary.providers.find((r) => r.id === "anthropic")?.state).toBe("connected");
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("answers false, without throwing, for a config that is not shaped like one", () => {
    for (const config of [{}, { auth: null }, { auth: { profiles: { [ID]: null } } }, { auth: { profiles: { [ID]: { provider: 7, mode: 7 } } } }, { models: { providers: { anthropic: null } } }]) {
      expect(claudeSignInFenced(config as never)).toBe(false);
    }
  });

  it("does not take an empty key for a key: the sign-in is still all there is", () => {
    for (const apiKey of ["", "   ", {}, null, 0]) {
      storeRead.mockClear();
      const config = subscriptionConfig({ models: { providers: { anthropic: { apiKey } } } });
      expect([apiKey, claudeSignInFenced(config as never)]).toEqual([apiKey, true]);
      expect(storeRead).toHaveBeenCalledTimes(1);
    }
  });
});

/**
 * The same question with nothing mocked between the config and the sqlite row:
 * the store the gateway resolves, in core's own table shape, under a temp
 * OPENCLAW_HOME. This is the chain the incident box ran.
 */
describe("…read out of the gateway's real store row", () => {
  let home = "";
  let restoreEnv: () => void;

  /** Core's marker pair for one claim, terminal (`failed`) or still being renewed. */
  function marker(state: "failed" | "pending") {
    const tag = state === "failed" ? "failed:" : "";
    return {
      type: "oauth",
      provider: "anthropic",
      access: `openclaw-oauth-refresh-fence:v1:${CLAIM}:${tag}access:${"a".repeat(64)}`,
      refresh: `openclaw-oauth-refresh-fence:v1:${CLAIM}:${tag}refresh:${"b".repeat(64)}`,
      expires: 1,
    };
  }
  const SIGNED_IN = {
    type: "oauth",
    provider: "anthropic",
    access: "sk-ant-oat01-FAKE-a-working-sign-in",
    refresh: "sk-ant-ort01-FAKE-its-refresh",
    expires: 1_900_000_000_000,
  };

  /** A shared state database that owns the auth store and holds `profile` at the sign-in's id, its row last written at `writtenAt`. */
  function sharedStore(profile: unknown, writtenAt = 1): void {
    const file = path.join(home, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT");
    const insert = db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)");
    insert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }), 1);
    insert.run("authProfiles.store", JSON.stringify({ version: 1, profiles: { [ID]: profile } }), writtenAt);
    db.close();
  }

  /** The main agent's OWN auth row beside it, which core resolves over the shared one for the ids it holds. */
  function mainAgentCopy(profile: unknown, writtenAt = 1): void {
    const file = path.join(home, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT");
    db.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", JSON.stringify({ version: 1, profiles: { [ID]: profile } }), writtenAt);
    db.close();
  }

  beforeEach(async () => {
    // Every variable gatewayAuthPaths() reads, so a shell that exports one
    // cannot send this test to a real store.
    restoreEnv = saveEnv("OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_AGENTS_DIR");
    home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-claude-fence-"));
    process.env.OPENCLAW_HOME = home;
    process.env.CLAWBOX_OPENCLAW_HOME = "";
    process.env.OPENCLAW_STATE_DIR = "";
    delete process.env.OPENCLAW_AGENTS_DIR;
    const actual = await vi.importActual<typeof import("@/lib/openclaw-auth-store")>("@/lib/openclaw-auth-store");
    storeRead.mockImplementation(actual.readGatewayAuthProfile);
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("needs-reauth over the failed fence core left behind, however recently", async () => {
    sharedStore(marker("failed"), NOW - 50);

    expect((await claudeRow()).state).toBe("needs-reauth");
  });

  it("Connected over a stored sign-in", async () => {
    sharedStore(SIGNED_IN);

    expect((await claudeRow()).state).toBe("connected");
  });

  it("Connected over the pending fence of a renewal that is still in flight", async () => {
    // The row as an outside reader finds it for the whole round trip to the
    // token endpoint: the fence, written a moment ago.
    sharedStore(marker("pending"), NOW - 2 * SECOND);

    expect((await claudeRow()).state).toBe("connected");
  });

  it("needs-reauth over a pending fence the row has held for longer than core lets a refresh run", async () => {
    sharedStore(marker("pending"), NOW - 5 * MINUTE);

    expect((await claudeRow()).state).toBe("needs-reauth");
  });

  it("needs-reauth when the main agent's own copy is the dead one — the copy a turn resolves — over a healthy shared row", async () => {
    sharedStore(SIGNED_IN);
    mainAgentCopy(marker("failed"));

    expect((await claudeRow()).state).toBe("needs-reauth");
  });

  it("Connected when the main agent's own copy is a sign-in, over a dead fence in the shared row", async () => {
    sharedStore(marker("failed"));
    mainAgentCopy(SIGNED_IN);

    expect((await claudeRow()).state).toBe("connected");
  });

  it("ages a pending fence in the main agent's own copy by that copy's row, not the shared one's", async () => {
    sharedStore(SIGNED_IN, NOW - 24 * 60 * MINUTE);
    mainAgentCopy(marker("pending"), NOW - 2 * SECOND);
    expect((await claudeRow()).state).toBe("connected");
  });

  it("Connected where there is no store to read — what an unmocked suite finds", async () => {
    expect((await claudeRow()).state).toBe("connected");
  });
});
