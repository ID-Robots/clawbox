import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { translations } from "@/lib/translations";

/**
 * A desktop app's `name` is a TRANSLATION KEY, not copy: `resolveAppName` in
 * `src/app/page.tsx` is `t(app.name) || app.name`, and `t()` returns the key
 * itself when it is missing. So a name that is not a key renders as its own
 * English self in every locale — the dock label, the window title and the
 * launcher entry all read from the same field, so all three go untranslated
 * together and nothing errors.
 *
 * Product names are the deliberate exception: they are the same word in every
 * language and carry no key.
 */
const PRODUCT_NAMES = new Set(["Hermes", "ClawKeep"]);

const LOCALES = Object.keys(translations);

function sliceBlock(file: string, opener: string, closer: string): string {
  const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const start = src.indexOf(opener);
  expect(start, `${file}: "${opener}" not found`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(closer, start + opener.length);
  expect(end, `${file}: end of "${opener}" block not found`).toBeGreaterThan(start);
  return src.slice(start + opener.length, end);
}

/** id -> name, from the desktop app registry. */
const registry = new Map<string, string>();
for (const line of sliceBlock("src/app/page.tsx", "const apps: AppDef[] = [", "\n];").split("\n")) {
  const m = line.match(/^\s*\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)"/);
  if (m) registry.set(m[1], m[2]);
}

/** id -> name, from the `/app/<id>` standalone window's title bar. */
const standaloneTitles = new Map<string, string>();
for (const line of sliceBlock(
  "src/app/app/[id]/page.tsx",
  "const APP_TITLES: Record<string, string> = {",
  "\n};",
).split("\n")) {
  const m = line.match(/^\s*"?([A-Za-z0-9_-]+)"?:\s*"([^"]+)",/);
  if (m) standaloneTitles.set(m[1], m[2]);
}

describe("desktop app names are translatable", () => {
  it("parses both name tables out of their sources", () => {
    expect(registry.size).toBeGreaterThanOrEqual(14);
    expect(standaloneTitles.size).toBeGreaterThanOrEqual(15);
  });

  it("gives every app a name key that exists in every locale", () => {
    for (const [id, name] of registry) {
      if (PRODUCT_NAMES.has(name)) continue;
      expect(name, `app "${id}" should name a translation key, not copy`).toMatch(/^app\./);
      for (const locale of LOCALES) {
        expect(
          translations[locale as keyof typeof translations][name],
          `${locale} has no "${name}" (app "${id}")`,
        ).toBeTruthy();
      }
    }
  });

  it("titles the standalone window with the same name the desktop shows", () => {
    for (const [id, name] of registry) {
      expect(
        standaloneTitles.get(id),
        `/app/${id} should title itself with the desktop's name for "${id}"`,
      ).toBe(name);
    }
  });
});
