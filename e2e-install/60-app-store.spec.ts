/**
 * App Store — real round trip to clawbox.com/api/store/apps, then
 * install one skill and verify it ends up registered locally.
 *
 * This test is network-dependent on clawbox.com. A regression in ClawBox's
 * own store proxy still fails the suite; the PUBLIC STORE refusing or failing
 * the runner (WAF/bot rules blocking CI's datacenter IPs, rate limits, an
 * outage) skips it instead — the same policy the INSTALL_OK flag below has
 * long applied to install-time hiccups. That distinction became load-bearing
 * on 2026-08-25, when clawbox.com started answering 403 to GitHub Actions
 * while serving residential IPs fine, and every open PR went red on this one
 * spec. We still don't cache the catalog — when the store is reachable, the
 * point is catching regressions in the live integration.
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
// False when the catalog search itself was refused by the public store
// (403/429/5xx through the proxy) — the whole store suite skips, because
// nothing downstream can pick a test app.
let STORE_OK = true;

// The store proxy (src/app/setup-api/apps/store/route.ts) forwards the
// UPSTREAM status with body {"error":"Store API error"}, and turns its own
// fetch failures into 502 {"error":"Failed to fetch store"}. Both shapes are
// clawbox.com refusing or failing the RUNNER, not a ClawBox regression.
// ClawBox-side statuses (400 validation, 401 auth, the Hermes guard) match
// neither and still fail the suite.
function storeRefusedRunner(message: string): boolean {
  return (
    /→ (403|429|5\d\d)\b.*Store API error/.test(message)
    || /→ 502\b.*Failed to fetch store/.test(message)
  );
}

test.describe.configure({ mode: "serial" });

test.describe("app store happy path", () => {
  test.afterAll(async () => {
    if (TEST_APP_ID) await uninstallApp(TEST_APP_ID).catch(() => {});
  });

  test("catalog search returns apps", async () => {
    let result: Awaited<ReturnType<typeof searchApps>>;
    try {
      result = await searchApps();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (storeRefusedRunner(message)) {
        STORE_OK = false;
        console.warn(`[app-store] public store refused the runner — skipping store suite: ${message}`);
        test.skip(true, "public store refused the runner (WAF / rate limit / outage)");
      }
      throw err;
    }
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
    test.skip(!STORE_OK, "public store refused the runner; no test app selected");
    expect(TEST_APP_ID).toBeTruthy();
    // Query with the first word of the app's slug — that's the least
    // ambiguous prefix that should still match the entry we're looking for.
    const query = TEST_APP_ID.split(/[-_]/)[0];
    const result = await searchApps(query);
    expect(result.apps.find((a) => a.slug === TEST_APP_ID)).toBeTruthy();
  });

  test("install selected app", async () => {
    test.skip(!STORE_OK, "public store refused the runner; no test app selected");
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
