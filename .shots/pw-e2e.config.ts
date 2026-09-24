import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

// Local run of the repo's own e2e specs against the standalone server this run
// started (no webServer — never builds or binds anything itself).
export default defineConfig({
  ...base,
  testDir: "../e2e",
  webServer: undefined,
  reporter: "list",
  retries: 0,
  workers: 6,
  outputDir: `${process.env.CLAWBOX_RUN_ARTIFACTS_DIR}/e2e-output`,
  use: { ...base.use, baseURL: "http://127.0.0.1:3158" },
});
