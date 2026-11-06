import { describe, expect, it } from "vitest";
import {
  classifyAnthropicFailure,
  DEFAULT_LIMIT_MS,
  detectAnthropicAuthFailure,
  detectAnthropicLimit,
  detectAnthropicLimitNotice,
  effectiveStatus,
  formatResetClock,
  isUsableFor,
  limitUntil,
  modelFamily,
  modelLimitedUntil,
  nextResetFor,
  parseLimitReset,
  pickAccount,
  pickForSpawn,
  poolHealth,
  resolveActiveAccount,
  type PoolMember,
} from "@/lib/anthropic-limit";

// 2026-09-18 22:27 in Sofia (UTC+3 in September) — the moment the queue died.
const SOFIA = "Europe/Sofia";
const AT_2227_SOFIA = Date.UTC(2026, 8, 18, 19, 27);

describe("detectAnthropicLimit", () => {
  it("recognises the line the overnight queue died on, and reads its reset in the box's zone", () => {
    const limit = detectAnthropicLimit("You've hit your session limit · resets 10:50pm", AT_2227_SOFIA, SOFIA);
    expect(limit).toEqual({ kind: "session", resetsAt: Date.UTC(2026, 8, 18, 19, 50) });
  });

  it.each([
    ["Claude AI usage limit reached|1790000000", "session"],
    ["Claude AI usage limit reached. Your limit will reset at 5pm (Europe/Sofia).", "session"],
    ["5-hour limit reached ∙ resets 3pm", "session"],
    ["Session limit reached ∙ resets 10:50pm", "session"],
    ["You’ve hit your session limit · resets 11pm", "session"],
    ["Weekly limit reached ∙ resets Oct 9, 10am", "weekly"],
    ["You've hit your weekly limit · resets Mon 9am", "weekly"],
    ["Opus weekly limit reached ∙ resets Oct 9 at 10am", "weekly"],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', "rate"],
    ["Credit balance is too low", "credit"],
  ])("recognises %j as a %s limit", (line, kind) => {
    expect(detectAnthropicLimit(line, AT_2227_SOFIA, SOFIA)?.kind).toBe(kind);
  });

  it.each([
    "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
    "API Error: 529 Overloaded",
    "Stopped after 80 steps without finishing.",
    "Claude Code exited with code 1 before reporting a result.",
    "",
  ])("does not mistake %j for a limit", (line) => {
    expect(detectAnthropicLimit(line, AT_2227_SOFIA, SOFIA)).toBeNull();
  });

  it("reads only the head of a failure, so a run that QUOTES a limit deep in its own words is not bounced", () => {
    const prose = `${"I refactored the pool and wrote the tests. ".repeat(12)}The fixture uses "You've hit your session limit · resets 10:50pm".`;
    expect(detectAnthropicLimit(prose, AT_2227_SOFIA, SOFIA)).toBeNull();
  });

  it("is null for anything that is not text", () => {
    expect(detectAnthropicLimit(null, AT_2227_SOFIA)).toBeNull();
    expect(detectAnthropicLimit(undefined, AT_2227_SOFIA)).toBeNull();
  });
});

