import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

/**
 * "What's new in 4.3", in a real browser: a dialog of one slide per highlight
 * that fits the screen whole — the common laptop sizes and a phone — and the
 * "Free backup with ClawBox AI" offer held back until it is closed. Then the
 * System Update window's own "What's new" (TASK-2121): the release's showcase,
 * one feature at a time beside the steps, still drawing every screenshot once
 * the box has gone down to restart.
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

/* ── The System Update window's showcase ──────────────────────────────── */

const RUN_STEPS = [
  "Refreshing updater scripts", "Updating system packages", "Installing Chromium", "Installing VNC (Remote Desktop)",
  "Updating ClawBox and restarting", "Applying system fixups", "Verifying gateway health",
].map((label, index) => ({ id: `step_${index}`, label, status: index < 2 ? "completed" : index === 2 ? "running" : "pending" }));

const SHOWCASE_CHIPS = ["Screenshots", "One browser for you", "Share an app with a public link", "xAI Grok", "Hold to talk", "The Coding Agent", "Prime Radiant"];
const FULL_IMAGES = ["screenshot", "agent-browser", "public-link", "model-picker", "hold-to-talk", "agent-chart", "prime-radiant"]
  .map((name) => `/whats-new/4.3/${name}-full.webp`);

/** The System Update window, standalone, over a run of 4.3.0 in progress. */
async function openUpdateWindow(page: Page) {
  await installClawboxMocks(page, { initialSetup: SETUP, timeoutCapMs: 300_000, chatFacts: { onboardingArmed: false } });
  await page.route("**/setup-api/update/status", (route) => route.fulfill({ json: { phase: "running", currentStepIndex: 2, steps: RUN_STEPS } }));
  await page.route("**/setup-api/update/versions", (route) => route.fulfill({
    json: {
      clawbox: { current: "4.2.5", target: "4.3.0", updateAvailable: true },
      openclaw: { current: "2026.10.3", target: "2026.10.7", updateAvailable: true },
      edition: "openclaw",
      remote: { reachable: true },
    },
  }));
  await page.route("**/setup-api/update/whats-new", (route) => route.fulfill({
    json: { version: "4.3.0", channel: "beta", source: "none", highlights: [], releaseUrl: "https://github.com/ID-Robots/clawbox/releases/tag/v4.3.0" },
  }));
  await page.goto("/app/system_update");
  const showcase = page.getByTestId("whats-new-showcase");
  await expect(showcase).toBeVisible({ timeout: 15_000 });
  return showcase;
}

/** The stage's screenshot has loaded: a real picture, not a broken frame. */
async function expectStageImage(page: Page, src: string) {
  const image = page.getByTestId("whats-new-showcase").getByTestId("update-whats-new-image");
  await expect(image).toHaveAttribute("src", src);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
}

