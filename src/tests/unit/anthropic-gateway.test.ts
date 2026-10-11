/**
 * The OpenClaw gateway as a consumer of the box's active Anthropic account
 * (TASK-1260) — the real pool and swap, a stand-in gateway.
 *
 * What would make it worthless or harmful if it broke:
 *
 *  1. THE GATEWAY FOLLOWS — on a limit or a refused credential the chat's
 *     Claude subscription is rewritten with the active account and the gateway
 *     restarted on it; a write the restart lost is written again.
 *  2. IT DOES NOT TAKE OVER FOR NOTHING — connecting a first account never
 *     replaces the sign-in the chat already runs on; an API key is never put
 *     where a Claude account's token belongs.
 *  3. THE KEEPER — the gateway's token is renewed before it ends, and a sign-in
 *     the owner made in Settings since is left alone.
 *  4. THE FAILURES — a cron run (a heartbeat is one) that died on the limit is
 *     reported and run once more after the swap; the chat's own report sends
 *     the turn again into its session; another provider's failure moves nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const announceAnthropicLimit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceAnthropicLimit }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const homedir = () => process.env.CLAWBOX_TEST_HOME ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

let root = "";
let restoreEnv: () => void;
let pool: typeof import("@/lib/anthropic-accounts");
let swap: typeof import("@/lib/anthropic-swap");
let gw: typeof import("@/lib/anthropic-gateway");
let fp: (token: string) => string;

type Profile = import("@/lib/anthropic-gateway-auth").GatewayAnthropicProfile;

/** A gateway whose one subscription profile holds `token` — and what was done to it. */
function fakeGateway(initial: string | null = "sk-ant-oat01-the-chats-own-sign-in") {
  const state = {
    token: initial,
    writes: [] as { access: string; expires: number | null }[],
    restarts: 0,
    calls: [] as { method: string; params: Record<string, unknown> }[],
    cronJobs: [] as unknown[],
    /** When set, the next restart puts this token back (the gateway flushed its own copy). */
    flushOnRestart: null as string | null,
  };
  const profile = (): Profile[] => state.token === null ? [] : [{ store: "agent", agentId: "main", profileId: "anthropic:default", type: "oauth", fingerprint: fp(state.token), expires: null }];
  gw._setGatewayDepsForTests({
    absent: () => false,
    list: profile,
    write: (token) => {
      state.writes.push(token);
      if (state.token === null) return { written: 0, failed: 0 };
      state.token = token.access;
      return { written: 1, failed: 0 };
    },
    restart: async () => {
      state.restarts += 1;
      if (state.flushOnRestart) {
        state.token = state.flushOnRestart;
        state.flushOnRestart = null;
      }
    },
    reachable: async () => true,
    call: async (method, params) => {
      state.calls.push({ method, params });
      if (method === "cron.list") return { jobs: state.cronJobs };
      return { ok: true };
    },
  });
  return state;
}

const H = 3_600_000;
const oauth = (access: string, expiresIn = 8 * H) => ({ access, refresh: `refresh-${access}`, expires: Date.now() + expiresIn });

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_TEST_HOME");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gw-")));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "3d".repeat(32), { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "cd".repeat(32);
  process.env.CLAWBOX_TEST_HOME = path.join(root, "home");
  vi.resetModules();
  pool = await import("@/lib/anthropic-accounts");
  swap = await import("@/lib/anthropic-swap");
  gw = await import("@/lib/anthropic-gateway");
  fp = (await import("@/lib/anthropic-gateway-auth")).tokenFingerprint;
  (await import("@/lib/project-secrets"))._resetSecretKeyCacheForTests();
  pool._resetAnthropicAccountsForTests();
  swap._resetAnthropicSwapForTests();
});