describe("parseLimitReset", () => {
  it("rolls a clock time that has already passed today to tomorrow", () => {
    const at2310 = Date.UTC(2026, 8, 18, 20, 10); // 23:10 Sofia
    expect(parseLimitReset("resets 10:50pm", at2310, SOFIA)).toBe(Date.UTC(2026, 8, 19, 19, 50));
  });

  it("honours a zone the message names over the box's own", () => {
    // 5pm in New York (UTC-4 in September) is 21:00 UTC.
    expect(parseLimitReset("resets 5pm (America/New_York)", Date.UTC(2026, 8, 18, 12, 0), SOFIA)).toBe(Date.UTC(2026, 8, 18, 21, 0));
  });

  it("falls back to the box's zone when the named zone is not a real one", () => {
    expect(parseLimitReset("resets 10:50pm (Mars/Olympus)", AT_2227_SOFIA, SOFIA)).toBe(Date.UTC(2026, 8, 18, 19, 50));
  });

  it("reads 24-hour clocks, noon and midnight", () => {
    expect(parseLimitReset("resets 22:50", AT_2227_SOFIA, SOFIA)).toBe(Date.UTC(2026, 8, 18, 19, 50));
    expect(parseLimitReset("resets 12pm", AT_2227_SOFIA, SOFIA)).toBe(Date.UTC(2026, 8, 19, 9, 0));
    expect(parseLimitReset("resets 12am", AT_2227_SOFIA, SOFIA)).toBe(Date.UTC(2026, 8, 18, 21, 0));
  });

  it("reads a month and day, and a date already past this year as next year's", () => {
    expect(parseLimitReset("resets Sep 20, 10am", AT_2227_SOFIA, SOFIA)).toBe(Date.UTC(2026, 8, 20, 7, 0));
    expect(parseLimitReset("resets Sep 20 at 10am", AT_2227_SOFIA, SOFIA)).toBe(Date.UTC(2026, 8, 20, 7, 0));
    const dec30 = Date.UTC(2026, 11, 30, 10, 0);
    expect(parseLimitReset("resets Jan 2, 9am", dec30, "UTC")).toBe(Date.UTC(2027, 0, 2, 9, 0));
  });

  it("reads a weekday as the next such day", () => {
    // 2026-09-18 is a Friday; "Mon 9am" is 2026-09-21 09:00 Sofia.
    expect(parseLimitReset("resets Mon 9am", AT_2227_SOFIA, SOFIA)).toBe(Date.UTC(2026, 8, 21, 6, 0));
  });

  it("reads the epoch the older CLI put after a pipe", () => {
    const now = Date.UTC(2026, 8, 18, 19, 27);
    const at = Math.floor((now + 23 * 60_000) / 1000);
    expect(parseLimitReset(`Claude AI usage limit reached|${at}`, now)).toBe(at * 1000);
  });

  it("refuses a reset that is past, absurdly far, or not a clock at all", () => {
    expect(parseLimitReset("Claude AI usage limit reached|1000000000", AT_2227_SOFIA)).toBeNull();
    expect(parseLimitReset("resets 3", AT_2227_SOFIA, SOFIA)).toBeNull();
    expect(parseLimitReset("resets 25:00", AT_2227_SOFIA, SOFIA)).toBeNull();
    expect(parseLimitReset("no time here", AT_2227_SOFIA, SOFIA)).toBeNull();
  });

  it("uses the default window when the message said nothing about time", () => {
    const limit = detectAnthropicLimit("Claude AI usage limit reached", AT_2227_SOFIA, SOFIA);
    expect(limit).toEqual({ kind: "session", resetsAt: null });
    expect(limitUntil(limit, AT_2227_SOFIA)).toBe(AT_2227_SOFIA + DEFAULT_LIMIT_MS);
    expect(DEFAULT_LIMIT_MS).toBe(5 * 60 * 60_000);
  });
});

