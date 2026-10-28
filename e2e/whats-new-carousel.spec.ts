import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

/**
 * "What's new in 4.3", in a real browser: a dialog of one slide per highlight
 * that fits the screen whole — the common laptop sizes and a phone — and the
 * "Free backup with ClawBox AI" offer held back until it is closed.
 *
 * The card used to be the first of the top-right notices: on a 720 px screen
 * its highlights scrolled inside a 320 px column and the offer was pushed off
 * the bottom of the screen beneath it.
 */

// A box with no ClawBox AI account, so the backup offer is due as well.
const SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: false,
  telegram_configured: true,
};

const WHATS_NEW = {
  show: true,
  release: "4.3",
  version: "4.3.0",
  edition: "openclaw",
  cta: { paidFeatures: true, editionSwitch: "hermes" },
  freeMonthCode: null,
};

const OFFER = "Free backup with ClawBox AI";

async function openDesktop(page: Page) {
  // The notices' 30 s clocks must not be squeezed into the helper's default 50 ms.
  await installClawboxMocks(page, { initialSetup: SETUP, timeoutCapMs: 300_000, chatFacts: { onboardingArmed: false } });
  const dismissals: unknown[] = [];
  await page.route("**/setup-api/whats-new", async (route) => {
    if (route.request().method() === "POST") {
      dismissals.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, show: false } });
      return;
    }
    await route.fulfill({ json: WHATS_NEW });
  });
  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  return dismissals;
}

/** The dialog is inside the viewport, and the page itself does not scroll. */
async function expectFits(page: Page) {
  const viewport = page.viewportSize()!;
  const box = await page.getByRole("dialog", { name: "What's new in 4.3" }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  // Nothing inside it is hidden behind a scroll either: the slide is whole.
  const slides = page.getByTestId("whats-new-slides");
  expect(await slides.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  const page_ = await page.evaluate(() => ({
    h: document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight,
    w: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
  }));
  expect(page_.h).toBeLessThanOrEqual(1);
  expect(page_.w).toBeLessThanOrEqual(1);
}

for (const size of [
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 375, height: 812 },
]) {
  test(`fits ${size.width}x${size.height} on every slide, and the backup offer waits until it is closed`, async ({ page }) => {
    await page.setViewportSize(size);
    const dismissals = await openDesktop(page);
    const dialog = page.getByRole("dialog", { name: "What's new in 4.3" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("This box now runs ClawBox 4.3.0.")).toBeVisible();

    const dots = dialog.getByTestId("whats-new-dot");
    const total = await dots.count();
    expect(total).toBe(7);
    for (let i = 0; i < total; i++) {
      const slide = dialog.getByTestId("whats-new-slide");
      await expect(slide).toHaveAttribute("data-slide", String(i));
      // Its screenshot has loaded: a real picture, not a broken frame.
      await expect.poll(() => slide.getByTestId("whats-new-image").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
      await expectFits(page);
      // Held back the whole time the dialog is up.
      await expect(page.getByText(OFFER)).toHaveCount(0);
      if (i < total - 1) await dialog.getByRole("button", { name: "Next" }).click();
    }

    // The last slide: the plan section and its two buttons.
    await expect(dialog.getByTestId("whats-new-plan")).toBeVisible();
    await expect(dialog.getByRole("link", { name: /See plans/ })).toBeVisible();
    await dialog.getByRole("button", { name: "Got it" }).click();
    await expect(dialog).toHaveCount(0);
    expect(dismissals).toEqual([{ release: "4.3" }]);

    // Now the offer comes up, whole and on screen.
    const offer = page.getByText(OFFER);
    await expect(offer).toBeVisible();
    await expect(offer).toBeInViewport({ ratio: 1 });
  });
}

test("the arrow keys turn the slides and Escape closes it", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const dismissals = await openDesktop(page);
  const dialog = page.getByRole("dialog", { name: "What's new in 4.3" });
  const slide = dialog.getByTestId("whats-new-slide");
  await expect(slide).toHaveAttribute("data-slide", "0");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(slide).toHaveAttribute("data-slide", "2");
  await page.keyboard.press("ArrowLeft");
  await expect(slide).toHaveAttribute("data-slide", "1");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(dismissals).toEqual([{ release: "4.3" }]);
  await expect(page.getByText(OFFER)).toBeVisible();
});

for (const size of [
  { width: 1366, height: 768, touch: false },
  { width: 375, height: 812, touch: true },
]) {
  test.describe(`the screenshot, full screen, at ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch });

    test("opens at full resolution, fits the screen, turns with the arrows, and closes without closing the card", async ({ page }) => {
      const dismissals = await openDesktop(page);
      const card = page.getByRole("dialog", { name: "What's new in 4.3" });
      await expect(card).toBeVisible();

      await card.getByRole("button", { name: "View screenshot full screen" }).click();
      const view = page.getByTestId("whats-new-lightbox");
      await expect(view).toBeVisible();
      await expect(view).toHaveAccessibleName("Screenshot: Screenshots, built in");
      const image = view.getByTestId("whats-new-lightbox-image");
      // The full-resolution file, loaded, and drawn whole inside the screen.
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(1024);
      const box = await image.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
      // Never drawn larger than the file is.
      const natural = await image.evaluate((img: HTMLImageElement) => img.naturalWidth);
      expect(box!.width).toBeLessThanOrEqual(natural + 1);

      // The next feature's screenshot, by key; the previous one by its button.
      await page.keyboard.press("ArrowRight");
      await expect(image).toHaveAttribute("src", "/whats-new/4.3/agent-browser-full.webp");
      await view.getByRole("button", { name: "Previous screenshot" }).click();
      await expect(image).toHaveAttribute("src", "/whats-new/4.3/screenshot-full.webp");

      // Escape closes the view, and only the view.
      await page.keyboard.press("Escape");
      await expect(view).toHaveCount(0);
      await expect(card).toBeVisible();
      expect(dismissals).toEqual([]);

      // A click on the picture opens it; a click (or a tap) outside it closes it.
      await card.getByTestId("whats-new-image").click();
      await expect(view).toBeVisible();
      if (size.touch) await page.touchscreen.tap(size.width / 2, 20);
      else await page.mouse.click(10, size.height / 2);
      await expect(view).toHaveCount(0);
      await expect(card).toBeVisible();
      expect(dismissals).toEqual([]);
    });
  });
}
