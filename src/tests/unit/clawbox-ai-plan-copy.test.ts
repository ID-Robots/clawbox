import { describe, expect, it } from "vitest";
import {
  CLAWAI_TIER_INFO,
  CLAWAI_TIER_ORDER,
  CLAWBOX_AI_DESCRIPTION,
  CLAWBOX_AI_DESCRIPTION_KEY,
} from "@/lib/clawbox-ai-tiers";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";

const LOCALES: Locale[] = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];
const NON_EN = LOCALES.filter((l) => l !== "en");

/** Product names: a locale that leaves these alone is right, not lazy. */
const BRAND_ONLY = new Set(["ai.planFeatureFlashModel"]);

/** Words a language spells exactly as English does — Spanish "Plan" is the
 *  Spanish word, not an untranslated string. */
const SAME_AS_ENGLISH: Partial<Record<Locale, Set<string>>> = {
  es: new Set(["ai.plan"]),
};

/**
 * The plan card was English on every box in every locale. These keys are what
 * replaced the literals, and this file is the reason a tenth locale cannot be
 * forgotten: the picker resolves the English floor when a key is missing, so a
 * gap here is invisible on screen and shows up only as a German card reading
 * "Maximum usage".
 */
describe("ClawBox AI plan copy is keyed and translated", () => {
  const keys = [
    CLAWBOX_AI_DESCRIPTION_KEY,
    ...CLAWAI_TIER_ORDER.flatMap((tier) => {
      const info = CLAWAI_TIER_INFO[tier];
      return [info.planNameKey, info.pricePeriodKey, ...info.featureKeys];
    }),
    "ai.plan",
    "ai.planChange",
    "ai.planBlurb",
    "ai.planTier",
    "ai.planTierGroup",
    "ai.planTierOption",
    "ai.planTierOptionTrial",
    "ai.planTrial",
    "ai.planStartTrial",
  ];

  it("keeps featureKeys index-for-index with the English features", () => {
    for (const tier of CLAWAI_TIER_ORDER) {
      const info = CLAWAI_TIER_INFO[tier];
      expect(info.featureKeys, `${tier} feature keys`).toHaveLength(info.features.length);
      expect(new Set(info.featureKeys).size, `${tier} feature keys are distinct`).toBe(
        info.featureKeys.length,
      );
    }
  });

  it("carries the English floor unchanged in the en pack", () => {
    expect(translations.en[CLAWBOX_AI_DESCRIPTION_KEY]).toBe(CLAWBOX_AI_DESCRIPTION);
    for (const tier of CLAWAI_TIER_ORDER) {
      const info = CLAWAI_TIER_INFO[tier];
      expect(translations.en[info.planNameKey]).toBe(info.planName);
      expect(translations.en[info.pricePeriodKey]).toBe(info.pricePeriod);
      info.featureKeys.forEach((key, i) => {
        expect(translations.en[key], key).toBe(info.features[i]);
      });
    }
  });

  for (const locale of LOCALES) {
    it(`'${locale}' carries every plan key`, () => {
      for (const key of keys) {
        expect(translations[locale][key], `${locale} is missing ${key}`).toBeTruthy();
      }
    });
  }

  it("translates the plan copy rather than shipping English in every locale", () => {
    for (const locale of NON_EN) {
      for (const key of keys) {
        if (BRAND_ONLY.has(key) || SAME_AS_ENGLISH[locale]?.has(key)) continue;
        expect(
          translations[locale][key],
          `${locale}["${key}"] is still the English string`,
        ).not.toBe(translations.en[key]);
      }
    }
  });

  it("keeps the {tier} placeholder in every locale's tier option name", () => {
    for (const locale of LOCALES) {
      expect(translations[locale]["ai.planTierOption"]).toContain("{tier}");
      expect(translations[locale]["ai.planTierOptionTrial"]).toContain("{tier}");
    }
  });
});
