/**
 * Separate Playwright config for the full-install e2e suite. Unlike the
 * mock-backed e2e/ directory, these tests boot a real systemd container and
 * run the actual install.sh — so the timeouts and lifecycle look very
 * different.
 *
 * Usage:
 *   bunx playwright test --config e2e-install/playwright.config.ts
 */
import { defineConfig } from "@playwright/test";

const CLAWBOX_PORT = process.env.CLAWBOX_PORT ?? "8080";

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,              // one shared container, strict order
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,                        // install failures should fail loud
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  // Each step (install, update, restart) can legitimately take minutes, so
  // test-level and per-action timeouts are much higher than UI tests.
  timeout: 60 * 60_000,              // 1h per test
  expect: { timeout: 120_000 },
  use: {
    baseURL: `http://localhost:${CLAWBOX_PORT}`,
    // US English, pinned. A freshly installed box stores no `pref:ui_language`
    // — that is correct behaviour, and the desktop then takes its language from
    // the browser (`detectLocale` in src/lib/i18n.tsx). These specs drive the
    // real UI by its English copy ("Continue with Ethernet", "Next"), so the
    // browser's language is part of the fixture rather than whatever the runner
    // happens to be set to: unpinned, the same install reads German on a German
    // machine and every by-name locator fails.
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: "install", testMatch: /.*\.spec\.ts/ },
  ],
});
