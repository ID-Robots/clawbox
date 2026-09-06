import type { Locale } from "./i18n";
import { settingsSecurityEn } from "./edition-translations/en-settings-security";
import { providerEn } from "./edition-translations/en-provider";
import { skillsEn } from "./edition-translations/en-skills";
import { localModelsEn } from "./edition-translations/en-local-models";
import { systemProfileEn } from "./edition-translations/en-system-profile";
import { codingAgentEn } from "./edition-translations/en-coding-agent";
import { shellScanEn } from "./edition-translations/en-shell-scan";
import { bg } from "./edition-translations/bg";
import { de } from "./edition-translations/de";
import { es } from "./edition-translations/es";
import { fr } from "./edition-translations/fr";
import { it } from "./edition-translations/it";
import { ja } from "./edition-translations/ja";
import { nl } from "./edition-translations/nl";
import { sv } from "./edition-translations/sv";
import { zh } from "./edition-translations/zh";

/**
 * EDITION here means RENDERED ON EVERY EDITION. This table has no per-edition
 * dimension and must not grow one: it is a single flat merge, spread into
 * `translations` once per locale, and WHICH edition shows a string is decided
 * by the component, never by the catalogue. A string that genuinely differs
 * between OpenClaw and Hermes is two keys the component picks between, not an
 * `openclaw`/`hermes` sub-map and a second lookup path beside `t()`.
 *
 * The surfaces that used to bypass `t()` entirely: the system-password card,
 * the Hermes provider picker, the Skills store and the Local Models tab
 * (TASK-458), joined by the Desktop & power card (TASK-455), the Coding agent
 * card and the pre-exec shell-scan notice. They are grouped here rather than appended to
 * `desktop-translations` because they arrived as one i18n pass and a reviewer
 * should be able to read that pass as one diff.
 *
 * NAMED FOR WHAT IT HOLDS, not for where it started. This was
 * `hermes-translations` because the first pass was the Hermes tab, and it has
 * long since carried copy every edition renders — the system-password card,
 * Desktop & power, Local Models, the Coding agent, the shell scan — so the old
 * name told a reader that an OpenClaw-only string did not belong here, which
 * is how a table like this ends up with a second one beside it (TASK-598).
 *
 * English is authored per surface (one `en-*` module each, so each surface's
 * copy sits next to nothing else); every other locale is one file per language.
 *
 * WHY every locale is spread over `en`: a key that a translator has not reached
 * yet must still RESOLVE — to the English sentence — instead of leaving the raw
 * key on screen. `i18n.tsx` layers the active locale over English at runtime
 * for exactly the same reason, and doing it here as well keeps the exported
 * table itself key-complete, which is what `translations.test.ts` asserts.
 */
export const editionEn: Record<string, string> = {
  ...settingsSecurityEn,
  ...providerEn,
  ...skillsEn,
  ...localModelsEn,
  ...systemProfileEn,
  ...codingAgentEn,
  ...shellScanEn,
};

const overrides: Record<Exclude<Locale, "en">, Record<string, string>> = {
  bg, de, es, fr, it, ja, nl, sv, zh,
};

export const editionTranslations: Record<Locale, Record<string, string>> = {
  en: editionEn,
  ...(Object.fromEntries(
    Object.entries(overrides).map(([locale, table]) => [locale, { ...editionEn, ...table }]),
  ) as Record<Exclude<Locale, "en">, Record<string, string>>),
};
