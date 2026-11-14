/**
 * The OpenClaw gateway as a consumer of the box's Anthropic account pool
 * (TASK-1260; the gateway leg of 2026-10-14) — the real pool and swap, a
 * stand-in for core's auth store and the `openclaw models auth` verbs.
 *
 * What would make it worthless or harmful if it broke:
 *
 *  1. THE POOL IN THE GATEWAY — every Claude account is its own profile, the
 *     access token only, in an order that follows the pool (the active account
 *     first, the chat's own sign-in last); a limited account out of the
 *     gateway (core's logout) while another can answer with its current
 *     token, or the chat's own subscription sign-in — core's rule moves a
 *     Claude CLI session off a removed profile (TASK-2533) — and back when it
 *     can answer, with no stop of its own while another does; the
 *     gateway stopped only for a token paste, and once for every account's.
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
    /** openclaw.json's `auth.order.anthropic`, which core's paste-token writes beside a sign-in of another mode. */
    configOrder: null as string[] | null,
    readable: true,
    pastes: [] as { profileId: string; access: string; expires: number | null }[],
    logouts: [] as string[],
    orders: [] as string[][],
    calls: [] as { method: string; params: Record<string, unknown> }[],
    cronJobs: [] as unknown[],
    /** Anthropic's usage windows, by access token; absent is "could not be asked". */
    usage: new Map<string, Usage>(),
    refusePaste: false,
    /** Ids whose paste core refuses, whatever `refusePaste` says. */
    refusePasteOf: new Set<string>(),
    refuseOrder: false,
    /**
     * OpenClaw 2026.11.3's `models.authOrderSet`: with no stored order and a
     * config one, the config one is core's order and no stored one is taken over it.
     */
    configControlsOrder: false,
    /** `order set` answers OK and the stored order reads back otherwise (core's read raced it). */
    orderReadsBackOtherwise: false,
    /** The `--agent` arguments openclaw.json's roster calls for; null: no `main` in it. */
    agent: [] as string[] | null,
    /** `paste-token` wrote the profile, then could not tell the running gateway and exited non-zero. */
    pasteExitsAfterWrite: false,
    /** OpenClaw 2026.11.3 keeps every other profile of the provider after the order asked for. */
    orderKeepsOthers: false,
    /** The gateway could not be stopped and started again around the pastes. */
    offlineFails: false,
    /** The gateway could not be STOPPED: the window's work never runs. */
    stopFails: false,
    /** The gateway is stopped, the pastes running. */
    windowOpen: false,
    /** How long one paste takes — a CLI start-up, on a clock the test has faked. */
    pasteTakesMs: 0,
    /**
     * Core's authorization lifetime per profile (OpenClaw 2026.11.3): a new one
     * on every write that is not core's own refresh — every paste.
     */
    lifetimes: new Map<string, string>(),
    /** Automations with core's hidden inference binding (TASK-2533). */
    crons: new Map<string, FakeCron>(),
    /** The `main` agent's default model, what a model-less automation runs on. */
    chatModel: "anthropic/claude-opus-5-5",
    /** The chat reader says what openclaw.json's order is (the production reader does). */
    tellsConfigOrder: false,
    /** openclaw.json cannot be written (a locked file, a config conflict). */
    refuseConfigSet: false,
    configWrites: [] as string[][],
    /** `cron.update` calls core refuses, by step value (`null` is a clear). */
    refuseCronUpdate: new Set<string | null>(),
    /** `cron.update` calls core applies and whose answer is then lost. */
    loseReplyOf: new Set<string | null>(),
    /** Runs before each gateway request: the owner acting meanwhile. */
    beforeCall: null as ((method: string, params: Record<string, unknown>) => void) | null,
    /** Other providers' profiles core holds (`deepseek:default`, …): what a job given back can be bound to. */
    otherProfiles: new Map<string, { provider: string; type: string; secret: string }>(),
  };
  offlineWindows = 0;
  gw._setGatewayDepsForTests({
    absent: () => false,
    chat: async () => (core.chatOnClaude === null ? null : {
      onAnthropic: core.chatOnClaude,
      configOrder: core.configOrder !== null,
      agent: core.agent,
      model: core.chatModel,
      ...(core.tellsConfigOrder ? { configOrderIds: core.configOrder ? [...core.configOrder] : null } : {}),
    }),
    setConfigOrder: async (ids) => {
      if (core.refuseConfigSet) throw new Error("config write refused: the file is locked");
      core.configWrites.push([...ids]);
      core.configOrder = [...ids];
    },
    readProvider: (provider) => ({
      kind: "present",
      profiles: [...core.otherProfiles].filter(([, p]) => p.provider === provider)
        .map(([profileId, p]) => ({ profileId, type: p.type, fingerprint: fp(p.secret), refreshFingerprint: null, expires: null, fenced: false, fence: null, authorization: core.lifetimes.get(profileId) ?? null })),
      order: null,
      failures: {},
    }),
    read: () => core.readable
      ? {
        kind: "present",
        profiles: [...core.profiles].map(([profileId, p]) => ({ profileId, type: p.type, fingerprint: fp(p.secret), refreshFingerprint: null, expires: p.expires, fenced: false, fence: null, authorization: core.lifetimes.get(profileId) ?? null })),
        order: core.order ? [...core.order] : null,
        failures: core.failures,
      }
      : { kind: "unreadable" },
    // OpenClaw 2026.11.3 takes `paste-token` only offline: the pass's pastes
    // run in one window with the gateway stopped (counted here).
    offline: async (work) => {
      offlineWindows += 1;
      if (core.stopFails) throw new Error("the gateway is still stopping");
      core.windowOpen = true;
      try {
        const done = await work();
        if (core.offlineFails) throw new Error("the gateway did not start again");
        return done;
      } finally {
        core.windowOpen = false;
      }
    },
    paste: async (profileId, token) => {
      if (core.pasteTakesMs > 0) vi.setSystemTime(Date.now() + core.pasteTakesMs);
      if (core.refusePaste || core.refusePasteOf.has(profileId)) throw new Error("the auth store is busy");
      core.pastes.push({ profileId, ...token });
      core.profiles.set(profileId, { type: "token", secret: token.access, expires: token.expires });
      // Explicit upsert is replacement: a new authorization lifetime.
      core.lifetimes.set(profileId, crypto.randomUUID());
      // applyAuthProfileConfig: beside a sign-in of another mode the paste
      // starts (or leads) a CONFIG order.
      if (core.configOrder) core.configOrder = [profileId, ...core.configOrder.filter((id) => id !== profileId)];
      else if (core.profiles.get("anthropic:default")?.type === "oauth") core.configOrder = [profileId, "anthropic:default"];
      if (core.pasteExitsAfterWrite) throw new Error("Model auth changes were saved, but the Gateway could not refresh them.");
    },
    logout: async (profileId) => {
      core.logouts.push(profileId);
      core.profiles.delete(profileId);
      core.lifetimes.delete(profileId);
      if (core.order) core.order = core.order.filter((id) => id !== profileId);
      if (core.configOrder) core.configOrder = core.configOrder.filter((id) => id !== profileId);
    },
    order: async (ids) => {
      if (core.refuseOrder) throw new Error("the auth state is busy");
      if (core.configControlsOrder && ids.length > 0 && !(core.order && core.order.length > 0) && core.configOrder !== null) {
        throw new Error("profile priority for provider anthropic is controlled by auth configuration");
      }
      core.orders.push([...ids]);
      core.order = ids.length > 0 ? [...ids, ...(core.orderKeepsOthers ? [...core.profiles.keys()].filter((id) => !ids.includes(id)) : [])] : null;
      if (core.orderReadsBackOtherwise && core.order) core.order = [...core.order].reverse();
    },
    unsetConfigOrder: async () => {
      core.configOrder = null;
    },
    usage: async (access) => core.usage.get(access) ?? null,
    call: async (method, params) => {
      core.calls.push({ method, params });
      core.beforeCall?.(method, params);
      if (method === "cron.list") return { jobs: [...core.cronJobs, ...[...core.crons.values()].map(publicCron)] };
      if (method === "cron.update") return cronUpdate(core, params);
      return { ok: true };
    },
  });
  return core;
}

/** One automation as core 2026.11.3 keeps it: its binding is never in `cron.list`. */
interface FakeCron {
  id: string;
  agentId?: string;
  sessionTarget: string;
  enabled: boolean;
  payload: { kind: string; message: string; model?: string };
  binding: { profileId: string; lifetime: string } | null;
  revision: number;
  state: { lastStatus?: string; lastError?: string; lastRunAtMs?: number };
}

function publicCron(job: FakeCron): Record<string, unknown> {
  const { binding: _hidden, revision, ...rest } = job;
  return { ...structuredClone(rest), configRevision: `rev-${revision}` };
}

/**
 * `cron.update` as core 2026.11.3 answers it: only a `model@profile` captures
 * a binding (the profile's CURRENT lifetime), `model: null` deletes the model
 * and keeps the binding it holds.
 */
function cronUpdate(core: ReturnType<typeof fakeCore>, params: Record<string, unknown>): Record<string, unknown> {
  const job = core.crons.get(String(params.id));
  if (!job) throw new Error(`unknown cron job id: ${String(params.id)}`);
  const model = ((params.patch as { payload?: { model?: string | null } }).payload ?? {}).model;
  if (core.refuseCronUpdate.has(model ?? null)) throw new Error("cron.update: the scheduler is busy");
  if (params.expectedConfigRevision !== undefined && params.expectedConfigRevision !== `rev-${job.revision}`) {
    throw new Error("cron job definition no longer matches the loaded version; review the latest version before retrying");
  }
  if (typeof model === "string") {
    const at = model.lastIndexOf("@");
    if (at > 0) {
      const profileId = model.slice(at + 1);
      if (!core.profiles.has(profileId) && !core.otherProfiles.has(profileId)) throw new Error("The selected automation account is unavailable.");
      if (!core.lifetimes.has(profileId)) core.lifetimes.set(profileId, crypto.randomUUID());
      job.binding = { profileId, lifetime: core.lifetimes.get(profileId) as string };
    }
    job.payload.model = model;
  } else if (model === null) {
    delete job.payload.model;
  }
  job.revision += 1;
  if (core.loseReplyOf.has(model ?? null)) throw new Error("gateway request timed out");
  return { ok: true, job: publicCron(job) };
}

/** A scheduled run as core 2026.11.3 admits it: the recorded account, that one only. Answers the profile it ran on. */
function runCron(core: ReturnType<typeof fakeCore>, id: string, now = Date.now()): string {
  const job = core.crons.get(id) as FakeCron;
  const fail = (text: string) => {
    job.state = { lastStatus: "error", lastError: text, lastRunAtMs: now };
    return text;
  };
  if (!job.binding) return fail("Automation has no recorded inference account. Explicitly select its account with a model@profile update before running it.");
  if (core.lifetimes.get(job.binding.profileId) !== job.binding.lifetime) return fail("Automation inference account was replaced. Explicitly select an authorized account again.");
  job.state = { lastStatus: "ok", lastRunAtMs: now };
  return job.binding.profileId;
}

