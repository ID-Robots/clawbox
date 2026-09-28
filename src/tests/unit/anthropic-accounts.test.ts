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

  it("hands a run the first account, then the next while the first is limited — and STAYS on it after the reset (TASK-1260)", async () => {
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
    // Sticky: the box does not swap back (and restart the gateway) for nothing.
    expect((await pool.prepareAccount()).prepared?.account.id).toBe(personal);
    expect((await pool.describePool()).activeAccountId).toBe(personal);
  });

  it("goes back to the first account after its reset when the owner prefers that", async () => {
    const [work, personal] = await twoAccounts();
    await pool.setReturnToPrimary(true);
    const until = Date.now() + 60_000;
    await pool.markLimited(work, until, "session");
    expect((await pool.prepareAccount()).prepared?.account.id).toBe(personal);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(until + 1);
    expect((await pool.prepareAccount()).prepared?.account.id).toBe(work);
    expect((await pool.describePool())).toMatchObject({ activeAccountId: work, returnToPrimary: true });
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
    const again = await pool.addOAuthAccount({ email: "Same@Example.com", tokens: tokens("b", 8 * 60 * 60_000) });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("ok");
    expect(await pool.readAccounts()).toHaveLength(1);
  });

  it("renews an account in place only with a sign-in that IS that account", async () => {
    const work = await pool.addOAuthAccount({ label: "Work", email: "work@example.com", tokens: tokens("work-access", 8 * 60 * 60_000) });
    await pool.markCredentialProblem(work.id, "revoked");
    const renewed = await pool.replaceCredential(work.id, { kind: "oauth", tokens: tokens("work-again", 8 * 60 * 60_000), email: "WORK@example.com" });
    expect(renewed).toMatchObject({ id: work.id, status: "ok", label: "Work" });
    expect((await pool.prepareAccount()).prepared?.credential).toEqual({ kind: "oauth", secret: "work-again" });
  });

  it("refuses to file another Claude account's sign-in under this one, and stores nothing", async () => {
    const work = await pool.addOAuthAccount({ label: "Work", email: "work@example.com", tokens: tokens("work-access", 8 * 60 * 60_000) });
    const personal = await pool.addOAuthAccount({ label: "Personal", email: "me@example.com", tokens: tokens("personal-access", 8 * 60 * 60_000) });

    // The browser was signed in as someone else entirely.
    await expect(pool.replaceCredential(work.id, { kind: "oauth", tokens: tokens("stranger-access", 8 * 60 * 60_000), email: "stranger@example.com" }))
      .rejects.toMatchObject({ code: "wrong_account", details: { signedIn: "stranger@example.com", expected: "work@example.com", label: "Work" } });
    // …or as the OTHER account on this list.
    await expect(pool.replaceCredential(work.id, { kind: "oauth", tokens: tokens("personal-again", 8 * 60 * 60_000), email: "me@example.com" }))
      .rejects.toMatchObject({ code: "wrong_account" });

    const accounts = await pool.readAccounts();
    expect(accounts.map((a) => [a.label, a.email])).toEqual([["Work", "work@example.com"], ["Personal", "me@example.com"]]);
    expect((await pool.prepareAccount()).prepared?.credential).toEqual({ kind: "oauth", secret: "work-access" });
    expect((await pool.prepareAccount({ exclude: new Set([work.id]) })).prepared).toMatchObject({ account: { id: personal.id }, credential: { secret: "personal-access" } });
  });

  it("refuses a sign-in that is another row's, even onto a row whose email the box never learned", async () => {
    const unnamed = await pool.addOAuthAccount({ label: "Old", tokens: tokens("old-access", 8 * 60 * 60_000) });
    await pool.addOAuthAccount({ label: "Personal", email: "me@example.com", tokens: tokens("personal-access", 8 * 60 * 60_000) });
    await expect(pool.replaceCredential(unnamed.id, { kind: "oauth", tokens: tokens("personal-again", 8 * 60 * 60_000), email: "me@example.com" }))
      .rejects.toMatchObject({ code: "duplicate", details: { signedIn: "me@example.com", label: "Personal" } });
    // A new address for it is learned, as before.
    const learned = await pool.replaceCredential(unnamed.id, { kind: "oauth", tokens: tokens("old-again", 8 * 60 * 60_000), email: "old@example.com" });
    expect(learned.email).toBe("old@example.com");
  });

  it("spends a single-use refresh token once when several runs start together", async () => {
    const account = await pool.addOAuthAccount({ label: "Max", email: "max@example.com", tokens: tokens("old-access", 5 * 60_000) });
    // Anthropic's rotation: the first renewal answers a new pair and retires
    // `refresh-old-access`; spending it again is refused like a revoked grant.
    const spent = new Set<string>();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { refresh_token } = JSON.parse(String(init.body)) as { refresh_token: string };
      if (spent.has(refresh_token)) return new Response("{\"error\":\"invalid_grant\"}", { status: 400 });
      spent.add(refresh_token);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 28_800 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([pool.prepareAccount(), pool.prepareAccount(), pool.prepareAccount()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const { prepared } of results) expect(prepared?.credential).toEqual({ kind: "oauth", secret: "new-access" });
    expect((await pool.readAccounts()).find((a) => a.id === account.id)?.status).toBe("ok");
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

// ── TASK-1260: one active account for the whole box ─────────────────────────

describe("the active account and its moves", () => {
  type Change = import("@/lib/anthropic-accounts").ActiveChange;

  /** Every move the pool announces, in order — emitted once the write has landed. */
  function recordMoves(): Change[] {
    const moves: Change[] = [];
    pool.onActiveChange((change) => moves.push(change));
    return moves;
  }

  const settleMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("adopts the first account of a pool written before TASK-1260 without calling it a swap", async () => {
    // A 4.1 pool on disk: no version 2, no activeId.
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const b = await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    const legacy = readConfig().anthropic_accounts as Record<string, unknown>;
    writeConfig({ anthropic_accounts: { ...legacy, version: 1, activeId: undefined } });
    pool._resetAnthropicAccountsForTests();
    const moves = recordMoves();
    const state = await pool.readPoolState();
    await settleMicrotasks();
    expect(state.activeId).toBe(a.id);
    expect(state.returnToPrimary).toBe(false);
    expect(moves).toEqual([]);
    expect((readConfig().anthropic_accounts as { version: number; activeId: string }).version).toBe(2);
    expect(b.id).not.toBe(a.id);
  });

  it("moves on a limit, says which run saw it and until when, and moves to NONE when the last one goes", async () => {
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const b = await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    const moves = recordMoves();
    const until = Date.now() + 60_000;
    await pool.markLimited(a.id, until, "weekly", { source: "coding", runId: "run-abc12345" });
    await settleMicrotasks();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      fromId: a.id, fromLabel: "Work", toId: b.id, toLabel: "Personal",
      cause: "limit", source: "coding", runId: "run-abc12345", limitKind: "weekly", limitedUntil: until,
    });
    // The same limit reported again moves nothing.
    await pool.markLimited(a.id, until, "weekly", { source: "chat" });
    await settleMicrotasks();
    expect(moves).toHaveLength(1);

    await pool.markLimited(b.id, Date.now() + 30_000, "session", { source: "cron" });
    await settleMicrotasks();
    expect(moves).toHaveLength(2);
    expect(moves[1]).toMatchObject({ fromId: b.id, toId: null, cause: "limit", source: "cron" });
    expect(moves[1].health).toMatchObject({ allLimited: true });
    expect((await pool.readPoolState()).activeId).toBeNull();
  });

  it("comes back from NONE at the first reset, on the account that is back — a move with cause `reset`", async () => {
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const b = await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    const soon = Date.now() + 5_000;
    await pool.markLimited(a.id, Date.now() + 60_000, "session");
    await pool.markLimited(b.id, soon, "session");
    const moves = recordMoves();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(soon + 1);
    const state = await pool.readPoolState();
    await settleMicrotasks();
    expect(state.activeId).toBe(b.id);
    expect(moves).toEqual([expect.objectContaining({ fromId: null, toId: b.id, cause: "reset" })]);
  });

  it("treats a 401 as its own cause and records when it happened", async () => {
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const b = await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    const moves = recordMoves();
    await pool.markCredentialProblem(a.id, "revoked", { source: "chat" });
    await settleMicrotasks();
    expect(moves).toEqual([expect.objectContaining({ fromId: a.id, toId: b.id, cause: "auth", source: "chat" })]);
    const row = (await pool.readAccounts()).find((x) => x.id === a.id);
    expect(row).toMatchObject({ status: "revoked" });
    expect(row?.authFailedAt).toEqual(expect.any(Number));
    // Signing it in again brings it back, and clears the refusal.
    await pool.replaceCredential(a.id, { kind: "api_key", key: "sk-ant-api03-renewed-key-0000000000000" });
    expect((await pool.readAccounts()).find((x) => x.id === a.id)).toMatchObject({ status: "ok", authFailedAt: null });
    // …without moving the sticky active account off the one that worked.
    expect((await pool.readPoolState()).activeId).toBe(b.id);
  });

  it("makes the first usable account of the owner's new order the active one", async () => {
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const b = await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    const moves = recordMoves();
    await pool.reorderAccounts([b.id, a.id]);
    await settleMicrotasks();
    expect(moves).toEqual([expect.objectContaining({ fromId: a.id, toId: b.id, cause: "owner", source: "owner" })]);
    // A reorder that keeps the same account first moves nothing.
    await pool.reorderAccounts([b.id, a.id]);
    await settleMicrotasks();
    expect(moves).toHaveLength(1);
  });

  it("says `removed`, with the removed account's label, when the active account is taken off the list", async () => {
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const b = await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    const moves = recordMoves();
    await pool.removeAccount(a.id);
    await settleMicrotasks();
    expect(moves).toEqual([expect.objectContaining({ fromId: a.id, fromLabel: "Work", toId: b.id, cause: "removed" })]);
  });

  it("does not move a sticky active account when a spare is connected, but names the first one `added`", async () => {
    const moves = recordMoves();
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    await settleMicrotasks();
    expect(moves).toEqual([expect.objectContaining({ fromId: null, toId: a.id, cause: "added" })]);
  });

  it("files the last swap and each consumer's outcome, and ignores an outcome for a swap that is no longer the last", async () => {
    await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const event = {
      id: "0123456789ab", at: Date.now(), fromId: null, fromLabel: "Work", toId: null, toLabel: null,
      cause: "limit" as const, source: "coding" as const, limitKind: "session" as const, limitedUntil: Date.now() + 1000, nextResetAt: Date.now() + 1000,
      consumers: { coding: { status: "pending" as const, code: null, count: null } },
    };
    await pool.recordSwapEvent(event);
    await pool.updateSwapConsumer(event.id, "coding", { status: "ok", code: "moved", count: 2 });
    await pool.updateSwapConsumer("ffffffffffff", "gateway", { status: "ok", code: "switched", count: 1 });
    const view = await pool.describePool();
    expect(view.lastSwap).toMatchObject({ id: event.id, cause: "limit", fromLabel: "Work", consumers: { coding: { status: "ok", code: "moved", count: 2 } } });
    expect(view.lastSwap?.consumers.gateway).toBeUndefined();
  });

  it("drops a hand-edited last swap or gateway mirror it cannot trust", async () => {
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    const raw = readConfig().anthropic_accounts as Record<string, unknown>;
    writeConfig({ anthropic_accounts: { ...raw, lastSwap: { at: "yesterday", cause: "limit" }, gateway: { accountId: a.id, fingerprint: "not-hex" } } });
    pool._resetAnthropicAccountsForTests();
    const state = await pool.readPoolState();
    expect(state.lastSwap).toBeNull();
    expect(state.gateway).toBeNull();
  });

  it("keeps ONE state per process, however many copies of the module a bundler made", async () => {
    // The boot hook and a route are two module copies in one web server
    // (src/lib/process-store.ts): a listener on one must hear a move the other made.
    const a = await pool.addApiKeyAccount({ label: "Work", key: LEGACY_KEY });
    await pool.addApiKeyAccount({ label: "Personal", key: SECOND_KEY });
    const moves = recordMoves();
    vi.resetModules();
    const otherCopy = await import("@/lib/anthropic-accounts");
    expect(otherCopy).not.toBe(pool);
    await otherCopy.markLimited(a.id, Date.now() + 60_000, "session");
    await settleMicrotasks();
    expect(moves).toHaveLength(1);
  });
});

describe("asking Anthropic whether a refused credential is really dead", () => {
  const tokens = (access: string, expiresIn: number) => ({ access, refresh: `refresh-${access}`, expires: Date.now() + expiresIn });

  it("renews a Claude account whose token was only stale, and keeps it in", async () => {
    const account = await pool.addOAuthAccount({ label: "Max", email: "max@example.com", tokens: tokens("stale-access", 8 * 3_600_000) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 28_800 }), { status: 200 })));
    expect(await pool.probeAccountCredential(account.id, async () => "ok")).toBe("ok");
    expect((await pool.readAccounts())[0].status).toBe("ok");
    expect((await pool.prepareAccount()).prepared?.credential).toEqual({ kind: "oauth", secret: "fresh-access" });
  });

  it("marks a grant Anthropic refuses to renew as revoked", async () => {
    const account = await pool.addOAuthAccount({ label: "Max", email: "max@example.com", tokens: tokens("dead-access", 8 * 3_600_000) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{\"error\":\"invalid_grant\"}", { status: 400 })));
    expect(await pool.probeAccountCredential(account.id, async () => "ok", { source: "coding", runId: "run-x" })).toBe("dead");
    expect((await pool.readAccounts())[0]).toMatchObject({ status: "revoked" });
  });

  it("marks nothing when Anthropic cannot be asked", async () => {
    const account = await pool.addOAuthAccount({ label: "Max", email: "max@example.com", tokens: tokens("live-access", 8 * 3_600_000) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    expect(await pool.probeAccountCredential(account.id, async () => "ok")).toBe("unknown");
    expect((await pool.readAccounts())[0].status).toBe("ok");
  });

  it("checks an API key the way the key form does", async () => {
    const account = await pool.addApiKeyAccount({ label: "Key", key: LEGACY_KEY });
    const verify = vi.fn(async () => "rejected" as const);
    expect(await pool.probeAccountCredential(account.id, verify)).toBe("dead");
    expect(verify).toHaveBeenCalledWith(LEGACY_KEY);
    expect((await pool.readAccounts())[0].status).toBe("revoked");
  });

  it("takes the Terminal sign-in out until the owner signs in again", async () => {
    signInWithClaude();
    const [login] = await pool.readAccounts();
    expect(await pool.probeAccountCredential(login.id, async () => "ok")).toBe("dead");
    expect((await pool.readAccounts())[0].status).toBe("revoked");
    // Claude Code writing the credential file again is the owner signing in again.
    const credentials = path.join(home, ".claude", ".credentials.json");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(credentials, later, later);
    expect((await pool.readAccounts())[0].status).toBe("ok");
  });
});

