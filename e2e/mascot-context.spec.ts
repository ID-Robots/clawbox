import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("mascot tap opens the chat popup", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    preferences: {
      ui_mascot_hidden: 0,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  const boxImage = page.locator('img[src="/clawbox-box.png"]').first();
  await expect(boxImage).toBeVisible();
  await page.locator('img[src="/clawbox-crab.png"]').first().click({ force: true });
  const dockButton = page.getByTitle("Dock to right");
  const chatInput = page.locator('textarea[placeholder="Type a message..."], textarea[placeholder="Connecting..."]').first();
  await expect.poll(async () => {
    const dockVisible = await dockButton.isVisible().catch(() => false);
    const inputVisible = await chatInput.isVisible().catch(() => false);
    return dockVisible || inputVisible;
  }, { timeout: 15_000 }).toBe(true);
});
