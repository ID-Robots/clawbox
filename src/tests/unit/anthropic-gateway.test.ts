/**
 * The OpenClaw gateway as a consumer of the box's Anthropic account pool
 * (TASK-1260; the gateway leg of 2026-10-14) — the real pool and swap, a
 * stand-in for core's auth store and the `openclaw models auth` verbs.
 *
 * What would make it worthless or harmful if it broke:
 *
 *  1. THE POOL IN THE GATEWAY — every Claude account is its own profile, the
 *     access token only, in an order that follows the pool (the active account
 *     first, the limited ones last, the chat's own sign-in after them); never
 *     a restart.
 *  2. NOTHING TAKEN FOR NOTHING — a chat on another provider is never moved;
 *     an unreadable config removes nothing; the owner's own profiles are never
 *     written or removed; a write core refused is owed, not claimed.
 *  3. WHAT CORE SAW — a rate limit core rotated off is the pool's limit until
 *     Anthropic's reset; a throttle is not; a refused credential is checked.
 *  4. THE FAILURES — a cron run (a heartbeat is one) or a chat turn that died
 *     on the limit is retried once on the account the pool moved to; another
 *     provider's failure moves nothing.
 *  5. THE OWNER'S SWITCH — "use these accounts for the chat" puts the accounts
 *     in before the chat's model is set, and says why when it cannot.
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

type Failure = import("@/lib/openclaw-auth-store").ProfileFailureState;
type Usage = import("@/lib/anthropic-usage").AnthropicUsageReading;

const H = 3_600_000;
const OWN = "sk-ant-oat01-the-chats-own-sign-in";

/** Core's store and the CLI that writes it — and what was asked of them. */
function fakeCore() {
  const core = {
    profiles: new Map<string, { type: string; secret: string; expires: number | null }>([["anthropic:default", { type: "oauth", secret: OWN, expires: null }]]),
    order: null as string[] | null,
    failures: {} as Record<string, Failure>,
    chatOnClaude: true as boolean | null,
    readable: true,
    pastes: [] as { profileId: string; access: string; expires: number | null }[],
    logouts: [] as string[],
    orders: [] as string[][],
    calls: [] as { method: string; params: Record<string, unknown> }[],
    cronJobs: [] as unknown[],
    /** Anthropic's usage windows, by access token; absent is "could not be asked". */
    usage: new Map<string, Usage>(),
    refusePaste: false,
    /** `paste-token` wrote the profile, then could not tell the running gateway and exited non-zero. */
    pasteExitsAfterWrite: false,
  };
  gw._setGatewayDepsForTests({
    absent: () => false,
    chatOnClaude: async () => core.chatOnClaude,
    read: () => core.readable
      ? {
        kind: "present",
        profiles: [...core.profiles].map(([profileId, p]) => ({ profileId, type: p.type, fingerprint: fp(p.secret), refreshFingerprint: null, expires: p.expires, fenced: false, fence: null })),
        order: core.order ? [...core.order] : null,
        failures: core.failures,
      }
      : { kind: "unreadable" },
    paste: async (profileId, token) => {
      if (core.refusePaste) throw new Error("the auth store is busy");
      core.pastes.push({ profileId, ...token });
      core.profiles.set(profileId, { type: "token", secret: token.access, expires: token.expires });
      if (core.pasteExitsAfterWrite) throw new Error("Model auth changes were saved, but the Gateway could not refresh them.");
    },
    logout: async (profileId) => {
      core.logouts.push(profileId);
      core.profiles.delete(profileId);
      if (core.order) core.order = core.order.filter((id) => id !== profileId);
    },
    order: async (ids) => {
      core.orders.push([...ids]);
      core.order = ids.length > 0 ? [...ids] : null;
    },
    usage: async (access) => core.usage.get(access) ?? null,
    call: async (method, params) => {
      core.calls.push({ method, params });
      if (method === "cron.list") return { jobs: core.cronJobs };
      return { ok: true };
    },
  });
  return core;
}

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
  announceAnthropicLimit.mockClear();
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

