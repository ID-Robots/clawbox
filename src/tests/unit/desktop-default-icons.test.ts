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
    expect(src).toMatch(
      /const saved = \(data\.desktop_apps as string\[\]\)\.filter\(id => BUILT_IN_APP_IDS\.includes\(id\)\)/
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
