/**
 * The one sentence for an allowance pause, shared by the run page and the
 * chat's run card (src/lib/coding-pause-reason-copy.ts).
 */
import { describe, expect, it } from "vitest";
import { pauseReasonText } from "@/lib/coding-pause-reason-copy";
import { translations } from "@/lib/translations";

const en = translations.en;
const t = (key: string, params?: Record<string, string | number>) => {
  let out = en[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) out = out.replaceAll(`{${k}}`, String(v));
  return out;
};

describe("pauseReasonText", () => {
  it("has nothing to say about an owner's pause, a run never paused, or a record from before the field", () => {
    expect(pauseReasonText({ kind: "owner" }, t, "en")).toBeNull();
    expect(pauseReasonText(null, t, "en")).toBeNull();
    expect(pauseReasonText(undefined, t, "en")).toBeNull();
  });

  it("a per-day meter: the spent allowance and the UTC hour it resets at", () => {
    expect(pauseReasonText({ kind: "allowance", meter: "images", resetsAt: "2026-10-31T09:00:00.000Z", message: "quota" }, t, "en"))
      .toBe("Paused: the daily image allowance is used up. It resets at 09:00 UTC.");
  });

  it("no reset time: says to resume once the allowance is back, rather than inventing an hour", () => {
    expect(pauseReasonText({ kind: "allowance", meter: "speech", resetsAt: null, message: "quota" }, t, "en"))
      .toBe("Paused: the speech allowance is used up. Resume it once the allowance is back.");
    expect(pauseReasonText({ kind: "allowance", meter: "weekly", resetsAt: null, message: "quota" }, t, "en"))
      .toBe("Paused: this week's ClawBox AI chat allowance is used up. Resume it once the allowance is back.");
  });

  it("a rolling meter frees up in the owner's clock; every Anthropic account at its limit carries on by itself", () => {
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    const rolling = pauseReasonText({ kind: "allowance", meter: "burst", resetsAt: soon, message: "quota" }, t, "en");
    expect(rolling).toMatch(/^Paused: the ClawBox AI 5-hour burst limit is reached\. It frees up at .+\.$/);
    const anthropic = pauseReasonText({ kind: "allowance", meter: "anthropic", resetsAt: soon, message: "limit" }, t, "en");
    expect(anthropic).toMatch(/^Waiting: every Anthropic account on this box is at its usage limit\. It carries on by itself at .+\.$/);
    expect(pauseReasonText({ kind: "allowance", meter: "anthropic", resetsAt: null, message: "limit" }, t, "en"))
      .toBe("Waiting: every Anthropic account on this box is at its usage limit. It carries on by itself as soon as one account is back.");
  });
});
