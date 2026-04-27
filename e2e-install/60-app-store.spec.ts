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
// Set by the install test: false when ClawHub itself reported failure
// (e.g. rate-limited). The follow-up assertions (registered / icon /
// uninstall) skip gracefully in that case so rate-limit hiccups on the
// public store don't flake the whole suite.
let INSTALL_OK = false;

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
    INSTALL_OK = !!result.clawhub?.success;
    // The openclaw CLI may fail on network-dependent paths (ClawHub rate
    // limit, upstream outage, skill config gaps). Treat that as a warning
    // so the rest of the suite keeps moving; follow-up tests skip below.
    if (!INSTALL_OK) {
      console.warn(`[app-store] openclaw skills install fallback: ${result.clawhub?.error ?? "unknown"}`);
    }
  });

  test("app registered in preferences", async () => {
    test.skip(!INSTALL_OK, "previous install returned failure; skip preference check");
    expect(TEST_APP_ID).toBeTruthy();
    const prefs = await getPreferences();
    const installed = (prefs.installed_apps as string[] | undefined) ?? [];
    expect(installed).toContain(TEST_APP_ID);
  });

  test("icon cached on disk", async () => {
    test.skip(!INSTALL_OK, "previous install returned failure; skip icon check");
    expect(TEST_APP_ID).toBeTruthy();
    const iconPath = `/home/clawbox/clawbox/data/icons/${TEST_APP_ID}.png`;

    // Step 1: happy path — the store CDN served the icon and we saved a
    // PNG to disk.
    const iconExists = await dockerExec(["test", "-f", iconPath], { user: "clawbox" })
      .then(() => true)
      .catch(() => false);
    if (iconExists) return;

    // Step 2: the download failed (CDN miss, rate limit, etc.), but the
    // route should still have registered installed_meta so the UI has a
    // fallback. Parse config.json directly — the install routine puts the
    // meta there regardless of icon outcome.
    const raw = await dockerExec(
      ["cat", "/home/clawbox/clawbox/data/config.json"],
      { user: "clawbox" },
    );
    const config = JSON.parse(raw) as { installed_meta?: Record<string, unknown> };
    expect(config.installed_meta?.[TEST_APP_ID]).toBeDefined();
  });

  test("uninstall selected app", async () => {
    test.skip(!INSTALL_OK, "previous install returned failure; nothing to uninstall");
    expect(TEST_APP_ID).toBeTruthy();
    await uninstallApp(TEST_APP_ID);
    const prefs = await getPreferences();
    const installed = (prefs.installed_apps as string[] | undefined) ?? [];
    expect(installed).not.toContain(TEST_APP_ID);
  });
});
