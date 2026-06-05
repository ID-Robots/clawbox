import { expect, test } from "./helpers/coverage";
import { completeSetupWizard, installClawboxMocks } from "./helpers/clawbox";

test("setup shows a gateway loading screen after the final step", async ({ page }) => {
  await installClawboxMocks(page, { timeoutCapMs: 200 });

  await page.goto("/setup");
  await completeSetupWizard(page);

  await expect(page.getByTestId("setup-completion-overlay")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
});