afterEach(() => {
  gw._setGatewayDepsForTests(null);
  swap._resetAnthropicSwapForTests();
  pool._resetAnthropicAccountsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

async function twoClaudeAccounts() {
  const work = await pool.addOAuthAccount({ label: "Work Max", email: "work@example.com", tokens: oauth("sk-ant-oat01-work") });
  const personal = await pool.addOAuthAccount({ label: "Personal Max", email: "me@example.com", tokens: oauth("sk-ant-oat01-personal") });
  return { work, personal };
}

describe("the swap reaching the gateway", () => {
  it("moves the chat's Claude subscription to the next account on a limit, and restarts the gateway on it", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await pool.markLimited(work.id, Date.now() + H, "weekly", { source: "coding" });
    await swap.whenSwapsSettled();

    expect(gateway.token).toBe("sk-ant-oat01-personal");
    expect(gateway.writes).toEqual([{ access: "sk-ant-oat01-personal", expires: expect.any(Number) }]);
    expect(gateway.restarts).toBe(1);
    const view = await pool.describePool();
    expect(view.gateway).toMatchObject({ following: true, accountId: personal.id, label: "Personal Max" });
    expect(view.lastSwap?.consumers.gateway).toEqual({ status: "ok", code: "switched", count: 1 });
    // The gateway is never handed the refresh token.
    expect(JSON.stringify(gateway.writes)).not.toContain("refresh-");
  });

  it("does not take over the chat's own sign-in when the owner merely connects accounts", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    await twoClaudeAccounts();
    await swap.whenSwapsSettled();
    expect(gateway.writes).toEqual([]);
    expect(gateway.restarts).toBe(0);
    expect((await pool.describePool()).gateway.following).toBe(false);
  });

  it("follows every move once it follows — a reset back to the first account included", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await pool.setReturnToPrimary(true);
    const until = Date.now() + 5_000;
    await pool.markLimited(work.id, until, "session");
    await swap.whenSwapsSettled();
    expect(gateway.token).toBe("sk-ant-oat01-personal");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(until + 1);
    await pool.readPoolState();
    await swap.whenSwapsSettled();
    expect(gateway.token).toBe("sk-ant-oat01-work");
    expect(gateway.restarts).toBe(2);
  });

  it("writes again when the restart put the old token back, and says so if it happens twice", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    gateway.flushOnRestart = "sk-ant-oat01-the-chats-own-sign-in";
    await pool.markLimited(work.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    expect(gateway.token).toBe("sk-ant-oat01-personal");
    expect(gateway.writes).toHaveLength(2);
    expect(gateway.restarts).toBe(2);
    expect((await pool.describePool()).lastSwap?.consumers.gateway).toMatchObject({ status: "ok", code: "switched" });
  });

  it("leaves the gateway where it is when the active account is an API key, and says why", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const work = await pool.addOAuthAccount({ label: "Work Max", email: "work@example.com", tokens: oauth("sk-ant-oat01-work") });
    await pool.addApiKeyAccount({ label: "Key", key: "sk-ant-api03-a-key-000000000000000000000" });
    await pool.markLimited(work.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    expect(gateway.writes).toEqual([]);
    expect((await pool.describePool()).lastSwap?.consumers.gateway).toEqual({ status: "skipped", code: "not_transferable", count: null });
  });

  it("does nothing on a gateway that does not run on a Claude subscription", async () => {
    const gateway = fakeGateway(null);
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await pool.markLimited(work.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    expect(gateway.restarts).toBe(0);
    expect((await pool.describePool()).lastSwap?.consumers.gateway).toMatchObject({ status: "skipped", code: "not_subscription" });
  });
});

