import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Remote Desktop ships OFF the desktop grid. The rule is only two lines of
// page.tsx, but each line fails in a different, quiet way if it drifts:
//   - filter the SAVED list against the DEFAULT set and an owner who added
//     Remote Desktop from the launcher loses it again on every reload;
//   - auto-add from BUILT_IN_APP_IDS and it returns to every desktop, which is
//     the behaviour this change removed.
const src = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");

describe("default desktop icons", () => {
  it("keeps Remote Desktop out of the default grid but in the built-in set", () => {
    expect(src).toMatch(/const OFF_DESKTOP_BY_DEFAULT = new Set\(\["vnc"\]\)/);
    expect(src).toMatch(/const BUILT_IN_APP_IDS = apps\.map\(a => a\.id\)/);
    expect(src).toMatch(
      /const DEFAULT_DESKTOP_APPS = BUILT_IN_APP_IDS\.filter\(id => !OFF_DESKTOP_BY_DEFAULT\.has\(id\)\)/
    );
    // Still a real app, so the launcher can offer it and "Add to desktop" works.
    expect(src).toMatch(/id: "vnc", name: "app\.remoteDesktop"/);
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
