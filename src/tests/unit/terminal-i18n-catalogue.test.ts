/**
 * Every string the Terminal window shows — the tab strip, the right-click
 * menus, the settings sheet, the theme and face names — is in all ten of the
 * desktop's languages, with the same {placeholders} as the English.
 *
 * The keys are read out of the components' own source, so a label added
 * there without its translations fails here rather than on a German desktop.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { desktopTranslations } from "@/lib/desktop-translations";

const SOURCES = [
  "src/components/TerminalApp.tsx",
  "src/components/TerminalTabs.tsx",
  "src/components/TerminalSettingsSheet.tsx",
  "src/lib/terminal-settings.ts",
];

function keysUsed(): string[] {
  const keys = new Set<string>();
  for (const file of SOURCES) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    for (const match of text.matchAll(/["'`](terminal\.[A-Za-z0-9_.]+)["'`]/g)) keys.add(match[1]);
  }
  return [...keys].sort();
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("the Terminal's copy in every language", () => {
  const keys = keysUsed();
  const locales = Object.keys(desktopTranslations);

  it("reads the keys it checks out of the components", () => {
    expect(locales.sort()).toEqual(["bg", "de", "en", "es", "fr", "it", "ja", "nl", "sv", "zh"]);
    // The settings sheet alone has a few dozen; a regex that stopped matching
    // would make every check below vacuous.
    expect(keys.length).toBeGreaterThan(60);
    expect(keys).toContain("terminal.settings.title");
    expect(keys).toContain("terminal.copyAll");
    expect(keys).toContain("terminal.renameTab");
  });

  it.each(["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"] as const)("has every key in %s, with the English placeholders", (locale) => {
    const table = desktopTranslations[locale];
    const english = desktopTranslations.en;
    const missing = keys.filter((key) => typeof table[key] !== "string" || !table[key].trim());
    expect(missing).toEqual([]);
    const drifted = keys.filter((key) => placeholders(table[key]).join() !== placeholders(english[key]).join());
    expect(drifted).toEqual([]);
  });
});
