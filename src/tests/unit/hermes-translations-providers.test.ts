import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import { desktopTranslations } from "@/lib/desktop-translations";
import { clawkeepTranslations } from "@/lib/clawkeep-translations";
import { hermesEn } from "@/lib/hermes-translations";
import { settingsSecurityEn } from "@/lib/hermes-translations/en-settings-security";
import { bg } from "@/lib/hermes-translations/bg";
import { de } from "@/lib/hermes-translations/de";
import { es } from "@/lib/hermes-translations/es";
import { fr } from "@/lib/hermes-translations/fr";
import { it as itLocale } from "@/lib/hermes-translations/it";
import { ja } from "@/lib/hermes-translations/ja";
import { nl } from "@/lib/hermes-translations/nl";
import { sv } from "@/lib/hermes-translations/sv";
import { zh } from "@/lib/hermes-translations/zh";
import type { Locale } from "@/lib/i18n";

/**
 * The cloud-provider list in Settings → AI (AiProviderList) shipped with every
 * string hardcoded in English — heading, helper sentence, both error lines, the
 * "Switched off" state, "Make default", the locked-switch hint and the empty
 * line — on a Settings page where every neighbouring card was translated.
 *
 * `hermes-translations.test.ts` holds each namespace of that catalogue to one
 * bar: every locale carries copy of its OWN, checked against the per-locale
 * module rather than the merged table (the merge layers English underneath as
 * a runtime safety net, which would mask exactly this regression). This file
 * holds `settings.providers.*` to the same bar.
 *
 * One string on the card is NOT this catalogue's: the "Default" badge reads
 * `settings.providers.default`, which desktop-translations already carries for
 * ProviderDefaultHero's badge. The hermes catalogue merges last in
 * translations.ts, so a second copy here would silently shadow the hero's and
 * the two would drift — the last block below keeps every hermes key out of
 * the other catalogues for exactly that reason.
 */

const OVERRIDES: Record<Exclude<Locale, "en">, Record<string, string>> = {
  bg, de, es, fr, it: itLocale, ja, nl, sv, zh,
};
const NON_EN = Object.keys(OVERRIDES) as Exclude<Locale, "en">[];

const KEYS = Object.keys(hermesEn).filter((k) => k.startsWith("settings.providers."));

/** Every string the component renders through THIS catalogue, by key. */
const RENDERED = [
  "settings.providers.title",
  "settings.providers.hint",
  "settings.providers.readError",
  "settings.providers.changeFailed",
  "settings.providers.enable",
  "settings.providers.switchedOff",
  "settings.providers.makeDefault",
  "settings.providers.lockedHint",
  "settings.providers.empty",
];

describe("the cloud-provider list is translated everywhere", () => {
  it("English defines every key the component renders, in the Settings module", () => {
    for (const key of RENDERED) {
      expect(settingsSecurityEn[key], `en["${key}"] should exist`).toBeTruthy();
      expect(translations.en[key], `en["${key}"] missing from the merged table`).toBe(settingsSecurityEn[key]);
    }
    expect(KEYS.sort()).toEqual([...RENDERED].sort());
  });

  it("the switch's name carries the provider's own label", () => {
    expect(hermesEn["settings.providers.enable"]).toContain("{name}");
  });

  for (const locale of NON_EN) {
    it(`'${locale}' translates every key, in its own words`, () => {
      const table = OVERRIDES[locale];
      const missing = KEYS.filter((k) => typeof table[k] !== "string" || table[k].length === 0);
      expect(missing, `${locale} is missing ${missing.length} key(s)`).toEqual([]);
      const english = KEYS.filter((k) => table[k] === hermesEn[k]);
      expect(english, `${locale} still renders English for ${english.length} key(s)`).toEqual([]);
    });

    it(`'${locale}' keeps the {name} placeholder`, () => {
      expect(OVERRIDES[locale]["settings.providers.enable"]).toContain("{name}");
    });
  }

  // The badge is the desktop catalogue's word, shared with ProviderDefaultHero
  // so both surfaces can never disagree on what "Default" is called.
  it("the Default badge is the desktop catalogue's, in every locale", () => {
    const key = "settings.providers.default";
    expect(hermesEn[key]).toBeUndefined();
    for (const locale of Object.keys(translations) as Locale[]) {
      expect(desktopTranslations[locale][key], `desktop.${locale}["${key}"]`).toBeTruthy();
      expect(translations[locale][key]).toBe(desktopTranslations[locale][key]);
    }
  });
});

describe("the hermes catalogue shadows nothing", () => {
  // translations.ts merges hermes LAST, so a hermes key that also exists in
  // desktop or clawkeep silently wins for EVERY consumer of that key — the
  // per-catalogue parity suites only compare locales within one catalogue and
  // would never notice. Keep the collision set empty.
  it("no hermes key also exists in the desktop or clawkeep catalogue", () => {
    const hermesKeys = Object.keys(hermesEn);
    const inDesktop = hermesKeys.filter((k) => k in desktopTranslations.en);
    const inClawkeep = hermesKeys.filter((k) => k in clawkeepTranslations.en);
    expect(inDesktop, "hermes keys shadowing desktop-translations").toEqual([]);
    expect(inClawkeep, "hermes keys shadowing clawkeep-translations").toEqual([]);
  });
});
