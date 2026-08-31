import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("the shelf clock opens System Settings instead of acting like a dead button", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
  });

  await page.goto("/");
  await page.getByTestId("shelf-tray-button").click();

  const settings = page.getByTestId("chrome-window-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Agent harness" })).toBeVisible();
});
