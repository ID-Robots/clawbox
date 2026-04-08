import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("store supports searching, viewing details, and installing an app", async ({ page }) => {
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
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByTestId("shelf-app-store").click();
  const storeWindow = page.getByTestId("chrome-window-store");
  await expect(storeWindow).toBeVisible();
  await expect(storeWindow.getByTestId("app-store")).toBeVisible();

  await storeWindow.getByPlaceholder("Search apps").fill("Weather");
  await expect(storeWindow.getByText("Weather Deck")).toBeVisible();
  await storeWindow.getByText("Weather Deck").click();

  await expect(storeWindow.getByText("Forecast cards and travel alerts tuned for the desktop shell.")).toBeVisible();
  await storeWindow.getByRole("button", { name: "Install" }).click();
  await page.getByRole("button", { name: "Install Anyway" }).click();

  await expect(storeWindow.getByText("Installed").first()).toBeVisible();
  await storeWindow.getByRole("button", { name: "arrow_back" }).click();
  await storeWindow.getByRole("button", { name: "Installed" }).click();
  await expect(storeWindow.getByText("Weather Deck")).toBeVisible();
});