function addCron(core: ReturnType<typeof fakeCore>, job: Partial<FakeCron> & { id: string }): FakeCron {
  const full: FakeCron = { sessionTarget: "isolated", enabled: true, payload: { kind: "agentTurn", message: "Summarise the inbox" }, binding: null, revision: 1, state: {}, ...job };
  core.crons.set(full.id, full);
  return full;
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
  (await import("@/lib/anthropic-cron-binding"))._resetCronBindingForTests();
  // No test reaches Anthropic: a usage ask nobody stubbed gets no answer.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
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
const UNSAID = { fiveHour: null, sevenDay: null };
const spent = (resetsAt: number): Usage => ({ exhausted: true, resetsAt, kind: "session", utilization: UNSAID });
const rateLimited = (now = Date.now(), until = now + 30_000): Failure => ({
  cooldownUntil: until, cooldownReason: "rate_limit", disabledUntil: null, disabledReason: null, blockedUntil: null, lastFailureAt: now - 1_000,
});

/** How many offline windows (gateway stopped) the pool asked for. */
let offlineWindows = 0;

describe("the pool in the gateway", () => {
  it("puts every Claude account in as its own profile — the access token only — the active one first and the chat's own sign-in last", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();

    expect(await gw.keepGatewayMirror()).toBe("synced");

    expect(core.pastes.map((w) => w.profileId).sort()).toEqual([p(work.id), p(personal.id)].sort());
    expect(core.pastes.find((w) => w.profileId === p(work.id))).toMatchObject({ access: "sk-ant-oat01-work", expires: expect.any(Number) });
    expect(JSON.stringify(core.pastes)).not.toContain("refresh-");
    // Both pastes in ONE offline window: the gateway is stopped once a pass.
    expect(offlineWindows).toBe(1);
    expect(core.order).toEqual([p(work.id), p(personal.id), "anthropic:default"]);
    // The chat's own sign-in is never written or taken out.
    expect(core.profiles.get("anthropic:default")?.secret).toBe(OWN);
    expect(core.logouts).toEqual([]);
    expect((await pool.describePool()).gateway).toMatchObject({ following: true, accountId: work.id, label: "Work Max" });

    // A second pass with nothing changed asks core for nothing.
    const asked = core.pastes.length + core.orders.length;
    expect(await gw.keepGatewayMirror()).toBe("fresh");
    expect(core.pastes.length + core.orders.length).toBe(asked);
    // ...and stops nothing.
    expect(offlineWindows).toBe(1);
  });

  it("takes an order the gateway completed with the provider's other profiles as landed (OpenClaw 2026.11.3)", async () => {
    const core = fakeCore();
    core.orderKeepsOthers = true;
    const { work, personal } = await twoClaudeAccounts();
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect(core.order?.slice(0, 2)).toEqual([p(work.id), p(personal.id)]);
    // A second pass finds the order leading with the pool's and writes nothing.
    const orders = core.orders.length;
    expect(await gw.keepGatewayMirror()).toBe("fresh");
    expect(core.orders.length).toBe(orders);
  });

  it("fails the pass when the gateway did not start again after the token pastes, whatever the store shows", async () => {
    const core = fakeCore();
    core.offlineFails = true;
    await twoClaudeAccounts();
    expect(await gw.keepGatewayMirror()).not.toBe("synced");
    expect(core.pastes.length).toBe(2);
  });

  it("moves the order when the pool moves — a limit seen elsewhere, the owner's new order — and never restarts anything", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();

    // A coding run hit Work's limit.
    await pool.markLimited(work.id, Date.now() + H, "weekly", { source: "coding" });
    await swap.whenSwapsSettled();
    expect(core.order).toEqual([p(personal.id), "anthropic:default"]);
    const view = await pool.describePool();
    expect(view.gateway).toMatchObject({ following: true, accountId: personal.id, label: "Personal Max" });
    // Work is out of the gateway while Personal answers (TASK-2533): one held.
    expect(view.lastSwap?.consumers.gateway).toEqual({ status: "ok", code: "switched", count: 1 });

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
    // The pool's key is never the gateway's; with its one Claude account
    // limited, the chat's own subscription sign-in answers.
    expect(core.order).toEqual(["anthropic:default"]);
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

  it("renews every other account in the SAME offline window when one comes due — one gateway stop a token lifetime, not one an account", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    expect(offlineWindows).toBe(1);
    // The accounts were signed in at different times: Work's token is inside
    // the pool's renewal margin, Personal's has two hours more.
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work", 2 * H), email: "work@example.com" });
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal", 4 * H), email: "me@example.com" });
    let renewals = 0;
    const gatewayStopped: boolean[] = [];
    const anthropic = vi.fn(async () => {
      renewals += 1;
      gatewayStopped.push(core.windowOpen);
      return new Response(JSON.stringify({ access_token: `sk-ant-oat01-renewed-${renewals}`, refresh_token: `r-${renewals}`, expires_in: 28_800 }), { status: 200 });
    });
    vi.stubGlobal("fetch", anthropic);

    expect(await gw.keepGatewayMirror()).toBe("synced");

    // Work came due; Personal was renewed beside it, and both went in with
    // the gateway stopped ONCE.
    expect(anthropic).toHaveBeenCalledTimes(2);
    expect(offlineWindows).toBe(2);
    // Only the renewal that called for the window was made with the gateway
    // up: Anthropic refuses the token a renewal replaced, so Personal's was
    // replaced only once the gateway was stopped.
    expect(gatewayStopped).toEqual([false, true]);
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-renewed-1");
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-renewed-2");
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: work.id, pending: false, fingerprint: fp("sk-ant-oat01-renewed-1") });

    // Their tokens end together now: the next pass has nothing to renew, and
    // stops nothing.
    expect(await gw.keepGatewayMirror()).toBe("fresh");
    expect(anthropic).toHaveBeenCalledTimes(2);
    expect(offlineWindows).toBe(2);
  });

  it("renews nothing ahead of time for an account whose token ends with the one going in", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const anthropic = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", anthropic);
    // The owner signed Work in again: a fresh token, minutes younger than
    // Personal's. Renewing Personal for that would refuse the copy a coding
    // run holds, to move its end by minutes.
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal", 8 * H - 20 * 60_000), email: "me@example.com" });
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });

    expect(await gw.keepGatewayMirror()).toBe("synced");

    expect(anthropic).not.toHaveBeenCalled();
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-v2");
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal");
    expect(offlineWindows).toBe(2);
  });

  it("leaves an account as it is when its renewal ahead of time could not be made — the window still takes the token that was owed", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal", 5 * H), email: "me@example.com" });
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });
    const anthropic = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    vi.stubGlobal("fetch", anthropic);

    expect(await gw.keepGatewayMirror()).toBe("synced");

    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-v2");
    // Personal's token has five hours in it: it stays, and nothing is marked.
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal");
    expect((await pool.readAccounts()).find((a) => a.id === personal.id)?.status).toBe("ok");
    expect(offlineWindows).toBe(2);
  });

  it("renews an account ahead of time once a margin, however often a window opens beside a token that ends far later", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    let renewals = 0;
    const anthropic = vi.fn(async () => {
      renewals += 1;
      return new Response(JSON.stringify({ access_token: `sk-ant-oat01-work-renewed-${renewals}`, refresh_token: `r-${renewals}`, expires_in: 28_800 }), { status: 200 });
    });
    vi.stubGlobal("fetch", anthropic);
    // The owner signs Personal in with a token that ends in a year: no
    // renewed token of Work's ever ends as late.
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal-long-lived", 365 * 24 * H), email: "me@example.com" });
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-renewed-1");

    // ...and again, and again: each is a window, none renews Work once more.
    for (const access of ["sk-ant-oat01-personal-long-lived-2", "sk-ant-oat01-personal-long-lived-3"]) {
      await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth(access, 365 * 24 * H), email: "me@example.com" });
      expect(await gw.keepGatewayMirror()).toBe("synced");
      expect(core.profiles.get(p(personal.id))?.secret).toBe(access);
    }
    expect(offlineWindows).toBe(4);
    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-renewed-1");
  });

  it("renews ONE account, not every account, when the gateway cannot be stopped — the others still answer on the tokens it holds", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // Both inside the pool's renewal margin: their tokens end together, as
    // they do once a window has taken them together.
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work", 2 * H), email: "work@example.com" });
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal", 2 * H), email: "me@example.com" });
    const anthropic = vi.fn(async () => new Response(JSON.stringify({ access_token: "sk-ant-oat01-work-renewed", refresh_token: "r-1", expires_in: 28_800 }), { status: 200 }));
    vi.stubGlobal("fetch", anthropic);
    core.stopFails = true;

    expect(await gw.keepGatewayMirror()).toBe("failed");

    // The window never opened: Personal was not renewed, so the token the
    // gateway holds for it is still the one Anthropic takes.
    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(core.pastes.filter((w) => w.access.includes("renewed"))).toEqual([]);
    expect(await pool.gatewayCredentialFor(personal.id, { renew: false })).toMatchObject({ access: "sk-ant-oat01-personal" });
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal");

    // The next pass, the gateway stopping again: Work's owed token goes in
    // and Personal is renewed beside it, in one window.
    core.stopFails = false;
    anthropic.mockImplementation(async () => new Response(JSON.stringify({ access_token: "sk-ant-oat01-personal-renewed", refresh_token: "r-2", expires_in: 28_800 }), { status: 200 }));
    const windows = offlineWindows;
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect(offlineWindows).toBe(windows + 1);
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-renewed");
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal-renewed");
  });

  it("renews nothing more once a token renewed in the window could not be pasted — one account lost to it, not the rest", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    const third = await pool.addOAuthAccount({ label: "Team Max", email: "team@example.com", tokens: oauth("sk-ant-oat01-team") });
    await gw.keepGatewayMirror();
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work", 2 * H), email: "work@example.com" });
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal", 2 * H), email: "me@example.com" });
    await pool.replaceCredential(third.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-team", 2 * H), email: "team@example.com" });
    let renewals = 0;
    const anthropic = vi.fn(async () => {
      renewals += 1;
      return new Response(JSON.stringify({ access_token: `sk-ant-oat01-renewed-${renewals}`, refresh_token: `r-${renewals}`, expires_in: 28_800 }), { status: 200 });
    });
    vi.stubGlobal("fetch", anthropic);
    core.refusePasteOf.add(p(personal.id));

    await gw.keepGatewayMirror();

    // Work (renewed to open the window) went in; Personal was renewed with
    // the gateway stopped and core would not take it; Team was left alone, on
    // the token the gateway holds and Anthropic still takes.
    expect(anthropic).toHaveBeenCalledTimes(2);
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-renewed-1");
    expect(core.profiles.get(p(third.id))?.secret).toBe("sk-ant-oat01-team");
    expect(await pool.gatewayCredentialFor(third.id, { renew: false })).toMatchObject({ access: "sk-ant-oat01-team" });
  });

  it("spends no account that has hours left on a window that cannot write, pass after pass", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    const third = await pool.addOAuthAccount({ label: "Team Max", email: "team@example.com", tokens: oauth("sk-ant-oat01-team") });
    await gw.keepGatewayMirror();
    // Work is due; Personal and Team have six hours, three ahead of their margin.
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work", 2 * H), email: "work@example.com" });
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal", 6 * H), email: "me@example.com" });
    await pool.replaceCredential(third.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-team", 6 * H), email: "team@example.com" });
    const anthropic = vi.fn(async () => new Response(JSON.stringify({ access_token: "sk-ant-oat01-work-renewed", refresh_token: "r-1", expires_in: 28_800 }), { status: 200 }));
    vi.stubGlobal("fetch", anthropic);
    // Core takes no paste at all: its store is busy, pass after pass.
    core.refusePaste = true;

    await gw.keepGatewayMirror();
    await gw.keepGatewayMirror();

    // Only Work, which came due, was renewed. One more account a pass would
    // have left the gateway with a refused token for every one of them.
    expect(anthropic).toHaveBeenCalledTimes(1);
    for (const [account, access] of [[personal, "sk-ant-oat01-personal"], [third, "sk-ant-oat01-team"]] as const) {
      expect(core.profiles.get(p(account.id))?.secret).toBe(access);
      expect(await pool.gatewayCredentialFor(account.id, { renew: false })).toMatchObject({ access });
    }
  });

  it("takes five accounts in one window however long each paste takes — the window's budget is for asking Anthropic", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const core = fakeCore();
    const accounts = [];
    for (const name of ["a", "b", "c", "d", "e"]) {
      accounts.push(await pool.addOAuthAccount({ label: `Max ${name}`, email: `${name}@example.com`, tokens: oauth(`sk-ant-oat01-${name}`) }));
    }
    await gw.keepGatewayMirror();
    for (const [i, account] of accounts.entries()) {
      await pool.replaceCredential(account.id, { kind: "oauth", tokens: oauth(`sk-ant-oat01-${"abcde"[i]}`, 2 * H), email: `${"abcde"[i]}@example.com` });
    }
    let renewals = 0;
    const gatewayStopped: boolean[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      renewals += 1;
      gatewayStopped.push(core.windowOpen);
      return new Response(JSON.stringify({ access_token: `sk-ant-oat01-renewed-${renewals}`, refresh_token: `r-${renewals}`, expires_in: 28_800 }), { status: 200 });
    }));
    // A CLI start-up on a Jetson: five pastes are a minute.
    core.pasteTakesMs = 12_000;
    const windows = offlineWindows;

    expect(await gw.keepGatewayMirror()).toBe("synced");

    expect(gatewayStopped).toEqual([false, true, true, true, true]);
    expect(offlineWindows).toBe(windows + 1);
    expect([...core.profiles.values()].filter((profile) => profile.secret.startsWith("sk-ant-oat01-renewed-"))).toHaveLength(5);
    // All five end together: nothing is left to come due on its own.
    expect(await gw.keepGatewayMirror()).toBe("fresh");
    expect(offlineWindows).toBe(windows + 1);
  });

  it("never pastes a token that is past its end as it stands: the window renews it, or it stays owed", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // The owner signed Work in again; Personal's token ran out meanwhile, and
    // Anthropic cannot be reached to renew it.
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal-ended", -60_000), email: "me@example.com" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));

    await gw.keepGatewayMirror();

    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-v2");
    expect(core.pastes.map((w) => w.access)).not.toContain("sk-ant-oat01-personal-ended");
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal");
  });

  it("renews a due account that is not behind the token going in — beside an owed one that itself ends soon and that core keeps refusing", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // Work's token is owed, refused by core pass after pass, and ends in
    // 3 h 10 min: not due itself, and too soon for Personal (2 h 50 min, due)
    // to count as behind it. Personal is read as it is on every pass, so
    // only the window can renew it.
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2", 3 * H + 10 * 60_000), email: "work@example.com" });
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal", 3 * H - 10 * 60_000), email: "me@example.com" });
    const anthropic = vi.fn(async () => new Response(JSON.stringify({ access_token: "sk-ant-oat01-personal-renewed", refresh_token: "r-1", expires_in: 28_800 }), { status: 200 }));
    vi.stubGlobal("fetch", anthropic);
    core.refusePasteOf.add(p(work.id));

    await gw.keepGatewayMirror();

    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal-renewed");
    // Work's own token was not renewed for it, and was pasted (and refused) once.
    expect(await pool.gatewayCredentialFor(work.id, { renew: false })).toMatchObject({ access: "sk-ant-oat01-work-v2" });
  });

  it("does not paste a token that ended while the window was open, when it could not be renewed there", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // Both owed. Personal's token has three minutes left when the pass reads
    // it, Anthropic cannot be reached to renew it, and Work's paste alone
    // takes four.
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal-v2", 3 * 60_000), email: "me@example.com" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    core.pasteTakesMs = 4 * 60_000;

    await gw.keepGatewayMirror();

    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-v2");
    expect(core.pastes.map((w) => w.access)).not.toContain("sk-ant-oat01-personal-v2");
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal");
  });

  it("goes on renewing the other accounts beside one whose owed paste core keeps refusing", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // Work's new token is owed and core refuses it, pass after pass; Personal
    // comes due meanwhile.
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal", 2 * H), email: "me@example.com" });
    const anthropic = vi.fn(async () => new Response(JSON.stringify({ access_token: "sk-ant-oat01-personal-renewed", refresh_token: "r-1", expires_in: 28_800 }), { status: 200 }));
    vi.stubGlobal("fetch", anthropic);
    core.refusePasteOf.add(p(work.id));

    await gw.keepGatewayMirror();

    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal-renewed");
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work");
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

describe("a limited account and the sessions core pinned to it", () => {
  // Core keeps a session's automatic auth pin on any profile that is in the
  // stored order and not cooling down for that session's model. A spent
  // account left in the order, even last, kept answering the sessions pinned
  // to it with the provider's limit text whenever core's own backoff lapsed.
  // Left out of the order, core drops that pin on the session's next turn.
  it("logs a limited account out of the gateway while another can answer — core's way to move a Claude CLI session bound to it — and pastes it back at the reset", async () => {
    // TASK-2533: on OpenClaw 2026.11.3 a Claude CLI run keeps its session on
    // the account its CLI session was bound to whatever the order says,
    // unless that profile is gone; and core records no cooldown for a CLI
    // limit. Out of the order alone, those sessions stayed on the spent account.
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();

    await pool.markLimited(work.id, Date.now() + H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(core.order).toEqual([p(personal.id), "anthropic:default"]);
    // Out of the store, by core's own logout (no restart).
    expect(core.logouts).toEqual([p(work.id)]);
    expect(core.profiles.has(p(work.id))).toBe(false);
    // A token the pool renews meanwhile is not pasted for nothing.
    const windows = offlineWindows;
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });
    await gw.keepGatewayMirror();
    expect(core.profiles.has(p(work.id))).toBe(false);
    expect(offlineWindows).toBe(windows);
    expect(core.order).toEqual([p(personal.id), "anthropic:default"]);

    // Back (here by the owner's clear) while Personal answers: no stop of its
    // own for it — it waits for the next window the pool opens anyway.
    await pool.clearLimit(work.id);
    await gw.syncGatewayNow();
    expect(core.profiles.has(p(work.id))).toBe(false);
    expect(offlineWindows).toBe(windows);
    // Personal's renewal opens one: Work goes in with it, its current token, after the active account.
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal-v2"), email: "me@example.com" });
    await gw.keepGatewayMirror();
    expect(offlineWindows).toBe(windows + 1);
    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-v2");
    expect(core.order).toEqual([p(personal.id), p(work.id), "anthropic:default"]);
  });

  it("hands the order to the owner's own subscription sign-in when no account of the pool can answer, and takes the accounts back at their reset", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly");
    await pool.markLimited(personal.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    const synced = await gw.syncGatewayNow();
    // The sign-in leads, and the spent accounts are out of the store, so a
    // Claude CLI session bound to one moves to the sign-in on its next turn
    // (TASK-2533: on 2026.11.3 out of the order alone it stayed).
    expect(core.order).toEqual(["anthropic:default"]);
    expect(synced.status).toBe("ok");
    expect([...core.logouts].sort()).toEqual([p(work.id), p(personal.id)].sort());
    // The chat is still the pool's, on the account back first.
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: personal.id, pending: false });
    expect(await gw.keepGatewayMirror()).not.toBe("failed");
    expect(core.order).toEqual(["anthropic:default"]);

    await pool.clearLimit(personal.id);
    await gw.syncGatewayNow();
    expect(core.order).toEqual([p(personal.id), "anthropic:default"]);
  });

  it("on OpenClaw 2026.11.3 takes the owner's sign-in leading a COMPLETED order as landed — the limited accounts out of the store", async () => {
    // The gateway takes only an order naming every profile it holds; with the
    // limited accounts out of the store, that is the owner's own.
    const core = fakeCore();
    core.orderKeepsOthers = true;
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly");
    await pool.markLimited(personal.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    const synced = await gw.syncGatewayNow();
    expect(synced.status).toBe("ok");
    expect(core.order).toEqual(["anthropic:default"]);
    expect(core.logouts.length).toBe(2);
    // A second pass finds the order leading with what it wants and writes nothing.
    const orders = core.orders.length;
    expect(await gw.keepGatewayMirror()).not.toBe("failed");
    expect(core.orders.length).toBe(orders);
  });

  it("keeps every limited account in, by its reset and ahead of it, when the owner's other Anthropic credential is an API key or of a kind the store does not say", async () => {
    for (const type of ["api_key", ""]) {
      const core = fakeCore();
      core.profiles.set("anthropic:default", { type, secret: OWN, expires: null });
      gw.startGatewaySwap();
      const { work, personal } = await twoClaudeAccounts();
      await gw.keepGatewayMirror();
      await pool.markLimited(work.id, Date.now() + 2 * H, "weekly");
      await pool.markLimited(personal.id, Date.now() + H, "session");
      await swap.whenSwapsSettled();
      await gw.syncGatewayNow();
      expect(core.order).toEqual([p(personal.id), p(work.id), "anthropic:default"]);
      for (const account of [work, personal]) await pool.removeAccount(account.id);
      await swap.whenSwapsSettled();
    }
  });

  it("leaves an API key the store holds beside the sign-in out while the sign-in leads — the turn's one rotation must not spend it — and a static token that has run out is no sign-in", async () => {
    const core = fakeCore();
    core.profiles.set("anthropic:key", { type: "api_key", secret: "sk-ant-api03-owner", expires: null });
    core.order = ["anthropic:key", "anthropic:default"];
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    expect(core.order).toEqual([p(work.id), p(personal.id), "anthropic:key", "anthropic:default"]);
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly");
    await pool.markLimited(personal.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();
    expect(core.order).toEqual(["anthropic:default"]);
    expect(core.profiles.has("anthropic:key")).toBe(true);

    core.profiles.set("anthropic:default", { type: "token", secret: OWN, expires: Date.now() - 60_000 });
    await gw.syncGatewayNow();
    expect(core.order).toEqual([p(personal.id), p(work.id), "anthropic:default", "anthropic:key"]);
  });

  it("never empties the order on a box with no sign-in of the owner's: every account limited, or the one that can answer not held", async () => {
    const core = fakeCore();
    core.profiles.delete("anthropic:default");
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly");
    await pool.markLimited(personal.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();
    // An empty order is `order clear`, which falls back to openclaw.json's
    // order or profiles and re-admits every pool account.
    expect(core.order).toEqual([p(personal.id), p(work.id)]);

    // Personal can answer again, but core would not take its token: only a
    // HELD account that can answer lets the limited one out.
    await pool.clearLimit(personal.id);
    core.refusePasteOf.add(p(personal.id));
    core.profiles.delete(p(personal.id));
    await gw.syncGatewayNow();
    expect(core.order).toEqual([p(work.id)]);
    expect(core.orders.every((ids) => ids.length > 0)).toBe(true);
  });

  it("leaves an account back from its reset out while another answers — no gateway stop of its own — and puts it in at once when it is the only one that can answer", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await pool.markLimited(work.id, Date.now() + H, "weekly");
    await vi.waitFor(() => expect(core.order).toEqual([p(personal.id), "anthropic:default"]));
    const windows = offlineWindows;
    // The pool's reset wake comes 20 s past the reset; Personal answers, so no stop for Work.
    await vi.advanceTimersByTimeAsync(H + 30_000);
    await vi.waitFor(() => expect(core.order).toEqual([p(personal.id), "anthropic:default"]));
    expect(offlineWindows).toBe(windows);
    // Personal runs out: Work is the one that can answer, and goes in at once.
    await pool.markLimited(personal.id, Date.now() + H, "session");
    await vi.waitFor(() => expect(core.order?.[0]).toBe(p(work.id)));
  });
});

