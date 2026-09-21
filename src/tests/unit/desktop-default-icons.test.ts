import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Remote Desktop and System Update ship OFF the desktop grid. The rule is only
// two lines of page.tsx, but each line fails in a different, quiet way if it
// drifts:
//   - filter the SAVED list against the DEFAULT set and an owner who added
//     Remote Desktop from the launcher loses it again on every reload;
//   - auto-add from BUILT_IN_APP_IDS and they return to every desktop, which is
//     the behaviour this change removed.
const src = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
// The app registry moved to a module both the desktop and `/app/<id>` import.
const registrySrc = fs.readFileSync(path.join(process.cwd(), "src/lib/desktop-apps.ts"), "utf8");

describe("default desktop icons", () => {
  it("keeps Remote Desktop and System Update out of the default grid but in the built-in set", () => {
    expect(src).toMatch(/const OFF_DESKTOP_BY_DEFAULT = new Set\(\["vnc", "system_update"\]\)/);
    expect(src).toMatch(/const BUILT_IN_APP_IDS = apps\.map\(a => a\.id\)/);
    expect(src).toMatch(
      /const DEFAULT_DESKTOP_APPS = BUILT_IN_APP_IDS\.filter\(id => !OFF_DESKTOP_BY_DEFAULT\.has\(id\)\)/
    );
    // Still real apps, so the launcher can offer them and "Add to desktop"
    // works — and for System Update the window and /app/system_update, which
    // Settings and the About tile lead to, keep resolving.
    expect(registrySrc).toMatch(/id: "vnc", name: "app\.remoteDesktop"/);
    expect(registrySrc).toMatch(/id: "system_update", name: "app\.systemUpdate"/);
  });

  it("validates a saved layout against every built-in, not just the defaults", () => {
    // The binding keyword is not the point — the shed below reassigns `saved`,
    // so this matches either form and pins only the rule it exists for.
    expect(src).toMatch(
      /(?:const|let) saved = \(data\.desktop_apps as string\[\]\)\.filter\(id => BUILT_IN_APP_IDS\.includes\(id\)\)/
    );
  });

  it("auto-adds only built-ins that belong on the desktop by default", () => {
    expect(src).toMatch(
      /const missingNewBuiltins = DEFAULT_DESKTOP_APPS\.filter\(id => !saved\.includes\(id\)\)/
    );
  });

  it("gives every built-in a declared icon slot, including the off-by-default ones", () => {
    expect(src).toMatch(/BUILT_IN_APP_IDS\.map\(\(id\) => `desktop-\$\{id\}`\)/);
  });
});

// `OFF_DESKTOP_BY_DEFAULT` only shapes the DEFAULT grid, and a saved list is
// restored verbatim so an owner's own additions survive. The consequence was
// that moving an app off the desktop reached FRESH boxes only: an upgraded box
// kept the icon for good, which is the state a v3.9.0 -> v4.0.0 box was found in.
describe("one-time shed of apps that moved off the desktop", () => {
  it("sheds exactly the ids that moved, and only from a saved list", () => {
    expect(src).toMatch(/1: \["system_update", "vnc"\]/);
    expect(src).toMatch(/saved = saved\.filter\(id => !shed\.has\(id\)\)/);
  });

  it("applies only the versions a box has not already had", () => {
    // The property that makes a later bump safe. Shedding one flat set on every
    // bump would take back an icon THIS version already shed and the owner has
    // since restored — the exact case the version exists to prevent.
    expect(src).toMatch(/DESKTOP_APPS_SHED_BY_VERSION: Record<number, readonly string\[\]>/);
    expect(src).toMatch(/\.filter\(\(\[version\]\) => Number\(version\) > from\)/);
    expect(src).toMatch(/const shedFrom = Number\(data\.desktop_apps_shed \?\? 0\)/);
    expect(src).toMatch(/shedFrom < DESKTOP_APPS_SHED_VERSION/);
  });

  it("records the version in the SAME write as the list it changed", () => {
    // Two writes could land apart, and a box that shed its icons without
    // recording the version would shed them again on the next load.
    expect(src).toMatch(
      /\{ desktop_apps: desktopApps, desktop_apps_shed: DESKTOP_APPS_SHED_VERSION \}/,
    );
  });

  it("drops the shed app's reserved grid cell where icon_grid is applied", () => {
    // Applied at the icon_grid assignment, which runs AFTER the shed and would
    // otherwise put the empty slot straight back.
    expect(src).toMatch(/for \(const id of shedNeeded\.current \?\? \[\]\) delete grid\[`desktop-\$\{id\}`\]/);
  });

  it("leaves both apps installable from the launcher", () => {
    // The shed is about the default grid, never about removing the app.
    expect(registrySrc).toMatch(/id: "vnc", name: "app\.remoteDesktop"/);
    expect(registrySrc).toMatch(/id: "system_update", name: "app\.systemUpdate"/);
  });
});
