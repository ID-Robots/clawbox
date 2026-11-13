/**
 * A fresh usage reading that says an account is spent makes it `limited`
 * (TASK-2515).
 *
 * Seen on a box: the owner's card and the `anthropic_accounts` tool showed a
 * Claude account with its week at 100 % as "can answer", because a reading
 * only fed the view and the "most room" ranking; the account became `limited`
 * only once a run or the chat was refused on it — and in the owner's order
 * the next move could land on it, fail once, and move on. Now the reading is
 * recorded through the same write a refusal is: the status, the health, the
 * pick and the move agree with it.
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
const iso = (at: number) => new Date(at).toISOString();

interface Meters {
  week?: number;
  /** Undefined: 100 hours from now; null: Anthropic gave none. */
  weekReset?: number | null;
  session?: number;
  sessionReset?: number | null;
  fable?: number;
  fableReset?: number | null;
}

/** An `/api/oauth/usage` answer of the 2026-11 shape: `five_hour: null` unless a session meter is asked for. */
function answer(m: Meters): Record<string, unknown> {
  const weekReset = m.weekReset === undefined ? Date.now() + 100 * H : m.weekReset;
  const limits: Record<string, unknown>[] = [
    { kind: "weekly_all", group: "weekly", percent: m.week ?? 30, severity: "normal", resets_at: weekReset === null ? null : iso(weekReset), scope: null, is_active: true },
  ];
  if (m.session !== undefined) {
    const at = m.sessionReset === undefined ? Date.now() + 2 * H : m.sessionReset;
    limits.unshift({ kind: "session", group: "session", percent: m.session, severity: "normal", resets_at: at === null ? null : iso(at), scope: null, is_active: false });
  }
  if (m.fable !== undefined) {
    const at = m.fableReset === undefined ? Date.now() + 50 * H : m.fableReset;
    limits.push({ kind: "weekly_scoped", group: "weekly", percent: m.fable, severity: "normal", resets_at: at === null ? null : iso(at), scope: { model: { id: null, display_name: "Fable" } }, is_active: false });
  }
  return {
    five_hour: null,
    seven_day: { utilization: m.week ?? 30, resets_at: weekReset === null ? null : iso(weekReset) },
    limits,
    extra_usage: { is_enabled: false, spend_limit_reached: false },
  };
}

/** Anthropic's usage endpoint by access token, changeable mid-test; every ask recorded. */
function usage(byToken: Record<string, Record<string, unknown>>): { asked: string[]; answers: Record<string, Record<string, unknown>> } {
  const asked: string[] = [];
  const answers = { ...byToken };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/api/oauth/usage")) throw new Error(`unexpected fetch of ${url}`);
    const access = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
    asked.push(access);
    const body = answers[access];
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 403 });
  }));
  return { asked, answers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_TEST_HOME");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-usage-limited-")));
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

async function accounts(...labels: string[]) {
  const out: Record<string, string> = {};
  for (const label of labels) {
    const key = label.toLowerCase();
    out[key] = (await pool.addOAuthAccount({ label, email: `${key}@example.com`, tokens: tokens(`sk-ant-oat01-${key}`) })).id;
  }
  return out;
}

const viewOf = async (id: string) => (await pool.describePool()).accounts.find((a) => a.id === id);