describe("what the move needs, and what can wait for the keeper", () => {
  it("counts a move as done once the gateway leads with the active account — another account owed costs no retry", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    const third = await pool.addOAuthAccount({ label: "Third Max", email: "third@example.com", tokens: oauth("sk-ant-oat01-third") });
    await gw.keepGatewayMirror();
    // The third account's renewal will not land; the limit moves the pool to Personal.
    await pool.replaceCredential(third.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-third-v2"), email: "third@example.com" });
    core.refusePasteOf.add(p(third.id));
    const retried = vi.fn(async () => true);
    await swap.reportAnthropicFailure({ text: "You've hit your weekly limit · resets Mon 9am", source: "cron", accountId: work.id, retry: { key: "cron:job-p", after: "gateway", run: retried } });

    expect(core.order?.[0]).toBe(p(personal.id));
    const view = await pool.describePool();
    // Work, limited, is out while Personal answers (TASK-2533): two held.
    expect(view.lastSwap?.consumers.gateway).toEqual({ status: "ok", code: "switched_partly", count: 2 });
    expect(retried).toHaveBeenCalledTimes(1);
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: personal.id, pending: false });
    // The keeper finishes the third account's write.
    core.refusePasteOf.clear();
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect(core.profiles.get(p(third.id))?.secret).toBe("sk-ant-oat01-third-v2");
  });

  it("backs off a keeper whose writes keep failing instead of spawning the CLI every pass", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    core.refusePaste = true;
    expect(await gw.keepGatewayMirror()).toBe("failed");
    expect(await gw.keepGatewayMirror()).toBe("failed");
    const tried = core.orders.length;
    core.refusePaste = false;
    // The third pass comes inside the back-off: nothing is asked of core.
    expect(await gw.keepGatewayMirror()).toBe("failed");
    expect(core.pastes).toEqual([]);
    expect(core.orders.length).toBe(tried);
    // A move of the pool's still goes through at once.
    expect(await gw.syncGatewayNow()).toMatchObject({ status: "ok", code: "switched" });
  });

  it("undoes the orders it wrote when the pool comes out — no one-entry order left to hide a later credential", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    expect(core.order).not.toBeNull();
    expect(core.configOrder).not.toBeNull();
    core.chatOnClaude = false;
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect([...core.profiles.keys()]).toEqual(["anthropic:default"]);
    expect(core.order).toBeNull();
    expect(core.configOrder).toBeNull();
    // A box that never ran the pool keeps an order the owner set by hand.
    core.order = ["anthropic:default"];
    expect(await gw.keepGatewayMirror()).toBe("idle");
    expect(core.order).toEqual(["anthropic:default"]);
  });

  it("keeps the chat named on the account the order really leads with while the active one's write is owed", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // Personal's token is renewed elsewhere and core will not take it; the owner puts Personal first.
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal-v2"), email: "me@example.com" });
    core.refusePasteOf.add(p(personal.id));
    core.refuseOrder = true;
    await pool.reorderAccounts([personal.id, work.id]);
    await swap.whenSwapsSettled();
    // Not on the new active account yet — but on the pool, not "does not use these accounts".
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: work.id, pending: true });
    expect((await pool.describePool()).gateway.following).toBe(true);
  });

  it("says the chat is off the accounts as soon as they are out, even with the order's cleanup still owed", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    core.chatOnClaude = false;
    core.refuseOrder = true;
    expect(await gw.keepGatewayMirror()).toBe("synced");
    expect([...core.profiles.keys()]).toEqual(["anthropic:default"]);
    expect((await pool.describePool()).gateway.following).toBe(false);
    // The keeper finishes it.
    core.refuseOrder = false;
    await gw.syncGatewayNow();
    expect(core.order).toBeNull();
  });

  it("writes nothing to a roster without a `main` agent, and says so instead of looping", async () => {
    const core = fakeCore();
    core.agent = null;
    await twoClaudeAccounts();
    expect(await gw.syncGatewayNow()).toEqual({ status: "skipped", code: "agent_unsupported", count: null });
    expect(core.pastes).toEqual([]);
    expect(await gw.putChatOnPool(async () => ({ ok: true }))).toMatchObject({ ok: false, code: "agent_unsupported", status: 409 });
  });

  it("clears on take-out an order core said it wrote, even when its read-back disagreed", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    core.orderReadsBackOtherwise = true;
    await gw.keepGatewayMirror();
    core.orderReadsBackOtherwise = false;
    core.chatOnClaude = false;
    await gw.syncGatewayNow();
    expect(core.order).toBeNull();
  });

  it("stops naming the pool when the roster loses its `main` agent", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    expect((await pool.describePool()).gateway.following).toBe(true);
    core.agent = null;
    expect(await gw.syncGatewayNow()).toMatchObject({ status: "skipped", code: "agent_unsupported" });
    expect((await pool.describePool()).gateway.following).toBe(false);
  });

  it("leaves an order the owner had in openclaw.json before the pool came", async () => {
    const core = fakeCore();
    core.configOrder = ["anthropic:default"];
    await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    core.chatOnClaude = false;
    await gw.keepGatewayMirror();
    expect(core.configOrder).toEqual(["anthropic:default"]);
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
    expect(core.order).toEqual([p(personal.id), "anthropic:default"]);
    expect(announceAnthropicLimit).toHaveBeenCalledTimes(1);
    // One failure is one limit: seen again, nothing more happens.
    await pool.clearLimit(work.id);
    expect(await gw.noteGatewayCooldowns()).toBe(0);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("ok");
  });

  it("sees a failure whose 30-second cooldown is already over by the time it looks", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const resetsAt = Date.now() + 2 * H;
    core.usage.set("sk-ant-oat01-work", spent(resetsAt));
    const now = Date.now();
    // The first rate limit after a success: 30 s, and the watcher came at 45 s.
    core.failures[p(work.id)] = rateLimited(now - 45_000, now - 15_000);
    expect(await gw.noteGatewayCooldowns(now)).toBe(1);
    await swap.whenSwapsSettled();
    expect((await pool.readAccounts()).find((a) => a.id === work.id)).toMatchObject({ status: "limited", limitedUntil: resetsAt });
    expect((await pool.readPoolState()).activeId).toBe(personal.id);
  });

  it("does not reach further back than a quarter of an hour on its first look, and needs a reason core still keeps", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    core.usage.set("sk-ant-oat01-work", spent(Date.now() + H));
    core.usage.set("sk-ant-oat01-personal", spent(Date.now() + H));
    const now = Date.now();
    // Before this process started looking (a boot) — and a success since cleared the other's reason.
    core.failures[p(work.id)] = rateLimited(now - 3 * H, now - 3 * H + 30_000);
    core.failures[p(personal.id)] = { ...rateLimited(now - 60_000), cooldownReason: null, cooldownUntil: null };
    expect(await gw.noteGatewayCooldowns(now)).toBe(0);
    expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
  });

  it("reads a newer rate limit over a refusal left on record from an earlier failure", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const resetsAt = Date.now() + 2 * H;
    core.usage.set("sk-ant-oat01-work", spent(resetsAt));
    const now = Date.now();
    // An old permanent-auth disable (over), then a real rate limit 45 s ago.
    core.failures[p(work.id)] = { ...rateLimited(now - 45_000, now - 15_000), disabledUntil: now - 60 * 60_000, disabledReason: "auth_permanent" };
    expect(await gw.noteGatewayCooldowns(now)).toBe(1);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)).toMatchObject({ status: "limited", limitedUntil: resetsAt });
  });

  it("leaves an account in when Anthropic says none of its windows is spent — a throttle core's own cooldown covers", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    core.usage.set("sk-ant-oat01-work", { exhausted: false, resetsAt: null, kind: "session", utilization: UNSAID });
    core.failures[p(work.id)] = rateLimited();
    expect(await gw.noteGatewayCooldowns()).toBe(0);
    expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
  });

  it("with Anthropic unreachable, takes core's own window — never longer than a session window", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const now = Date.now();
    // Core's fifth rate limit in a row: eight minutes — a cap, not a throttle.
    core.failures[p(work.id)] = rateLimited(now, now + 8 * 60_000);
    core.failures[p(personal.id)] = rateLimited(now, now + 30 * H);
    expect(await gw.noteGatewayCooldowns(now)).toBe(2);
    const accounts = await pool.readAccounts();
    expect(accounts.find((a) => a.id === work.id)?.limitedUntil).toBe(now + 8 * 60_000);
    expect(accounts.find((a) => a.id === personal.id)?.limitedUntil).toBe(now + 5 * H);
  });

  it("with Anthropic unreachable, leaves core's short cooldowns to core and takes the cap once its back-off reaches five minutes", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // Core's rate-limit back-off on one account, each failure after the last
    // window ended: 30 s, 1, 2, 4 min — throttles, so no swap ends a live
    // coding run — then 8 min, a cap the pool takes over.
    let at = Date.now();
    const verdicts: number[] = [];
    for (const window of [30_000, 60_000, 120_000, 240_000, 480_000]) {
      core.failures[p(work.id)] = { ...rateLimited(at, at + window), lastFailureAt: at };
      verdicts.push(await gw.noteGatewayCooldowns(at + 1_000));
      await swap.whenSwapsSettled();
      if (verdicts.length < 5) {
        expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
        expect((await pool.readPoolState()).activeId).toBe(work.id);
      }
      at += window + 5_000;
    }
    expect(verdicts).toEqual([0, 0, 0, 0, 1]);
    expect((await pool.readPoolState()).activeId).toBe(personal.id);
    expect(announceAnthropicLimit).toHaveBeenCalledTimes(1);
  });

  it("with Anthropic unreachable, judges core's window by its length — a cap first seen late is still a cap", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const now = Date.now();
    // An eight-minute window first looked at four minutes in (a web-server restart).
    core.failures[p(work.id)] = { ...rateLimited(now - 4 * 60_000, now + 4 * 60_000), lastFailureAt: now - 4 * 60_000 };
    expect(await gw.noteGatewayCooldowns(now)).toBe(1);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.limitedUntil).toBe(now + 4 * 60_000);
  });

  it("with Anthropic unreachable and core's window over, sets nothing aside", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const now = Date.now();
    core.failures[p(work.id)] = rateLimited(now - 45_000, now - 15_000);
    expect(await gw.noteGatewayCooldowns(now)).toBe(0);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("ok");
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

  it("runs a cron (a heartbeat is one) that died on the limit once more, on the account the pool moved to (a limit core recorded a cooldown for; T3 is the Claude CLI case, which records none)", async () => {
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
    core.usage.set("sk-ant-oat01-work", { exhausted: true, resetsAt: Date.now() + 3 * 24 * H, kind: "weekly", utilization: UNSAID });
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
    expect(await gw.putChatOnPool(setModel)).toMatchObject({ ok: true });
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
    expect(await gw.putChatOnPool(setModel)).toMatchObject({ ok: false, code: "no_claude_account", status: 409 });
    expect(setModel).not.toHaveBeenCalled();
    expect(core.pastes).toEqual([]);
  });

  it("sets no model when core would not take the accounts, and answers the model route's refusal as its own", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    core.refusePaste = true;
    const setModel = vi.fn(async () => ({ ok: false as const, error: "That provider is switched off. Switch it on first.", status: 409 }));
    expect(await gw.putChatOnPool(setModel)).toMatchObject({ ok: false, code: "gateway_write_failed", status: 502 });
    expect(setModel).not.toHaveBeenCalled();
    core.refusePaste = false;
    core.chatOnClaude = false;
    expect(await gw.putChatOnPool(setModel)).toEqual({ ok: false, code: "model_not_set", error: "That provider is switched off. Switch it on first.", status: 409 });
    // The chat did not move, so the accounts are out again and the card offers the switch.
    expect([...core.profiles.keys()]).toEqual(["anthropic:default"]);
    expect((await pool.describePool()).gateway.following).toBe(false);
  });

  it("answers a model route that failed AFTER the chat's model landed on Claude as done, with what the box reported — the accounts stay", async () => {
    const core = fakeCore();
    core.chatOnClaude = false;
    const { work } = await twoClaudeAccounts();
    const setModel = vi.fn(async () => {
      // `agents.defaults.model.primary` is written, then a later step of the model route throws.
      core.chatOnClaude = true;
      return { ok: false as const, error: "The plugin state could not be written.", status: 500 };
    });
    const result = await gw.putChatOnPool(setModel);
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining("The plugin state could not be written.") });
    // Taking them out would leave a chat on Claude with no credential of the pool's.
    expect(core.logouts).toEqual([]);
    expect(core.order?.[0]).toBe(p(work.id));
    expect((await pool.describePool()).gateway.following).toBe(true);
  });

  it("takes nothing out when the model route failed and openclaw.json cannot be read to tell whether the chat moved, and says so", async () => {
    const core = fakeCore();
    core.chatOnClaude = false;
    await twoClaudeAccounts();
    const setModel = vi.fn(async () => {
      core.chatOnClaude = null;
      return { ok: false as const, error: "Failed to switch chat model", status: 500 };
    });
    const result = await gw.putChatOnPool(setModel);
    expect(result).toMatchObject({ ok: false, code: "model_unknown", status: 500 });
    expect(result.ok ? "" : result.error).toMatch(/could not be read.*Failed to switch chat model$/);
    expect(core.logouts).toEqual([]);
  });

  it("decides a model route that threw the same way as one that refused — the accounts go out when the chat did not move", async () => {
    const core = fakeCore();
    core.chatOnClaude = false;
    await twoClaudeAccounts();
    const setModel = vi.fn(async (): Promise<{ ok: true }> => {
      throw new Error("the config store could not be written");
    });
    expect(await gw.putChatOnPool(setModel)).toEqual({ ok: false, code: "model_not_set", error: "the config store could not be written", status: 500 });
    expect([...core.profiles.keys()]).toEqual(["anthropic:default"]);
    expect((await pool.describePool()).gateway.following).toBe(false);
  });
});