const p = (id: string) => `anthropic:clawbox-${id}`;
const spent = (resetsAt: number): Usage => ({ exhausted: true, resetsAt, kind: "session" });
const rateLimited = (now = Date.now(), until = now + 30_000): Failure => ({
  cooldownUntil: until, cooldownReason: "rate_limit", disabledUntil: null, disabledReason: null, blockedUntil: null, lastFailureAt: now - 1_000,
});

describe("the pool in the gateway", () => {
  it("puts every Claude account in as its own profile — the access token only — the active one first and the chat's own sign-in last", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();

    expect(await gw.keepGatewayMirror()).toBe("synced");

    expect(core.pastes.map((w) => w.profileId).sort()).toEqual([p(work.id), p(personal.id)].sort());
    expect(core.pastes.find((w) => w.profileId === p(work.id))).toMatchObject({ access: "sk-ant-oat01-work", expires: expect.any(Number) });
    expect(JSON.stringify(core.pastes)).not.toContain("refresh-");
    expect(core.order).toEqual([p(work.id), p(personal.id), "anthropic:default"]);
    // The chat's own sign-in is never written or taken out.
    expect(core.profiles.get("anthropic:default")?.secret).toBe(OWN);
    expect(core.logouts).toEqual([]);
    expect((await pool.describePool()).gateway).toMatchObject({ following: true, accountId: work.id, label: "Work Max" });

    // A second pass with nothing changed asks core for nothing.
    const asked = core.pastes.length + core.orders.length;
    expect(await gw.keepGatewayMirror()).toBe("fresh");
    expect(core.pastes.length + core.orders.length).toBe(asked);
  });

  it("moves the order when the pool moves — a limit seen elsewhere, the owner's new order — and never restarts anything", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();

    // A coding run hit Work's limit.
    await pool.markLimited(work.id, Date.now() + H, "weekly", { source: "coding" });
    await swap.whenSwapsSettled();
    expect(core.order).toEqual([p(personal.id), p(work.id), "anthropic:default"]);
    const view = await pool.describePool();
    expect(view.gateway).toMatchObject({ following: true, accountId: personal.id, label: "Personal Max" });
    expect(view.lastSwap?.consumers.gateway).toEqual({ status: "ok", code: "switched", count: 2 });

    // The owner puts Work first again once it is back.
    await pool.clearLimit(work.id);
    await pool.reorderAccounts([work.id, personal.id]);
    await swap.whenSwapsSettled();
    expect(core.order).toEqual([p(work.id), p(personal.id), "anthropic:default"]);
  });

  it("never moves a chat that is on another provider, and takes the pool out when the chat leaves Claude", async () => {
    const core = fakeCore();
    core.chatOnClaude = false;
    await twoClaudeAccounts();
    expect(await gw.keepGatewayMirror()).toBe("idle");
    expect(core.pastes).toEqual([]);
    expect(core.orders).toEqual([]);

    core.chatOnClaude = true;
    await gw.keepGatewayMirror();
    expect(core.profiles.size).toBe(3);
    core.chatOnClaude = false;
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect(core.logouts).toHaveLength(2);
    expect([...core.profiles.keys()]).toEqual(["anthropic:default"]);
    expect((await pool.describePool()).gateway.following).toBe(false);
  });

  it("takes nothing out when openclaw.json cannot be read, or core's store cannot", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    core.chatOnClaude = null;
    expect(await gw.keepGatewayMirror()).toBe("failed");
    core.chatOnClaude = true;
    core.readable = false;
    expect(await gw.keepGatewayMirror()).toBe("failed");
    expect(core.logouts).toEqual([]);
    expect(core.profiles.size).toBe(3);
  });

  it("keeps the chat on the Claude accounts when an API key is the active account, and says why", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const work = await pool.addOAuthAccount({ label: "Work Max", email: "work@example.com", tokens: oauth("sk-ant-oat01-work") });
    await pool.addApiKeyAccount({ label: "Key", key: "sk-ant-api03-a-key-000000000000000000000" });
    await pool.markLimited(work.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    expect(core.order).toEqual([p(work.id), "anthropic:default"]);
    expect((await pool.describePool()).lastSwap?.consumers.gateway).toMatchObject({ status: "skipped", code: "not_transferable" });
  });

  it("takes out an account that left the pool or needs the owner — and only the pool's own", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.removeAccount(personal.id);
    await gw.keepGatewayMirror();
    expect(core.logouts).toEqual([p(personal.id)]);
    await pool.markCredentialProblem(work.id, "revoked");
    await gw.keepGatewayMirror();
    expect(core.logouts).toEqual([p(personal.id), p(work.id)]);
    expect([...core.profiles.keys()]).toEqual(["anthropic:default"]);
  });

  it("puts a token the pool renewed in — no restart — and owes a write core refused instead of claiming it", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });

    core.refusePaste = true;
    expect(await gw.keepGatewayMirror()).toBe("failed");
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: work.id, pending: true });
    // The old token stays in the order meanwhile: it still answers until it ends.
    expect(core.order).toContain(p(work.id));

    core.refusePaste = false;
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-v2");
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: work.id, pending: false, fingerprint: fp("sk-ant-oat01-work-v2") });
  });
});

