import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

test("desktop launcher, files window, and power menu work across a reload", async ({ page }) => {
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

  await openLauncher(page);
  await page.getByTestId("app-launcher").getByRole("button", { name: "Files" }).click();

  const filesWindow = page.getByTestId("chrome-window-files");
  await expect(filesWindow).toBeVisible();
  await expect(page.getByTestId("files-app")).toBeVisible();

  await filesWindow.getByRole("button", { name: "Minimize" }).click();
  await expect(page.locator('[data-testid="chrome-window-files"]')).toHaveCount(0);

  await page.getByTestId("shelf-app-files").click();
  await expect(page.getByTestId("chrome-window-files")).toBeVisible();

  await page.getByTestId("chrome-window-files").getByRole("button", { name: "Close" }).click();
  await expect(page.locator('[data-testid="chrome-window-files"]')).toHaveCount(0);

  await page.getByTestId("shelf-power-button").click();
  await expect(page.getByTestId("system-tray")).toBeVisible();

  await page.waitForTimeout(100);
  await page.reload();

  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await expect(page.locator('[data-testid="chrome-window-files"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="system-tray"]')).toHaveCount(0);
});