describe("automations follow the pool across a swap and a renewal (TASK-2533, OpenClaw 2026.11.3)", () => {
  // Since 2026.11.3 every isolated agent-turn automation runs on its RECORDED
  // inference account — one profile and that profile's authorization
  // lifetime — and on no other. The pool's renewals are `paste-token` writes,
  // a new lifetime each, and a swap moves only the order.
  it("binds a model-less automation to the account the order leads with, and it keeps inheriting the agent's default model", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    expect(runCron(core, "inbox")).toMatch(/no recorded inference account/);

    await gw.keepGatewayMirror();

    const job = core.crons.get("inbox") as FakeCron;
    expect(job.binding?.profileId).toBe(p(work.id));
    // Bound, and no model of its own left behind: it still follows the agent default.
    expect(job.payload.model).toBeUndefined();
    expect(core.calls.filter((c) => c.method === "cron.update").map((c) => (c.params.patch as { payload: { model: unknown } }).payload.model))
      .toEqual([`anthropic/claude-opus-5-5@${p(work.id)}`, null]);
    expect(runCron(core, "inbox")).toBe(p(work.id));
    // A pass with nothing changed updates nothing.
    const updates = core.calls.filter((c) => c.method === "cron.update").length;
    await gw.bindGatewayCrons();
    await gw.keepGatewayMirror();
    expect(core.calls.filter((c) => c.method === "cron.update").length).toBe(updates);
  });

  it("keeps running across a token renewal: the paste's new lifetime is adopted again before the next run", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    await gw.keepGatewayMirror();
    expect(runCron(core, "inbox")).toBe(p(work.id));
    const before = core.lifetimes.get(p(work.id));

    // The pool renews Work's token; the keeper pastes it in.
    await pool.replaceCredential(work.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-work-v2"), email: "work@example.com" });
    await gw.keepGatewayMirror();

    expect(core.profiles.get(p(work.id))?.secret).toBe("sk-ant-oat01-work-v2");
    expect(core.lifetimes.get(p(work.id))).not.toBe(before);
    expect((core.crons.get("inbox") as FakeCron).binding).toEqual({ profileId: p(work.id), lifetime: core.lifetimes.get(p(work.id)) });
    expect(runCron(core, "inbox")).toBe(p(work.id));
  });

  it("follows a swap to the account that can answer — a model-less job, a job with its own Claude model, and a job pinned to a pool account — and leaves the owner's choices alone", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "inherits" });
    addCron(core, { id: "own-model", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-sonnet-5-5" } });
    // Re-pinned by hand on 14.11 to one pool account: it must not stay there.
    addCron(core, { id: "pinned", payload: { kind: "agentTurn", message: "m", model: `anthropic/claude-sonnet-5-5@${p(work.id)}` } });
    // The owner's own account for this job, another provider, the chat's own turn, another agent.
    addCron(core, { id: "owners", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-opus-5-5@anthropic:default" } });
    addCron(core, { id: "other-provider", payload: { kind: "agentTurn", message: "m", model: "openai/gpt-5.5" } });
    addCron(core, { id: "main-session", sessionTarget: "main", payload: { kind: "systemEvent", message: "m" } });
    addCron(core, { id: "research", agentId: "research" });
    await gw.keepGatewayMirror();
    for (const id of ["inherits", "own-model", "pinned"]) expect(runCron(core, id)).toBe(p(work.id));

    // Work hits its weekly limit; the pool moves to Personal.
    await pool.markLimited(work.id, Date.now() + H, "weekly", { source: "cron" });
    await swap.whenSwapsSettled();

    expect(core.order?.[0]).toBe(p(personal.id));
    for (const id of ["inherits", "own-model", "pinned"]) expect(runCron(core, id)).toBe(p(personal.id));
    expect((core.crons.get("inherits") as FakeCron).payload.model).toBeUndefined();
    expect((core.crons.get("own-model") as FakeCron).payload.model).toBe(`anthropic/claude-sonnet-5-5@${p(personal.id)}`);
    expect((core.crons.get("pinned") as FakeCron).payload.model).toBe(`anthropic/claude-sonnet-5-5@${p(personal.id)}`);
    const touched = new Set(core.calls.filter((c) => c.method === "cron.update").map((c) => c.params.id));
    for (const id of ["owners", "other-provider", "main-session", "research"]) expect(touched.has(id)).toBe(false);
    expect((core.crons.get("owners") as FakeCron).payload.model).toBe("anthropic/claude-opus-5-5@anthropic:default");

    // Work back: Personal still leads (it is active), so nothing moves again.
    const updates = core.calls.filter((c) => c.method === "cron.update").length;
    await pool.clearLimit(work.id);
    await gw.syncGatewayNow();
    expect(core.calls.filter((c) => c.method === "cron.update").length).toBe(updates);
  });

  it("moves its automations onto the owner's own sign-in when every pool account is limited, and back onto the pool at a reset", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "own-model", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-sonnet-5-5" } });
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly");
    await pool.markLimited(personal.id, Date.now() + H, "session");
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();
    expect(core.order?.[0]).toBe("anthropic:default");
    expect(runCron(core, "own-model")).toBe("anthropic:default");

    // The box put it on the sign-in, so it is still the box's to move back.
    await pool.clearLimit(personal.id);
    await gw.syncGatewayNow();
    expect(runCron(core, "own-model")).toBe(p(personal.id));
  });

  it("runs once more a run lost to its account, right after adopting it — once", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    // The run that failed before the box looked (the update to 2026.11.3).
    runCron(core, "inbox");
    await gw.keepGatewayMirror();
    expect(core.calls.filter((c) => c.method === "cron.run")).toEqual([{ method: "cron.run", params: { id: "inbox", mode: "force" } }]);
    expect(runCron(core, "inbox")).toBe(p(work.id));
    await gw.bindGatewayCrons();
    expect(core.calls.filter((c) => c.method === "cron.run").length).toBe(1);
  });

  it("finishes a model-less job's clear on the next pass when core did not take it — the job is never left pinned to a model it did not choose", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    core.refuseCronUpdate.add(null);
    await gw.keepGatewayMirror();
    expect((core.crons.get("inbox") as FakeCron).payload.model).toBe(`anthropic/claude-opus-5-5@${p(work.id)}`);
    core.refuseCronUpdate.clear();
    // One refusal is asked again on the next pass (TASK-2533 review F6).
    await gw.bindGatewayCrons();
    const job = core.crons.get("inbox") as FakeCron;
    expect(job.payload.model).toBeUndefined();
    expect(job.binding?.profileId).toBe(p(work.id));
  });

  it("gives the jobs it adopted back when the pool leaves the gateway — their own model again, no pin on a model-less one — and touches no other", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    addCron(core, { id: "inherits" });
    addCron(core, { id: "own-model", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-sonnet-5-5" } });
    await gw.keepGatewayMirror();
    expect((core.crons.get("own-model") as FakeCron).payload.model).toMatch(/@anthropic:clawbox-/);
    // Made after the pool left: never the box's.
    core.chatOnClaude = false;
    await gw.syncGatewayNow();
    expect([...core.profiles.keys()]).toEqual(["anthropic:default"]);
    addCron(core, { id: "later", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-haiku-5-5" } });
    await gw.bindGatewayCrons();
    expect((core.crons.get("own-model") as FakeCron).payload.model).toBe("anthropic/claude-sonnet-5-5");
    expect((core.crons.get("inherits") as FakeCron).payload.model).toBeUndefined();
    expect((core.crons.get("later") as FakeCron).revision).toBe(1);
    // Nothing left of the box's: the next look asks core nothing.
    const asked = core.calls.length;
    await gw.bindGatewayCrons();
    expect(core.calls.length).toBe(asked);
  });

  it("moves the jobs it adopted onto the owner's own sign-in when the pool's accounts all leave while the chat stays on Claude", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "own-model", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-sonnet-5-5" } });
    await gw.keepGatewayMirror();
    await pool.removeAccount(work.id);
    await pool.removeAccount(personal.id);
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();
    expect(runCron(core, "own-model")).toBe("anthropic:default");
  });

  it("never writes over an owner's edit made while it was planning: core refuses the stale revision, and the job is planned again from what it is", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    const job = addCron(core, { id: "own-model", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-sonnet-5-5" } });
    // The owner moves the job to another provider between the box's list and its update.
    core.beforeCall = (method) => {
      if (method !== "cron.update") return;
      core.beforeCall = null;
      job.payload.model = "openai/gpt-5.5";
      job.revision += 1;
    };
    await gw.keepGatewayMirror();
    expect(job.payload.model).toBe("openai/gpt-5.5");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await gw.bindGatewayCrons();
    expect(job.payload.model).toBe("openai/gpt-5.5");
  });

  it("runs a lost run again once in its window, however often it fails again", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    runCron(core, "inbox");
    await gw.keepGatewayMirror();
    // Its forced run fails on its account again (here: the binding vanished).
    (core.crons.get("inbox") as FakeCron).binding = null;
    runCron(core, "inbox", Date.now() + 1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    await gw.bindGatewayCrons();
    expect(core.calls.filter((c) => c.method === "cron.run").length).toBe(1);
    expect(runCron(core, "inbox")).toMatch(/^anthropic:clawbox-/);
  });

  it("knows a model-less job as its own when core took the pin but its answer was lost — the next pass clears it instead of keeping it pinned", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    const job = addCron(core, { id: "inbox" });
    // Core applies the pin, and its answer never arrives (a timeout on a busy box).
    core.loseReplyOf.add(`anthropic/claude-opus-5-5@${p(work.id)}`);
    await gw.keepGatewayMirror();
    expect(job.payload.model).toBe(`anthropic/claude-opus-5-5@${p(work.id)}`);
    core.loseReplyOf.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await gw.bindGatewayCrons();
    expect(job.payload.model).toBeUndefined();
    expect(job.binding?.profileId).toBe(p(work.id));
    expect(runCron(core, "inbox")).toBe(p(work.id));
  });

  it("never binds the automations to a static token past its end, whatever the order says (CodeRabbit on #1526)", async () => {
    const core = fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const job = addCron(core, { id: "inbox" });
    // Work's copy has run out and the order has not been rewritten yet.
    const held = core.profiles.get(p(work.id));
    if (held) held.expires = Date.now() - 1_000;
    await gw.bindGatewayCrons();
    expect(job.binding?.profileId).toBe(p(personal.id));
  });

  it("adopts a job the chat made since, bound to whatever its session ran on, on the watcher's next look", async () => {
    const core = fakeCore();
    const { personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // Created in a chat session pinned to Personal: core bound it there.
    const job = addCron(core, { id: "new" });
    job.binding = { profileId: p(personal.id), lifetime: core.lifetimes.get(p(personal.id)) as string };
    await gw.bindGatewayCrons();
    expect(job.binding?.profileId).toBe(core.order?.[0]);
  });

  it("keeps openclaw.json's order equal to the stored one: after the pastes its head is the active account, not the last one pasted", async () => {
    // On the box the config order led with the LAST account pasted
    // (paste-token beside a sign-in of another mode), and automations were
    // bound by it instead of by the pool's stored order.
    const core = fakeCore();
    core.tellsConfigOrder = true;
    const accounts = [];
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
      accounts.push(await pool.addOAuthAccount({ label: `${name} Max`, email: `${name.toLowerCase()}@example.com`, tokens: oauth(`sk-ant-oat01-${name.toLowerCase()}`) }));
    }
    await gw.keepGatewayMirror();
    const active = (await pool.readPoolState()).activeId as string;
    expect(core.order?.[0]).toBe(p(active));
    expect(core.configOrder).toEqual(core.order);
    expect(core.configOrder?.[0]).toBe(p(active));

    // A renewal's paste puts the pasted account at the config head again; the pass puts it back.
    await pool.replaceCredential(accounts[4].id, { kind: "oauth", tokens: oauth("sk-ant-oat01-echo-v2"), email: "echo@example.com" });
    await gw.keepGatewayMirror();
    expect(core.configOrder?.[0]).toBe(p(active));
    expect(core.configOrder).toEqual(core.order);

    // Taken out with the pool, as the pool created it.
    core.chatOnClaude = false;
    await gw.syncGatewayNow();
    expect(core.configOrder).toBeNull();
  });

  it("asks Anthropic about the account the gateway leads with, and moves off it when its window is spent — a Claude CLI limit leaves core no cooldown to read", async () => {
    fakeCore();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const resetsAt = Date.now() + 2 * H;
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/oauth/usage")) {
        const token = ((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
        asked.push(token);
        const body = token.includes("work")
          ? { five_hour: { utilization: 100, resets_at: new Date(resetsAt).toISOString() }, seven_day: { utilization: 40, resets_at: null } }
          : { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 10, resets_at: null } };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }));
    await gw.lookAtLeadUsage();
    await swap.whenSwapsSettled();
    expect(asked).toContain("sk-ant-oat01-work");
    const state = await pool.readPoolState();
    expect(state.accounts.find((a) => a.id === work.id)?.status).toBe("limited");
    expect(state.activeId).toBe(personal.id);
    // Not asked again inside its reading life.
    const n = asked.length;
    await gw.lookAtLeadUsage();
    expect(asked.length).toBe(n);
  });
});

