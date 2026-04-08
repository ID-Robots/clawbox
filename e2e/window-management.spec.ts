import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("chrome windows can maximize and restore", async ({ page }) => {
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

  await page.getByTestId("shelf-app-settings").click();
  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible();

  const before = await settingsWindow.boundingBox();
  if (!before) {
    throw new Error("Settings window bounds were not available");
  }

  await settingsWindow.getByRole("button", { name: "Maximize" }).click();
  const maximized = await settingsWindow.boundingBox();
  if (!maximized) {
    throw new Error("Maximized settings window bounds were not available");
  }
  expect(maximized.width).toBeGreaterThan(before.width);
  expect(maximized.height).toBeGreaterThan(before.height);

  await settingsWindow.getByRole("button", { name: "Restore" }).click();
  const restored = await settingsWindow.boundingBox();
  if (!restored) {
    throw new Error("Restored settings window bounds were not available");
  }
  expect(Math.round(restored.width)).toBe(Math.round(before.width));
});
