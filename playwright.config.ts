import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || process.env.PORT || 3100);
const baseURL = `http://localhost:${port}`;

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
  // 30s default per-test timeout was tight when ~40 tests run sequentially
  // against one `bun run dev` server. Five tests reliably hit 30s on first
  // action despite passing in 7-18s when run in isolation on the Jetson.
  // Doubling buys headroom without masking real bugs (a real hang would
  // still fail at 60s).
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "html",
  use: {
    baseURL,
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
    // Run a production build + the standalone production server, not
    // `bun run dev`. The dev server (Turbopack) recompiles routes on first
    // hit, and under CI's single shared server (workers: 1) that
    // recompile-under-load is what made ~6 interaction specs flake on the
    // GH-Actions runner (tracked in #114). The production server serves
    // pre-built routes with no per-request compile, and matches what ships
    // on the device. Locally we reuse an already-running server so devs
    // don't pay the build each run.
    command: process.env.CI
      ? `PORT=${port} bun run build && PORT=${port} HOSTNAME=127.0.0.1 node production-server.js`
      : `PORT=${port} bun run dev`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // A cold `next build` on the CI runner runs well past the 60s default.
    timeout: process.env.CI ? 300_000 : 120_000,
  },
});
