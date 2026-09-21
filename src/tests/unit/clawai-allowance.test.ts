/**
 * Reading ClawBox AI's allowance refusals (src/lib/clawai-allowance.ts), and
 * saying when a rolling window frees up.
 *
 * The refusal reaches the box through several layers that each quote it their
 * own way — the proxy's JSON envelope, a harness's `API Error: 429 {…}`, a
 * gateway that kept only the sentence — so each of those shapes is pinned, and
 * so are the look-alikes that must NOT read as a spent allowance.
 */
import { describe, expect, it } from "vitest";
import { formatFreesUpAt, parseClawaiAllowanceRefusal } from "@/lib/clawai-allowance";

const RESET = "2026-09-19T14:05:00.000Z";

/** The proxy's 429 body for each window, as src/app/api/ai on the website writes it. */
function envelope(code: string, message: string, resetAt: string | null = RESET): string {
  return JSON.stringify({ error: { message, type: "usage_limit", code, ...(resetAt ? { resetAt } : {}) } });
}

describe("parseClawaiAllowanceRefusal", () => {
  it("names each of the three windows from the proxy's own code", () => {
    expect(parseClawaiAllowanceRefusal(envelope("weekly_limit_exceeded", "Weekly token allowance used up. Enough frees up in 2d 5h."))).toEqual({
      kind: "weekly",
      resetAt: RESET,
      message: "Weekly token allowance used up. Enough frees up in 2d 5h.",
    });
    expect(parseClawaiAllowanceRefusal(envelope("burst_limit_exceeded", "Short-term burst limit reached"))?.kind).toBe("burst");
    // The embeddings code contains the weekly one; it must not be read as it.
    expect(parseClawaiAllowanceRefusal(envelope("embeddings_weekly_limit_exceeded", "Memory indexing allowance used up."))?.kind).toBe("embeddings");
  });

  it("reads the refusal a coding harness prints around the envelope", () => {
    const raw = `API Error: 429 ${envelope("burst_limit_exceeded", "Short-term burst limit reached — that is a quarter of your weekly allowance in 5 hours.")}`;
    expect(parseClawaiAllowanceRefusal(raw)).toEqual({
      kind: "burst",
      resetAt: RESET,
      message: "Short-term burst limit reached — that is a quarter of your weekly allowance in 5 hours.",
    });
  });

  it("reads a refusal quoted inside another JSON string", () => {
    const nested = JSON.stringify({ errorMessage: `429 ${envelope("weekly_limit_exceeded", "Weekly token allowance used up.")}` });
    const refusal = parseClawaiAllowanceRefusal(nested);
    expect(refusal?.kind).toBe("weekly");
    expect(refusal?.resetAt).toBe(RESET);
  });

  it("recognises the proxy's sentence when a layer dropped the envelope", () => {
    expect(parseClawaiAllowanceRefusal("HTTP 429: Weekly token allowance used up. Enough frees up in 3h. Upgrade at https://clawbox.com/portal"))
      .toEqual({ kind: "weekly", resetAt: null, message: null });
    expect(parseClawaiAllowanceRefusal("Memory indexing allowance used up. Upgrade at https://clawbox.com/portal")?.kind).toBe("embeddings");
  });

  it("carries no reset instant it cannot read", () => {
    expect(parseClawaiAllowanceRefusal(envelope("weekly_limit_exceeded", "out", null))?.resetAt).toBeNull();
    expect(parseClawaiAllowanceRefusal('{"error":{"code":"weekly_limit_exceeded","resetAt":"soon"}}')?.resetAt).toBeNull();
  });

  it("leaves every other limit to the wording that already handles it", () => {
    for (const raw of [
      "API rate limit reached. Please try again later.",
      "429 Too Many Requests",
      envelope("rate_limit_exceeded", "Too many requests"),
      envelope("flash_limit_exceeded", "Daily limit reached"),
      "Request exceeds the size limit",
      "You have used up today's ClawBox AI pictures. The allowance resets at midnight UTC.",
      "",
    ]) {
      expect(parseClawaiAllowanceRefusal(raw), raw).toBeNull();
    }
    expect(parseClawaiAllowanceRefusal(undefined)).toBeNull();
    expect(parseClawaiAllowanceRefusal({ code: "weekly_limit_exceeded" })).toBeNull();
  });

  it("bounds the sentence it carries forward", () => {
    const refusal = parseClawaiAllowanceRefusal(envelope("weekly_limit_exceeded", "x".repeat(5000)));
    expect(refusal?.message).toHaveLength(300);
  });
});

describe("formatFreesUpAt", () => {
  const now = Date.parse("2026-09-17T09:00:00.000Z"); // a Thursday

  it("is the bare clock later the same day, in the zone it is given", () => {
    expect(formatFreesUpAt("2026-09-17T11:30:00.000Z", { locale: "en", timeZone: "UTC", now })).toBe("11:30");
    // The box's zone, not UTC: 11:30Z is 14:30 in Sofia.
    expect(formatFreesUpAt("2026-09-17T11:30:00.000Z", { locale: "en", timeZone: "Europe/Sofia", now })).toBe("14:30");
  });

  it("puts the weekday in front for another day inside the week", () => {
    expect(formatFreesUpAt("2026-09-19T14:05:00.000Z", { locale: "en", timeZone: "UTC", now })).toBe("Sat 14:05");
    // Tomorrow is another day even when it is fewer than 24 hours away.
    expect(formatFreesUpAt("2026-09-18T01:00:00.000Z", { locale: "en", timeZone: "UTC", now })).toBe("Fri 01:00");
  });

  it("uses the date beyond six days, where a weekday would repeat today's", () => {
    expect(formatFreesUpAt("2026-09-24T08:00:00.000Z", { locale: "en", timeZone: "UTC", now })).toBe("Sep 24, 08:00");
  });

  it("never quotes an instant from an earlier day as a bare clock", () => {
    // A paused run looked at days later: "14:05" alone would read as today.
    expect(formatFreesUpAt("2026-09-14T14:05:00.000Z", { locale: "en", timeZone: "UTC", now })).toBe("Mon 14:05");
    expect(formatFreesUpAt("2026-09-17T08:00:00.000Z", { locale: "en", timeZone: "UTC", now })).toBe("08:00");
  });

  it("writes the clock in the owner's language", () => {
    expect(formatFreesUpAt("2026-09-19T14:05:00.000Z", { locale: "de", timeZone: "UTC", now })).toBe("Sa., 14:05");
  });

  it("falls back to the runtime zone for a zone it does not know, rather than failing", () => {
    expect(formatFreesUpAt("2026-09-17T11:30:00.000Z", { locale: "en", timeZone: "Mars/Olympus_Mons", now })).toMatch(/^\d{2}:\d{2}$|^\w{3} \d{2}:\d{2}$/);
  });

  it("offers no clock when there is no instant", () => {
    expect(formatFreesUpAt(null, { locale: "en", now })).toBeNull();
    expect(formatFreesUpAt("not a time", { locale: "en", now })).toBeNull();
  });
});
