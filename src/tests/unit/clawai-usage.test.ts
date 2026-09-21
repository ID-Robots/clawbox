/**
 * The ClawBox AI usage payload as the card reads it (src/lib/clawai-usage.ts).
 *
 * Fixtures follow the portal's own answer: `weekly`/`burst` rolling windows,
 * `meters` for images/speechSeconds/audioSeconds/embeddingsTokens, `credits`
 * in cents — beside the fields every portal has sent (`percentUsed`,
 * `resetIn`, `isOverLimit`, `tier`, `tierDisplayName`, `buckets`).
 */
import { describe, expect, it } from "vitest";
import {
  durationUntil,
  formatCredits,
  formatUsageCount,
  formatUsageMinutes,
  normalizeClawaiUsage,
  offersYearlyBilling,
} from "@/lib/clawai-usage";

const NOW = Date.parse("2026-09-17T09:00:00.000Z");
const IN_THREE_DAYS = "2026-09-20T09:00:00.000Z";

function win(used: number, limit: number, resetAt = IN_THREE_DAYS) {
  return { used, limit, remaining: limit - used, percentUsed: Math.round((used / limit) * 100), isOverLimit: used >= limit, resetAt };
}

const WEEKLY_BODY = {
  percentUsed: 24,
  resetIn: "3d 0h",
  isOverLimit: false,
  tier: "pro",
  tierDisplayName: "Pro",
  buckets: { flash: { used: 1, limit: 2, requests: 1, costUsd: 0, percentUsed: 50, isOverLimit: false } },
  weekly: win(1_200_000, 5_000_000),
  burst: win(300_000, 1_250_000, "2026-09-17T11:00:00.000Z"),
  meters: {
    images: { ...win(4, 40), period: "week" },
    audioSeconds: { ...win(0, 1800), period: "week" },
    speechSeconds: { ...win(610, 3600), period: "week" },
    embeddingsTokens: { ...win(250_000, 2_000_000), period: "week", unavailable: true },
  },
  credits: {
    balanceCents: 1250,
    usedThisWeekCents: 120,
    usedThisWeekByDimension: { chat: 120 },
    canBuy: true,
  },
  boostMultiplier: 1,
};

