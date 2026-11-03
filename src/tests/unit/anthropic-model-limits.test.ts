/**
 * A model's own week on the account pool (TASK-2141).
 *
 * Anthropic's usage scheme of 2026-11 caps some models with a week of their
 * own (`weekly_scoped`) inside the account's week (`weekly_all`), and answers
 * `five_hour: null`. A spent model week must keep only runs on THAT model off
 * the account: the account stays `ok`, the box's active account does not move,
 * runs on every other model still get it — and the "most room" pick ranks on
 * the account's week plus the run's model week, with no five-hour window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, default: { ...actual, homedir: () => process.env.CLAWBOX_TEST_HOME ?? actual.homedir() }, homedir: () => process.env.CLAWBOX_TEST_HOME ?? actual.homedir() };
});

const H = 3_600_000;
const FABLE = "claude-fable-5-1";
const OPUS = "claude-opus-5-5";

let root = "";
let restoreEnv: () => void;
let pool: typeof import("@/lib/anthropic-accounts");

const tokens = (access: string) => ({ access, refresh: `refresh-${access}`, expires: Date.now() + 8 * H });

/** The live answer of 2026-11-03, with this account's week and its Fable week. */
function answer(week: number, fable: number | null): Record<string, unknown> {
  const resets = new Date(Date.now() + 100 * H).toISOString();
  return {
    five_hour: null,
    seven_day: { utilization: week, resets_at: resets },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      { kind: "weekly_all", group: "weekly", percent: week, severity: "normal", resets_at: resets, scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: fable ?? 0, severity: "normal", resets_at: new Date(Date.now() + 50 * H).toISOString(), scope: { model: { id: null, display_name: "Fable" } }, is_active: fable !== null },
    ],
    weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 17, allowance_percent_of_weekly: 50 }],
    extra_usage: { is_enabled: false, spend_limit_reached: false },
  };
}

