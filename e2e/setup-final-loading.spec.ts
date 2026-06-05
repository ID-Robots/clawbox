import { expect, test } from "./helpers/coverage";
import { completeSetupWizard, installClawboxMocks } from "./helpers/clawbox";

// test.fixme: Ethernet-first Step 1 + WiFi handoff-redirect flow now redirects
// to the box's home-network address instead of advancing in-page, so the
// full-wizard path can't complete in e2e. Rework tracked in #167.
test.fixme("setup shows a gateway loading screen after the final step", async ({ page }) => {
  await installClawboxMocks(page, { timeoutCapMs: 200 });

  await page.goto("/setup");
  await completeSetupWizard(page);

  await expect(page.getByTestId("setup-completion-overlay")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
});