describe("the gateway's copy of an account", () => {
  it("hands out a Claude account's access token and its end — never the refresh token — and nothing for other kinds", async () => {
    const expires = Date.now() + 8 * 3_600_000;
    const max = await pool.addOAuthAccount({ label: "Max", email: "max@example.com", tokens: { access: "gw-access", refresh: "gw-refresh", expires } });
    const key = await pool.addApiKeyAccount({ label: "Key", key: LEGACY_KEY });
    expect(await pool.gatewayCredentialFor(max.id)).toEqual({ access: "gw-access", expires });
    expect(JSON.stringify(await pool.gatewayCredentialFor(max.id))).not.toContain("gw-refresh");
    expect(await pool.gatewayCredentialFor(key.id)).toBeNull();
    expect(await pool.gatewayCredentialFor("ffffffff")).toBeNull();
  });

  it("forgets a mirror of an account that is no longer on the list", async () => {
    const max = await pool.addOAuthAccount({ label: "Max", email: "max@example.com", tokens: { access: "a", refresh: "r", expires: Date.now() + 3_600_000 } });
    await pool.setGatewayMirror({ accountId: max.id, fingerprint: "0123456789abcdef", expiresAt: null, at: Date.now() });
    expect((await pool.describePool()).gateway).toMatchObject({ following: true, accountId: max.id, label: "Max" });
    await pool.removeAccount(max.id);
    expect((await pool.describePool()).gateway).toMatchObject({ following: false, accountId: null });
  });
});

describe("a refused Terminal sign-in with no time on record", () => {
  it("stays refused until the credential file is written AGAIN", async () => {
    signInWithClaude();
    const [login] = await pool.readAccounts();
    const raw = readConfig().anthropic_accounts as { accounts: Record<string, unknown>[] };
    writeConfig({ anthropic_accounts: { ...raw, accounts: raw.accounts.map((a) => (a.id === login.id ? { ...a, status: "revoked", authFailedAt: null } : a)) } });
    pool._resetAnthropicAccountsForTests();
    expect((await pool.readAccounts())[0].status).toBe("revoked");
    expect((await pool.readAccounts())[0].status).toBe("revoked");
    const credentials = path.join(home, ".claude", ".credentials.json");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(credentials, later, later);
    expect((await pool.readAccounts())[0].status).toBe("ok");
  });
});
