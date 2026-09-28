import { describe, expect, it } from "vitest";
import {
  classifyAnthropicFailure,
  DEFAULT_LIMIT_MS,
  detectAnthropicAuthFailure,
  detectAnthropicLimit,
  effectiveStatus,
  formatResetClock,
  limitUntil,
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
