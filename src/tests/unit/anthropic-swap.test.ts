/**
 * The box-wide Anthropic account swap (TASK-1260), on a real pool in a temp
 * root, with stand-in consumers.
 *
 * What would make the feature worthless if it broke:
 *
 *  1. A MOVE REACHES EVERY CONSUMER — in order, once, and what each did is
 *     filed on the swap the owner's card shows.
 *  2. ONLY FAILURES ARE ANNOUNCED — "switched" and "no account left", once per
 *     move; a reset or the owner's own change says nothing.
 *  3. A FAILED TURN IS RETRIED ONCE, AFTER THE SWAP — held while every account
 *     is limited and sent at the reset; a second report of the same failure is
 *     not a second retry.
 *  4. A REFUSED CREDENTIAL IS CONFIRMED FIRST — a stale token does not take a
 *     healthy account out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const announceAnthropicLimit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceAnthropicLimit }));
// A home of the test's own: the machine running the suite may well have a
// `claude` sign-in, which the pool would list as an account of its own.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const homedir = () => process.env.CLAWBOX_TEST_HOME ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const KEY_A = "sk-ant-api03-account-A-work-000000000000";
const KEY_B = "sk-ant-api03-account-B-personal-111111111";

let root = "";
let restoreEnv: () => void;
let pool: typeof import("@/lib/anthropic-accounts");
let swap: typeof import("@/lib/anthropic-swap");

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_TEST_HOME");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-swap-")));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  process.env.CLAWBOX_TEST_HOME = path.join(root, "home");
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "5e".repeat(32), { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "ab".repeat(32);
  announceAnthropicLimit.mockClear();
  vi.resetModules();
  pool = await import("@/lib/anthropic-accounts");
  swap = await import("@/lib/anthropic-swap");
  (await import("@/lib/project-secrets"))._resetSecretKeyCacheForTests();
  pool._resetAnthropicAccountsForTests();
  swap._resetAnthropicSwapForTests();
});

afterEach(() => {
  swap._resetAnthropicSwapForTests();
  pool._resetAnthropicAccountsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

async function twoAccounts() {
  const work = await pool.addApiKeyAccount({ label: "Work", key: KEY_A });
  const personal = await pool.addApiKeyAccount({ label: "Personal", key: KEY_B });
  return { work, personal };
}

type Ctx = import("@/lib/anthropic-swap").SwapContext;
type Outcome = import("@/lib/anthropic-accounts").SwapConsumerOutcome;

function consumer(name: "coding" | "gateway", answer: Outcome | ((ctx: Ctx) => Promise<Outcome>)) {
  const calls: Ctx[] = [];
  swap.registerSwapConsumer({
    name,
    apply: async (ctx) => {
      calls.push(ctx);
      return typeof answer === "function" ? answer(ctx) : answer;
    },
  });
  return calls;
}

describe("a move of the active account", () => {
  it("reaches every consumer once, in order, and files what each did on the swap", async () => {
    const { work, personal } = await twoAccounts();
    const order: string[] = [];
    const coding = consumer("coding", async () => {
      order.push("coding");
      return { status: "ok", code: "moved", count: 2 };
    });
    const gateway = consumer("gateway", async () => {
      order.push("gateway");
      return { status: "ok", code: "switched", count: 3 };
    });

    const until = Date.now() + 60_000;
    await pool.markLimited(work.id, until, "session", { source: "coding", runId: "run-aaaa1111" });
    await swap.whenSwapsSettled();

    expect(order).toEqual(["coding", "gateway"]);
    expect(coding[0].change).toMatchObject({ fromId: work.id, toId: personal.id, cause: "limit", runId: "run-aaaa1111" });
    expect(gateway[0].takeover).toBe(false);
    const last = (await pool.describePool()).lastSwap;
    expect(last).toMatchObject({
      fromLabel: "Work", toLabel: "Personal", cause: "limit", source: "coding", limitKind: "session", limitedUntil: until,
      consumers: { coding: { status: "ok", code: "moved", count: 2 }, gateway: { status: "ok", code: "switched", count: 3 } },
    });
  });

  it("announces a limit once — with the run that saw it — and nothing when the box goes back", async () => {
    const { work } = await twoAccounts();
    swap.startAnthropicSwap();
    await pool.markLimited(work.id, Date.now() + 60_000, "session", { source: "coding", runId: "run-bbbb2222" });
    await swap.whenSwapsSettled();
    expect(announceAnthropicLimit).toHaveBeenCalledTimes(1);
    expect(announceAnthropicLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: "switched", reason: "limit", fromLabel: "Work", toLabel: "Personal", runId: "run-bbbb2222" }));

    announceAnthropicLimit.mockClear();
    await pool.setReturnToPrimary(true);
    await pool.clearLimit(work.id);
    await swap.whenSwapsSettled();
    expect((await pool.readPoolState()).activeId).toBe(work.id);
    expect(announceAnthropicLimit).not.toHaveBeenCalled();
  });

  it("announces a refused credential as its own kind, with no reset time", async () => {
    const { work } = await twoAccounts();
    swap.startAnthropicSwap();
    await pool.markCredentialProblem(work.id, "revoked", { source: "chat" });
    await swap.whenSwapsSettled();
    expect(announceAnthropicLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: "switched", reason: "auth", resetAt: null }));
  });

  it("says when no account is left, and when the first one is back", async () => {
    const { work, personal } = await twoAccounts();
    const coding = consumer("coding", { status: "ok", code: "nothing_running", count: 0 });
    await pool.markLimited(work.id, Date.now() + 60_000, "session");
    const soon = Date.now() + 5_000;
    await pool.markLimited(personal.id, soon, "session");
    await swap.whenSwapsSettled();
    expect(announceAnthropicLimit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "all_limited", resetAt: soon }));
    expect((await pool.describePool()).lastSwap).toMatchObject({ toId: null, nextResetAt: soon });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(soon + 1);
    await pool.readPoolState();
    await swap.whenSwapsSettled();
    expect(coding.at(-1)?.change).toMatchObject({ fromId: null, toId: personal.id, cause: "reset" });
  });

  it("skips a move a newer one has already overtaken — the gateway is never restarted onto a stale target", async () => {
    const { work, personal } = await twoAccounts();
    const third = await pool.addApiKeyAccount({ label: "Spare", key: "sk-ant-api03-account-C-spare-22222222222" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gateway = consumer("gateway", async () => ({ status: "ok", code: "switched", count: 1 }));
    consumer("coding", async (ctx) => {
      if (ctx.change.toId === personal.id) await gate;
      return { status: "ok", code: "nothing_running", count: 0 };
    });
    await pool.markLimited(work.id, Date.now() + 60_000, "session");
    // While the first move is still in its first consumer, the second account goes too.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.markLimited(personal.id, Date.now() + 60_000, "session");
    release();
    await swap.whenSwapsSettled();
    expect(gateway.map((c) => c.change.toId)).toEqual([third.id]);
  });

  it("files a consumer that throws as failed and carries on with the next", async () => {
    const { work } = await twoAccounts();
    consumer("coding", async () => { throw new Error("boom"); });
    const gateway = consumer("gateway", { status: "ok", code: "switched", count: 1 });
    await pool.markLimited(work.id, Date.now() + 60_000, "session");
    await swap.whenSwapsSettled();
    expect(gateway).toHaveLength(1);
    expect((await pool.describePool()).lastSwap?.consumers.coding).toMatchObject({ status: "failed", code: "error" });
  });
});

describe("a failure another consumer reports", () => {
  const LIMIT_LINE = "You've hit your weekly limit · resets Mon 9am";

  it("marks the account it was on, swaps, and retries the turn once after the gateway moved", async () => {
    const { work, personal } = await twoAccounts();
    consumer("gateway", { status: "ok", code: "switched", count: 1 });
    const retried = vi.fn(async () => true);
    const outcome = await swap.reportAnthropicFailure({
      text: LIMIT_LINE, source: "cron", accountId: work.id,
      retry: { key: "cron:job-1", after: "gateway", run: retried },
    });
    expect(outcome).toMatchObject({ handled: true, kind: "limit", limitKind: "weekly", activeId: personal.id, activeLabel: "Personal", retry: "sent" });
    expect(retried).toHaveBeenCalledTimes(1);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("limited");
    expect((await pool.describePool()).lastSwap).toMatchObject({ source: "cron", consumers: { retries: { status: "ok", code: "retried", count: 1 } } });

    // The same failure reported again is not a second retry.
    const again = await swap.reportAnthropicFailure({ text: LIMIT_LINE, source: "cron", accountId: work.id, retry: { key: "cron:job-1", after: "gateway", run: retried } });
    expect(again.retry).toBe("none");
    expect(retried).toHaveBeenCalledTimes(1);
  });

  it("holds the retry while every account is limited, and sends it at the reset", async () => {
    const { work, personal } = await twoAccounts();
    consumer("gateway", { status: "ok", code: "switched", count: 1 });
    const soon = Date.now() + 5_000;
    await pool.markLimited(personal.id, soon, "session");
    const retried = vi.fn(async () => true);
    const outcome = await swap.reportAnthropicFailure({
      text: LIMIT_LINE, source: "chat", accountId: work.id,
      retry: { key: "chat:s:1", after: "gateway", run: retried },
    });
    expect(outcome).toMatchObject({ handled: true, allLimited: true, nextResetAt: soon, retry: "held" });
    expect(retried).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(soon + 1);
    await pool.readPoolState();
    await swap.whenSwapsSettled();
    expect(retried).toHaveBeenCalledTimes(1);
  });

  it("drops the retry when the consumer it needs could not follow — it would only fail the same way", async () => {
    const { work } = await twoAccounts();
    consumer("gateway", { status: "skipped", code: "not_transferable", count: null });
    const retried = vi.fn(async () => true);
    const outcome = await swap.reportAnthropicFailure({ text: LIMIT_LINE, source: "chat", accountId: work.id, retry: { key: "chat:s:2", after: "gateway", run: retried } });
    expect(retried).not.toHaveBeenCalled();
    expect(outcome.retry).toBe("none");
  });

  it("moves only the reporting consumer when the failing credential is not one of the pool's", async () => {
    const { personal } = await twoAccounts();
    const coding = consumer("coding", { status: "ok", code: "moved", count: 1 });
    const gateway = consumer("gateway", async (ctx) => {
      await pool.setGatewayMirror({ accountId: ctx.change.toId!, fingerprint: "0123456789abcdef", expiresAt: null, at: Date.now(), pending: false });
      return { status: "ok", code: "switched", count: 1 };
    });
    await pool.markLimited((await pool.readAccounts())[0].id, Date.now() + 60_000, "session");
    await swap.whenSwapsSettled();
    coding.length = 0;
    gateway.length = 0;
    await pool.setGatewayMirror(null);

    // The gateway's OWN sign-in (not in the pool) hit its limit.
    const retried = vi.fn(async () => true);
    const outcome = await swap.reportAnthropicFailure({ text: LIMIT_LINE, source: "chat", accountId: null, retry: { key: "chat:s:3", after: "gateway", run: retried } });
    expect(outcome).toMatchObject({ handled: true, activeId: personal.id, retry: "sent" });
    expect(gateway).toHaveLength(1);
    expect(gateway[0]).toMatchObject({ takeover: true, change: { toId: personal.id, source: "chat" } });
    expect(coding).toHaveLength(0);
    expect(retried).toHaveBeenCalledTimes(1);
    // Nothing in the pool was marked for a credential the pool does not hold.
    expect((await pool.readAccounts()).find((a) => a.id === personal.id)?.status).toBe("ok");
  });

  it("keeps a refused-looking account whose credential Anthropic still accepts", async () => {
    const { work } = await twoAccounts();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    const outcome = await swap.reportAnthropicFailure({ text: "Invalid API key · Please run /login", source: "chat", accountId: work.id });
    expect(outcome).toMatchObject({ handled: true, kind: "auth", activeId: work.id });
    expect((await pool.readAccounts())[0].status).toBe("ok");
  });

  it("takes out an account whose key Anthropic refuses, and moves on", async () => {
    const { work, personal } = await twoAccounts();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const outcome = await swap.reportAnthropicFailure({ text: "Invalid API key · Please run /login", source: "chat", accountId: work.id });
    expect(outcome).toMatchObject({ handled: true, kind: "auth", activeId: personal.id });
    expect((await pool.readAccounts())[0].status).toBe("revoked");
  });

  it("keeps an account on a bare rate limit, sends the turn again a minute later, and swaps only when it comes back", async () => {
    const { work, personal } = await twoAccounts();
    consumer("gateway", { status: "ok", code: "switched", count: 1 });
    const BARE = 'HTTP 429: {"type":"error","error":{"type":"rate_limit_error"}}';
    const retried = vi.fn(async () => true);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const first = await swap.reportAnthropicFailure({ text: BARE, source: "cron", accountId: work.id, retry: { key: "cron:job-9", after: "gateway", run: retried } });
    expect(first).toMatchObject({ handled: true, kind: "throttled", retry: "later", activeId: work.id });
    expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
    expect(announceAnthropicLimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(retried).toHaveBeenCalledTimes(1));

    const second = await swap.reportAnthropicFailure({ text: BARE, source: "cron", accountId: work.id, retry: { key: "cron:job-9", after: "gateway", run: retried } });
    expect(second).toMatchObject({ handled: true, kind: "limit", activeId: personal.id, retry: "sent" });
    expect(retried).toHaveBeenCalledTimes(2);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)).toMatchObject({ status: "limited", limitKind: "rate" });
  });

  it("forgets a throttle after ten quiet minutes", async () => {
    const { work } = await twoAccounts();
    const BARE = 'HTTP 429: {"type":"error","error":{"type":"rate_limit_error"}}';
    expect((await swap.reportAnthropicFailure({ text: BARE, source: "chat", accountId: work.id })).kind).toBe("throttled");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await swap.reportAnthropicFailure({ text: BARE, source: "chat", accountId: work.id })).kind).toBe("throttled");
    expect((await pool.readAccounts())[0].status).toBe("ok");
  });

  it("puts a renewed credential into the gateway, without filing a swap, before the retry", async () => {
    const { work } = await twoAccounts();
    const order: string[] = [];
    const gateway = consumer("gateway", async () => {
      order.push("gateway");
      return { status: "ok", code: "switched", count: 1 };
    });
    await pool.setGatewayMirror({ accountId: work.id, fingerprint: "0123456789abcdef", expiresAt: null, at: Date.now(), pending: false });
    const before = (await pool.describePool()).lastSwap;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    const outcome = await swap.reportAnthropicFailure({
      text: "Invalid API key · Please run /login", source: "chat", accountId: work.id,
      retry: { key: "chat:s:9", after: "gateway", run: async () => { order.push("retry"); return true; } },
    });
    expect(outcome).toMatchObject({ handled: true, kind: "auth", activeId: work.id, retry: "sent" });
    expect(order).toEqual(["gateway", "retry"]);
    expect(gateway[0]).toMatchObject({ takeover: true, change: { toId: work.id } });
    expect((await pool.describePool()).lastSwap).toEqual(before);
    expect(announceAnthropicLimit).not.toHaveBeenCalled();
  });

  it("does nothing for a failure that is neither a limit nor a refused credential", async () => {
    const { work } = await twoAccounts();
    const retried = vi.fn(async () => true);
    const outcome = await swap.reportAnthropicFailure({ text: "The model is not available in your region.", source: "chat", accountId: work.id, retry: { key: "chat:s:4", after: "gateway", run: retried } });
    expect(outcome.handled).toBe(false);
    expect(retried).not.toHaveBeenCalled();
    expect((await pool.readAccounts())[0].status).toBe("ok");
  });
});
