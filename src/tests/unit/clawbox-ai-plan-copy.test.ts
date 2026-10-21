import { describe, expect, it } from "vitest";
import {
  CLAWAI_TIER_INFO,
  CLAWAI_TIER_ORDER,
  CLAWBOX_AI_DESCRIPTION,
  CLAWBOX_AI_DESCRIPTION_KEY,
} from "@/lib/clawbox-ai-tiers";
import { CLAWBOX_AI_CHAT_MODEL_LABEL } from "@/lib/clawbox-ai-models";
import { codingModelName } from "@/lib/coding-model-names";
import { CLAWAI_MODELS } from "@/lib/provider-models";
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
    "ai.planFromAccount",
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

/**
 * Every plan is served by DeepSeek V4 Flash. The proxy answers the Max plan's
 * `deepseek-v4-pro` id with the same Flash model, so copy that sells Max a
 * bigger one ("V4 Pro", "1.6T", "frontier" in any of its translations) names a
 * model the box does not run. The wire id stays; only the words change.
 */
describe("ClawBox AI copy names the model that serves it", () => {
  const SERVED_MODEL = "DeepSeek V4 Flash";
  /** "V4 Pro", "1.6T" and "frontier", as the ten locale packs spelled them. */
  const OVERCLAIM =
    /V4[ -]?Pro|1[.,]6\s?T|fronti|frontera|frontlinje|フロンティア|前沿|最上位|фронт|челн|Spitzen|de pointe|di punta|topp?model/i;
  /** The keys that carried the claim. A key that is gone claims nothing. */
  const CLAIM_KEYS = [
    "ai.planFeatureProModel",
    "ai.clawboxTierMaxHint",
    "ai.clawboxTierFlashHint",
    "tierCelebration.maxBody",
    "upgradeCard.trialBannerSubtitle",
  ];

  it("lists no bigger model in any plan's features", () => {
    for (const tier of CLAWAI_TIER_ORDER) {
      for (const feature of CLAWAI_TIER_INFO[tier].features) {
        expect(feature, `${tier}: ${feature}`).not.toMatch(OVERCLAIM);
      }
    }
  });

  it("shows the Max plan the same model as Free and Pro, in every locale", () => {
    const modelKey = (tier: (typeof CLAWAI_TIER_ORDER)[number]) =>
      CLAWAI_TIER_INFO[tier].featureKeys.find((key) => /Model$/.test(key));
    for (const tier of CLAWAI_TIER_ORDER) {
      const key = modelKey(tier);
      expect(key, `${tier} names its model`).toBeTruthy();
      for (const locale of LOCALES) {
        expect(translations[locale][key!], `${locale} ${tier}`).toBe(SERVED_MODEL);
      }
    }
  });

  it("carries no bigger-model claim in any locale", () => {
    for (const locale of LOCALES) {
      for (const key of CLAIM_KEYS) {
        expect(translations[locale][key] ?? "", `${locale}["${key}"]`).not.toMatch(OVERCLAIM);
      }
    }
  });

  it("names the served model on both picker rows and the Max celebration", () => {
    for (const locale of LOCALES) {
      // Same model on both rows, so neither may call itself the faster one.
      expect(translations[locale]["ai.clawboxTierFlashHint"], locale).toContain(SERVED_MODEL);
      expect(translations[locale]["ai.clawboxTierMaxHint"], locale).toContain(SERVED_MODEL);
      expect(translations[locale]["tierCelebration.maxBody"], locale).toContain(SERVED_MODEL);
    }
  });

  it("keeps the picker rows, the chat label and the coding agent on the same name", () => {
    for (const model of CLAWAI_MODELS) {
      expect(`${model.label} ${model.hint ?? ""}`, model.id).not.toMatch(OVERCLAIM);
    }
    expect(CLAWAI_MODELS.find((m) => m.id === "deepseek-v4-pro")?.hint).toContain(SERVED_MODEL);
    expect(CLAWBOX_AI_CHAT_MODEL_LABEL).toBe(SERVED_MODEL);
    expect(codingModelName("deepseek-v4-pro")).toBe(codingModelName("deepseek-v4-flash"));
    expect(codingModelName("deepseek-v4-pro[1m]")).not.toMatch(/Pro/);
  });
});
