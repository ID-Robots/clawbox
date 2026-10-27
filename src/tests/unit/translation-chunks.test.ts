import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGES } from "@/lib/i18n";
import { translations } from "@/lib/translations";
import { loadLocaleTable } from "@/lib/translation-chunks";

// The per-locale chunks under src/lib/translations-generated/ are what the
// desktop and /login actually load (one ~300 KB JSON instead of the 3.5 MB
// aggregate). They are generated from the source tables and COMMITTED, so
// this test is the guard: a translation edited in src/lib/*translations*.ts
// without `bun run gen:translations` fails here, naming the fix.

const generatedDir = path.resolve(__dirname, "../../lib/translations-generated");

function expectedTable(locale: string): Record<string, string> {
  const en = translations.en ?? {};
  const active = (translations as Record<string, Record<string, string>>)[locale] ?? en;
  const merged = { ...en, ...active };
  return Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
}

describe("translation chunks", () => {
  for (const { code } of LANGUAGES) {
    it(`${code}.json is the ${code} table laid over English (else run: bun run gen:translations)`, () => {
      const file = path.join(generatedDir, `${code}.json`);
      expect(fs.existsSync(file), `${file} is missing — run: bun run gen:translations`).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(onDisk, `${code}.json drifted from src/lib/translations.ts — run: bun run gen:translations`).toEqual(expectedTable(code));
    });
  }

  it("the loader hands back each locale's table, English for the default branch", async () => {
    const bg = await loadLocaleTable("bg");
    expect(bg["common.cancel"] ?? bg[Object.keys(bg)[0]]).toBeDefined();
    expect(Object.keys(bg).length).toBe(Object.keys(translations.en).length);
    const en = await loadLocaleTable("en");
    expect(en).toEqual(expectedTable("en"));
    expect(bg).not.toEqual(en);
  });
});
