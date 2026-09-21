import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("desktop keeps the mascot below the chat popup", async ({ page }) => {
  // At the normal 1280px test viewport the 520px popup has to clamp against
  // the right edge when the mascot starts at 85vw. Use a wide desktop here so
  // the centring branch itself is exercised; edge clamping is covered by the
  // same placement formula and must not be mistaken for misalignment.
  await page.setViewportSize({ width: 1920, height: 1080 });

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
  const popup = page.getByTestId("chat-popup");
  await expect(popup).toBeVisible();

  // Bounding boxes during the 620ms scale/rotate entrance depend on runner
  // load and are not the resting layout. Wait for that exact animation rather
  // than sleeping or accepting an ever-wider geometry tolerance.
  await expect.poll(() => popup.evaluate((element) => {
    const entrance = element.getAnimations().find((animation) =>
      animation instanceof CSSAnimation && animation.animationName === "clawChatBurstIn"
    );
    return entrance?.playState ?? "not-started";
  })).toBe("finished");

  const popupBox = await popup.boundingBox();
  const mascotBox = await page.locator('[data-mascot="crab"]').boundingBox();

  expect(popupBox).not.toBeNull();
  expect(mascotBox).not.toBeNull();

  const popupCenterX = (popupBox!.x + popupBox!.width / 2);
  const mascotCenterX = (mascotBox!.x + mascotBox!.width / 2);

  expect(Math.abs(mascotCenterX - popupCenterX)).toBeLessThanOrEqual(1);
  expect(mascotBox!.y).toBeGreaterThan(popupBox!.y + popupBox!.height - 40);
});
