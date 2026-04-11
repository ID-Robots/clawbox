import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("desktop first render keeps the mascot below an already-open chat popup", async ({ page }) => {
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
      ui_chat_open: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await expect(page.getByTestId("chat-popup")).toBeVisible();

  const popupBox = await page.getByTestId("chat-popup").boundingBox();
  const mascotBox = await page.locator('img[src="/clawbox-box.png"]').first().boundingBox();

  expect(popupBox).not.toBeNull();
  expect(mascotBox).not.toBeNull();

  const popupCenterX = (popupBox!.x + popupBox!.width / 2);
  const mascotCenterX = (mascotBox!.x + mascotBox!.width / 2);

  expect(Math.abs(mascotCenterX - popupCenterX)).toBeLessThan(60);
  expect(mascotBox!.y).toBeGreaterThan(popupBox!.y + popupBox!.height - 40);
});