describe("an account whose own week reads spent", () => {
  it("is limited until Anthropic's reset — on the card, in the health, in the pick — and the next move passes it over", async () => {
    const reset = Date.now() + 30 * H;
    usage({ "sk-ant-oat01-a": answer({ week: 40 }), "sk-ant-oat01-b": answer({ week: 100, weekReset: reset }) });
    const { a, b } = await accounts("A", "B");
    const moves: unknown[] = [];
    pool.onActiveChange((change) => moves.push(change));

    await pool.refreshPoolUsage();
    const view = await pool.describePool();
    expect(view.accounts.find((x) => x.id === b)).toMatchObject({ status: "limited", limitedUntil: reset, limitKind: "weekly", active: false, usage: { weeklyPercent: 100 } });
    expect(view.accounts.find((x) => x.id === a)).toMatchObject({ status: "ok", active: true });
    expect(view.health).toMatchObject({ healthy: 1, limited: 1, allLimited: false, nextResetAt: reset });
    // B was not the active account: nothing moved.
    await settle();
    expect(moves).toEqual([]);

    // Kept on disk, marked as a reading's.
    pool._resetAnthropicAccountsForTests();
    expect((await pool.readAccounts()).find((x) => x.id === b)).toMatchObject({ status: "limited", limitedUntil: reset, limitKind: "weekly", limitFromUsage: true });

    // A refused now: the owner's order no longer lands on the spent B.
    await pool.markLimited(a, Date.now() + 2 * H, "session", { source: "coding" });
    const state = await pool.readPoolState();
    expect(state.activeId).toBeNull();
    expect(state.health).toMatchObject({ healthy: 0, limited: 2, allLimited: true });
    expect((await pool.prepareAccount()).prepared).toBeNull();
  });

  it("keeps parseAnthropicUsage's own rule: a session at 90 % or more counts when nothing is full, a week at 95 % does not", async () => {
    const sessionReset = Date.now() + 2 * H;
    usage({
      "sk-ant-oat01-a": answer({ week: 95 }),
      "sk-ant-oat01-b": answer({ week: 60, session: 92, sessionReset }),
    });
    const { a, b } = await accounts("A", "B");
    await pool.refreshPoolUsage();
    expect(await viewOf(a)).toMatchObject({ status: "ok", limitedUntil: null });
    expect(await viewOf(b)).toMatchObject({ status: "limited", limitedUntil: sessionReset, limitKind: "session" });
  });
});

describe("an account whose only spent week is a model's own (weekly_scoped)", () => {
  it("stays ok and active; only that model is limited, until that week's reset", async () => {
    const fableReset = Date.now() + 50 * H;
    usage({ "sk-ant-oat01-a": answer({ week: 56, fable: 100, fableReset }) });
    const { a, b } = await accounts("A", "B");
    const moves: unknown[] = [];
    pool.onActiveChange((change) => moves.push(change));

    await pool.readAccountUsage(a);
    const view = await viewOf(a);
    expect(view).toMatchObject({ status: "ok", limitedUntil: null, limitKind: null, active: true });
    expect(view?.modelLimits).toEqual([{ family: "fable", name: "Fable", until: fableReset }]);
    expect((await pool.describePool()).health).toMatchObject({ healthy: 2, limited: 0 });
    await settle();
    expect(moves).toEqual([]);

    // Fable runs go to B; every other model, and the box, stay on A.
    expect((await pool.prepareAccount({ model: FABLE })).prepared?.account.id).toBe(b);
    expect((await pool.prepareAccount({ model: OPUS })).prepared?.account.id).toBe(a);
    expect((await pool.readPoolState()).activeId).toBe(a);
  });
});

describe("a reading with no reset time", () => {
  it("changes nothing: no limit is invented, for the account or for a model", async () => {
    usage({ "sk-ant-oat01-a": answer({ week: 100, weekReset: null, fable: 100, fableReset: null }) });
    const { a } = await accounts("A", "B");
    const reading = await pool.readAccountUsage(a);
    expect(reading).toMatchObject({ exhausted: true, resetsAt: null });
    const view = await viewOf(a);
    expect(view).toMatchObject({ status: "ok", limitedUntil: null, active: true });
    expect(view?.modelLimits).toEqual([]);
  });

  it("leaves a limit already on record as it is", async () => {
    const reset = Date.now() + 30 * H;
    const { answers } = usage({ "sk-ant-oat01-a": answer({ week: 100, weekReset: reset }) });
    const { a } = await accounts("A", "B");
    await pool.readAccountUsage(a);
    answers["sk-ant-oat01-a"] = answer({ week: 100, weekReset: null });
    await pool.readAccountUsage(a);
    expect(await viewOf(a)).toMatchObject({ status: "limited", limitedUntil: reset });
  });

  it("and one whose reset is already past changes nothing either", async () => {
    usage({ "sk-ant-oat01-a": answer({ week: 100, weekReset: Date.now() - 60_000 }) });
    const { a } = await accounts("A", "B");
    await pool.readAccountUsage(a);
    expect(await viewOf(a)).toMatchObject({ status: "ok", active: true });
  });
});