describe("rotation", () => {
  const NOW = 1_000_000;
  const ok = (id: string): PoolMember => ({ id, status: "ok", limitedUntil: null });
  const limited = (id: string, until: number): PoolMember => ({ id, status: "limited", limitedUntil: until });

  it("picks the first usable account in priority order", () => {
    expect(pickAccount([ok("a"), ok("b")], NOW)?.id).toBe("a");
    expect(pickAccount([limited("a", NOW + 1), ok("b"), ok("c")], NOW)?.id).toBe("b");
  });

  it("returns to the preferred account by itself once its limit is over", () => {
    const pool = [limited("a", NOW + 60_000), ok("b")];
    expect(pickAccount(pool, NOW)?.id).toBe("b");
    expect(pickAccount(pool, NOW + 60_000)?.id).toBe("a");
    expect(effectiveStatus(pool[0], NOW + 60_000)).toBe("ok");
  });

  it("never hands back the account that has just refused", () => {
    expect(pickAccount([ok("a"), ok("b")], NOW, new Set(["a"]))?.id).toBe("b");
    expect(pickAccount([ok("a")], NOW, new Set(["a"]))).toBeNull();
  });

  it("skips accounts that need the owner", () => {
    const pool: PoolMember[] = [{ id: "a", status: "revoked", limitedUntil: null }, { id: "b", status: "expired", limitedUntil: null }, ok("c")];
    expect(pickAccount(pool, NOW)?.id).toBe("c");
  });

  it("reports all limited, and the earliest reset, when nobody can answer", () => {
    const pool = [limited("a", NOW + 5_000), limited("b", NOW + 2_000), { id: "c", status: "revoked" as const, limitedUntil: null }];
    expect(poolHealth(pool, NOW)).toEqual({ total: 3, healthy: 0, limited: 2, needsAttention: 1, allLimited: true, nextResetAt: NOW + 2_000 });
    expect(pickAccount(pool, NOW)).toBeNull();
  });

  it("is not 'all limited' with one healthy account, nor with no accounts at all", () => {
    expect(poolHealth([limited("a", NOW + 1), ok("b")], NOW).allLimited).toBe(false);
    expect(poolHealth([], NOW).allLimited).toBe(false);
  });

  it("says a reset time as a 24-hour clock in the box's zone", () => {
    expect(formatResetClock(Date.UTC(2026, 8, 18, 19, 50), SOFIA)).toBe("22:50");
  });
});

// ── TASK-1260: a refused credential, and the one active account ─────────────

describe("detectAnthropicAuthFailure", () => {
  it.each([
    "Invalid API key · Please run /login",
    "OAuth token revoked · Please run /login",
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    "OAuth token has been revoked",
    // Field wordings (TASK-1235, TASK-1271): bare, with no JSON around them and no "/login".
    "OAuth access token has been revoked",
    "Your organization has disabled Claude subscription access for Claude Code",
  ])("recognises %j as Anthropic refusing the credential", (text) => {
    expect(detectAnthropicAuthFailure(text)).toBe(true);
  });

  it.each([
    "You've hit your session limit · resets 10:50pm",
    // A package registry's 401 is the run's business, not the account's.
    "npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/private-pkg",
    "The build failed.",
    "",
  ])("does not take %j for a refused Anthropic credential", (text) => {
    expect(detectAnthropicAuthFailure(text)).toBe(false);
  });

  it("reads only the head, like the limit parser: a run writing ABOUT 401s is not refused", () => {
    expect(detectAnthropicAuthFailure(`${"I added a retry around the login flow. ".repeat(15)}Fixture: Invalid API key · Please run /login`)).toBe(false);
  });
});

