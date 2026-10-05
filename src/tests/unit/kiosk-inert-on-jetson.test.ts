import { describe, expect, it } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";

/**
 * The kiosk tab work is for the internal x64 kiosk only. Every owner runs
 * ClawBox on a Jetson, installed by install.sh, and NOTHING of it may run or
 * show there. This file pins the gates that make it inert — what the other
 * kiosk suites test in behaviour, held here as the one place a reviewer reads
 * "what does a Jetson get from this":
 *
 *  - the desktop polls the tab list and routes "open" through the kiosk only
 *    on a page that carries the kiosk extension's bar (`inKiosk()`), which a
 *    Jetson never has;
 *  - the kiosk-only app (Web) is hidden off the kiosk, on the desktop and in
 *    the agent's app list;
 *  - the server never dials the kiosk's CDP port on a box with no kiosk.env
 *    (`kioskConfigured`, behaviour in kiosk-tabs.test.ts);
 *  - install.sh and the shared scripts it runs are untouched by it.
 */
const ROOT = nodePath.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(nodePath.join(ROOT, f), "utf-8");

describe("the kiosk work is inert on a Jetson", () => {
  it("the desktop asks for kiosk tabs only on the kiosk's own page", () => {
    const page = read("src/app/page.tsx");
    expect(page).toContain("const onKiosk = kioskBarInset > 0;");
    expect(page).toContain("const kiosk = useKioskTabs(ownerApis && onKiosk);");
    // Every external open goes through openInKiosk, which is plain
    // window.open off the kiosk, decided from the page itself.
    const client = read("src/lib/kiosk-tabs-client.ts");
    expect(client).toMatch(/export function openInKiosk\([^)]*\): void \{\s*if \(!inKiosk\(\)\) \{\s*window\.open\(url, "_blank", features\);\s*return;/);
    expect(client).toContain("return kioskBarInset() > 0;");
  });

  it("hides the kiosk-only apps off the kiosk, on the desktop and for the agent", () => {
    const page = read("src/app/page.tsx");
    expect(page).toContain("...(onKiosk ? [] : apps.filter((a) => a.kioskOnly).map((a) => a.id))");
    expect(read("src/lib/desktop-apps.ts")).toMatch(/id: "web"[^\n]*kioskOnly: true/);
    const mcp = read("mcp/lib/context.ts");
    expect(mcp).toMatch(/web: \{[^\n]*kioskOnly: true/);
    expect(mcp).toContain("(!def.kioskOnly || kiosk)");
  });

  it("gates every CDP call on kiosk.env", () => {
    const lib = read("src/lib/kiosk-tabs.ts");
    for (const fn of ["listKioskTabs", "openKioskTab", "tabVerb"]) {
      expect(lib, fn).toMatch(new RegExp(`function ${fn}\\([^)]*\\)[^{]*\\{\\s*if \\(!kioskConfigured\\(\\)\\)`));
    }
  });

  it("leaves install.sh and the shared scripts it runs alone", () => {
    // These keep the modes the release branches have; every caller runs them
    // with `bash`, and the root mirror copies a mode as it finds it.
    for (const f of ["scripts/postbuild.sh", "scripts/check-build-isolation.sh", "scripts/check-bundled-builtins.sh"]) {
      expect((fs.statSync(nodePath.join(ROOT, f)).mode & 0o111) !== 0, `${f} is executable`).toBe(false);
    }
    // Nothing install.sh runs knows the kiosk exists.
    expect(read("install.sh")).not.toMatch(/kiosk|x64-migration/);
  });
});
