import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import { desktopTranslations } from "@/lib/desktop-translations";
import { LANGUAGES } from "@/lib/i18n";

/**
 * Every key the desktop asks `t()` for is one the dictionary can answer
 * (TASK-1520).
 *
 * `t()` hands back the KEY itself when the dictionary has no entry, so a
 * missing key does not fail anything: it reaches the owner as raw text. The
 * wallpaper upload's refusal toast was reported doing exactly that —
 * "settings.wallpaperNotImage" on the desktop. This reads the literal keys out
 * of the desktop page and holds each one to the catalogue the desktop's
 * <I18nProvider> actually loads, in every locale the language picker offers.
 *
 * Only string literals can be read this way. `t(app.name)` is held by
 * desktop-app-names-i18n.test.ts, and `tr(key, english)` has an English floor
 * of its own (see src/app/page.tsx).
 */

const ROOT = process.cwd();
const DESKTOP_PAGE = "src/app/page.tsx";
const LOCALES = LANGUAGES.map((language) => language.code);

function source(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

/** The first argument of every `t("…")` / `t('…')` / `` t(`…`) `` call that is a plain literal. */
function literalTKeys(code: string): string[] {
  const keys = new Set<string>();
  for (const match of code.matchAll(/\bt\(\s*(["'`])([^"'`\\$\n]+)\1/g)) keys.add(match[2]);
  return [...keys].sort();
}

describe("the keys src/app/page.tsx passes to t()", () => {
  const keys = literalTKeys(source(DESKTOP_PAGE));

  it("are read out of the page at all", () => {
    // A regex that silently stops matching would make every case below pass.
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain("settings.wallpaperNotImage");
  });

  it("are looked up in the catalogue this test checks against", () => {
    // The provider lazy-loads `translations` from @/lib/translations. If it
    // ever reads another dictionary, this file must follow it there.
    expect(source("src/lib/i18n.tsx")).toContain('import("@/lib/translations")');
  });

  it.each(LOCALES)("each have a translation in '%s'", (locale) => {
    const dictionary = translations[locale];
    const missing = keys.filter((key) => {
      const value = dictionary[key];
      return typeof value !== "string" || value.trim() === "" || value === key;
    });
    expect(missing, `keys src/app/page.tsx renders raw in '${locale}'`).toEqual([]);
  });
});

describe("the wallpaper upload's refusal (settings.wallpaperNotImage)", () => {
  const KEY = "settings.wallpaperNotImage";

  it.each(LOCALES)("lives in the desktop dictionary for '%s'", (locale) => {
    const value = desktopTranslations[locale][KEY];
    expect(typeof value, `desktopTranslations.${locale}["${KEY}"]`).toBe("string");
    expect(value.trim()).not.toBe("");
    expect(value).not.toBe(KEY);
    // What the merged catalogue answers is this copy, not a stale one elsewhere.
    expect(translations[locale][KEY]).toBe(value);
  });

  it.each(LOCALES.filter((locale) => locale !== "en"))("is translated for '%s', not the English copy", (locale) => {
    expect(desktopTranslations[locale][KEY]).not.toBe(desktopTranslations.en[KEY]);
  });

  it("names the formats in every locale", () => {
    for (const locale of LOCALES) {
      const value = desktopTranslations[locale][KEY] ?? "";
      for (const format of ["PNG", "JPEG", "WebP"]) {
        expect(value, `${locale} copy should name ${format}`).toContain(format);
      }
    }
  });
});
