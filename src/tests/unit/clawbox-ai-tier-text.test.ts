import { describe, expect, it } from "vitest";
import {
  CLAWBOX_AI_TIER_TEXT_KEYS,
  clawboxAiTierTextKeys,
} from "@/lib/clawbox-ai-models";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";

const LOCALES = Object.keys(translations) as Locale[];

/**
 * The chat composer's model chip said "Max Tier" beside a Settings page that
 * called the same plan "Max-Tarif" (the UI sweep of 2026-09-07). The words
 * now come from the locale, through keys this React-free module names.
 */
describe("clawboxAiTierTextKeys", () => {
  it("answers the flash and pro tiers for a bare id, the shape a catalogue row carries", () => {
    expect(clawboxAiTierTextKeys("deepseek-v4-flash")).toBe(CLAWBOX_AI_TIER_TEXT_KEYS.flash);
    expect(clawboxAiTierTextKeys("deepseek-v4-pro")).toBe(CLAWBOX_AI_TIER_TEXT_KEYS.pro);
  });

  it("answers the same for either ClawBox AI ref spelling", () => {
    expect(clawboxAiTierTextKeys("deepseek/deepseek-v4-pro")).toBe(CLAWBOX_AI_TIER_TEXT_KEYS.pro);
    expect(clawboxAiTierTextKeys("clawai/deepseek-v4-flash")).toBe(CLAWBOX_AI_TIER_TEXT_KEYS.flash);
  });

  it("is null for another provider's model, a model outside the tiers, and no model at all", () => {
    // The id alone is not proof: a model of another provider that happens to
    // share it must keep the catalogue's own name.
    expect(clawboxAiTierTextKeys("openai/deepseek-v4-pro")).toBeNull();
    expect(clawboxAiTierTextKeys("gpt-5.4")).toBeNull();
    expect(clawboxAiTierTextKeys("deepseek/deepseek-v4-vision")).toBeNull();
    expect(clawboxAiTierTextKeys(null)).toBeNull();
    expect(clawboxAiTierTextKeys(undefined)).toBeNull();
  });

  it("names the Max tier with the plan name Settings already uses", () => {
    // One key for one plan, so the chip and the Providers page cannot call it
    // two things again.
    expect(CLAWBOX_AI_TIER_TEXT_KEYS.pro.labelKey).toBe("ai.planNameMax");
  });

  it("has every key it names, and the chat's own, in all ten locales", () => {
    const keys = [
      ...Object.values(CLAWBOX_AI_TIER_TEXT_KEYS).flatMap((tier) => [tier.labelKey, tier.hintKey]),
      "chat.switchingProvider",
      "chat.restartingChat",
      "chat.reloadMayTake",
      "chat.reloadProgress",
      "chat.maxTierDowngraded",
      "chat.modelNeedsMax",
      "chat.modelNotInPlan",
    ];
    expect(LOCALES).toHaveLength(10);
    for (const locale of LOCALES) {
      for (const key of keys) {
        expect(translations[locale][key], `${locale} ${key}`).toBeTruthy();
      }
    }
    // The notice names both tiers and carries the portal link.
    for (const locale of LOCALES) {
      const notice = translations[locale]["chat.maxTierDowngraded"];
      expect(notice).toContain("{max}");
      expect(notice).toContain("{flash}");
      expect(notice).toContain("({url})");
    }
    // A refused pick names the row the owner picked and carries the link too.
    for (const locale of LOCALES) {
      for (const key of ["chat.modelNeedsMax", "chat.modelNotInPlan"]) {
        const refusal = translations[locale][key];
        expect(refusal, `${locale} ${key}`).toContain("{model}");
        expect(refusal, `${locale} ${key}`).toContain("({url})");
      }
    }
  });
});