describe("a restart that failed, and two writers at once", () => {
  it("records the move as owed until the restart succeeds, and the keeper finishes it", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    const restart = vi.fn(async (): Promise<void> => { throw new Error("Start request repeated too quickly"); });
    gw._setGatewayDepsForTests({
      absent: () => false,
      list: () => [{ store: "agent", agentId: "main", profileId: "anthropic:default", type: "oauth", fingerprint: fp(gateway.token!), expires: null }],
      write: (token) => { gateway.token = token.access; return { written: 1, failed: 0 }; },
      restart,
      reachable: async () => false,
      call: async () => ({}),
    });
    gw.startGatewaySwap();
    await pool.markLimited(work.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    expect((await pool.describePool()).lastSwap?.consumers.gateway).toMatchObject({ status: "failed", code: "restart_failed" });
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: personal.id, pending: true });

    restart.mockImplementation(async () => undefined);
    expect(await gw.keepGatewayMirror()).toBe("resynced");
    expect(restart).toHaveBeenCalledTimes(2);
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: personal.id, pending: false });
    expect(await gw.keepGatewayMirror()).toBe("fresh");
  });

  it("clears the debt without another restart when a slow restart came up after its readiness wait", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    let up = false;
    const restart = vi.fn(async (): Promise<void> => { throw new Error("gateway did not come back"); });
    gw._setGatewayDepsForTests({
      absent: () => false,
      list: () => [{ store: "agent", agentId: "main", profileId: "anthropic:default", type: "oauth", fingerprint: fp(gateway.token!), expires: null }],
      write: (token) => { gateway.token = token.access; return { written: 1, failed: 0 }; },
      restart,
      reachable: async () => up,
      call: async () => ({}),
    });
    gw.startGatewaySwap();
    await pool.markLimited(work.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: personal.id, pending: true });

    // The gateway finished starting on its own, on the new token.
    up = true;
    expect(await gw.keepGatewayMirror()).toBe("resynced");
    expect(restart).toHaveBeenCalledTimes(1);
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: personal.id, pending: false });
    expect(await gw.keepGatewayMirror()).toBe("fresh");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("backs off instead of restarting a gateway that keeps failing every keeper pass", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    const restart = vi.fn(async (): Promise<void> => { throw new Error("gateway did not come back"); });
    gw._setGatewayDepsForTests({
      absent: () => false,
      list: () => [{ store: "agent", agentId: "main", profileId: "anthropic:default", type: "oauth", fingerprint: fp(gateway.token!), expires: null }],
      write: (token) => { gateway.token = token.access; return { written: 1, failed: 0 }; },
      restart,
      reachable: async () => false,
      call: async () => ({}),
    });
    gw.startGatewaySwap();
    await pool.markLimited(work.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    expect(restart).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const pass = async (atMin: number) => { vi.setSystemTime(start + atMin * 60_000); return gw.keepGatewayMirror(); };
    // First retry on the next pass.
    expect(await pass(10)).toBe("failed");
    expect(restart).toHaveBeenCalledTimes(2);
    // Then the wait doubles: none at 20 min, one at 30 (20 after the last failure).
    expect(await pass(20)).toBe("failed");
    expect(restart).toHaveBeenCalledTimes(2);
    expect(await pass(30)).toBe("failed");
    expect(restart).toHaveBeenCalledTimes(3);
    // Next needs 40 min: none at 60, one at 70.
    expect(await pass(60)).toBe("failed");
    expect(restart).toHaveBeenCalledTimes(3);
    expect(await pass(70)).toBe("failed");
    expect(restart).toHaveBeenCalledTimes(4);
    // 80 min: one at 150. 160 min: none at 300, one at 310.
    const expectAt = async (m: number, n: number) => { await pass(m); expect(restart).toHaveBeenCalledTimes(n); };
    await expectAt(150, 5);
    await expectAt(300, 5);
    await expectAt(310, 6);
  }, 20_000);

  it("makes the keeper wait for a swap in progress instead of mistaking its token for the owner's", async () => {
    const gateway = fakeGateway();
    const { work, personal } = await twoClaudeAccounts();
    await gw.syncGatewayTo(work.id, { restart: false });
    let release: () => void = () => {};
    const restarting = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    gw._setGatewayDepsForTests({
      absent: () => false,
      list: () => [{ store: "agent", agentId: "main", profileId: "anthropic:default", type: "oauth", fingerprint: fp(gateway.token!), expires: null }],
      write: (token) => { gateway.token = token.access; return { written: 1, failed: 0 }; },
      restart: async () => { entered = true; await restarting; },
      call: async () => ({}),
    });
    gw.startGatewaySwap();
    await pool.markLimited(work.id, Date.now() + H, "session");
    await vi.waitFor(() => expect(entered).toBe(true));
    const keeper = gw.keepGatewayMirror();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await swap.whenSwapsSettled();
    expect(await keeper).not.toBe("stood_down");
    expect((await pool.describePool()).gateway).toMatchObject({ following: true, accountId: personal.id });
  });
});

describe("the keeper", () => {
  it("renews the gateway's token through the pool before it ends — no restart — and is quiet while it is fresh", async () => {
    const gateway = fakeGateway();
    const work = await pool.addOAuthAccount({ label: "Work Max", email: "work@example.com", tokens: oauth("sk-ant-oat01-work", 2 * H) });
    await pool.addOAuthAccount({ label: "Personal Max", email: "me@example.com", tokens: oauth("sk-ant-oat01-personal") });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "sk-ant-oat01-work-renewed", refresh_token: "r2", expires_in: 28_800 }), { status: 200 })));
    expect(await gw.syncGatewayTo(work.id, { restart: true })).toMatchObject({ status: "ok" });
    // The pool renewed the two-hour token on the way in: that is what the gateway holds.
    expect(gateway.token).toBe("sk-ant-oat01-work-renewed");
    expect(await gw.keepGatewayMirror()).toBe("fresh");
    expect(gateway.restarts).toBe(1);
  });

  it("puts the renewal in when the pool renewed the account elsewhere", async () => {
    const gateway = fakeGateway();
    const work = await pool.addOAuthAccount({ label: "Work Max", email: "work@example.com", tokens: oauth("sk-ant-oat01-work") });
    await gw.syncGatewayTo(work.id, { restart: false });
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });
    expect(await gw.keepGatewayMirror()).toBe("renewed");
    expect(gateway.token).toBe("sk-ant-oat01-work-v2");
    expect(gateway.restarts).toBe(0);
  });

  it("stands down when the owner signed the chat in again in Settings", async () => {
    const gateway = fakeGateway();
    const work = await pool.addOAuthAccount({ label: "Work Max", email: "work@example.com", tokens: oauth("sk-ant-oat01-work") });
    await gw.syncGatewayTo(work.id, { restart: false });
    gateway.token = "sk-ant-oat01-the-owner-signed-in-again";
    expect(await gw.keepGatewayMirror()).toBe("stood_down");
    expect(gateway.token).toBe("sk-ant-oat01-the-owner-signed-in-again");
    expect((await pool.describePool()).gateway.following).toBe(false);
    expect(await gw.keepGatewayMirror()).toBe("idle");
  });
});

