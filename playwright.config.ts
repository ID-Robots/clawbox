import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Mirror CI's retry strategy locally too. Tests that compress
  // setTimeout/setInterval (e.g. system-tray-restart) are timing-sensitive
  // and flake on slow runs; one auto-retry kills the noise without hiding
  // a real regression (which would fail twice in a row).
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    // CI runners share one `bun run dev` server across all sequential
    // tests (workers: 1). After ~35 tests the dev server gets sluggish
    // and later-in-suite waits hit the default 5s action timeout. The
    // 15s bump absorbs that variance without rewriting tests; mirrors
    // the explicit 15s overrides already in mascot-context and chat-popup.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
