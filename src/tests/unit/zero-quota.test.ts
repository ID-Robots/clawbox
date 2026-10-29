import { describe, expect, it } from "vitest";
import { creditConsoleFor, statesZeroRateLimit } from "@/lib/zero-quota";

// A 429 that states the account's limit as ZERO is not a throttle: no wait
// helps. Everything else that reads as a rate limit keeps the normal retry.

// The refusal a box logged (2026-10), with the team id replaced.
const XAI_ZERO = "429 Too many requests for team 00000000-0000-0000-0000-000000000000 and model grok-4.6. "
  + "Your team's rate limit is — Requests per Minute (actual/limit): 0/0. Your rate limit tier is determined "
  + "based on your historical API spend.";

describe("statesZeroRateLimit", () => {
  it("reads xAI's 0/0 refusal as a zero limit", () => {
    expect(statesZeroRateLimit(XAI_ZERO)).toBe(true);
    // Also when the core quotes it inside its JSON log line.
    expect(statesZeroRateLimit(JSON.stringify({ rawErrorPreview: XAI_ZERO }))).toBe(true);
  });

  it("reads Google's and OpenAI's zero-quota shapes", () => {
    expect(statesZeroRateLimit("429 RESOURCE_EXHAUSTED: Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro")).toBe(true);
    expect(statesZeroRateLimit("Rate limit reached for gpt-x on requests per min (RPM): Limit 0, Used 0, Requested 1.")).toBe(true);
  });

  it("keeps an ordinary throttle a throttle", () => {
    expect(statesZeroRateLimit("429 Too many requests. Requests per Minute (actual/limit): 61/60.")).toBe(false);
    expect(statesZeroRateLimit("API rate limit reached. Please try again later.")).toBe(false);
    expect(statesZeroRateLimit("Rate limit reached: Limit 500, Used 500, Requested 1.")).toBe(false);
    expect(statesZeroRateLimit("429 Too many requests (actual/limit): 0/60")).toBe(false);
    expect(statesZeroRateLimit("quota: limit: 0.5 credits left")).toBe(false);
  });

  it("needs the text to be a rate-limit refusal at all", () => {
    expect(statesZeroRateLimit("context window: limit: 0 tokens left")).toBe(false);
    expect(statesZeroRateLimit("")).toBe(false);
    expect(statesZeroRateLimit(undefined)).toBe(false);
  });

  it("names where each provider takes credit", () => {
    expect(creditConsoleFor("xai")).toBe("console.x.ai");
    expect(creditConsoleFor("XAI")).toBe("console.x.ai");
    expect(creditConsoleFor("ollama")).toBeNull();
    expect(creditConsoleFor("constructor")).toBeNull();
  });
});