describe("classifyAnthropicFailure", () => {
  it("prefers the limit when a line reads as both", () => {
    expect(classifyAnthropicFailure("You've hit your weekly limit · resets Mon 9am — please run /login to switch", AT_2227_SOFIA, { timeZone: SOFIA }))
      .toMatchObject({ type: "limit", limit: { kind: "weekly" } });
  });

  it("answers auth for a refused credential and null for anything else", () => {
    expect(classifyAnthropicFailure("Invalid API key · Please run /login", AT_2227_SOFIA)).toEqual({ type: "auth" });
    expect(classifyAnthropicFailure("The agent run failed before producing a reply.", AT_2227_SOFIA)).toBeNull();
  });

  it("answers an account its organisation has switched off as refused for good, and a revoked token as one to ask about", () => {
    // The token behind it renews perfectly well, so asking Anthropic about the
    // credential would keep the account in; it cannot serve until the owner acts.
    expect(classifyAnthropicFailure("Your organization has disabled Claude subscription access for Claude Code", AT_2227_SOFIA))
      .toEqual({ type: "auth", permanent: true });
    expect(classifyAnthropicFailure('API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Your organization has disabled Claude subscription access for Claude Code"}}', AT_2227_SOFIA))
      .toEqual({ type: "auth", permanent: true });
    expect(classifyAnthropicFailure("OAuth access token has been revoked", AT_2227_SOFIA)).toEqual({ type: "auth" });
  });

  it("takes the gateway's failover reason when its own copy carries no provider words", () => {
    expect(classifyAnthropicFailure("⚠️ API rate limit reached. Please try again later.", AT_2227_SOFIA, { reason: "rate_limit" }))
      .toEqual({ type: "limit", limit: { kind: "rate", resetsAt: null } });
    expect(classifyAnthropicFailure("Your credit is exhausted", AT_2227_SOFIA, { reason: "billing" }))
      .toEqual({ type: "limit", limit: { kind: "credit", resetsAt: null } });
    expect(classifyAnthropicFailure("The provider refused the request.", AT_2227_SOFIA, { reason: "auth" })).toEqual({ type: "auth" });
  });

  it("never takes Anthropic's OVERLOAD for the account's cap, whatever the reason says", () => {
    expect(classifyAnthropicFailure('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', AT_2227_SOFIA, { reason: "rate_limit" })).toBeNull();
  });

  it("ignores a reason that says nothing about the account", () => {
    expect(classifyAnthropicFailure("timed out", AT_2227_SOFIA, { reason: "timeout" })).toBeNull();
  });
});

describe("the active account", () => {
  const NOW_A = Date.UTC(2026, 8, 18, 12, 0);
  const ok = (id: string): PoolMember => ({ id, status: "ok", limitedUntil: null });
  const limited = (id: string, until: number): PoolMember => ({ id, status: "limited", limitedUntil: until });

  it("stays on the active account while it can answer, even when an earlier one is back (sticky)", () => {
    const pool = [ok("a"), ok("b"), ok("c")];
    expect(resolveActiveAccount(pool, "b", NOW_A)?.id).toBe("b");
  });

  it("moves to the first usable account in order when the active one cannot answer", () => {
    expect(resolveActiveAccount([limited("a", NOW_A + 60_000), limited("b", NOW_A + 60_000), ok("c")], "b", NOW_A)?.id).toBe("c");
    expect(resolveActiveAccount([ok("a"), limited("b", NOW_A + 60_000), ok("c")], "b", NOW_A)?.id).toBe("a");
  });

  it("goes back to the first usable account with returnToPrimary, and after the owner's reorder", () => {
    const pool = [ok("a"), ok("b")];
    expect(resolveActiveAccount(pool, "b", NOW_A, { returnToPrimary: true })?.id).toBe("a");
    expect(resolveActiveAccount(pool, "b", NOW_A, { reselect: true })?.id).toBe("a");
  });

  it("answers null when no account can answer, and the first one back once its limit is over", () => {
    const pool = [limited("a", NOW_A + 10_000), limited("b", NOW_A + 5_000)];
    expect(resolveActiveAccount(pool, "a", NOW_A)).toBeNull();
    expect(resolveActiveAccount(pool, null, NOW_A + 6_000)?.id).toBe("b");
  });

  it("hands a spawn the active account, and another usable one when the caller excludes it", () => {
    const pool = [ok("a"), ok("b"), ok("c")];
    expect(pickForSpawn(pool, "b", NOW_A)?.id).toBe("b");
    expect(pickForSpawn(pool, "b", NOW_A, new Set(["b"]))?.id).toBe("a");
    expect(pickForSpawn(pool, null, NOW_A)?.id).toBe("a");
  });
});