describe("the active account read spent", () => {
  it("moves the box to the next usable account, as a recorded limit does", async () => {
    const reset = Date.now() + 30 * H;
    usage({ "sk-ant-oat01-a": answer({ week: 100, weekReset: reset }), "sk-ant-oat01-b": answer({ week: 20 }) });
    const { a, b } = await accounts("A", "B");
    expect((await pool.readPoolState()).activeId).toBe(a);
    const moves: Array<Record<string, unknown>> = [];
    pool.onActiveChange((change) => moves.push(change as unknown as Record<string, unknown>));

    const reading = await pool.readAccountUsage(a);
    expect(reading?.exhausted).toBe(true);
    // Recorded before the reading is handed back.
    const state = await pool.readPoolState();
    expect(state.activeId).toBe(b);
    expect(state.accounts.find((x) => x.id === a)).toMatchObject({ status: "limited", limitedUntil: reset, limitKind: "weekly" });
    await settle();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ fromId: a, toId: b, cause: "limit", source: "box", runId: null, limitKind: "weekly", limitedUntil: reset });
  });

  it("in the owner's order, skips a spent account the same view read, onto the first that can answer", async () => {
    usage({
      "sk-ant-oat01-a": answer({ week: 100 }),
      "sk-ant-oat01-b": answer({ week: 100 }),
      "sk-ant-oat01-c": answer({ week: 10 }),
    });
    const { b, c } = await accounts("A", "B", "C");
    await pool.refreshPoolUsage();
    const state = await pool.readPoolState();
    expect(state.activeId).toBe(c);
    expect(state.accounts.find((x) => x.id === b)?.status).toBe("limited");
  });

  it("under \"most room\", the readings taken for the move limit a spent candidate too", async () => {
    usage({ "sk-ant-oat01-b": answer({ week: 100 }), "sk-ant-oat01-c": answer({ week: 70 }) });
    const { a, b, c } = await accounts("A", "B", "C");
    await pool.setPickMode("most-room");
    await pool.markLimited(a, Date.now() + H, "session");
    const state = await pool.readPoolState();
    expect(state.activeId).toBe(c);
    expect(state.accounts.find((x) => x.id === b)).toMatchObject({ status: "limited", limitFromUsage: true });
  });
});

