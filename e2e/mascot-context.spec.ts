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

  const mascotImg = page.locator('img[src="/clawbox-crab.png"][alt=""]').first();
  await expect(mascotImg).toBeVisible();
  // Only meaningful once the crab is on screen: Mascot renders null until the
  // pet status resolves, so asserting absence any earlier passes vacuously.
  await expect(page.locator('img[src="/clawbox-box.png"]')).toHaveCount(0);

  const chatPopup = page.getByTestId("chat-popup");
  // Tap the crab with a real pointer, not a synthetic PointerEvent: the handler
  // calls `setPointerCapture(e.pointerId)`, which throws for a dispatched event
  // (no active pointer with that id) and aborts the tap. A Playwright click uses
  // a genuine, capturable pointer and waits for actionability. Because tapping
  // *toggles* the chat (onTap -> setChatOpen(o => !o)), only click while it is
  // still closed and stop the moment it opens, so exactly one tap lands. (This
  // surfaced only on the production build — see #114.)
  await expect(async () => {
    if (!(await chatPopup.isVisible())) {
      await mascotImg.click({ timeout: 2000, force: true });
    }
    await expect(chatPopup).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000, intervals: [400, 400, 600] });
});
