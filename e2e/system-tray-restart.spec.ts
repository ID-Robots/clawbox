import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("system tray restart flow reaches reconnecting and restores the desktop", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeSetInterval = window.setInterval.bind(window);

    window.setTimeout = ((handler: TimerHandler, delay: number = 0, ...args: unknown[]) => {
      const numericDelay = typeof delay === "number" ? delay : Number(delay) || 0;
      return nativeSetTimeout(handler, Math.min(numericDelay, 50), ...args);
    }) as typeof window.setTimeout;

    window.setInterval = ((handler: TimerHandler, delay: number = 0, ...args: unknown[]) => {
      const numericDelay = typeof delay === "number" ? delay : Number(delay) || 0;
      return nativeSetInterval(handler, Math.min(numericDelay, 50), ...args);
    }) as typeof window.setInterval;
  });

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

  await page.getByTestId("shelf-power-button").click();
  await expect(page.getByTestId("system-tray")).toBeVisible();

  await page.getByRole("button", { name: "Restart" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByText("Restarting")).toBeVisible();
  await expect(page.getByText("Back Online")).toBeVisible();
  await expect(page.getByTestId("desktop-root")).toBeVisible();
});