describe("the owner's pick: their order, or the most room", () => {
  const NOW_P = Date.UTC(2026, 9, 21, 12, 0);
  const of = (id: string, kind: string, status: PoolMember["status"] = "ok"): PoolMember => ({ id, status, limitedUntil: status === "limited" ? NOW_P + 60_000 : null, kind });
  const room = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it("is exactly the owner's order with no mode set — an API key the owner put first stays first, whatever the readings", () => {
    const pool = [of("key", "api_key"), of("a", "oauth"), of("b", "oauth")];
    const full = room({ a: 90, b: 10 });
    expect(pickAccount(pool, NOW_P)?.id).toBe("key");
    expect(pickAccount(pool, NOW_P, new Set(), { fullness: full })?.id).toBe("key");
    expect(pickAccount(pool, NOW_P, new Set(), { mode: "order", fullness: full })?.id).toBe("key");
    expect(pickAccount(pool, NOW_P, new Set(["key"]), { fullness: full })?.id).toBe("a");
    expect(resolveActiveAccount(pool, null, NOW_P, { fullness: full })?.id).toBe("key");
    expect(pickForSpawn(pool, "key", NOW_P, new Set(["key"]), { fullness: full })?.id).toBe("a");
  });

  it("takes the subscription whose fullest window has the most room, the owner's order breaking a tie", () => {
    const pool = [of("a", "oauth"), of("b", "oauth"), of("c", "oauth")];
    expect(pickAccount(pool, NOW_P, new Set(), { mode: "most-room", fullness: room({ a: 80, b: 35, c: 60 }) })?.id).toBe("b");
    expect(pickAccount(pool, NOW_P, new Set(), { mode: "most-room", fullness: room({ a: 40, b: 40, c: 60 }) })?.id).toBe("a");
    // A limited account is no candidate, however empty its reading.
    expect(pickAccount([of("a", "oauth", "limited"), ...pool.slice(1)], NOW_P, new Set(), { mode: "most-room", fullness: room({ a: 0, b: 70, c: 60 }) })?.id).toBe("c");
  });

  it("never puts an API key ahead of a subscription, and takes an account with no reading after those with one, in the owner's order", () => {
    const pool = [of("key", "api_key"), of("login", "login"), of("a", "oauth"), of("b", "oauth")];
    expect(pickAccount(pool, NOW_P, new Set(), { mode: "most-room", fullness: room({ b: 99 }) })?.id).toBe("b");
    expect(pickAccount(pool, NOW_P, new Set(), { mode: "most-room" })?.id).toBe("login");
    expect(pickAccount(pool, NOW_P, new Set(["login", "a", "b"]), { mode: "most-room" })?.id).toBe("key");
  });

  it("takes an account Anthropic reports spent after every subscription it knows nothing about, and still ahead of an API key", () => {
    const pool = [of("key", "api_key"), of("a", "oauth"), of("b", "oauth"), of("login", "login")];
    expect(pickAccount(pool, NOW_P, new Set(), { mode: "most-room", fullness: room({ a: 100, b: 40 }) })?.id).toBe("b");
    expect(pickAccount(pool, NOW_P, new Set(["b"]), { mode: "most-room", fullness: room({ a: 100, b: 40 }) })?.id).toBe("login");
    expect(pickAccount(pool, NOW_P, new Set(["b", "login"]), { mode: "most-room", fullness: room({ a: 100, b: 40 }) })?.id).toBe("a");
    expect(pickAccount(pool, NOW_P, new Set(["a", "b", "login"]), { mode: "most-room", fullness: room({ a: 100, b: 40 }) })?.id).toBe("key");
  });

  it("stays sticky: the most room decides only when the active account has to move, and the owner's reorder means the account they put first", () => {
    const pool = [of("a", "oauth"), of("b", "oauth"), of("c", "oauth")];
    const opts = { mode: "most-room" as const, fullness: room({ a: 90, b: 50, c: 5 }) };
    expect(resolveActiveAccount(pool, "a", NOW_P, opts)?.id).toBe("a");
    expect(resolveActiveAccount([of("a", "oauth", "limited"), pool[1], pool[2]], "a", NOW_P, opts)?.id).toBe("c");
    expect(resolveActiveAccount(pool, "b", NOW_P, { ...opts, reselect: true })?.id).toBe("a");
    expect(resolveActiveAccount(pool, "b", NOW_P, { ...opts, returnToPrimary: true })?.id).toBe("a");
    expect(pickForSpawn(pool, "a", NOW_P, new Set(), opts)?.id).toBe("a");
    expect(pickForSpawn(pool, "a", NOW_P, new Set(["a"]), opts)?.id).toBe("c");
  });
});