describe("TASK-2533 adversarial (production 2026-11-14)", () => {
  const fiveAccounts = async (names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) => {
    const ids: string[] = [];
    for (const name of names) {
      ids.push((await pool.addOAuthAccount({ label: `${name} Max`, email: `${name.toLowerCase()}@example.com`, tokens: oauth(`sk-ant-oat01-${name.toLowerCase()}`) })).id);
    }
    return ids;
  };

  it("T1 — keeps a config order that predates the pool led by the active account, its own entries kept, and gives it back when the pool leaves", async () => {
    const core = fakeCore();
    core.tellsConfigOrder = true;
    // The owner's order from before the pool (marker `config` stays false): one id only the config names.
    core.configOrder = ["anthropic:default", "anthropic:owner-extra"];
    const ids = await fiveAccounts();
    await gw.keepGatewayMirror();
    const active = (await pool.readPoolState()).activeId as string;
    expect(core.order?.[0]).toBe(p(active));
    // Five pastes left Echo first; the pass must put the active account back at the head.
    expect(core.configOrder?.[0]).toBe(p(active));
    expect(core.configOrder).toContain("anthropic:owner-extra");
    expect(ids).toHaveLength(5);
    core.chatOnClaude = false;
    await gw.syncGatewayNow();
    expect(core.configOrder).toEqual(["anthropic:default", "anthropic:owner-extra"]);
  });

  it("T2 — a refused write of openclaw.json's order leaves the move pending, and the watcher's next minute puts the active account back at its head", async () => {
    const core = fakeCore();
    core.tellsConfigOrder = true;
    const ids = await fiveAccounts(["Alpha", "Bravo", "Charlie"]);
    await gw.keepGatewayMirror();
    const active = (await pool.readPoolState()).activeId as string;
    expect(active).toBe(ids[0]);
    expect(core.configOrder?.[0]).toBe(p(active));

    core.refuseConfigSet = true;
    // Charlie's renewal: its paste puts it at the head of the config order.
    await pool.replaceCredential(ids[2], { kind: "oauth", tokens: oauth("sk-ant-oat01-charlie-v2"), email: "charlie@example.com" });
    await gw.keepGatewayMirror();
    expect(core.configOrder?.[0]).toBe(p(ids[2])); // precondition: the head is the last paste
    // New CLI sessions and cron-isolated runs follow this order on 2026.11.3: the lead has not landed for them.
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: active, pending: true });

    core.refuseConfigSet = false;
    await gw.noteGatewayCooldowns();
    await gw.bindGatewayCrons();
    expect(core.configOrder?.[0]).toBe(p(active));
  });

  it("T3 — records the lead's limit at once when an automation the box bound to it dies on the limit (no core cooldown, usage unreadable)", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    await gw.keepGatewayMirror();
    expect(runCron(core, "inbox")).toBe(p(work.id));
    // Anthropic's usage endpoint is rate-limited (seen in production); core records no cooldown for a CLI limit.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"error\":\"rate_limited\"}", { status: 429 })));
    const job = core.crons.get("inbox") as FakeCron;
    job.state = { lastStatus: "error", lastError: "anthropic/claude-opus-5-5: You've hit your weekly limit · resets Mon 9am", lastRunAtMs: Date.now() };

    await gw.scanGatewayCrons();
    await swap.whenSwapsSettled();

    const state = await pool.readPoolState();
    expect(state.accounts.find((a) => a.id === work.id)?.status).toBe("limited");
    expect(state.activeId).toBe(personal.id);
    expect(runCron(core, "inbox")).toBe(p(personal.id));
  });

  it("T4 — learns a spent window on a held account that is not the lead: its CLI-bound sessions stay on it on 2026.11.3", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    expect((await pool.readPoolState()).gateway?.accountId).toBe(work.id);
    const resetsAt = Date.now() + 2 * H;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith("/api/oauth/usage")) return new Response("{}", { status: 404 });
      const token = ((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
      const body = token.includes("personal")
        ? { five_hour: { utilization: 100, resets_at: new Date(resetsAt).toISOString() }, seven_day: { utilization: 40, resets_at: null } }
        : { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 10, resets_at: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    // The watcher's looks over the next ten minutes (one account a tick would do).
    for (let i = 0; i < 10; i += 1) await gw.lookAtLeadUsage(Date.now() + i * 60_000 + 10 * 60_000);
    await swap.whenSwapsSettled();

    expect((await pool.readPoolState()).accounts.find((a) => a.id === personal.id)?.status).toBe("limited");
    await gw.keepGatewayMirror();
    expect(core.profiles.has(p(personal.id))).toBe(false);
  });

  it("T5 — takes a held account out within the watcher's minute when the pool records its limit without moving the active one", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    expect((await pool.readPoolState()).activeId).toBe(work.id);
    // No live request from the lead look below.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"error\":\"rate_limited\"}", { status: 429 })));

    // A usage reading (or a coding run) records Personal's week spent; Work stays active.
    await pool.markLimited(personal.id, Date.now() + 24 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    // The watcher's minute pass, no keeper pass.
    await gw.noteGatewayCooldowns();
    await gw.lookAtLeadUsage();
    await gw.bindGatewayCrons();

    expect(core.logouts).toEqual([p(personal.id)]);
  });

  it("T6 — pastes no limited account back, and stops nothing, when the last answering account runs out", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(core.profiles.has(p(work.id))).toBe(false);
    const windows = offlineWindows;
    const pastes = core.pastes.length;

    await pool.markLimited(personal.id, Date.now() + H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();

    expect(core.order?.[0]).toBe("anthropic:default");
    // Work cannot answer anyone: pasting it back costs a gateway stop for nothing.
    expect(core.pastes.slice(pastes).map((x) => x.profileId)).not.toContain(p(work.id));
    expect(offlineWindows).toBe(windows);
  });

  it("T7 — backs off a paste-back core keeps refusing instead of stopping the assistant every ten minutes while another account answers", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(core.profiles.has(p(work.id))).toBe(false);

    core.refusePasteOf.add(p(work.id));
    await pool.clearLimit(work.id); // its reset (Personal stays active)
    await gw.syncGatewayNow();
    expect((await pool.readPoolState()).activeId).toBe(personal.id);
    const windows = offlineWindows;
    for (let i = 0; i < 3; i += 1) await gw.keepGatewayMirror();

    expect(offlineWindows - windows).toBeLessThan(3);
  });

  it("T8 — marks nothing on a 429 or 401 usage answer, and asks again within two minutes rather than ten", async () => {
    fakeCore();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    let status = 429;
    const asked: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!String(url).endsWith("/api/oauth/usage")) return new Response("{}", { status: 404 });
      asked.push(status);
      return new Response("{\"error\":\"no\"}", { status });
    }));
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await gw.lookAtLeadUsage();
    expect((await pool.readPoolState()).accounts.find((a) => a.id === work.id)?.status).toBe("ok");

    status = 401;
    vi.setSystemTime(t0 + 2 * 60_000);
    await gw.lookAtLeadUsage();
    expect((await pool.readPoolState()).accounts.find((a) => a.id === work.id)?.status).toBe("ok");
    expect(asked).toEqual([429, 401]);
  });

  it("T9 — a reading another caller took nine minutes ago does not push the lead's next real ask to twenty minutes", async () => {
    fakeCore();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    let spentNow = false;
    let asks = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!String(url).endsWith("/api/oauth/usage")) return new Response("{}", { status: 404 });
      asks += 1;
      const body = spentNow
        ? { five_hour: { utilization: 100, resets_at: new Date(Date.now() + 2 * H).toISOString() }, seven_day: { utilization: 40, resets_at: null } }
        : { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 10, resets_at: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await pool.readAccountUsage(work.id); // the owner's card, or a move's room read
    spentNow = true; // the five-hour window runs out right after
    vi.setSystemTime(t0 + 9 * 60_000);
    await gw.lookAtLeadUsage();
    vi.setSystemTime(t0 + 18.5 * 60_000);
    await gw.lookAtLeadUsage();
    await swap.whenSwapsSettled();

    expect(asks).toBeGreaterThan(1);
    expect((await pool.readPoolState()).accounts.find((a) => a.id === work.id)?.status).toBe("limited");
  });

  it("T10 — a rebind refused right after the swap that logged its account out is asked again on the next minute", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    await gw.keepGatewayMirror();
    expect(runCron(core, "inbox")).toBe(p(work.id));

    // The scheduler is still loading after the pass's stop/start: the first update is refused.
    core.refuseCronUpdate.add(`anthropic/claude-opus-5-5@${p(personal.id)}`);
    await pool.markLimited(work.id, Date.now() + 2 * H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(core.profiles.has(p(work.id))).toBe(false);

    core.refuseCronUpdate.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    await gw.bindGatewayCrons();

    expect(runCron(core, "inbox")).toBe(p(personal.id));
  });

  it("T11 — when the stored order does not read back, openclaw.json's head is the account that should lead, never the last one pasted", async () => {
    const core = fakeCore();
    core.tellsConfigOrder = true;
    core.orderReadsBackOtherwise = true;
    const ids = await fiveAccounts();
    await gw.keepGatewayMirror();
    const active = (await pool.readPoolState()).activeId as string;
    expect(core.pastes.at(-1)?.profileId).toBe(p(ids[4])); // precondition: Echo pasted last
    expect([core.order?.[0], p(active)]).toContain(core.configOrder?.[0]);
  });

  it("F6 — backs a job off only after core refused it twice in a row, and never while its account has left the gateway", async () => {
    const core = fakeCore();
    const { work } = await twoClaudeAccounts();
    const job = addCron(core, { id: "inbox", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-sonnet-5-5" } });
    core.refuseCronUpdate.add(`anthropic/claude-sonnet-5-5@${p(work.id)}`);
    await gw.keepGatewayMirror();
    await gw.bindGatewayCrons();
    const asked = () => core.calls.filter((c) => c.method === "cron.update" && c.params.id === "inbox").length;
    const twice = asked();
    expect(twice).toBe(2);
    // Twice refused, its account still in: not asked every minute.
    await gw.bindGatewayCrons();
    expect(asked()).toBe(twice);
    core.refuseCronUpdate.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await gw.bindGatewayCrons();
    expect(job.payload.model).toBe(`anthropic/claude-sonnet-5-5@${p(work.id)}`);
  });
});

