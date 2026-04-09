import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("desktop boots first and opens setup in a window while setup is incomplete", async ({ page }) => {
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

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await expect(page.getByTestId("chrome-window-setup")).toBeVisible();
  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();

  await page.reload();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await expect(page.getByTestId("chrome-window-setup")).toBeVisible();
  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
});
