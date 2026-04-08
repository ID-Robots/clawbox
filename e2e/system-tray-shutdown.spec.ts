import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("system tray shutdown flow reaches the powered off overlay", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay: number = 0, ...args: unknown[]) => {
      const numericDelay = typeof delay === "number" ? delay : Number(delay) || 0;
      return nativeSetTimeout(handler, Math.min(numericDelay, 50), ...args);
    }) as typeof window.setTimeout;
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

  await page.getByRole("button", { name: "Shut Down" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("heading", { name: /Shutting down/i })).toBeVisible();
});
