import type { Locale } from "./i18n";
import { settingsSecurityEn } from "./hermes-translations/en-settings-security";
import { providerEn } from "./hermes-translations/en-provider";
import { skillsEn } from "./hermes-translations/en-skills";
import { localModelsEn } from "./hermes-translations/en-local-models";
import { bg } from "./hermes-translations/bg";
import { de } from "./hermes-translations/de";
import { es } from "./hermes-translations/es";
import { fr } from "./hermes-translations/fr";
import { it } from "./hermes-translations/it";
import { ja } from "./hermes-translations/ja";
import { nl } from "./hermes-translations/nl";
import { sv } from "./hermes-translations/sv";
import { zh } from "./hermes-translations/zh";

/**
 * The surfaces that used to bypass `t()` entirely: the system-password card,
 * the Hermes provider picker, the Skills store and the Local Models tab
 * (TASK-458). They are grouped here rather than appended to
 * `desktop-translations` because they arrived as one i18n pass and a reviewer
 * should be able to read that pass as one diff.
 *
 * English is authored per surface (four `en-*` modules, so each surface's copy
 * sits next to nothing else); every other locale is one file per language.
 *
 * WHY every locale is spread over `en`: a key that a translator has not reached
 * yet must still RESOLVE — to the English sentence — instead of leaving the raw
 * key on screen. `i18n.tsx` layers the active locale over English at runtime
 * for exactly the same reason, and doing it here as well keeps the exported
 * table itself key-complete, which is what `translations.test.ts` asserts.
 */
export const hermesEn: Record<string, string> = {
  ...settingsSecurityEn,
  ...providerEn,
  ...skillsEn,
  ...localModelsEn,
};

const overrides: Record<Exclude<Locale, "en">, Record<string, string>> = {
  bg, de, es, fr, it, ja, nl, sv, zh,
};

export const hermesTranslations: Record<Locale, Record<string, string>> = {
  en: hermesEn,
  ...(Object.fromEntries(
    Object.entries(overrides).map(([locale, table]) => [locale, { ...hermesEn, ...table }]),
  ) as Record<Exclude<Locale, "en">, Record<string, string>>),
};
