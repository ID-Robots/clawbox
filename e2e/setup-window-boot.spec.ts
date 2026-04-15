import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("visiting / while setup is incomplete redirects to /setup full-screen wizard", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: false,
      wifi_configured: false,
      update_completed: false,
      password_configured: false,
      ai_model_configured: false,
      telegram_configured: false,
    },
  });

  await page.goto("/");

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  await expect(page.getByTestId("desktop-root")).toHaveCount(0);
  await expect(page.getByTestId("chrome-window-setup")).toHaveCount(0);

  await page.goto("/");

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
});
