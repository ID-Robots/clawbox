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
  const mascotImg = page.locator('img[src="/clawbox-crab.png"][alt=""]').first();
  await expect(mascotImg).toBeVisible();
  await page.evaluate(() => {
    const img = document.querySelector('img[src="/clawbox-crab.png"][alt=""]') as HTMLElement | null;
    if (!img) throw new Error("mascot img not found");
    const rect = img.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: cx,
      clientY: cy,
    };
    img.dispatchEvent(new PointerEvent("pointerdown", init));
    img.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  });
  await expect(page.getByTestId("chat-popup")).toBeVisible({ timeout: 15_000 });
});