describe("TASK-2533 second review pass", () => {
  const LIMIT_TEXT = "anthropic/claude-opus-5-5: You've hit your weekly limit · resets Mon 9am";
  /** Anthropic's usage endpoint: the tokens named spent, every other one with room. */
  const usageSpentFor = (spentTokens: string[], resetsAt: number) => vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/api/oauth/usage")) return new Response("{}", { status: 404 });
    const token = ((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
    const body = spentTokens.includes(token)
      ? { five_hour: { utilization: 100, resets_at: new Date(resetsAt).toISOString() }, seven_day: { utilization: 40, resets_at: null } }
      : { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 10, resets_at: null } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const statusOf = async (id: string) => (await pool.readPoolState()).accounts.find((a) => a.id === id)?.status;

  it("the watcher's minute never stops the gateway: a renewal core refuses beside a limited account still held waits for the keeper, asked on a widening interval", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    // Personal's renewal: core refuses its paste, so the gateway holds its replaced token.
    core.refusePasteOf.add(p(personal.id));
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal-v2"), email: "me@example.com" });
    await pool.markLimited(work.id, Date.now() + 2 * H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    // Nothing that answers is in with its current token: Work stays (precondition).
    expect(core.profiles.has(p(work.id))).toBe(true);
    const windows = offlineWindows;
    const lists = () => core.calls.filter((c) => c.method === "cron.list").length;
    const before = lists();

    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    for (let minute = 1; minute <= 7; minute += 1) {
      vi.setSystemTime(t0 + minute * 60_000);
      await gw.noteGatewayCooldowns();
    }
    expect(offlineWindows).toBe(windows);
    // Minutes 1, 3 and 7: two minutes after a pass that left it owing, then four.
    expect(lists() - before).toBe(3);

    // The keeper's window takes the renewal; Work is out with it.
    core.refusePasteOf.clear();
    vi.setSystemTime(t0 + 11 * 60_000);
    await gw.keepGatewayMirror();
    expect(core.profiles.get(p(personal.id))?.secret).toBe("sk-ant-oat01-personal-v2");
    expect(core.profiles.has(p(work.id))).toBe(false);
  });

  it("a cron limit from a run made before the job was moved is not blamed on the account it was moved to", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    await gw.keepGatewayMirror();
    expect(runCron(core, "inbox")).toBe(p(work.id));
    // The run on Work dies on Work's limit...
    const job = core.crons.get("inbox") as FakeCron;
    job.state = { lastStatus: "error", lastError: LIMIT_TEXT, lastRunAtMs: Date.now() };
    // ...and the pool learns it first from elsewhere: it moves to Personal, and the job with it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1_000);
    await pool.markLimited(work.id, Date.now() + 24 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(job.binding?.profileId).toBe(p(personal.id));

    await gw.scanGatewayCrons();
    await swap.whenSwapsSettled();

    expect(await statusOf(personal.id)).toBe("ok");
    expect((await pool.readPoolState()).activeId).toBe(personal.id);
  });

  it("a cron limit is not blamed on the account a refused adoption was moving the job to", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    await gw.keepGatewayMirror();
    expect(runCron(core, "inbox")).toBe(p(work.id));
    // The pool moves to Personal; core refuses the job's adoption, so its record stays provisional.
    core.refuseCronUpdate.add(`anthropic/claude-opus-5-5@${p(personal.id)}`);
    await pool.markLimited(work.id, Date.now() + 24 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    const job = core.crons.get("inbox") as FakeCron;
    expect(job.binding?.profileId).toBe(p(work.id));
    // Its next run is still Work's, and dies on Work's limit.
    job.state = { lastStatus: "error", lastError: LIMIT_TEXT, lastRunAtMs: Date.now() + 1_000 };

    await gw.scanGatewayCrons(Date.now() + 2_000);
    await swap.whenSwapsSettled();

    expect(await statusOf(personal.id)).toBe("ok");
  });

  it("binds the automations to an account that answers, not to a limited one an order write left at the head", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    await gw.keepGatewayMirror();
    expect(runCron(core, "inbox")).toBe(p(work.id));
    // The order cannot be written, and Work stays in: Personal's renewal was refused.
    core.refuseOrder = true;
    core.refusePasteOf.add(p(personal.id));
    await pool.replaceCredential(personal.id, { kind: "oauth", tokens: oauth("sk-ant-oat01-personal-v2"), email: "me@example.com" });
    await pool.markLimited(work.id, Date.now() + 2 * H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(core.order?.[0]).toBe(p(work.id));
    expect(core.profiles.has(p(work.id))).toBe(true);

    await gw.bindGatewayCrons();

    expect(runCron(core, "inbox")).toBe(p(personal.id));
  });

  it("with no sign-in of the owner's, pastes no limited account back when the last that answers runs out", async () => {
    const core = fakeCore();
    core.profiles.delete("anthropic:default");
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(core.profiles.has(p(work.id))).toBe(false);
    const windows = offlineWindows;
    const pastes = core.pastes.length;

    await pool.markLimited(personal.id, Date.now() + H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();

    expect(core.pastes.slice(pastes).map((x) => x.profileId)).not.toContain(p(work.id));
    expect(offlineWindows).toBe(windows);
    // The order is never emptied: the one held stays.
    expect(core.order?.[0]).toBe(p(personal.id));
  });

  it("takes a limited account out for the owner's sign-in when the account that could answer is not in the gateway", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    core.refusePasteOf.add(p(personal.id));
    await gw.keepGatewayMirror();
    expect(core.profiles.has(p(personal.id))).toBe(false);

    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();

    expect(core.order?.[0]).toBe("anthropic:default");
    expect(core.profiles.has(p(work.id))).toBe(false);
  });

  it("backs off taking the active account back while core keeps refusing it and another answers, and asks again later", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await pool.setReturnToPrimary(true);
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(core.profiles.has(p(work.id))).toBe(false);

    core.refusePasteOf.add(p(work.id));
    await pool.clearLimit(work.id); // its reset: back to the first account
    await swap.whenSwapsSettled();
    expect((await pool.readPoolState()).activeId).toBe(work.id);
    await gw.syncGatewayNow();
    const windows = offlineWindows;
    for (let i = 0; i < 3; i += 1) await gw.keepGatewayMirror();
    expect(offlineWindows).toBe(windows);

    core.refusePasteOf.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 41 * 60_000);
    await gw.keepGatewayMirror();
    expect(core.profiles.has(p(work.id))).toBe(true);
  });

  it("a desktop chat that died on a limit reads every held account first: a spent one that is not the lead is out before the turn is sent again", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    expect((await pool.readPoolState()).gateway?.accountId).toBe(work.id);
    vi.stubGlobal("fetch", usageSpentFor(["sk-ant-oat01-personal"], Date.now() + 2 * H));
    let personalHeldAtRetry: boolean | null = null;
    core.beforeCall = (method) => {
      if (method === "chat.send") personalHeldAtRetry = core.profiles.has(p(personal.id));
    };

    await gw.reportChatFailure({ errorMessage: "You've hit your limit · resets 5pm", provider: "anthropic", sessionKey: "agent:main:desk", message: "hello" });
    await swap.whenSwapsSettled();

    expect(await statusOf(personal.id)).toBe("limited");
    expect(core.logouts).toContain(p(personal.id));
    expect(personalHeldAtRetry === null || personalHeldAtRetry === false).toBe(true);
  });

  it("an account the owner adds while another answers goes into the gateway at once: only a paste-back after a limit waits for a window", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const work = await pool.addOAuthAccount({ label: "Work Max", email: "work@example.com", tokens: oauth("sk-ant-oat01-work") });
    await gw.keepGatewayMirror();
    expect(core.profiles.has(p(work.id))).toBe(true);

    const personal = await pool.addOAuthAccount({ label: "Personal Max", email: "me@example.com", tokens: oauth("sk-ant-oat01-personal") });
    await gw.syncGatewayNow();

    expect(core.profiles.has(p(personal.id))).toBe(true);
    expect(core.order?.slice(0, 2)).toEqual([p(work.id), p(personal.id)]);
  });

  it("with no stored order, openclaw.json's order is core's: a move that core refuses to store over it lands there, and is not left owed", async () => {
    const core = fakeCore();
    core.tellsConfigOrder = true;
    core.configControlsOrder = true;
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    // The first paste beside the owner's sign-in starts a config order: the store gets none.
    await gw.keepGatewayMirror();
    expect(core.order).toBeNull();
    expect(core.configOrder?.[0]).toBe(p(work.id));
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: work.id, pending: false });

    await pool.markLimited(work.id, Date.now() + 2 * H, "session", { source: "chat" });
    await swap.whenSwapsSettled();

    expect(core.configOrder?.[0]).toBe(p(personal.id));
    expect(core.profiles.has(p(work.id))).toBe(false);
    expect((await pool.readPoolState()).gateway).toMatchObject({ accountId: personal.id, pending: false });
    // Nothing owed: the keeper's next pass is not a failure, and earns no back-off.
    expect(await gw.keepGatewayMirror()).not.toBe("failed");
  });

  it("gives an adopted job back onto the account its model runs on now — the owner's sign-in for its own Claude model, the new default's account for a model-less one — not the pool's profile that left (seen on a lab board)", async () => {
    const core = fakeCore();
    core.otherProfiles.set("deepseek:default", { provider: "deepseek", type: "api_key", secret: "sk-deepseek-key" });
    await twoClaudeAccounts();
    addCron(core, { id: "inherits" });
    addCron(core, { id: "own-model", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-sonnet-5-5" } });
    await gw.keepGatewayMirror();
    expect(runCron(core, "inherits")).toMatch(/^anthropic:clawbox-/);

    // The owner moves the chat to another provider: the pool leaves the gateway.
    core.chatOnClaude = false;
    core.chatModel = "deepseek/deepseek-v4-flash";
    await gw.syncGatewayNow();

    const inherits = core.crons.get("inherits") as FakeCron;
    const own = core.crons.get("own-model") as FakeCron;
    expect(inherits.payload.model).toBeUndefined();
    expect(own.payload.model).toBe("anthropic/claude-sonnet-5-5");
    expect(runCron(core, "inherits")).toBe("deepseek:default");
    expect(runCron(core, "own-model")).toBe("anthropic:default");
  });

  it("a job moved onto the owner's sign-in while every pool account was limited stays the box's after a refused move back, and moves once core takes it", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "own-model", payload: { kind: "agentTurn", message: "m", model: "anthropic/claude-sonnet-5-5" } });
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    await pool.markLimited(personal.id, Date.now() + H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();
    expect(runCron(core, "own-model")).toBe("anthropic:default");

    // Personal is back; core refuses the move back (twice: the job is backed off).
    core.refuseCronUpdate.add(`anthropic/claude-sonnet-5-5@${p(personal.id)}`);
    await pool.clearLimit(personal.id);
    await swap.whenSwapsSettled();
    await gw.syncGatewayNow();
    expect(runCron(core, "own-model")).toBe("anthropic:default");

    core.refuseCronUpdate.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await gw.bindGatewayCrons();
    expect(runCron(core, "own-model")).toBe(p(personal.id));
  });

  it("finishes giving a model-less job back when core took the first update and its answer was lost", async () => {
    const core = fakeCore();
    core.otherProfiles.set("deepseek:default", { provider: "deepseek", type: "api_key", secret: "sk-deepseek-key" });
    await twoClaudeAccounts();
    addCron(core, { id: "inherits" });
    await gw.keepGatewayMirror();
    core.loseReplyOf.add("deepseek/deepseek-v4-flash@deepseek:default");
    core.chatOnClaude = false;
    core.chatModel = "deepseek/deepseek-v4-flash";
    await gw.syncGatewayNow();
    const job = core.crons.get("inherits") as FakeCron;
    // Taken by core, its answer lost: pinned to the new default for now.
    expect(job.payload.model).toBe("deepseek/deepseek-v4-flash@deepseek:default");

    core.loseReplyOf.clear();
    await gw.bindGatewayCrons();

    expect(job.payload.model).toBeUndefined();
    expect(runCron(core, "inherits")).toBe("deepseek:default");
  });

  it("gives a job with a bare Claude model back onto the owner's sign-in, not its removed pool profile", async () => {
    const core = fakeCore();
    await twoClaudeAccounts();
    addCron(core, { id: "bare", payload: { kind: "agentTurn", message: "m", model: "claude-sonnet-5-5" } });
    await gw.keepGatewayMirror();
    expect(runCron(core, "bare")).toMatch(/^anthropic:clawbox-/);
    core.chatOnClaude = false;
    core.chatModel = "deepseek/deepseek-v4-flash";
    await gw.syncGatewayNow();

    expect((core.crons.get("bare") as FakeCron).payload.model).toBe("claude-sonnet-5-5");
    expect(runCron(core, "bare")).toBe("anthropic:default");
  });

  it("asks Anthropic about every held account in turn: accounts whose asks keep failing do not keep another from being asked", async () => {
    fakeCore();
    const ids: string[] = [];
    for (const name of ["alpha", "bravo", "charlie"]) {
      ids.push((await pool.addOAuthAccount({ label: name, email: `${name}@example.com`, tokens: oauth(`sk-ant-oat01-${name}`) })).id);
    }
    await gw.keepGatewayMirror();
    expect((await pool.readPoolState()).gateway?.accountId).toBe(ids[0]);
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith("/api/oauth/usage")) return new Response("{}", { status: 404 });
      const token = ((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
      asked.push(token);
      if (!token.includes("charlie")) return new Response("{\"error\":\"rate_limited\"}", { status: 429 });
      return new Response(JSON.stringify({ five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 10, resets_at: null } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    for (let tick = 0; tick < 6; tick += 1) {
      vi.setSystemTime(t0 + tick * 60_000);
      await gw.lookAtLeadUsage();
    }

    expect(asked.some((t) => t.includes("charlie"))).toBe(true);
  });

  it("a cron limit no account can be named for reads every held account before its retry is sent", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    const events: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith("/api/oauth/usage")) return new Response("{}", { status: 404 });
      const token = ((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
      events.push(`usage:${token}`);
      const body = token.includes("work")
        ? { five_hour: { utilization: 100, resets_at: new Date(Date.now() + 2 * H).toISOString() }, seven_day: { utilization: 40, resets_at: null } }
        : { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 10, resets_at: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    core.beforeCall = (method) => {
      if (method === "cron.run") events.push("cron.run");
    };
    // A job the box never bound (core bound it itself): its limit names no account.
    core.cronJobs.push({ id: "foreign", state: { lastStatus: "error", lastError: LIMIT_TEXT, lastRunAtMs: Date.now() } });

    await gw.scanGatewayCrons();
    await swap.whenSwapsSettled();

    expect(await statusOf(work.id)).toBe("limited");
    const firstAsk = events.findIndex((e) => e.startsWith("usage:"));
    expect(firstAsk).toBeGreaterThanOrEqual(0);
    const run = events.indexOf("cron.run");
    expect(run === -1 || firstAsk < run).toBe(true);
  });

  it("the minute's back-off holds back only what it already tried: an account limited since is out at once", async () => {
    const core = fakeCore();
    core.tellsConfigOrder = true;
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    expect(core.configOrder?.[0]).toBe(p(work.id));
    // openclaw.json is locked and a paste since put Personal at its head: owed, and refused every minute.
    core.refuseConfigSet = true;
    core.configOrder = [p(personal.id), p(work.id), "anthropic:default"];
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    for (let minute = 1; minute <= 3; minute += 1) {
      vi.setSystemTime(t0 + minute * 60_000);
      await gw.noteGatewayCooldowns();
    }
    // Personal, not the active account, runs out (a usage reading): no swap comes.
    await pool.markLimited(personal.id, Date.now() + 2 * H, "session", { source: "chat" });
    await swap.whenSwapsSettled();
    expect((await pool.readPoolState()).activeId).toBe(work.id);
    vi.setSystemTime(t0 + 4 * 60_000);
    await gw.noteGatewayCooldowns();

    expect(core.logouts).toContain(p(personal.id));
  });

  it("a run that started while its job was being moved is not blamed on the account the move had not yet given it", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    addCron(core, { id: "inbox" });
    await gw.keepGatewayMirror();
    expect(runCron(core, "inbox")).toBe(p(work.id));
    const job = core.crons.get("inbox") as FakeCron;
    vi.useFakeTimers({ toFake: ["Date"] });
    // The swap's re-binding: a scheduled run starts on Work after the pass began and before core took the update.
    core.beforeCall = (method, params) => {
      const model = ((params.patch as { payload?: { model?: string | null } } | undefined)?.payload ?? {}).model;
      if (method !== "cron.update" || typeof model !== "string" || !model.includes(p(personal.id))) return;
      vi.setSystemTime(Date.now() + 1);
      job.state = { lastStatus: "error", lastError: LIMIT_TEXT, lastRunAtMs: Date.now() };
      vi.setSystemTime(Date.now() + 1);
    };
    await pool.markLimited(work.id, Date.now() + 24 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    core.beforeCall = null;
    expect(job.binding?.profileId).toBe(p(personal.id));

    await gw.scanGatewayCrons();
    await swap.whenSwapsSettled();

    expect(await statusOf(personal.id)).toBe("ok");
  });

  it("a desktop chat's limit is read fresh: a reading with room taken before the turn failed does not stand in for one", async () => {
    const core = fakeCore();
    gw.startGatewaySwap();
    const { personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    vi.stubGlobal("fetch", usageSpentFor([], 0));
    await pool.readAccountUsage(personal.id); // the owner's card, a minute before
    vi.stubGlobal("fetch", usageSpentFor(["sk-ant-oat01-personal"], Date.now() + 2 * H));

    await gw.reportChatFailure({ errorMessage: "You've hit your limit · resets 5pm", provider: "anthropic", sessionKey: "agent:main:desk", message: "hello" });
    await swap.whenSwapsSettled();

    expect(await statusOf(personal.id)).toBe("limited");
    expect(core.logouts).toContain(p(personal.id));
  });

  it("with no sign-in of the owner's, a limited account goes back in when the only other one held leaves: the order is never emptied", async () => {
    const core = fakeCore();
    core.profiles.delete("anthropic:default");
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await gw.keepGatewayMirror();
    await pool.markLimited(work.id, Date.now() + 2 * H, "weekly", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(core.profiles.has(p(work.id))).toBe(false);

    // Personal can no longer answer at all (its grant was refused): it leaves the gateway.
    await pool.markCredentialProblem(personal.id, "revoked");
    await swap.whenSwapsSettled();
    // One pass after it: the swap's, or the owner's next change.
    if (core.profiles.has(p(personal.id))) await gw.syncGatewayNow();

    // In that same pass — not one keeper interval later with nothing held.
    expect(core.profiles.has(p(personal.id))).toBe(false);
    expect(core.profiles.has(p(work.id))).toBe(true);
    expect(core.order?.[0]).toBe(p(work.id));
  });
});