describe("what landed is what the store says", () => {
  it("counts a token the CLI wrote and then failed to announce as in — no false failure", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    core.pasteExitsAfterWrite = true;
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work");
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: work.id, pending: false });
  });
});

describe("what core saw", () => {
  it("records a rate limit core rotated off as the pool's limit until Anthropic's reset, and moves everything once", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const resetsAt = Date.now() + 2 * H;
    core.usage.set("sk-ant-oat01-work", spent(resetsAt));
    core.failures[p(work.id)] = rateLimited();

    expect(await gw.noteGatewayCooldowns()).toBe(1);
    await swap.whenSwapsSettled();

    const limited = (await pool.readAccounts()).find((a) => a.id === work.id);
    expect(limited).toMatchObject({ status: "limited", limitKind: "session", limitedUntil: resetsAt });
    expect((await pool.readPoolState()).activeId).toBe(personal.id);
    expect(core.order).toEqual([p(personal.id), p(work.id), "anthropic:default"]);
    expect(announceAnthropicLimit).toHaveBeenCalledTimes(1);
    // One failure is one limit: seen again, nothing more happens.
    await pool.clearLimit(work.id);
    expect(await gw.noteGatewayCooldowns()).toBe(0);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("ok");
  });

  it("leaves an account in when Anthropic says none of its windows is spent — a throttle core's own cooldown covers", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    core.usage.set("sk-ant-oat01-work", { exhausted: false, resetsAt: null, kind: "session" });
    core.failures[p(work.id)] = rateLimited();
    expect(await gw.noteGatewayCooldowns()).toBe(0);
    expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
  });

  it("with Anthropic unreachable, takes core's own window — never longer than a session window", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const now = Date.now();
    core.failures[p(work.id)] = rateLimited(now, now + 60_000);
    core.failures[p(personal.id)] = rateLimited(now, now + 30 * H);
    expect(await gw.noteGatewayCooldowns(now)).toBe(2);
    const accounts = await pool.readAccounts();
    expect(accounts.find((a) => a.id === work.id)?.limitedUntil).toBe(now + 60_000);
    expect(accounts.find((a) => a.id === personal.id)?.limitedUntil).toBe(now + 5 * H);
  });

  it("checks a credential core saw refused with the pool's own renewal, and puts the renewed token in", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "sk-ant-oat01-work-renewed", refresh_token: "r2", expires_in: 28_800 }), { status: 200 })));
    core.failures[p(work.id)] = { ...rateLimited(), cooldownReason: "auth" };
    expect(await gw.noteGatewayCooldowns()).toBe(1);
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-renewed");
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("ok");
  });
});