describe("a bare rate limit from something that does not retry it (TASK-1260 review)", () => {
  it("is a throttle, not yet a limit, when neither the words nor the reason give a reset time", () => {
    expect(classifyAnthropicFailure('HTTP 429: {"type":"error","error":{"type":"rate_limit_error"}}', AT_2227_SOFIA, { transientRate: true }))
      .toEqual({ type: "throttled" });
    expect(classifyAnthropicFailure("⚠️ API rate limit reached.", AT_2227_SOFIA, { reason: "rate_limit", transientRate: true }))
      .toEqual({ type: "throttled" });
  });

  it("stays a limit when the words say it is the account's cap, or give the time it lifts", () => {
    expect(classifyAnthropicFailure("429 rate_limit_error: You've hit your weekly limit · resets Mon 9am", AT_2227_SOFIA, { timeZone: SOFIA, transientRate: true }))
      .toMatchObject({ type: "limit", limit: { kind: "weekly" } });
    expect(classifyAnthropicFailure("rate limited, resets 10:50pm", AT_2227_SOFIA, { timeZone: SOFIA, reason: "rate_limit", transientRate: true }))
      .toMatchObject({ type: "limit", limit: { kind: "rate", resetsAt: Date.UTC(2026, 8, 18, 19, 50) } });
  });

  it("is still a limit for Claude Code, which has already backed off and retried it", () => {
    expect(classifyAnthropicFailure('HTTP 429: {"type":"error","error":{"type":"rate_limit_error"}}', AT_2227_SOFIA))
      .toEqual({ type: "limit", limit: { kind: "rate", resetsAt: null } });
  });
});

/**
 * The CLI's words of the usage scheme of 2026-11 (CLI 2.1.317, TASK-2141):
 * a full window it CARRIES ON past is no stop; the monthly spend limit is a
 * kind of its own; a model's own week caps only runs on that model.
 */
