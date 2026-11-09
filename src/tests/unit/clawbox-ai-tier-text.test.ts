import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";

const LOCALES = Object.keys(translations) as Locale[];

/**
 * The ClawBox AI chat's own words, in every locale.
 *
 * There used to be a tier label per ClawBox AI model here — a Flash row and a
 * Max-plan row, and the notices that moved a box from one to the other. ClawBox
 * AI is ONE model since TASK-2261, so those keys are gone; what is left is the
 * chat's own switching copy, which must still exist everywhere.
 */
describe("ClawBox AI chat copy", () => {
  it("has the chat's switching notices in all ten locales", () => {
    const keys = [
      "chat.switchingProvider",
      "chat.restartingChat",
      "chat.reloadMayTake",
      "chat.reloadProgress",
    ];
    expect(LOCALES).toHaveLength(10);
    for (const locale of LOCALES) {
      for (const key of keys) {
        expect(translations[locale][key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });

  it("carries no per-model tier label or plan-gate notice any more", () => {
    for (const locale of LOCALES) {
      for (const key of [
        "ai.clawboxTierFlash",
        "ai.clawboxTierFlashHint",
        "ai.clawboxTierMaxHint",
        "chat.maxTierDowngraded",
        "chat.modelNeedsMax",
        "chat.modelNotInPlan",
      ]) {
        expect(translations[locale][key], `${locale} ${key}`).toBeUndefined();
      }
    }
  });
});