describe("failed gateway turns", () => {
  const LIMIT = "All models failed (1): anthropic/claude-opus-5-5: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"You've hit your weekly limit · resets Mon 9am\"}}";

  it("runs a cron (a heartbeat is one) that died on the limit once more, on the account the pool moved to", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    core.usage.set("sk-ant-oat01-work", spent(Date.now() + 3 * 24 * H));
    core.failures[p(work.id)] = rateLimited();
    const now = Date.now() + 5_000;
    core.cronJobs = [
      { id: "heartbeat-main", state: { lastStatus: "error", lastError: LIMIT, lastRunAtMs: now - 1_000 } },
      { id: "daily-digest", state: { lastStatus: "ok", lastRunAtMs: now - 2_000 } },
      { id: "old-failure", state: { lastStatus: "error", lastError: LIMIT, lastRunAtMs: now - 60 * 60_000 } },
      { id: "openai-job", state: { lastStatus: "error", lastError: "429 rate_limit_exceeded from api.openai.com", lastRunAtMs: now - 500 } },
    ];

    // The watcher's pass: what core recorded, then the crons.
    await gw.noteGatewayCooldowns();
    await swap.whenSwapsSettled();
    expect(await gw.scanGatewayCrons(now)).toBe(1);

    expect(core.calls.filter((c) => c.method === "cron.run")).toEqual([{ method: "cron.run", params: { id: "heartbeat-main", mode: "force" } }]);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)).toMatchObject({ status: "limited" });
    expect((await pool.describePool()).lastSwap).toMatchObject({ toId: personal.id, consumers: { retries: { code: "retried", count: 1 } } });
    // Looked at once: the next pass does not report the same run again.
    expect(await gw.scanGatewayCrons(now + 1)).toBe(0);
  });

  it("sends a failed chat turn again into its session once core's record of the limit has moved the pool", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    core.usage.set("sk-ant-oat01-work", { exhausted: true, resetsAt: Date.now() + 3 * 24 * H, kind: "weekly" });
    core.failures[p(work.id)] = rateLimited();
    const outcome = await gw.reportChatFailure({
      errorMessage: "⚠️ API rate limit reached. Please try again later.",
      detail: "HTTP 429: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"You've hit your weekly limit · resets Mon 9am\"}}",
      reason: "rate_limit",
      provider: "anthropic",
      sessionKey: "agent:main:main",
      message: "Summarise my inbox",
    });
    expect(outcome).toMatchObject({ handled: true, kind: "limit", limitKind: "weekly", activeLabel: "Personal Max", retry: "sent" });
    expect((await pool.readAccounts()).find((a) => a.id === work.id)).toMatchObject({ status: "limited", limitKind: "weekly" });
    const sent = core.calls.filter((c) => c.method === "chat.send");
    expect(sent).toEqual([{ method: "chat.send", params: expect.objectContaining({ sessionKey: "agent:main:main", message: "Summarise my inbox", deliver: false }) }]);
    // The retry's key is stable for the turn it repeats.
    expect((sent[0].params as { idempotencyKey: string }).idempotencyKey).toMatch(/^clawbox-swap-[0-9a-f]{16}$/);
  });

  it("blames no pool account for a turn core recorded nothing against — the chat's own sign-in, say", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const outcome = await gw.reportChatFailure({
      detail: "HTTP 429: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"You've hit your weekly limit · resets Mon 9am\"}}",
      reason: "rate_limit",
      provider: "anthropic",
      sessionKey: "agent:main:main",
      message: "Summarise my inbox",
    });
    expect(outcome).toMatchObject({ handled: true, kind: "limit", activeLabel: "Work Max", retry: "sent" });
    expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
    expect(core.calls.filter((c) => c.method === "chat.send")).toHaveLength(1);
  });

  it("treats a bare rate limit as a throttle: nothing moved, the turn sent again a minute later", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const first = await gw.reportChatFailure({
      errorMessage: "⚠️ API rate limit reached. Please try again later.",
      detail: "HTTP 429: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
      reason: "rate_limit",
      provider: "anthropic",
      sessionKey: "agent:main:main",
      message: "Summarise my inbox",
    });
    expect(first).toMatchObject({ handled: true, kind: "throttled", retry: "later", activeLabel: "Work Max" });
    expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
    expect(core.calls.filter((c) => c.method === "chat.send")).toEqual([]);
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(core.calls.filter((c) => c.method === "chat.send")).toHaveLength(1));
  });

  it("tells the chat of no move when the pool's only account is the Terminal's `claude` sign-in, which the gateway cannot carry", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    // 2026-10-10: the chat was told 13 times that the box had "moved
    // everything that uses Claude" to a sign-in the gateway cannot use.
    fs.mkdirSync(path.join(root, "home", ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, "home", ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-terminal-sign-in" } }));
    const [login] = await pool.readAccounts();
    expect(login.kind).toBe("login");
    await swap.whenSwapsSettled();

    const outcome = await gw.reportChatFailure({
      errorMessage: 'No API key found for provider "anthropic".',
      reason: "auth",
      provider: "anthropic",
      sessionKey: "agent:main:main",
      message: "Summarise my inbox",
    });
    expect(outcome).toMatchObject({ handled: true, kind: "auth", activeId: null, activeLabel: null, allLimited: false, retry: "none" });
    expect(core.pastes).toEqual([]);
    expect(core.calls.filter((c) => c.method === "chat.send")).toEqual([]);
    const view = await pool.describePool();
    expect(view.activeAccountId).toBe(login.id);
    expect(view.gateway.following).toBe(false);
    expect(view.lastSwap?.consumers.gateway).toEqual({ status: "skipped", code: "not_transferable", count: null });
  });

  it("ignores another provider's failure", async () => {
    fakeCore();
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

describe("the owner's switch: use these accounts for the chat too", () => {
  it("puts the Claude accounts in BEFORE the chat's model is set", async () => {
    const core = fakeCore();
    core.chatOnClaude = false;
    const { work } = await twoClaudeAccounts();
    const setModel = vi.fn(async () => {
      // The model route resolves Claude's row from what the store holds now.
      expect(core.profiles.has(p(work.id))).toBe(true);
      core.chatOnClaude = true;
      return { ok: true as const };
    });
    expect(await gw.useAccountsForChat(setModel)).toMatchObject({ ok: true });
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(core.order?.[0]).toBe(p(work.id));
    // And the keeper that follows keeps them.
    await gw.keepGatewayMirror();
    expect(core.logouts).toEqual([]);
  });

  it("refuses with no Claude account to give, and sets no model", async () => {
    const core = fakeCore();
    await pool.addApiKeyAccount({ label: "Key", key: "sk-ant-api03-a-key-000000000000000000000" });
    const setModel = vi.fn(async () => ({ ok: true as const }));
    expect(await gw.useAccountsForChat(setModel)).toMatchObject({ ok: false, code: "no_claude_account", status: 409 });
    expect(setModel).not.toHaveBeenCalled();
    expect(core.pastes).toEqual([]);
  });

  it("sets no model when core would not take the accounts, and answers the model route's refusal as its own", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    core.refusePaste = true;
    const setModel = vi.fn(async () => ({ ok: false as const, error: "That provider is switched off. Switch it on first.", status: 409 }));
    expect(await gw.useAccountsForChat(setModel)).toMatchObject({ ok: false, code: "gateway_write_failed", status: 502 });
    expect(setModel).not.toHaveBeenCalled();
    core.refusePaste = false;
    expect(await gw.useAccountsForChat(setModel)).toEqual({ ok: false, code: "model_not_set", error: "That provider is switched off. Switch it on first.", status: 409 });
  });
});
