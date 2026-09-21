import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT_MS,
  detectAnthropicLimit,
  effectiveStatus,
  formatResetClock,
  limitUntil,
  parseLimitReset,
  pickAccount,
  poolHealth,
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
