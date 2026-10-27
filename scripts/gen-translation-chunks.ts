#!/usr/bin/env bun
// Writes one JSON table per locale into src/lib/translations-generated/ from
// the aggregate in src/lib/translations.ts — every key of the locale laid over
// English, so a key a locale lacks still reads in English, exactly as the
// I18nProvider merged them at runtime.
//
// Why: `translations.ts` and the tables it merges keep all ten locales in the
// same modules, so the bundler could only ship them as ONE 3.5 MB chunk that
// every desktop and /login load parsed for the one locale it renders. The
// generated files are what `src/lib/translation-chunks.ts` imports, one chunk
// per locale, and they are COMMITTED: `src/tests/unit/translation-chunks.test.ts`
// fails when they drift from the source tables, and this script is the fix
// (`bun run gen:translations`). Run it after any change to a translation table.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translations } from "../src/lib/translations";
import { LANGUAGES, type Locale } from "../src/lib/i18n";

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "translations-generated");
fs.mkdirSync(outDir, { recursive: true });

export function localeTable(locale: Locale): Record<string, string> {
  const en = translations.en ?? {};
  const active = translations[locale] ?? en;
  const merged: Record<string, string> = { ...en, ...active };
  return Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
}

let changed = 0;
for (const { code } of LANGUAGES) {
  const file = path.join(outDir, `${code}.json`);
  const next = JSON.stringify(localeTable(code), null, 0) + "\n";
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (prev !== next) { fs.writeFileSync(file, next); changed++; }
}
console.log(`[gen-translation-chunks] ${LANGUAGES.length} locales, ${changed} file(s) written to ${path.relative(process.cwd(), outDir)}`);
