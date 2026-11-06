import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openChatPopup } from "./helpers/clawbox";
import { installFakeGatewaySocket } from "./helpers/fake-gateway";

/**
 * Scrolling the chat while the bot writes (TASK-2222), in a real browser with
 * a real mouse wheel, on both surfaces that share the transcript: the mascot
 * chat over the desktop and the full-page chat (`/app/clawbox`).
 *
 * While a reply streamed, the chat could not be scrolled: every chunk put a
 * reader who had scrolled up back at the bottom. The owner expects:
 *   1. the reply is followed while they are at the bottom;
 *   2. scrolled up, they stay where they are while it keeps streaming;
 *   3. back at the very bottom, it is followed again.
 */

// About 15 s of streaming: long enough for all three steps on a slow runner.
const STREAM = { chunks: 300, everyMs: 50 };

async function prepare(page: Page) {
  await installFakeGatewaySocket(page, { streamedReply: STREAM });
  await installClawboxMocks(page, {
    // Real timers: the stream is paced by them, and so is the chat's wait
    // for a wheel scroll to land before it follows again.
    timeoutCapMs: 300_000,
    kvEntries: { "clawbox-mascot-hidden": "1" },
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    preferences: { ui_mascot_hidden: 1 },
  });
}

const geometry = (transcript: Locator) =>
  transcript.evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
    distance: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));

const chunksSent = (page: Page) =>
  page.evaluate(() => (window as unknown as { __streamedChunks?: number }).__streamedChunks ?? 0);

async function scrollWhileItWrites(page: Page, transcript: Locator) {
  const composer = page.locator("textarea:visible").last();
  await composer.fill("Tell me everything");
  await composer.press("Enter");

  // The reply has filled the transcript and is still coming.
  await expect.poll(async () => {
    const g = await transcript.evaluate((el) => el.scrollHeight - el.clientHeight);
    return g;
  }, { timeout: 20_000 }).toBeGreaterThan(600);
  expect(await chunksSent(page)).toBeLessThan(STREAM.chunks);

  // 1. At the bottom it is followed.
  const followedFrom = await geometry(transcript);
  await page.waitForTimeout(600);
  await expect.poll(async () => (await geometry(transcript)).distance).toBeLessThanOrEqual(2);
  expect((await geometry(transcript)).height).toBeGreaterThan(followedFrom.height);

  // 2. A few wheel ticks up: the reader stays where they put themselves.
  const box = await transcript.boundingBox();
  if (!box) throw new Error("the transcript has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);
  const reading = await geometry(transcript);
  expect(reading.distance).toBeGreaterThan(100);
  await page.waitForTimeout(1_500);
  const later = await geometry(transcript);
  expect(await chunksSent(page)).toBeLessThan(STREAM.chunks);
  expect(later.height).toBeGreaterThan(reading.height);
  expect(Math.abs(later.top - reading.top)).toBeLessThanOrEqual(1);

  // 3. Back to the very bottom: followed again as the reply keeps growing.
  await page.mouse.wheel(0, later.distance + 2_000);
  await expect.poll(async () => (await geometry(transcript)).distance).toBeLessThanOrEqual(2);
  const resumed = await geometry(transcript);
  await page.waitForTimeout(1_000);
  expect(await chunksSent(page)).toBeLessThan(STREAM.chunks);
  await expect.poll(async () => (await geometry(transcript)).distance).toBeLessThanOrEqual(2);
  expect((await geometry(transcript)).height).toBeGreaterThan(resumed.height);
}

test("the mascot chat can be scrolled while the bot writes", async ({ page }) => {
  await prepare(page);
  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await openChatPopup(page);
  const transcript = page.getByTestId("chat-transcript");
  await expect(transcript).toBeVisible();
  await expect(page.locator("textarea:visible").last()).toBeEnabled();
  await scrollWhileItWrites(page, transcript);
});

test("the full-page chat can be scrolled while the bot writes", async ({ page }) => {
  await prepare(page);
  await page.goto("/app/clawbox");
  const transcript = page.getByTestId("chatapp-transcript");
  await expect(transcript).toBeVisible();
  await expect(page.locator("textarea:visible").last()).toBeEnabled();
  await scrollWhileItWrites(page, transcript);
});
