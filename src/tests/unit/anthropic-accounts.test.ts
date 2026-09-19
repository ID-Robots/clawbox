/**
 * The Anthropic account pool (TASK-902), on a real config file and a real
 * encrypted secret store in a temp root.
 *
 * What would make the feature worthless if it broke:
 *
 *  1. THE MIGRATION. A box with the single legacy key in data/config.json gets
 *     it as account #1 with no action — and afterwards the key is in the secret
 *     store (encrypted, invisible to the owner's own secret list) and NOT in the
 *     config. A migration the store could not take leaves the key where the
 *     wrapper can still read it.
 *  2. THE ORDER. The first usable account answers; a limited one is skipped
 *     until its reset and then answers again by itself.
 *  3. THE CREDENTIALS NEVER SURFACE. Nothing a route or a tool is handed
 *     carries a token.
 *  4. AN OAUTH TOKEN IS RENEWED before a run is handed it, and a grant
 *     Anthropic refuses takes the account out of rotation, not the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const homedir = () => process.env.CLAWBOX_TEST_HOME ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const SESSION_SECRET = "7c".repeat(32);
const LEGACY_KEY = "sk-ant-api03-legacy-owner-key-0123456789";
const SECOND_KEY = "sk-ant-api03-second-account-key-987654321";

let root = "";
let home = "";
let restoreEnv: () => void;
let pool: typeof import("@/lib/anthropic-accounts");
let secrets: typeof import("@/lib/project-secrets");

function configPath(): string {
  return path.join(root, "data", "config.json");
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(configPath(), JSON.stringify(config), { mode: 0o600 });
}

function secretsText(): string {
  try {
    return fs.readFileSync(path.join(root, "data", "secrets.json"), "utf-8");
  } catch {
    return "";
  }
}

function signInWithClaude(email = "owner@example.com"): void {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "native" } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_TEST_HOME");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pool-")));
  home = path.join(root, "home");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "data", ".session-secret"), SESSION_SECRET, { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_TEST_HOME = home;
  process.env.SESSION_SECRET = "ff".repeat(32);
  vi.resetModules();
  pool = await import("@/lib/anthropic-accounts");
  secrets = await import("@/lib/project-secrets");
  secrets._resetSecretKeyCacheForTests();
  pool._resetAnthropicAccountsForTests();
  (await import("@/lib/claude-login"))._resetAnthropicLoginCache();
});

afterEach(() => {
  pool._resetAnthropicAccountsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("migrating the single legacy credential", () => {
  it("moves the key into the secret store as account #1 and out of the config, with no owner action", async () => {
    writeConfig({ anthropic_api_key: LEGACY_KEY, clawai_token: "claw_keep_me" });
    const accounts = await pool.readAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ kind: "api_key", label: "API key", status: "ok" });
    const config = readConfig();
    // Out of the config — and nothing else there was touched.
    expect(config.anthropic_api_key).toBeUndefined();
    expect(config.clawai_token).toBe("claw_keep_me");
    expect(JSON.stringify(config)).not.toContain(LEGACY_KEY);
    // In the secret store, encrypted.
    expect(secretsText()).not.toBe("");
    expect(secretsText()).not.toContain(LEGACY_KEY);
    // And the account hands it back to a run.
    const { prepared } = await pool.prepareAccount();
    expect(prepared?.credential).toEqual({ kind: "api_key", secret: LEGACY_KEY });
  });

  it("puts the owner's `claude` sign-in after the key, with its email", async () => {
    writeConfig({ anthropic_api_key: LEGACY_KEY });
    signInWithClaude("me@example.com");
    const accounts = await pool.readAccounts();
    expect(accounts.map((a) => a.kind)).toEqual(["api_key", "login"]);
    expect(accounts[1].email).toBe("me@example.com");
  });

  it("makes a sign-in alone account #1 — the box the overnight queue ran on", async () => {
    signInWithClaude();
    const accounts = await pool.readAccounts();
    expect(accounts.map((a) => a.kind)).toEqual(["login"]);
    const { prepared } = await pool.prepareAccount();
    expect(prepared?.credential).toEqual({ kind: "login", secret: null });
  });

  it("runs once: a second read changes nothing and never re-adds a key", async () => {
    writeConfig({ anthropic_api_key: LEGACY_KEY });
    const first = await pool.readAccounts();
    pool._resetAnthropicAccountsForTests();
    const second = await pool.readAccounts();
    expect(second.map((a) => a.id)).toEqual(first.map((a) => a.id));
  });

  it("leaves the key in the config when the secret store cannot take it, and tries again later", async () => {
    writeConfig({ anthropic_api_key: LEGACY_KEY });
    // A directory where the store's file should be: every write fails.
    fs.mkdirSync(path.join(root, "data", "secrets.json"));
    const accounts = await pool.readAccounts();
    expect(accounts).toEqual([]);
    expect(readConfig().anthropic_api_key).toBe(LEGACY_KEY);
    expect((readConfig().anthropic_accounts as { migrated?: boolean } | undefined)?.migrated).not.toBe(true);

    fs.rmSync(path.join(root, "data", "secrets.json"), { recursive: true });
    pool._resetAnthropicAccountsForTests();
    expect((await pool.readAccounts()).map((a) => a.kind)).toEqual(["api_key"]);
    expect(readConfig().anthropic_api_key).toBeUndefined();
  });

  it("keeps the credentials out of the owner's own secret list and out of every run's environment", async () => {
    writeConfig({ anthropic_api_key: LEGACY_KEY, coding_agent_inject_secrets: true });
    await pool.readAccounts();
    expect(await secrets.listSecrets()).toEqual([]);
    const resolved = await secrets.resolveSecretsForRun({ project: null });
    expect(resolved.names).toEqual([]);
    // And an owner route cannot name the scope to reach one.
    await expect(secrets.deleteSecretsForScope("@anthropic-accounts")).rejects.toThrow();
    await expect(secrets.setSecret({ name: "X_TOKEN", value: "12345678", scope: "@anthropic-accounts" })).rejects.toThrow();
  });
});

describe("the order and the limits", () => {
  async function twoAccounts(): Promise<[string, string]> {
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const b = await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    return [a.id, b.id];
  }

  it("hands a run the first account, then the next while the first is limited, then the first again after its reset", async () => {
    const [work, personal] = await twoAccounts();
    expect((await pool.prepareAccount()).prepared?.account.id).toBe(work);

    const until = Date.now() + 60_000;
    const recorded = await pool.markLimited(work, until, "session");
    expect(recorded).toMatchObject({ newlyLimited: true, becameAllLimited: false });
    const next = await pool.prepareAccount();
    expect(next.prepared?.account.id).toBe(personal);
    expect(next.prepared?.credential).toEqual({ kind: "api_key", secret: SECOND_KEY });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(until + 1);
    expect((await pool.prepareAccount()).prepared?.account.id).toBe(work);
  });

  it("says when the LAST healthy account is limited, once", async () => {
    const [work, personal] = await twoAccounts();
    await pool.markLimited(work, Date.now() + 60_000, "session");
    const last = await pool.markLimited(personal, Date.now() + 30_000, "session");
    expect(last.becameAllLimited).toBe(true);
    expect(last.health).toMatchObject({ healthy: 0, limited: 2, allLimited: true });
    expect(last.health.nextResetAt).toBeLessThanOrEqual(Date.now() + 30_000);
    // The same account reported again is not news.
    const again = await pool.markLimited(personal, Date.now() + 30_000, "session");
    expect(again).toMatchObject({ newlyLimited: false, becameAllLimited: false });
    // Nobody can answer, so nothing is handed out — unless the caller must spawn anyway.
    expect((await pool.prepareAccount()).prepared).toBeNull();
    expect((await pool.prepareAccount({ fallback: true })).prepared).not.toBeNull();
  });

  it("never hands back the account that has just refused", async () => {
    const [work, personal] = await twoAccounts();
    expect((await pool.prepareAccount({ exclude: new Set([work]) })).prepared?.account.id).toBe(personal);
  });

  it("follows the owner's order", async () => {
    const [work, personal] = await twoAccounts();
    await pool.reorderAccounts([personal, work]);
    expect((await pool.prepareAccount()).prepared?.account.id).toBe(personal);
    await expect(pool.reorderAccounts([personal])).rejects.toThrow(/every account/);
  });

  it("answers the pool synchronously once it has been read, for the runner's settle path", async () => {
    expect(pool.anotherAccountLikely("x")).toBeNull();
    const [work] = await twoAccounts();
    expect(pool.anotherAccountLikely(work)).toBe(true);
    await pool.markLimited(work, Date.now() + 60_000, "session");
    const personal = (await pool.readAccounts())[1].id;
    expect(pool.anotherAccountLikely(personal)).toBe(false);
  });

  it("takes a removed account's credential out of the store", async () => {
    const [work] = await twoAccounts();
    await pool.removeAccount(work);
    expect((await pool.readAccounts()).map((a) => a.label)).toEqual(["Personal"]);
    expect(await secrets.readDeviceSecret({ scope: "@anthropic-accounts", name: `ACCOUNT_${work.toUpperCase()}` })).toEqual({ found: false, reason: "missing" });
  });

  it("only unlists the `claude` sign-in, and does not put it back by itself", async () => {
    signInWithClaude();
    const [login] = await pool.readAccounts();
    await pool.removeAccount(login.id);
    pool._resetAnthropicAccountsForTests();
    expect(await pool.readAccounts()).toEqual([]);
    // The sign-in itself is untouched.
    expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(true);
    expect((await pool.describePool()).loginAvailable).toBe(true);
    await pool.relistLogin();
    expect((await pool.readAccounts()).map((a) => a.kind)).toEqual(["login"]);
  });
});

describe("OAuth accounts", () => {
  const tokens = (access: string, expiresIn: number) => ({ access, refresh: `refresh-${access}`, expires: Date.now() + expiresIn });

  it("renews a token near its end before a run is handed it, and keeps the renewal", async () => {
    const account = await pool.addOAuthAccount({ label: "Max #2", email: "two@example.com", tokens: tokens("old-access", 30 * 60_000) });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 28_800 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { prepared } = await pool.prepareAccount();
    expect(prepared?.credential).toEqual({ kind: "oauth", secret: "new-access" });
    // The same token endpoint and client the box's sign-in uses.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://console.anthropic.com/v1/oauth/token");
    expect(JSON.parse(String(init.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-old-access" });
    // Stored: the next run does not refresh again.
    fetchMock.mockClear();
    expect((await pool.prepareAccount()).prepared?.credential).toEqual({ kind: "oauth", secret: "new-access" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await pool.readAccounts()).find((a) => a.id === account.id)?.expiresAt).toBeGreaterThan(Date.now() + 7 * 60 * 60_000);
  });

  it("takes an account whose grant Anthropic refused out of rotation, and hands the run the next one", async () => {
    const dead = await pool.addOAuthAccount({ label: "Revoked", email: "gone@example.com", tokens: tokens("dead-access", -60_000) });
    await pool.addApiKeyAccount({ label: "Spare", key: SECOND_KEY });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{\"error\":\"invalid_grant\"}", { status: 400 })));
    const { prepared } = await pool.prepareAccount();
    expect(prepared?.account.label).toBe("Spare");
    expect((await pool.readAccounts()).find((a) => a.id === dead.id)?.status).toBe("revoked");
  });

  it("still uses a live token when the renewal could not reach Anthropic", async () => {
    await pool.addOAuthAccount({ label: "Max", email: "m@example.com", tokens: tokens("live-access", 60 * 60_000) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    expect((await pool.prepareAccount()).prepared?.credential).toEqual({ kind: "oauth", secret: "live-access" });
  });

  it("treats the same email again as the same account signing in again", async () => {
    const first = await pool.addOAuthAccount({ email: "same@example.com", tokens: tokens("a", 8 * 60 * 60_000) });
    await pool.markCredentialProblem(first.id, "revoked");
    const again = await pool.addOAuthAccount({ email: "same@example.com", tokens: tokens("b", 8 * 60 * 60_000) });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("ok");
    expect(await pool.readAccounts()).toHaveLength(1);
  });
});

describe("what surfaces are shown", () => {
  it("never carries a credential", async () => {
    await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    await pool.addOAuthAccount({ label: "Max", email: "max@example.com", tokens: { access: "sk-ant-oat01-visible-nowhere", refresh: "rt-visible-nowhere", expires: Date.now() + 8 * 3_600_000 } });
    const view = JSON.stringify(await pool.describePool());
    expect(view).not.toContain(LEGACY_KEY);
    expect(view).not.toContain("visible-nowhere");
    expect(JSON.stringify(readConfig())).not.toContain("visible-nowhere");
  });

  it("names the account a run would use and the pool's health", async () => {
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const b = await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    await pool.markLimited(a.id, Date.now() + 60_000, "session");
    const view = await pool.describePool();
    expect(view.activeAccountId).toBe(b.id);
    expect(view.accounts.map((x) => [x.priority, x.status, x.active])).toEqual([[1, "limited", false], [2, "ok", true]]);
    expect(view.health).toMatchObject({ total: 2, healthy: 1, limited: 1, allLimited: false });
  });
});

describe("the handoff file", () => {
  it("is 0600 in a 0700 folder, holds one credential, and is removed with its run", () => {
    const file = pool.writeCredentialHandoff("run-abc123", { kind: "oauth", secret: "tok" });
    expect(fs.readFileSync(file, "utf-8")).toBe("oauth\ntok\n");
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(path.dirname(file)).mode & 0o777).toString(8)).toBe("700");
    pool.removeCredentialHandoffs("run-abc123");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a run id that could name a path", () => {
    expect(() => pool.writeCredentialHandoff("../x", { kind: "login", secret: null })).toThrow();
  });
});
