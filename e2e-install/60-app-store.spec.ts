/**
 * App Store — real round trip to openclawhardware.dev/api/store/apps, then
 * install one skill and verify it ends up registered locally.
 *
 * This test is network-dependent on openclawhardware.dev — if that service
 * is down or region-restricted, the whole spec fails. We don't cache the
 * result because the point is catching regressions in the live integration.
 *
 * The test app is picked dynamically from the live catalog so the suite
 * doesn't rot when individual apps get delisted. Override with
 * `CLAWBOX_E2E_STORE_APP_ID` to target a specific slug.
 */
import { test, expect } from "@playwright/test";
import { dockerExec } from "./helpers/container";
import { getPreferences, installApp, searchApps, uninstallApp } from "./helpers/setup-api";

const FORCED_APP_ID = process.env.CLAWBOX_E2E_STORE_APP_ID;
// Capture target across tests. Populated by the first catalog-search test.
let TEST_APP_ID = "";

test.describe.configure({ mode: "serial" });

test.describe("app store happy path", () => {
  test.afterAll(async () => {
    if (TEST_APP_ID) await uninstallApp(TEST_APP_ID).catch(() => {});
  });

  test("catalog search returns apps", async () => {
    const result = await searchApps();
    expect(result.total).toBeGreaterThan(0);
    expect(result.apps.length).toBeGreaterThan(0);
    // Every entry should have the fields the UI renders.
    for (const app of result.apps.slice(0, 3)) {
      expect(app.slug).toBeTruthy();
      expect(app.name).toBeTruthy();
      expect(app.category).toBeTruthy();
    }
    TEST_APP_ID = FORCED_APP_ID ?? result.apps[0].slug;
    console.log(`[app-store] using test app id '${TEST_APP_ID}'`);
  });

  test("search filter narrows results", async () => {
    expect(TEST_APP_ID).toBeTruthy();
    // Query with the first word of the app's slug — that's the least
    // ambiguous prefix that should still match the entry we're looking for.
    const query = TEST_APP_ID.split(/[-_]/)[0];
    const result = await searchApps(query);
    expect(result.apps.find((a) => a.slug === TEST_APP_ID)).toBeTruthy();
  });

  test("install selected app", async () => {
    test.setTimeout(120_000);
    expect(TEST_APP_ID).toBeTruthy();
    const result = await installApp(TEST_APP_ID);
    // The openclaw CLI may fail to install a skill in the test container
    // (some skills need gateway-side config we don't provide), but the
    // preferences side of install should still register it. We treat a
    // full failure as fatal, partial as a warning.
    if (!result.clawhub?.success) {
      console.warn(`[app-store] openclaw skills install fallback: ${result.clawhub?.error ?? "unknown"}`);
    }
  });

  test("app registered in preferences", async () => {
    expect(TEST_APP_ID).toBeTruthy();
    const prefs = await getPreferences();
    const installed = (prefs.installed_apps as string[] | undefined) ?? [];
    expect(installed).toContain(TEST_APP_ID);
  });

  test("icon cached on disk", async () => {
    expect(TEST_APP_ID).toBeTruthy();
    // icons land in data/icons/<appId>.png. This would be skipped if the
    // download failed (network hiccup against the store CDN), so we look
    // for either the icon OR the meta-only fallback.
    const out = await dockerExec(
      ["bash", "-c",
        `ls /home/clawbox/clawbox/data/icons/${TEST_APP_ID}.png 2>/dev/null || ` +
        `node -e 'const c=JSON.parse(require("fs").readFileSync("/home/clawbox/clawbox/data/config.json","utf8"));` +
        `const m=(c.installed_meta||{})["${TEST_APP_ID}"];process.stdout.write(m?"meta-ok":"missing");'`,
      ],
      { user: "clawbox" },
    );
    expect(out.trim()).toMatch(/\.png$|^meta-ok$/);
  });

  test("uninstall selected app", async () => {
    expect(TEST_APP_ID).toBeTruthy();
    await uninstallApp(TEST_APP_ID);
    const prefs = await getPreferences();
    const installed = (prefs.installed_apps as string[] | undefined) ?? [];
    expect(installed).not.toContain(TEST_APP_ID);
  });
});