/** Anthropic's usage endpoint, by access token; every ask recorded, nothing else may be fetched. */
function usage(byToken: Record<string, Record<string, unknown>>): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/api/oauth/usage")) throw new Error(`unexpected fetch of ${url}`);
    const access = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
    asked.push(access);
    const body = byToken[access];
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 403 });
  }));
  return asked;
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_TEST_HOME");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-model-limits-")));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "7c".repeat(32), { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_TEST_HOME = home;
  process.env.SESSION_SECRET = "ff".repeat(32);
  vi.resetModules();
  pool = await import("@/lib/anthropic-accounts");
  (await import("@/lib/project-secrets"))._resetSecretKeyCacheForTests();
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

async function twoAccounts() {
  const a = await pool.addOAuthAccount({ label: "A", email: "a@example.com", tokens: tokens("sk-ant-oat01-a") });
  const b = await pool.addOAuthAccount({ label: "B", email: "b@example.com", tokens: tokens("sk-ant-oat01-b") });
  return { a, b };
}

describe("a spent model week", () => {
  it("keeps only runs on that model off the account: it stays ok, active, and healthy, and nothing is swapped", async () => {
    usage({});
    const { a, b } = await twoAccounts();
    const moves: unknown[] = [];
    pool.onActiveChange((change) => moves.push(change));
    const until = Date.now() + 30 * H;

    const recorded = await pool.markModelLimited(a.id, { family: "fable", name: "Fable" }, until, { source: "coding", runId: "run-aaaaaaaa" });
    expect(recorded).toMatchObject({ newlyLimited: true, becameAllLimited: false, health: { healthy: 2, limited: 0 } });

    const state = await pool.readPoolState();
    expect(state.activeId).toBe(a.id);
    const view = (await pool.describePool()).accounts.find((x) => x.id === a.id);
    expect(view).toMatchObject({ status: "ok", limitedUntil: null, limitKind: null, active: true });
    expect(view?.modelLimits).toEqual([{ family: "fable", name: "Fable", until }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(moves).toEqual([]);

    // The picker: Fable runs get B, every other model still gets A.
    expect((await pool.prepareAccount({ model: FABLE })).prepared?.account.id).toBe(b.id);
    expect((await pool.prepareAccount({ model: OPUS })).prepared?.account.id).toBe(a.id);
    expect((await pool.prepareAccount()).prepared?.account.id).toBe(a.id);
    expect(pool.anotherAccountLikely(b.id, Date.now(), FABLE)).toBe(false);
    expect(pool.anotherAccountLikely(b.id, Date.now(), OPUS)).toBe(true);
  });

  it("is kept on disk, and the owner's clear takes it back", async () => {
    usage({});
    const { a, b } = await twoAccounts();
    await pool.markModelLimited(a.id, { family: "fable", name: "Fable" }, Date.now() + 30 * H);
    pool._resetAnthropicAccountsForTests();
    expect((await pool.readAccounts()).find((x) => x.id === a.id)?.modelLimits).toMatchObject([{ family: "fable", name: "Fable" }]);
    expect((await pool.prepareAccount({ model: FABLE })).prepared?.account.id).toBe(b.id);

    await pool.clearLimit(a.id);
    expect((await pool.readAccounts()).find((x) => x.id === a.id)?.modelLimits).toBeUndefined();
    expect((await pool.prepareAccount({ model: FABLE })).prepared?.account.id).toBe(a.id);
  });

  it("still hands a run on that model the preferred account when every account's week for it is spent — its refusal is what pauses the run", async () => {
    usage({});
    const { a, b } = await twoAccounts();
    await pool.markModelLimited(a.id, { family: "fable", name: "Fable" }, Date.now() + 30 * H);
    await pool.markModelLimited(b.id, { family: "fable", name: "Fable" }, Date.now() + 20 * H);
    expect((await pool.prepareAccount({ model: FABLE })).prepared).toBeNull();
    expect((await pool.prepareAccount({ model: FABLE, fallback: true })).prepared?.account.id).toBe(a.id);
  });

  it("never falls back onto an account that needs the owner, whatever model week it has", async () => {
    usage({});
    const { a, b } = await twoAccounts();
    await pool.markModelLimited(a.id, { family: "fable", name: "Fable" }, Date.now() + 30 * H);
    await pool.markModelLimited(b.id, { family: "fable", name: "Fable" }, Date.now() + 20 * H);
    await pool.markCredentialProblem(a.id, "revoked");
    expect((await pool.prepareAccount({ model: FABLE, fallback: true })).prepared?.account.id).toBe(b.id);
  });

  it("never falls back onto an account the run gave up on after refusals (TASK-2139), even one still ok", async () => {
    usage({});
    const { a, b } = await twoAccounts();
    await pool.markModelLimited(a.id, { family: "fable", name: "Fable" }, Date.now() + 30 * H);
    await pool.markModelLimited(b.id, { family: "fable", name: "Fable" }, Date.now() + 20 * H);
    expect((await pool.prepareAccount({ model: FABLE, fallback: true, exclude: new Set([a.id]) })).prepared?.account.id).toBe(b.id);
    expect((await pool.prepareAccount({ model: FABLE, fallback: true, exclude: new Set([a.id, b.id]) })).prepared).toBeNull();
  });

  it("wakes the runs waiting for it at its end, like an account's own limit", async () => {
    usage({});
    const { a } = await twoAccounts();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const woke = vi.fn();
    pool.onLimitReset(woke);
    await pool.markModelLimited(a.id, { family: "fable", name: "Fable" }, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(60_000 + 25_000);
    expect(woke).toHaveBeenCalled();
  });
});

describe("\"most room\" on the meters of 2026-11", () => {
  it("ranks with five_hour null: the account's week, plus the run's model week", async () => {
    // A is active; B: week 60 %, Fable 95 %; C: week 70 %, Fable 10 %.
    const asked = usage({
      "sk-ant-oat01-b": answer(60, 95),
      "sk-ant-oat01-c": answer(70, 10),
    });
    const a = await pool.addOAuthAccount({ label: "A", email: "a@example.com", tokens: tokens("sk-ant-oat01-a") });
    const b = await pool.addOAuthAccount({ label: "B", email: "b@example.com", tokens: tokens("sk-ant-oat01-b") });
    const c = await pool.addOAuthAccount({ label: "C", email: "c@example.com", tokens: tokens("sk-ant-oat01-c") });
    await pool.setPickMode("most-room");

    // A run on Fable that has seen A refuse: C has the more Fable room.
    expect((await pool.prepareAccount({ exclude: new Set([a.id]), model: FABLE })).prepared?.account.id).toBe(c.id);
    // A run on Opus: the Fable week is not its own — B's week has more room.
    expect((await pool.prepareAccount({ exclude: new Set([a.id]), model: OPUS })).prepared?.account.id).toBe(b.id);
    // The box's own move (no model): the account's week.
    await pool.markLimited(a.id, Date.now() + H, "weekly");
    expect((await pool.readPoolState()).activeId).toBe(b.id);
    expect([...new Set(asked)].sort()).toEqual(["sk-ant-oat01-b", "sk-ant-oat01-c"]);
  });
});

describe("the owner's view of each account's usage", () => {
  it("says the weekly percent and the ACTIVE model weeks from Anthropic's answer, and never calls the account limited for a model week", async () => {
    const asked = usage({ "sk-ant-oat01-a": answer(56, 100), "sk-ant-oat01-b": answer(56, null) });
    const { a, b } = await twoAccounts();
    expect((await pool.describePool()).accounts.every((x) => x.usage === null)).toBe(true);
    expect(asked).toEqual([]);

    await pool.refreshPoolUsage();
    const view = await pool.describePool();
    const first = view.accounts.find((x) => x.id === a.id);
    expect(first?.status).toBe("ok");
    expect(first?.usage).toMatchObject({ sessionPercent: null, weeklyPercent: 56, models: [{ name: "Fable", family: "fable", percent: 100, spent: true }], extraUsage: { enabled: false, spendLimitReached: false } });
    // B's Fable week is inactive: not shown.
    expect(view.accounts.find((x) => x.id === b.id)?.usage).toMatchObject({ weeklyPercent: 56, models: [] });
    expect(view.health).toMatchObject({ healthy: 2, limited: 0, allLimited: false });

    // Asked once per ten minutes, not per view.
    await pool.refreshPoolUsage();
    expect(asked.sort()).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-b"]);
  });

  it("asks once for callers that ask together, and keeps the last good answer when Anthropic does not answer", async () => {
    const asked = usage({ "sk-ant-oat01-a": answer(56, 100) });
    const { a } = await twoAccounts();
    const [one, two] = await Promise.all([pool.readAccountUsage(a.id), pool.readAccountUsage(a.id)]);
    expect(one).toBe(two);
    expect(asked).toEqual(["sk-ant-oat01-a"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    expect(await pool.readAccountUsage(a.id)).toBeNull();
    expect((await pool.describePool()).accounts.find((x) => x.id === a.id)?.usage).toMatchObject({ weeklyPercent: 56 });
  });

  it("answers the run's question — which window, until when — straight from Anthropic", async () => {
    usage({ "sk-ant-oat01-a": answer(56, 100) });
    const { a, b } = await twoAccounts();
    const reading = await pool.readAccountUsage(a.id);
    expect(reading?.exhausted).toBe(false);
    expect(reading?.models?.[0]).toMatchObject({ family: "fable", spent: true });
    // Not an answer for an account Anthropic would not answer for.
    expect(await pool.readAccountUsage(b.id)).toBeNull();
  });
});