describe("the CLI's limit words of 2026-11", () => {
  it.each([
    ["Usage limit reached · continuing automatically", "continuing"],
    ["Usage limit reached again · continuing automatically", "continuing"],
    ["Usage limit reached — grace window active", "grace"],
  ] as const)("does not take %j for a stop", (line, notice) => {
    expect(detectAnthropicLimit(line, AT_2227_SOFIA, SOFIA)).toBeNull();
    expect(detectAnthropicLimitNotice(line)).toBe(notice);
    // Not even with the rate-limit reason a gateway files it under.
    expect(classifyAnthropicFailure(line, AT_2227_SOFIA, { timeZone: SOFIA, reason: "rate_limit" })).toBeNull();
    expect(classifyAnthropicFailure(line, AT_2227_SOFIA, { timeZone: SOFIA })).toBeNull();
  });

  it("still stops on a real limit that follows a carrying-on line", () => {
    const text = "Usage limit reached · continuing automatically\nYou've hit your limit · resets 10:50pm";
    expect(detectAnthropicLimitNotice(text)).toBeNull();
    expect(detectAnthropicLimit(text, AT_2227_SOFIA, SOFIA)).toEqual({ kind: "session", resetsAt: Date.UTC(2026, 8, 18, 19, 50) });
  });

  it("reads \"You've hit your monthly spend limit\" as a limit of its own kind", () => {
    expect(detectAnthropicLimit("You've hit your monthly spend limit", AT_2227_SOFIA, SOFIA)).toEqual({ kind: "spend", resetsAt: null });
    expect(classifyAnthropicFailure("You’ve hit your monthly spend limit · resets Dec 1, 12am", AT_2227_SOFIA, { timeZone: SOFIA }))
      .toMatchObject({ type: "limit", limit: { kind: "spend" } });
  });

  it("reads the bare \"You've hit your limit\" as a stop with no time, for Anthropic's answer to date", () => {
    expect(detectAnthropicLimit("You've hit your limit", AT_2227_SOFIA, SOFIA)).toEqual({ kind: "session", resetsAt: null });
  });

  it.each([
    ["Opus weekly limit reached ∙ resets Oct 9 at 10am", "opus"],
    ["You've hit your Fable limit · resets Mon 9am", "fable"],
    ["You’ve hit your Fable weekly limit", "fable"],
    ["Sonnet limit reached ∙ resets 3pm", "sonnet"],
  ])("reads %j as the %s week only", (line, family) => {
    expect(detectAnthropicLimit(line, AT_2227_SOFIA, SOFIA)).toMatchObject({ kind: "weekly", model: family });
  });

  it.each([
    "You've hit your weekly limit · resets Mon 9am",
    "You've hit your session limit · resets 10:50pm",
    "Weekly limit reached ∙ resets Oct 9, 10am",
    "5-hour limit reached ∙ resets 3pm",
    "Claude AI usage limit reached|1790000000",
  ])("keeps %j the account's own window", (line) => {
    expect(detectAnthropicLimit(line, AT_2227_SOFIA, SOFIA)?.model).toBeUndefined();
  });

  it.each(["Context limit reached", "Output token limit reached for this turn", "Step limit reached"])("does not take %j for any usage limit", (line) => {
    expect(detectAnthropicLimit(line, AT_2227_SOFIA, SOFIA)).toBeNull();
  });

  it("takes a plan's name for no model: \"You've hit your Max limit\" is the account's stop, for Anthropic's answer to place", () => {
    expect(detectAnthropicLimit("You've hit your Max limit · resets Mon 9am", AT_2227_SOFIA, SOFIA)).toMatchObject({ kind: "session" });
    expect(detectAnthropicLimit("You've hit your Max limit · resets Mon 9am", AT_2227_SOFIA, SOFIA)?.model).toBeUndefined();
  });

  it("reads \"reached\" as it reads \"hit\"", () => {
    expect(detectAnthropicLimit("You've reached your weekly limit · resets Mon 9am", AT_2227_SOFIA, SOFIA)?.kind).toBe("weekly");
    expect(detectAnthropicLimit("You've reached your Opus limit", AT_2227_SOFIA, SOFIA)).toMatchObject({ kind: "weekly", model: "opus" });
  });

  it("keeps a real stop that shares its line with a carrying-on notice", () => {
    const merged = "Usage limit reached · continuing automatically You've hit your limit · resets 10:50pm";
    expect(detectAnthropicLimitNotice(merged)).toBeNull();
    expect(detectAnthropicLimit(merged, AT_2227_SOFIA, SOFIA)).toEqual({ kind: "session", resetsAt: Date.UTC(2026, 8, 18, 19, 50) });
  });
});