test.describe("the System Update window's What's new showcase", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("shows one feature at a time, picked by a chip or ←/→, and turns by itself", async ({ page }) => {
    const showcase = await openUpdateWindow(page);
    const region = page.getByRole("region", { name: "What's new in ClawBox 4.3.0" });
    await expect(region).toHaveAttribute("data-variant", "grid");
    await expect(showcase).toHaveAttribute("data-index", "0");
    await expect(showcase.getByTestId("whats-new-showcase-count")).toHaveText("01 / 07 · New in 4.3");
    await expect(showcase.getByRole("heading", { name: "Screenshots, built in" })).toBeAttached();
    await expectStageImage(page, FULL_IMAGES[0]);
    await expect(showcase.getByRole("tab")).toHaveText(SHOWCASE_CHIPS);
    // The title types in; the whole of it is there within a second.
    await expect(showcase.getByTestId("whats-new-showcase-typed")).toContainText("Screenshots, built in");
    await expect(showcase.getByTestId("whats-new-showcase-logo")).toBeVisible();

    await showcase.getByRole("tab", { name: "Prime Radiant" }).click();
    await expect(showcase).toHaveAttribute("data-index", "6");
    await expectStageImage(page, FULL_IMAGES[6]);
    await expect(showcase.getByTestId("whats-new-showcase-live")).toHaveText("Prime Radiant, a living wiki");

    // The keyboard: → from the last wraps to the first, ← goes back.
    await page.keyboard.press("ArrowRight");
    await expect(showcase).toHaveAttribute("data-index", "0");
    await expect(showcase.getByRole("tab", { name: "Screenshots" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(showcase).toHaveAttribute("data-index", "6");

    // Held while the pointer or the focus is in it; on again once both have left.
    await expect(showcase).toHaveAttribute("data-paused", "true");
    await page.mouse.move(5, 5);
    await page.getByTestId("update-run").click({ position: { x: 5, y: 5 } });
    await expect(showcase).toHaveAttribute("data-paused", "false");
    await expect(showcase).toHaveAttribute("data-index", "0", { timeout: 9_000 });
    await expectStageImage(page, FULL_IMAGES[0]);
  });

  test("keeps the stage at the screenshots' 16:10 and sizes its overlay text from the stage, with the demo running", async ({ page }) => {
    const showcase = await openUpdateWindow(page);
    await showcase.getByRole("tab", { name: "Share an app with a public link" }).click();
    const stage = showcase.getByTestId("whats-new-showcase-stage");
    const box = (await stage.boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(1.6, 1);
    const fontSize = await stage.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeCloseTo(box.width * 0.0115, 0);
    // The camera moves and the link's dialog comes up, then the link is copied.
    expect(await stage.locator(".wns-cam").evaluate((el) => getComputedStyle(el).animationName)).toBe("wns-lkcam");
    await expect(stage.locator(".wns-toast")).toHaveCSS("opacity", "1", { timeout: 6_000 });
    await expect(stage.locator(".wns-copy")).toHaveText("✓ Copied", { timeout: 6_000 });
    // It all sits inside the window: nothing pushes the page sideways.
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("in a narrower window it stacks the text over a full-width screenshot instead of squeezing it", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const showcase = await openUpdateWindow(page);
    const hero = (await showcase.boundingBox())!;
    const stage = (await showcase.getByTestId("whats-new-showcase-stage").boundingBox())!;
    expect(hero.width).toBeLessThan(672);
    expect(stage.width).toBeGreaterThan(hero.width * 0.8);
    const title = (await showcase.getByRole("heading", { name: "Screenshots, built in" }).boundingBox())!;
    expect(stage.y).toBeGreaterThan(title.y + title.height);
  });

  test("with reduced motion: no zoom and no typing, every demo already at its end", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const showcase = await openUpdateWindow(page);
    await expect(showcase).toHaveAttribute("data-motion", "reduce");
    await expect(showcase.getByTestId("whats-new-showcase-typed")).toHaveText("Screenshots, built inScreenshots, built in");
    await expect(showcase.locator(".wns-caret")).toHaveCount(0);
    const stage = showcase.getByTestId("whats-new-showcase-stage");
    expect(await stage.locator(".wns-cam").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    // The demo's result at once: the "saved" toast, not the flash before it.
    await expect(stage.locator(".wns-toast")).toHaveCSS("opacity", "1");
    await expect(stage.locator(".wns-flash")).toHaveCSS("opacity", "0");
    await showcase.getByRole("tab", { name: "Hold to talk" }).click();
    await expect(stage).toContainText("Recording 0:04");
  });

  test("in Settings → System Update's 672 px pane it is narrow: the text over a cropped, legible screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openUpdateWindow(page);
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "System Update" }).first().click();
    const showcase = page.getByTestId("whats-new-showcase");
    await expect(showcase).toHaveAttribute("data-layout", "narrow", { timeout: 15_000 });
    const stage = showcase.getByTestId("whats-new-showcase-stage");
    const box = (await stage.boundingBox())!;
    expect(box.width).toBeGreaterThan((await showcase.boundingBox())!.width * 0.8);
    expect(box.width / box.height).toBeCloseTo(4 / 3, 1);
    expect(await stage.locator(".wns-cam").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(10);
  });

  test("goes on drawing every feature, screenshot and all, once the box has gone down", async ({ page }) => {
    const showcase = await openUpdateWindow(page);
    // Every screenshot is fetched the moment the panel is drawn.
    for (const preload of await showcase.locator("img[data-showcase-image]").all()) {
      await expect.poll(() => preload.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    }
    // The server goes away: every request from here on fails.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const requested: string[] = [];
    await page.route("**/*", (route) => {
      requested.push(new URL(route.request().url()).pathname);
      return route.abort("connectionrefused");
    });
    for (const [index, chip] of SHOWCASE_CHIPS.entries()) {
      await showcase.getByRole("tab", { name: chip }).click();
      await expectStageImage(page, FULL_IMAGES[index]);
    }
    await expect(showcase.getByTestId("whats-new-showcase-logo").locator("img")).toBeVisible();
    // No screenshot, font or icon was asked of the server that is down.
    expect(requested.filter((path) => !path.startsWith("/setup-api/"))).toEqual([]);
  });
});

/* ── On a phone: the owner watching the update through the box's tunnel ─── */

/** A real touch swipe across the page, through the browser's own input. */
async function swipe(page: Page, from: [number, number], to: [number, number]) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
  for (let step = 1; step <= 8; step += 1) {
    const x = from[0] + ((to[0] - from[0]) * step) / 8;
    const y = from[1] + ((to[1] - from[1]) * step) / 8;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

for (const size of [{ width: 360, height: 740 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
  test.describe(`the update screen's showcase on a ${size.width}x${size.height} phone`, () => {
    test.use({ viewport: size, isMobile: true, hasTouch: true });

    test("nothing scrolls sideways, the steps come first, and the screenshot is cropped to a legible size", async ({ page }) => {
      const showcase = await openUpdateWindow(page);
      await expect(showcase).toHaveAttribute("data-layout", "narrow");
      // The page itself never scrolls sideways; only the chips' own row does.
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth)).toBeLessThanOrEqual(1);
      const steps = (await page.getByRole("progressbar", { name: "System Update" }).boundingBox())!;
      const hero = (await showcase.boundingBox())!;
      expect(steps.y + steps.height).toBeLessThanOrEqual(hero.y);
      expect(hero.width).toBeGreaterThan(size.width * 0.85);
      expect(hero.x + hero.width).toBeLessThanOrEqual(size.width);
      // The demo's text is drawn at the cropped picture's size, not the stage's 3–4 px.
      const stage = showcase.getByTestId("whats-new-showcase-stage");
      expect(await stage.locator(".wns-cam").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(10);
      const chips = showcase.getByTestId("whats-new-showcase-chips");
      expect(await chips.evaluate((el) => getComputedStyle(el).flexWrap)).toBe("nowrap");
      expect(await chips.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(size.width);
      await expect(page.getByTestId("update-run-notice")).toBeInViewport();
    });

    test("a swipe turns it and a tap holds it", async ({ page }) => {
      const showcase = await openUpdateWindow(page);
      const stage = showcase.getByTestId("whats-new-showcase-stage");
      // The stage floats by design, so it is never "stable": no actionability waits on it.
      await stage.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const box = (await stage.boundingBox())!;
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
      await swipe(page, [x + box.width * 0.3, y], [x - box.width * 0.3, y + 6]);
      await expect(showcase).toHaveAttribute("data-index", "1");
      await swipe(page, [x - box.width * 0.3, y], [x + box.width * 0.3, y]);
      await expect(showcase).toHaveAttribute("data-index", "0");
      await page.touchscreen.tap(x, y);
      await expect(showcase).toHaveAttribute("data-held", "true");
      await expect(showcase.getByTestId("whats-new-showcase-held")).toBeVisible();
      await page.touchscreen.tap(x, y);
      await expect(showcase).toHaveAttribute("data-paused", "false");
    });
  });
}
