import type { Locale } from "./i18n";

/**
 * The UI's translation table for ONE locale, as its own chunk.
 *
 * Each `import()` names one generated file, so the bundler emits ten small
 * chunks (~300 KB each) and a page parses only the locale it renders,
 * instead of the one 3.5 MB module every locale used to share
 * (`src/lib/translations.ts`, which stays the source of truth and what the
 * tests read). The files are written by `bun run gen:translations`
 * (scripts/gen-translation-chunks.ts) and held in step with the source tables
 * by src/tests/unit/translation-chunks.test.ts. Each table already carries
 * English under every key the locale lacks.
 */
export function loadLocaleTable(locale: Locale): Promise<Record<string, string>> {
  switch (locale) {
    case "bg": return import("./translations-generated/bg").then((m) => m.default);
    case "de": return import("./translations-generated/de").then((m) => m.default);
    case "es": return import("./translations-generated/es").then((m) => m.default);
    case "fr": return import("./translations-generated/fr").then((m) => m.default);
    case "it": return import("./translations-generated/it").then((m) => m.default);
    case "ja": return import("./translations-generated/ja").then((m) => m.default);
    case "nl": return import("./translations-generated/nl").then((m) => m.default);
    case "sv": return import("./translations-generated/sv").then((m) => m.default);
    case "zh": return import("./translations-generated/zh").then((m) => m.default);
    case "en":
    default: return import("./translations-generated/en").then((m) => m.default);
  }
}