describe("modelFamily", () => {
  it.each([
    ["claude-fable-5-1", "fable"],
    ["claude-opus-5-5", "opus"],
    ["claude-sonnet-5-5", "sonnet"],
    ["claude-3-5-sonnet-20241022", "sonnet"],
    ["opus[1m]", "opus"],
    ["Fable", "fable"],
    ["Claude Opus 4.1", "opus"],
    ["claude-haiku-5-5", "haiku"],
    ["openrouter/anthropic/claude-haiku-4.5", "haiku"],
    ["global.anthropic.claude-newname-6-0", "newname"],
  ])("%s is %s", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it("is null for nothing to go on", () => {
    expect(modelFamily(null)).toBeNull();
    expect(modelFamily("")).toBeNull();
    expect(modelFamily("claude")).toBeNull();
  });
});

describe("a model's own week on the pool (TASK-2141)", () => {
  const NOW = Date.UTC(2026, 10, 3, 12, 0);
  const H = 3_600_000;
  const fableSpent = (id: string, kind = "oauth"): PoolMember => ({ id, status: "ok", limitedUntil: null, kind, modelLimits: [{ family: "fable", name: "Fable", until: NOW + 30 * H }] });
  const ok = (id: string, kind = "oauth"): PoolMember => ({ id, status: "ok", limitedUntil: null, kind });

  it("keeps a run on THAT model off the account, and every other run on it", () => {
    const a = fableSpent("a");
    expect(modelLimitedUntil(a, "claude-fable-5-1", NOW)).toBe(NOW + 30 * H);
    expect(isUsableFor(a, NOW, "claude-fable-5-1")).toBe(false);
    expect(isUsableFor(a, NOW, "claude-opus-5-5")).toBe(true);
    expect(isUsableFor(a, NOW, null)).toBe(true);
    // The account itself is not limited: it is healthy, the active account stays.
    expect(effectiveStatus(a, NOW)).toBe("ok");
    expect(poolHealth([a], NOW)).toMatchObject({ healthy: 1, limited: 0, allLimited: false });
    expect(resolveActiveAccount([a, ok("b")], "a", NOW)?.id).toBe("a");
  });

  it("gives the account to runs on other models and the next one to runs on the spent model", () => {
    const accounts = [fableSpent("a"), ok("b")];
    expect(pickForSpawn(accounts, "a", NOW, new Set(), { model: "claude-opus-5-5" })?.id).toBe("a");
    expect(pickForSpawn(accounts, "a", NOW, new Set(), { model: "claude-fable-5-1" })?.id).toBe("b");
    expect(pickAccount(accounts, NOW, new Set(), { model: "claude-fable-5-1" })?.id).toBe("b");
    expect(pickAccount([fableSpent("a"), fableSpent("b")], NOW, new Set(), { model: "fable" })).toBeNull();
  });

  it("says when the first account is back for a run on that model", () => {
    const limited: PoolMember = { id: "c", status: "limited", limitedUntil: NOW + 2 * H, kind: "oauth" };
    expect(nextResetFor([fableSpent("a"), limited], NOW, "claude-fable-5-1")).toBe(NOW + 2 * H);
    expect(nextResetFor([fableSpent("a"), fableSpent("b")], NOW, "claude-fable-5-1")).toBe(NOW + 30 * H);
    // A run on another model waits for no model week.
    expect(nextResetFor([fableSpent("a"), fableSpent("b")], NOW, "claude-opus-5-5")).toBeNull();
    // An account limited AND past its model week is back for it only once both are over.
    const both: PoolMember = { ...fableSpent("d"), status: "limited", limitedUntil: NOW + H };
    expect(nextResetFor([both], NOW, "claude-fable-5-1")).toBe(NOW + 30 * H);
    expect(nextResetFor([both], NOW, null)).toBe(NOW + H);
  });

  it("ends by itself at the week's reset", () => {
    const a = fableSpent("a");
    expect(isUsableFor(a, NOW + 31 * H, "claude-fable-5-1")).toBe(true);
    expect(modelLimitedUntil(a, "claude-fable-5-1", NOW + 31 * H)).toBeNull();
  });

  it("ranks \"most room\" by the fullness the caller read for that model — the week of 2026-11 with no five-hour window", () => {
    // A: account week 56 %, its Fable week 95 %; B: account week 70 %, Fable 20 %.
    const accounts = [ok("a"), ok("b")];
    const forFable = new Map([["a", 95], ["b", 70]]);
    const forOpus = new Map([["a", 56], ["b", 70]]);
    expect(pickAccount(accounts, NOW, new Set(), { mode: "most-room", fullness: forFable, model: "claude-fable-5-1" })?.id).toBe("b");
    expect(pickAccount(accounts, NOW, new Set(), { mode: "most-room", fullness: forOpus, model: "claude-opus-5-5" })?.id).toBe("a");
  });
});
