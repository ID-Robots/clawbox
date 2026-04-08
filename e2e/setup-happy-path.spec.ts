import { expect, test } from "./helpers/coverage";
import { completeSetupWizard, installClawboxMocks } from "./helpers/clawbox";

test("fresh setup reaches the desktop shell", async ({ page }) => {
  await installClawboxMocks(page);

  await page.goto("/setup");
  await completeSetupWizard(page);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
});