describe("a later reading with room", () => {
  it("lifts a limit only a reading had set, and a model week only a reading had set", async () => {
    const { answers } = usage({ "sk-ant-oat01-b": answer({ week: 100, fable: 100 }) });
    const { a, b } = await accounts("A", "B");
    await pool.readAccountUsage(b);
    expect(await viewOf(b)).toMatchObject({ status: "limited" });
    expect((await viewOf(b))?.modelLimits).toHaveLength(1);

    answers["sk-ant-oat01-b"] = answer({ week: 12, fable: 3 });
    await pool.readAccountUsage(b);
    const view = await viewOf(b);
    expect(view).toMatchObject({ status: "ok", limitedUntil: null, limitKind: null });
    expect(view?.modelLimits).toEqual([]);
    expect((await pool.readAccounts()).find((x) => x.id === b)?.limitFromUsage).toBeUndefined();
    expect((await pool.readPoolState()).activeId).toBe(a);
  });

  it("brings the box back when every account was limited", async () => {
    const { answers } = usage({ "sk-ant-oat01-a": answer({ week: 100 }) });
    const { a, b } = await accounts("A", "B");
    await pool.markLimited(b, Date.now() + 5 * H, "session", { source: "chat" });
    await pool.readAccountUsage(a);
    expect((await pool.readPoolState()).activeId).toBeNull();
    answers["sk-ant-oat01-a"] = answer({ week: 40 });
    await pool.readAccountUsage(a);
    expect((await pool.readPoolState()).activeId).toBe(a);
  });

  it("never lifts a limit a refusal recorded — before the reading or after it", async () => {
    const reset = Date.now() + 30 * H;
    const { answers } = usage({ "sk-ant-oat01-b": answer({ week: 12 }) });
    const { b } = await accounts("A", "B");
    const refused = Date.now() + 5 * H;
    await pool.markLimited(b, refused, "session", { source: "coding" });
    await pool.readAccountUsage(b);
    expect(await viewOf(b)).toMatchObject({ status: "limited", limitedUntil: refused, limitKind: "session" });

    // A reading's limit, then a refusal: the refusal's from then on, and a later reading only extends it.
    answers["sk-ant-oat01-b"] = answer({ week: 100, weekReset: reset });
    await pool.readAccountUsage(b);
    expect(await viewOf(b)).toMatchObject({ status: "limited", limitedUntil: reset, limitKind: "weekly" });
    expect((await pool.readAccounts()).find((x) => x.id === b)?.limitFromUsage).toBeUndefined();
    answers["sk-ant-oat01-b"] = answer({ week: 12 });
    await pool.readAccountUsage(b);
    expect(await viewOf(b)).toMatchObject({ status: "limited", limitedUntil: reset });
  });

  it("never lifts a model week a refused run recorded", async () => {
    usage({ "sk-ant-oat01-a": answer({ week: 20, fable: 10 }) });
    const { a } = await accounts("A", "B");
    const until = Date.now() + 30 * H;
    await pool.markModelLimited(a, { family: "fable", name: "Fable" }, until, { source: "coding", runId: "run-aaaaaaaa" });
    await pool.readAccountUsage(a);
    expect((await viewOf(a))?.modelLimits).toEqual([{ family: "fable", name: "Fable", until }]);
  });
});

describe("what does not record a reading", () => {
  it("a caller that records the limit itself (record: false) gets the reading and nothing is written", async () => {
    usage({ "sk-ant-oat01-a": answer({ week: 100 }) });
    const { a } = await accounts("A", "B");
    const reading = await pool.readAccountUsage(a, 0, { record: false });
    expect(reading?.exhausted).toBe(true);
    expect(await viewOf(a)).toMatchObject({ status: "ok", active: true });
  });

  it("an account that needs the owner keeps that state, whatever its reading", async () => {
    usage({ "sk-ant-oat01-a": answer({ week: 100 }) });
    const { a } = await accounts("A", "B");
    await pool.markCredentialProblem(a, "expired");
    expect(await pool.readAccountUsage(a)).toMatchObject({ exhausted: true });
    const account = (await pool.readAccounts()).find((x) => x.id === a);
    expect(account).toMatchObject({ status: "expired", limitedUntil: null });
  });

  it("a reading that only confirms what is on record writes nothing", async () => {
    const reset = Date.now() + 30 * H;
    usage({ "sk-ant-oat01-b": answer({ week: 100, weekReset: reset }) });
    const { b } = await accounts("A", "B");
    await pool.readAccountUsage(b);
    const before = (await pool.readAccounts()).find((x) => x.id === b);
    // The store writes a fresh file and renames it over: a write is a new inode.
    const config = path.join(root, "data", "config.json");
    const inode = fs.statSync(config).ino;
    expect(await pool.readAccountUsage(b)).toMatchObject({ exhausted: true });
    expect(fs.statSync(config).ino).toBe(inode);
    expect((await pool.readAccounts()).find((x) => x.id === b)).toEqual(before);
  });
});
