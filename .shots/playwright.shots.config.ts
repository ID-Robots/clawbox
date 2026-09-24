import { defineConfig } from "@playwright/test";

// Screenshot pass for TASK-1157 — not part of the suite. Drives the running
// dev server; every file lands in the run's evidence folder.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.shots\.ts/,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: "list",
  outputDir: `${process.env.CLAWBOX_RUN_ARTIFACTS_DIR}/pw-output`,
  use: {
    baseURL: `http://127.0.0.1:${process.env.SHOTS_PORT ?? 3157}`,
    locale: "en-US",
    actionTimeout: 30_000,
    screenshot: "only-on-failure",
    navigationTimeout: 120_000,
  },
});