describe("failed gateway turns", () => {
  const LIMIT = "All models failed (1): anthropic/claude-opus-5-5: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"You've hit your weekly limit · resets Mon 9am\"}}";

  it("reports a cron run (a heartbeat is one) that died on the limit, and runs it once more after the swap", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    // The gateway already follows account #1.
    await gw.syncGatewayTo(work.id, { restart: false });
    const now = Date.now();
    gateway.cronJobs = [
      { id: "heartbeat-main", state: { lastStatus: "error", lastError: LIMIT, lastRunAtMs: now - 1_000 } },
      { id: "daily-digest", state: { lastStatus: "ok", lastRunAtMs: now - 2_000 } },
      { id: "old-failure", state: { lastStatus: "error", lastError: LIMIT, lastRunAtMs: now - 60 * 60_000 } },
      { id: "openai-job", state: { lastStatus: "error", lastError: "429 rate_limit_exceeded from api.openai.com", lastRunAtMs: now - 500 } },
    ];
    expect(await gw.scanGatewayCrons(now)).toBe(1);
    expect(gateway.token).toBe("sk-ant-oat01-personal");
    expect(gateway.calls.filter((c) => c.method === "cron.run")).toEqual([{ method: "cron.run", params: { id: "heartbeat-main", mode: "force" } }]);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)).toMatchObject({ status: "limited", limitKind: "weekly" });
    expect((await pool.describePool()).lastSwap).toMatchObject({ source: "cron", toId: personal.id, consumers: { retries: { code: "retried", count: 1 } } });

    // Looked at once: the next pass does not report the same run again.
    expect(await gw.scanGatewayCrons(now + 1)).toBe(0);
  });

  it("sends a failed chat turn again into its session after a real limit's swap", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await gw.syncGatewayTo(work.id, { restart: false });
    const outcome = await gw.reportChatFailure({
      errorMessage: "⚠️ API rate limit reached. Please try again later.",
      detail: "HTTP 429: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"You've hit your weekly limit · resets Mon 9am\"}}",
      reason: "rate_limit",
      provider: "anthropic",
      sessionKey: "agent:main:main",
      message: "Summarise my inbox",
    });
    expect(outcome).toMatchObject({ handled: true, kind: "limit", limitKind: "weekly", activeLabel: "Personal Max", retry: "sent" });
    const sent = gateway.calls.filter((c) => c.method === "chat.send");
    expect(sent).toEqual([{ method: "chat.send", params: expect.objectContaining({ sessionKey: "agent:main:main", message: "Summarise my inbox", deliver: false }) }]);
    // The retry's key is stable for the turn it repeats.
    expect((sent[0].params as { idempotencyKey: string }).idempotencyKey).toMatch(/^clawbox-swap-[0-9a-f]{16}$/);
  });

  it("treats a bare rate limit as a throttle: same account, the turn sent again a minute later — and as the cap only when it comes back", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await gw.syncGatewayTo(work.id, { restart: false });
    const bare = {
      errorMessage: "⚠️ API rate limit reached. Please try again later.",
      detail: "HTTP 429: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
      reason: "rate_limit",
      provider: "anthropic",
      sessionKey: "agent:main:main",
      message: "Summarise my inbox",
    };
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const first = await gw.reportChatFailure(bare);
    expect(first).toMatchObject({ handled: true, kind: "throttled", retry: "later", activeLabel: "Work Max" });
    expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
    expect(gateway.restarts).toBe(0);
    expect(gateway.calls.filter((c) => c.method === "chat.send")).toEqual([]);
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(gateway.calls.filter((c) => c.method === "chat.send")).toHaveLength(1));

    // The retry was throttled too (the chat reports it without a turn of its
    // own): the account IS capped, and the first turn goes again after the swap.
    const second = await gw.reportChatFailure({ ...bare, message: undefined });
    expect(second).toMatchObject({ handled: true, kind: "limit", activeLabel: "Personal Max", retry: "sent" });
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("limited");
    expect(gateway.token).toBe("sk-ant-oat01-personal");
    expect(gateway.calls.filter((c) => c.method === "chat.send")).toHaveLength(2);
  });

  it("puts a renewed token in before retrying when Anthropic refused a token the pool could still renew", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await gw.syncGatewayTo(work.id, { restart: true });
    const lastSwap = (await pool.describePool()).lastSwap;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "sk-ant-oat01-work-renewed", refresh_token: "r2", expires_in: 28_800 }), { status: 200 })));
    const outcome = await gw.reportChatFailure({
      errorMessage: "Authentication failed.",
      detail: "HTTP 401: {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth token has expired.\"}}",
      reason: "auth",
      provider: "anthropic",
      sessionKey: "agent:main:main",
      message: "Summarise my inbox",
    });
    expect(outcome).toMatchObject({ handled: true, kind: "auth", activeLabel: "Work Max", retry: "sent" });
    // The gateway got the renewal and was restarted onto it BEFORE the turn went again.
    expect(gateway.token).toBe("sk-ant-oat01-work-renewed");
    expect(gateway.restarts).toBe(2);
    const order = gateway.calls.map((c) => c.method);
    expect(order).toEqual(["chat.send"]);
    // Not a swap: nothing new filed, the account still in.
    expect((await pool.describePool()).lastSwap?.id).toBe(lastSwap?.id);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("ok");
  });

  it("tells the chat of no move when the pool's only account is the Terminal's `claude` sign-in, which the gateway cannot carry", async () => {
    const gateway = fakeGateway();
    gw.startGatewaySwap();
    // 2026-10-10: the owner had signed `claude` in from the Terminal and
    // connected nothing else, the gateway's own stored sign-in was unusable,
    // and the chat was told 13 times that the box had "moved everything that
    // uses Claude" to that sign-in.
    fs.mkdirSync(path.join(root, "home", ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, "home", ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-terminal-sign-in" } }));
    const [login] = await pool.readAccounts();
    expect(login.kind).toBe("login");
    await swap.whenSwapsSettled();

    const outcome = await gw.reportChatFailure({
      errorMessage: 'No API key found for provider "anthropic". Auth store: /home/clawbox/.openclaw/state/openclaw.sqlite (agentDir: /home/clawbox/.openclaw/agents/main/agent).',
      reason: "auth",
      provider: "anthropic",
      sessionKey: "agent:main:main",
      message: "Summarise my inbox",
    });
    expect(outcome).toMatchObject({ handled: true, kind: "auth", activeId: null, activeLabel: null, allLimited: false, retry: "none" });
    // Nothing was written, nothing restarted, the turn not sent again.
    expect(gateway.writes).toEqual([]);
    expect(gateway.restarts).toBe(0);
    expect(gateway.calls.filter((c) => c.method === "chat.send")).toEqual([]);
    const view = await pool.describePool();
    expect(view.activeAccountId).toBe(login.id);
    expect(view.gateway.following).toBe(false);
    expect(view.lastSwap?.consumers.gateway).toEqual({ status: "skipped", code: "not_transferable", count: null });
  });

  it("ignores another provider's failure", async () => {
    fakeGateway();
    await twoClaudeAccounts();
    expect(await gw.reportChatFailure({ errorMessage: "rate limited", reason: "rate_limit", provider: "openai" })).toBeNull();
  });

  it("reads cron jobs whatever shape core gives them", () => {
    expect(gw.parseCronJobs({ jobs: [
      { id: "a", state: { lastStatus: "error", lastError: "x", lastRunAtMs: 5 } },
      { jobId: "b", lastRunStatus: "ok", lastRunAt: 6 },
      { name: "no id" },
      null,
    ] })).toEqual([
      { id: "a", lastStatus: "error", lastError: "x", lastRunAtMs: 5 },
      { id: "b", lastStatus: "ok", lastError: null, lastRunAtMs: 6 },
    ]);
    expect(gw.parseCronJobs(null)).toEqual([]);
  });
});
