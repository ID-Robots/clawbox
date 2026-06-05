import { expect, test } from "./helpers/coverage";
import { completeSetupWizard, installClawboxMocks } from "./helpers/clawbox";

// test.fixme: Ethernet-first Step 1 + WiFi handoff-redirect flow now redirects
// to the box's home-network address instead of advancing in-page, so the
// full-wizard path can't complete in e2e. Rework tracked in #167.
test.fixme("fresh setup reaches the desktop shell", async ({ page }) => {
  await installClawboxMocks(page);

  await page.goto("/setup");
  await completeSetupWizard(page);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
});
