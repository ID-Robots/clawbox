import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";
import { CLOUD_VOICES, LOCAL_VOICES } from "@/lib/voice-catalog";

/**
 * The Voice tab's dropdown carried "Ash — male, warm" in English on a German
 * desktop (locale sweep DE-8, 2026-09-07): the descriptor is prose, and it
 * lived as a literal in the catalogue of voices. Each voice now names its
 * catalogue key; the English `label` stays as the floor and is what the `en`
 * pack must carry, so the two cannot drift.
 */

const LOCALES: Locale[] = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];
const VOICES = [...CLOUD_VOICES, ...LOCAL_VOICES];

describe("voice labels come from the catalogue", () => {
  it("names one settings.voice.name.* key per voice, in the catalogue's own key shape", () => {
    for (const v of CLOUD_VOICES) expect(v.labelKey).toBe(`settings.voice.name.${v.id}`);
    // A Kokoro id carries an underscore, which the catalogue's key rule forbids.
    expect(LOCAL_VOICES.find((v) => v.id === "af_heart")?.labelKey).toBe("settings.voice.name.afHeart");
    expect(LOCAL_VOICES.find((v) => v.id === "bm_george")?.labelKey).toBe("settings.voice.name.bmGeorge");
    for (const v of VOICES) expect(v.labelKey).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9][a-zA-Z0-9]*)*$/);
  });

  it("keeps the English label as the en pack's value", () => {
    for (const v of VOICES) expect(translations.en[v.labelKey], v.id).toBe(v.label);
  });

  for (const locale of LOCALES) {
    it(`'${locale}' carries every voice`, () => {
      for (const v of VOICES) expect(translations[locale][v.labelKey], `${locale} ${v.id}`).toBeTruthy();
    });
  }

  it("translates the descriptors rather than shipping English under every locale", () => {
    // "neutral" is the same word in several languages; a gendered descriptor is not.
    const ash = CLOUD_VOICES.find((v) => v.id === "ash")!;
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      expect(translations[locale][ash.labelKey], locale).not.toBe(ash.label);
      // The name is a product name and stays.
      expect(translations[locale][ash.labelKey]).toMatch(/^Ash /);
    }
  });
});
