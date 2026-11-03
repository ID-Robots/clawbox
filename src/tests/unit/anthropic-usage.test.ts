/**
 * Anthropic's own word on whether a Claude account is at its limit, and until
 * when (TASK-1260, the chat on the pool) — the windows core's own reader reads.
 * A spent window is a limit until ITS reset; a window short of full is not a
 * limit at all; Anthropic not answering is never read as "fine".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAnthropicUsage, nearestFull, parseAnthropicUsage, usageForModel } from "@/lib/anthropic-usage";

const at = (iso: string) => Date.parse(iso);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading the windows", () => {
  it("is the five-hour window's reset when that is the one spent", () => {
    expect(parseAnthropicUsage({
      five_hour: { utilization: 100, resets_at: "2026-10-14T18:10:00Z" },
      seven_day: { utilization: 43, resets_at: "2026-10-19T09:00:00Z" },
    })).toMatchObject({ exhausted: true, resetsAt: at("2026-10-14T18:10:00Z"), kind: "session" });
  });

  it("is a weekly limit, until the LATEST reset, when a week is spent too", () => {
    expect(parseAnthropicUsage({
      five_hour: { utilization: 100, resets_at: "2026-10-14T18:10:00Z" },
      seven_day_opus: { utilization: 100, resets_at: "2026-10-19T09:00:00Z" },
    })).toMatchObject({ exhausted: true, resetsAt: at("2026-10-19T09:00:00Z"), kind: "weekly" });
  });

  it("reads a model-scoped week from `limits[]` as THAT model's, never the account's, and skips one that names no model", () => {
    // TASK-2141: a spent `weekly_scoped` week stops runs on its model only —
    // the account is not exhausted (before, this read as the account's week).
    const reading = parseAnthropicUsage({
      five_hour: { utilization: 12, resets_at: null },
      limits: [
        { kind: "weekly_scoped", percent: 100, resets_at: "2026-10-20T00:00:00Z", scope: { model: { display_name: "Fable" } } },
        { kind: "weekly_scoped", percent: 100, resets_at: "2026-10-21T00:00:00Z" },
      ],
    });
    expect(reading).toMatchObject({ exhausted: false, resetsAt: null, kind: "session" });
    expect(reading.models).toEqual([{ family: "fable", name: "Fable", percent: 100, resetsAt: at("2026-10-20T00:00:00Z"), spent: true }]);
    expect(usageForModel(reading, "claude-fable-5-1")).toMatchObject({ exhausted: true, resetsAt: at("2026-10-20T00:00:00Z"), account: null });
  });

  it("counts the session window a few points short of full as spent — the request that would cross it is refused before it reads 100", () => {
    expect(parseAnthropicUsage({ five_hour: { utilization: 96, resets_at: "2026-10-14T18:10:00Z" }, seven_day: { utilization: 40, resets_at: "2026-10-19T09:00:00Z" } }))
      .toMatchObject({ exhausted: true, resetsAt: at("2026-10-14T18:10:00Z"), kind: "session" });
  });

  it("never sets an account aside until a WEEK resets over a week that still has room", () => {
    // The five-hour window capped, the week at 92 %: back in hours, not days.
    expect(parseAnthropicUsage({
      five_hour: { utilization: 100, resets_at: "2026-10-14T18:10:00Z" },
      seven_day: { utilization: 92, resets_at: "2026-10-19T09:00:00Z" },
    })).toMatchObject({ exhausted: true, resetsAt: at("2026-10-14T18:10:00Z"), kind: "session" });
    // A throttle on an account whose week is high is no limit at all.
    expect(parseAnthropicUsage({ five_hour: { utilization: 30, resets_at: null }, seven_day: { utilization: 95, resets_at: "2026-10-19T09:00:00Z" } }))
      .toMatchObject({ exhausted: false, resetsAt: null, kind: "session" });
  });

  it("is no limit when every window has room, whatever else the answer holds", () => {
    expect(parseAnthropicUsage({ five_hour: { utilization: 80, resets_at: null }, seven_day: { utilization: 20 }, extra_usage: { utilization: 100 } }))
      .toMatchObject({ exhausted: false, resetsAt: null, kind: "session" });
    expect(parseAnthropicUsage(null)).toMatchObject({ exhausted: false, resetsAt: null, kind: "session" });
  });

  it("says how full the five-hour and the seven-day window are, from the same answer, and null for a window it does not have", () => {
    expect(parseAnthropicUsage({
      five_hour: { utilization: 37.5, resets_at: "2026-10-14T18:10:00Z" },
      seven_day: { utilization: 81, resets_at: "2026-10-19T09:00:00Z" },
      seven_day_opus: { utilization: 99 },
    }).utilization).toEqual({ fiveHour: 37.5, sevenDay: 81 });
    expect(parseAnthropicUsage({ five_hour: { utilization: 12 }, seven_day: { utilization: "81" } }).utilization).toEqual({ fiveHour: 12, sevenDay: null });
    expect(parseAnthropicUsage(null).utilization).toEqual({ fiveHour: null, sevenDay: null });
  });
});

describe("asking Anthropic", () => {
  it("asks with the account's own token and the OAuth beta core's reader sends", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: "2026-10-14T18:10:00Z" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchAnthropicUsage("sk-ant-oat01-acct")).toMatchObject({ exhausted: true, kind: "session" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-ant-oat01-acct", "anthropic-beta": "oauth-2025-04-20" });
  });

  it("answers null — never \"not limited\" — when Anthropic refuses or cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    expect(await fetchAnthropicUsage("x")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    expect(await fetchAnthropicUsage("x")).toBeNull();
  });
});

/**
 * The meters of 2026-11 (TASK-2141), in the exact shape Anthropic's
 * `/api/oauth/usage` answered on 2026-11-03 (trimmed, reset times made up):
 * `five_hour: null`, the account's week in `seven_day` and `limits[]`, the
 * model weeks `weekly_scoped`, and keys this box has never seen, all null.
 */