describe("normalizeClawaiUsage", () => {
  it("reads a portal with rolling allowances as the weekly shape", () => {
    const usage = normalizeClawaiUsage(WEEKLY_BODY, NOW);
    expect(usage?.shape).toBe("weekly");
    if (usage?.shape !== "weekly") throw new Error("shape");
    expect(usage.plan).toBe("pro");
    expect(usage.tierDisplayName).toBe("Pro");
    expect(usage.weekly).toEqual({
      used: 1_200_000, limit: 5_000_000, percentUsed: 24, isOverLimit: false, resetAt: IN_THREE_DAYS, unavailable: false,
    });
    expect(usage.burst?.resetAt).toBe("2026-09-17T11:00:00.000Z");
    expect(Object.keys(usage.meters)).toEqual(["images", "speechSeconds", "audioSeconds", "embeddingsTokens"]);
    // Unreadable is carried as unreadable, never as an empty window.
    expect(usage.meters.embeddingsTokens?.unavailable).toBe(true);
    expect(usage.credits).toEqual({ balanceCents: 1250, usedThisWeekCents: 120, canBuy: true, currency: "EUR", unavailable: false });
    expect(usage.billingInterval).toBeNull();
    // The old fields travel with it, as the portal sent them.
    expect(usage.legacy).toEqual({
      percentUsed: 24, resetIn: "3d 0h", isOverLimit: false, tier: "pro", tierDisplayName: "Pro", buckets: WEEKLY_BODY.buckets,
    });
  });

  it("derives the old fields from the weekly pool when a newer portal leaves them out", () => {
    const rest: Record<string, unknown> = { ...WEEKLY_BODY, weekly: win(5_000_000, 5_000_000) };
    delete rest.percentUsed;
    delete rest.resetIn;
    delete rest.isOverLimit;
    const usage = normalizeClawaiUsage(rest, NOW);
    expect(usage?.legacy).toMatchObject({ percentUsed: 100, resetIn: "3d 0h", isOverLimit: true, tier: "pro" });
  });

  it("reads an older portal's answer as the legacy shape, untouched", () => {
    const body = { percentUsed: 37, resetIn: "4h 30m", isOverLimit: false, tier: "free", tierDisplayName: "Free", buckets: { flash: {} } };
    expect(normalizeClawaiUsage(body, NOW)).toEqual({
      shape: "legacy",
      plan: "free",
      tierDisplayName: "Free",
      legacy: { percentUsed: 37, resetIn: "4h 30m", isOverLimit: false, tier: "free", tierDisplayName: "Free", buckets: { flash: {} } },
    });
  });

  it("refuses what is not a usage payload", () => {
    for (const body of [null, "<html>", [], {}, { error: { code: "invalid_token" } }]) {
      expect(normalizeClawaiUsage(body, NOW), JSON.stringify(body)).toBeNull();
    }
  });

  it("keeps hostile numbers inside the bar", () => {
    const usage = normalizeClawaiUsage({ ...WEEKLY_BODY, weekly: { used: -5, limit: "lots", percentUsed: 250, resetAt: "never" } }, NOW);
    if (usage?.shape !== "weekly") throw new Error("shape");
    expect(usage.weekly).toEqual({ used: 0, limit: 0, percentUsed: 100, isOverLimit: false, resetAt: null, unavailable: false });
  });

  it("honours a currency and a billing interval the portal names", () => {
    const usage = normalizeClawaiUsage({ ...WEEKLY_BODY, billingInterval: "year", credits: { ...WEEKLY_BODY.credits, currency: "usd" } }, NOW);
    if (usage?.shape !== "weekly") throw new Error("shape");
    expect(usage.credits?.currency).toBe("USD");
    expect(usage.billingInterval).toBe("year");
  });
});

describe("offersYearlyBilling", () => {
  it("is for a paid plan not already billed yearly", () => {
    const monthly = normalizeClawaiUsage(WEEKLY_BODY, NOW)!;
    expect(offersYearlyBilling(monthly)).toBe(true);
    expect(offersYearlyBilling(normalizeClawaiUsage({ ...WEEKLY_BODY, billingInterval: "year" }, NOW)!)).toBe(false);
    expect(offersYearlyBilling(normalizeClawaiUsage({ ...WEEKLY_BODY, tier: "free" }, NOW)!)).toBe(false);
    expect(offersYearlyBilling(normalizeClawaiUsage({ percentUsed: 1, tier: "pro" }, NOW)!)).toBe(false);
  });
});

describe("formatting", () => {
  it("shortens counts in the owner's language", () => {
    expect(formatUsageCount(1_200_000, "en")).toBe("1.2M");
    expect(formatUsageCount(950, "en")).toBe("950");
    expect(formatUsageCount(-3, "en")).toBe("0");
  });

  it("rounds used minutes up and limit minutes down", () => {
    expect(formatUsageMinutes(10, "en", "up")).toBe("1");
    expect(formatUsageMinutes(3599, "en", "down")).toBe("59");
  });

  it("writes cents as money", () => {
    expect(formatCredits(1250, "EUR", "en")).toBe("€12.50");
    expect(formatCredits(1250, "EUR", "de")).toMatch(/^12,50\s€$/);
    // A currency code Intl refuses falls back to euros rather than throwing.
    expect(formatCredits(100, "E!!", "en")).toBe("€1.00");
  });

  it("words a remaining duration the way the portal's resetIn does", () => {
    expect(durationUntil("2026-09-17T13:30:00.000Z", NOW)).toBe("4h 30m");
    expect(durationUntil("2026-09-17T09:45:00.000Z", NOW)).toBe("45m");
    expect(durationUntil("2026-09-19T12:00:00.000Z", NOW)).toBe("2d 3h");
    expect(durationUntil(null, NOW)).toBeNull();
  });
});
