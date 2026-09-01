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

  const popup = page.getByTestId("chat-popup");
  // The desktop entrance is a 0.62s spring burst out of the mascot (a scale
  // from the anchor point with an overshoot), so a bounding box read while it
  // plays is whatever frame the runner happened to catch: early in the burst
  // the tiny popup sits right over the crab, at the overshoot it is wider
  // than its resting size. Wait for it to settle, then measure layout.
  await popup.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

  const popupBox = await popup.boundingBox();
  const mascotBox = await page.locator('img[src="/clawbox-box.png"]').first().boundingBox();

  expect(popupBox).not.toBeNull();
  expect(mascotBox).not.toBeNull();

  const mascotCenterX = (mascotBox!.x + mascotBox!.width / 2);

  // "Above the mascot": the crab is under the popup's span, and the popup is
  // as centred on it as the screen allows. At 1280px wide a 520px popup over a
  // crab at 85vw is clamped against the right edge, so centre-to-centre is
  // ~76px here and would be 0 on a wider screen — the span is the invariant,
  // the offset is not.
  expect(mascotCenterX).toBeGreaterThan(popupBox!.x + 40);
  expect(mascotCenterX).toBeLessThan(popupBox!.x + popupBox!.width - 40);
  const viewportWidth = page.viewportSize()!.width;
  const wanted = Math.min(mascotCenterX - popupBox!.width / 2, viewportWidth - popupBox!.width - 8);
  expect(Math.abs(popupBox!.x - wanted)).toBeLessThan(2);
  expect(mascotBox!.y).toBeGreaterThan(popupBox!.y + popupBox!.height - 40);
});