describe("the usage scheme of 2026-11", () => {
  const WEEK_RESET = "2026-11-09T08:00:00Z";
  const FABLE_RESET = "2026-11-08T17:00:00Z";
  const LIVE = {
    five_hour: null,
    seven_day: { utilization: 56, resets_at: WEEK_RESET },
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_oauth_apps: null,
    seven_day_cowork: null,
    iguana_necktie: null,
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 56, severity: "normal", resets_at: WEEK_RESET, scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 34, severity: "normal", resets_at: FABLE_RESET, scope: { model: { id: null, display_name: "Fable" } }, is_active: false },
    ],
    weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 17, allowance_percent_of_weekly: 50 }],
    extra_usage: { is_enabled: true, spend_limit_reached: false, monthly_limit: null, used_credits: null },
    spend: { currency: "USD", amount: null },
  };

  /**
   * The live answer with its Fable week at `percent`, the server's headline
   * pick (`is_active`) moved onto it as Anthropic moves it to the binding meter
   * (an Ultra account's answer of 2026-11-03: the week 54 % `is_active: false`,
   * Fable 100 % `critical` `is_active: true`).
   */
  const withFable = (percent: number, extra: Record<string, unknown> = {}) => ({
    ...LIVE,
    limits: [{ ...LIVE.limits[0], is_active: false }, { ...LIVE.limits[1], percent, is_active: true, ...extra }],
  });

  it("reads today's answer: the account's week at 56 %, nothing spent, no session window, and the Fable week that is not the headline", () => {
    // `is_active` is the server's headline pick — the one row a single-value
    // indicator shows (Claude Code 2.1.317's schema) — not "this meter is off":
    // the Fable week at 34 % still counts for every run on Fable.
    const reading = parseAnthropicUsage(LIVE);
    expect(reading).toMatchObject({ exhausted: false, resetsAt: null, kind: "session" });
    expect(reading.utilization).toEqual({ fiveHour: null, sevenDay: 56 });
    expect(reading.models).toEqual([{ family: "fable", name: "Fable", percent: 34, resetsAt: at(FABLE_RESET), spent: false }]);
    expect(usageForModel(reading, "claude-fable-5-1")).toMatchObject({ exhausted: false, week: null, fullness: 56 });
    expect(reading.windows).toContainEqual({ kind: "weekly", percent: 56, resetsAt: at(WEEK_RESET) });
    expect(reading.windows?.some((w) => w.kind === "session")).toBe(false);
    expect(reading.extraUsage).toEqual({ enabled: true, spendLimitReached: false });
  });

  it("does NOT mark the account exhausted when only the Fable week is at 100 % — a run on Fable waits, a run on Opus does not", () => {
    const reading = parseAnthropicUsage(withFable(100));
    expect(reading.exhausted).toBe(false);
    expect(reading.models).toEqual([{ family: "fable", name: "Fable", percent: 100, resetsAt: at(FABLE_RESET), spent: true }]);
    expect(usageForModel(reading, "claude-fable-5-1")).toEqual({
      exhausted: true,
      resetsAt: at(FABLE_RESET),
      account: null,
      week: reading.models?.[0],
      fullness: 100,
    });
    expect(usageForModel(reading, "claude-opus-5-5")).toMatchObject({ exhausted: false, resetsAt: null, week: null, fullness: 56 });
    expect(usageForModel(reading, null)).toMatchObject({ exhausted: false, fullness: 56 });
  });

  it("reads the account's week from a `weekly_all` meter that is not the headline, with no `seven_day` beside it", () => {
    // The Fable week spent took the headline from the account's week; the week
    // still counts for every run, and must not hang on the old field.
    const reading = parseAnthropicUsage({ five_hour: null, limits: withFable(100).limits });
    expect(reading.utilization).toEqual({ fiveHour: null, sevenDay: 56 });
    expect(reading.windows).toEqual([{ kind: "weekly", percent: 56, resetsAt: at(WEEK_RESET) }]);
    expect(usageForModel(reading, "claude-opus-5-5")).toMatchObject({ exhausted: false, week: null, fullness: 56 });
    expect(usageForModel(reading, "claude-fable-5-1")).toMatchObject({ exhausted: true, account: null, week: { family: "fable", spent: true }, resetsAt: at(FABLE_RESET) });
  });

  it("matches the scoped week on the model's id when Anthropic gives one, and on its name when it does not", () => {
    const byId = parseAnthropicUsage(withFable(100, { scope: { model: { id: "claude-fable-5-1", display_name: null } } }));
    expect(byId.models?.[0]).toMatchObject({ family: "fable", name: "claude-fable-5-1", spent: true });
    expect(usageForModel(byId, "claude-fable-5-1").exhausted).toBe(true);
    expect(usageForModel(byId, "claude-sonnet-5-5").exhausted).toBe(false);
  });

  it("ranks a run's room by the account's week plus ITS model's week, never another model's", () => {
    const reading = parseAnthropicUsage(withFable(91));
    expect(usageForModel(reading, "claude-fable-5-1").fullness).toBe(91);
    expect(usageForModel(reading, "claude-opus-5-5").fullness).toBe(56);
  });

  it("is the account's limit when `weekly_all` is spent, until its reset, whatever the model", () => {
    const reading = parseAnthropicUsage({ ...LIVE, seven_day: { utilization: 100, resets_at: WEEK_RESET }, limits: [{ ...LIVE.limits[0], percent: 100, severity: "exceeded" }, LIVE.limits[1]] });
    expect(reading).toMatchObject({ exhausted: true, resetsAt: at(WEEK_RESET), kind: "weekly" });
    expect(usageForModel(reading, "claude-opus-5-5")).toMatchObject({ exhausted: true, account: { kind: "weekly", resetsAt: at(WEEK_RESET) }, week: null });
  });

  it("reads a `session` meter as the session window when `five_hour` is null — and its 90 % rule with it", () => {
    const session = { kind: "session", group: "session", percent: 93, severity: "normal", resets_at: "2026-11-03T21:00:00Z", scope: null, is_active: true };
    const reading = parseAnthropicUsage({ ...LIVE, limits: [session, LIVE.limits[0]] });
    expect(reading.utilization).toEqual({ fiveHour: 93, sevenDay: 56 });
    expect(reading).toMatchObject({ exhausted: true, kind: "session", resetsAt: at("2026-11-03T21:00:00Z") });
  });

  it("takes a meter Anthropic itself calls refused as spent, short of 100 %", () => {
    expect(parseAnthropicUsage({ limits: [{ ...LIVE.limits[0], percent: 98, severity: "rejected" }] })).toMatchObject({ exhausted: true, kind: "weekly" });
    expect(parseAnthropicUsage({ limits: [{ ...LIVE.limits[0], percent: 98, severity: "warning" }] }).exhausted).toBe(false);
  });

  it("places a kind it does not know by what it does: scoped to a model is that model's week, else its group", () => {
    const reading = parseAnthropicUsage({
      limits: [
        { kind: "weekly_model_v2", group: "weekly", percent: 100, scope: { model: { display_name: "Opus" } }, resets_at: WEEK_RESET },
        { kind: "burst", group: "session", percent: 40, resets_at: null },
      ],
    });
    expect(reading.exhausted).toBe(false);
    expect(reading.models).toEqual([{ family: "opus", name: "Opus", percent: 100, resetsAt: at(WEEK_RESET), spent: true }]);
    expect(reading.windows).toEqual([{ kind: "session", percent: 40, resetsAt: null }]);
  });

  it("says which window a stop the answer does not show spent was nearest to — the session or the run's model week, never the account's week", () => {
    expect(nearestFull(parseAnthropicUsage(withFable(97)), "claude-fable-5-1")?.week).toMatchObject({ family: "fable", percent: 97 });
    expect(nearestFull(parseAnthropicUsage(withFable(97)), "claude-opus-5-5")).toBeNull();
    // The account's week fuller still, so the headline stays on it: the Fable week at 93 % is still the run's.
    const weekFirst = parseAnthropicUsage({ ...LIVE, seven_day: { utilization: 96, resets_at: WEEK_RESET }, limits: [{ ...LIVE.limits[0], percent: 96 }, { ...LIVE.limits[1], percent: 93 }] });
    expect(nearestFull(weekFirst, "claude-fable-5-1")?.week).toMatchObject({ family: "fable", percent: 93 });
    // A week at 99 % is a week with room: parking the account until its reset would lose it for days.
    expect(nearestFull(parseAnthropicUsage({ ...LIVE, limits: [{ ...LIVE.limits[0], percent: 99 }] }), null)).toBeNull();
    const session = { kind: "session", group: "session", percent: 92, severity: "normal", resets_at: "2026-11-03T21:00:00Z", scope: null, is_active: true };
    expect(nearestFull({ ...parseAnthropicUsage({ ...LIVE, limits: [session, LIVE.limits[0]] }), exhausted: false }, null)?.window).toMatchObject({ kind: "session", percent: 92 });
  });

  it("does not take the whole account out for a session at 9x % when the run's model week is what is spent", () => {
    const session = { kind: "session", group: "session", percent: 91, severity: "normal", resets_at: "2026-11-03T21:00:00Z", scope: null, is_active: true };
    const reading = parseAnthropicUsage({ ...withFable(100), limits: [session, LIVE.limits[0], { ...LIVE.limits[1], percent: 100, is_active: true }] });
    expect(reading.exhausted).toBe(true);
    expect(usageForModel(reading, "claude-fable-5-1")).toMatchObject({ exhausted: true, account: null, week: { family: "fable" }, resetsAt: at(FABLE_RESET) });
    // A run on another model meets the session window's 90 % rule as before.
    expect(usageForModel(reading, "claude-opus-5-5")).toMatchObject({ exhausted: true, account: { kind: "session" } });
    // A session truly full takes the account out whatever the model.
    const full = parseAnthropicUsage({ ...withFable(100), limits: [{ ...session, percent: 100 }, LIVE.limits[0], { ...LIVE.limits[1], percent: 100, is_active: true }] });
    expect(usageForModel(full, "claude-fable-5-1").account).toMatchObject({ kind: "session" });
  });

  it("reads the old shape's model weeks beside `limits[]` as those models' weeks, not the account's", () => {
    const reading = parseAnthropicUsage({ ...LIVE, seven_day_opus: { utilization: 100, resets_at: FABLE_RESET } });
    expect(reading.exhausted).toBe(false);
    expect(reading.models).toEqual([
      { family: "fable", name: "Fable", percent: 34, resetsAt: at(FABLE_RESET), spent: false },
      { family: "opus", name: "Opus", percent: 100, resetsAt: at(FABLE_RESET), spent: true },
    ]);
    expect(usageForModel(reading, "claude-opus-5-5").exhausted).toBe(true);
    expect(usageForModel(reading, "claude-fable-5-1").exhausted).toBe(false);
  });

  it("takes the spent one of two weeks Anthropic gives for one model", () => {
    const reading = parseAnthropicUsage({ ...LIVE, limits: [LIVE.limits[0], { ...LIVE.limits[1], percent: 20, is_active: true }, { ...LIVE.limits[1], percent: 100, is_active: true }] });
    expect(usageForModel(reading, "claude-fable-5-1")).toMatchObject({ exhausted: true, week: { percent: 100 } });
  });

  it("still reads an answer of the old shape exactly as before", () => {
    const old = parseAnthropicUsage({ five_hour: { utilization: 40, resets_at: "2026-10-14T18:10:00Z" }, seven_day: { utilization: 70, resets_at: "2026-10-19T09:00:00Z" } });
    expect(old).toMatchObject({ exhausted: false, utilization: { fiveHour: 40, sevenDay: 70 }, models: [], extraUsage: null });
    expect(usageForModel(old, "claude-opus-5-5").fullness).toBe(70);
  });
});
