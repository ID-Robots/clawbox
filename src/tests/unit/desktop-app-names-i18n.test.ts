import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { apps } from "@/lib/desktop-apps";
import { translations } from "@/lib/translations";

/**
 * A desktop app's `name` is a TRANSLATION KEY, not copy: both surfaces that
 * render one resolve it as `t(name) || name`, and `t()` returns the key itself
 * when it is missing. So a name that is not a key renders as its own English
 * self in every locale — the dock label, the window title and the launcher
 * entry all read the same field, so all three go untranslated together and
 * nothing errors.
 *
 * Product names are the deliberate exception: they are the same word in every
 * language and carry no key.
 */
const PRODUCT_NAMES = new Set(["Hermes", "ClawKeep"]);

const desktopSrc = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
const standaloneSrc = fs.readFileSync(
  path.join(process.cwd(), "src/app/app/[id]/page.tsx"),
  "utf8",
);

/** Only `en` is checked per key: translations.test.ts already asserts that every locale has exactly the `en` key set. */
function expectNameIsResolvable(id: string, name: string) {
  if (PRODUCT_NAMES.has(name)) return;
  expect(name, `app "${id}" should name a translation key, not copy`).toMatch(/^app\./);
  expect(translations.en[name], `en has no "${name}" (app "${id}")`).toBeTruthy();
}

describe("desktop app names are translatable", () => {
  it("gives every built-in app a name key that exists", () => {
    expect(apps.length).toBeGreaterThanOrEqual(14);
    for (const app of apps) expectNameIsResolvable(app.id, app.name);
  });

  it("gives the setup wizard a name key too", () => {
    // Not in `apps`: the desktop appends it in `getAllApps()` because it is not
    // an icon you can pin, but it is a window with a title like any other.
    const m = desktopSrc.match(/id: "setup",\s*\n\s*name: "([^"]+)",/);
    expect(m, "the setup entry moved or changed shape — update this test").not.toBeNull();
    expectNameIsResolvable("setup", m![1]);
  });

  it("titles the standalone window from the shared registry, not a second table", () => {
    // `/app/<id>` used to keep its own map of English names. If that returns,
    // every app's title bar there silently stops translating again.
    expect(standaloneSrc).toContain('import { apps } from "@/lib/desktop-apps"');
    expect(standaloneSrc).toMatch(
      /const APP_TITLES: Record<string, string> = \{\s*\n\s*\.\.\.Object\.fromEntries\(apps\.map\(\(a\) => \[a\.id, a\.name\]\)\),/,
    );
  });
});
