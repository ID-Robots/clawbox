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
    // Run e2e against a real production build, not `bun run dev`. The Turbopack
    // dev server compiled routes on demand (the first hit to `/` could outlast
    // the 15s expect timeout under CI load) and, on next 16.2, its HMR
    // websocket crashed hydration under Bun — both CI-only failures that never
    // reproduced on-device. The standalone server serves pre-built, minified
    // output with no HMR and no on-demand compile, so those classes vanish.
    //
    // SESSION_SECRET is unset for the test server so middleware auth stays
    // inactive and `/` renders the desktop directly (production deploys set it
    // via production-server.js; e2e drives the UI, not the auth gate). The
    // WebSocket-backed specs mock `window.WebSocket` in-browser, so the bare
    // standalone server (no gateway/terminal proxy) is enough.
    command: `bun run build && env -u SESSION_SECRET PORT=${port} HOSTNAME=127.0.0.1 NODE_ENV=production node .next/standalone/server.js`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
  },
});
