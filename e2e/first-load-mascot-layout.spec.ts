import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("desktop keeps the mascot below the chat popup", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    // A persisted `ui_chat_open` no longer opens the floating popup — that
    // is deliberately ignored on load now (see src/app/page.tsx), so it
    // can't set up the state this test measures. Use the one load-time path
    // that still opens it: the fresh-install greeting, which fires when no
    // wallpaper and no desktop apps have been saved yet. That matters for
    // more than convenience — the popup must be open at mount so `frozen`
    // pins the crab immediately. Opening it later (via a click) races the
    // mascot's autonomous walk, which starts ~3.5s in and drifts the crab
    // away from the popup's `mascotX` anchor under CI load.
    preferences: {
      ui_mascot_hidden: 0,
      wp_id: null,
      desktop_apps: null,
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
