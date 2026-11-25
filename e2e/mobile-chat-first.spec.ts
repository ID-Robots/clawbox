import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

/**
 * Chat-first on a phone (src/lib/mobile-chat-first.ts): the page lands in the
 * chat with an in-flow microphone, the desktop is one labelled tap away and
 * the shelf crab brings the chat back. A big screen with a mouse is unchanged.
 *
 * Screenshots go to the test's output folder, for a human to look at.
 */
async function installFakeGatewaySocket(page: Page) {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor() {
        setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({
                type: "event",
                event: "connect.challenge",
                payload: { nonce: "test-nonce" },
              }),
            } as MessageEvent<string>);
          }, 50);
        }, 10);
      }

      send(raw: string) {
        const message = JSON.parse(raw) as {
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };

        const emit = (payload: unknown) => {
          this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
        };

        if (message.method === "connect") {
          emit({
            type: "res",
            id: message.id,
            ok: true,
            payload: {
              snapshot: {
                sessionDefaults: {
                  mainSessionKey: "main",
                },
              },
            },
          });
          return;
        }

        if (message.method === "chat.history") {
          // Counted so a test can wait for the transcript read to have HAPPENED
          // before asserting that nothing was sent. Without that, "no turn went
          // out" is asserted before the greeting path could have run and would
          // pass against a regression that still greets.
          const w = window as unknown as { __chatHistoryReads?: number };
          w.__chatHistoryReads = (w.__chatHistoryReads ?? 0) + 1;
          emit({
            type: "res",
            id: message.id,
            ok: true,
            payload: {
              messages: [],
            },
          });
          return;
        }

        if (message.method === "chat.send") {
          // The popup greets an empty transcript with a "hi" of its own, and
          // that turn is answered here like any other. The owner's turn gets a
          // reply that names it, so a test can tell the two apart: asserting
          // the greeting's words after typing found that bubble AND the new
          // one — the same text twice, which a strict locator refuses — and
          // passed only when it looked before the second reply landed.
          const w = window as unknown as { __chatSends?: string[] };
          w.__chatSends = w.__chatSends ?? [];
          const sent = String((message.params as { message?: unknown } | undefined)?.message ?? "");
          w.__chatSends.push(sent);
          const reply = sent === "hi" ? "Hello from the fake gateway" : `Fake gateway heard: ${sent}`;
          emit({
            type: "res",
            id: message.id,
            ok: true,
            payload: {},
          });
          setTimeout(() => {
            emit({
              type: "event",
              event: "chat",
              payload: {
                sessionKey: "main",
                state: "delta",
                message: { text: reply.slice(0, 14) },
              },
            });
          }, 20);
          // A test that needs a reply IN FLIGHT (the Stop control on screen)
          // sets this; the owner's turn then starts and never finishes.
          if (sent !== "hi" && (window as unknown as { __holdReplies?: boolean }).__holdReplies) return;
          setTimeout(() => {
            emit({
              type: "event",
              event: "chat",
              payload: {
                sessionKey: "main",
                state: "final",
                message: { text: reply },
              },
            });
          }, 50);
          return;
        }

        // Session RPCs are part of a real reconnect/provider switch. Leaving
        // them unanswered only worked when the global timer cap forced their
        // failures early; the mock must acknowledge the protocol instead.
        if (["chat.abort", "sessions.reset", "sessions.patch", "sessions.subscribe"].includes(message.method)) {
          emit({
            type: "res",
            id: message.id,
            ok: true,
            payload: {},
          });
        }
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new Event("close"));
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
  });
}

const SETUP = {
  timeoutCapMs: 300_000,
  // A linked box: the microphone is offered only where there is a ClawBox AI
  // credential to transcribe with.
  chatFacts: { hasClawaiToken: true },
  initialSetup: {
    setup_complete: true,
    wifi_configured: true,
    update_completed: true,
    password_configured: true,
    ai_model_configured: true,
    telegram_configured: true,
  },
  // Not a fresh install, so the one-time greeting auto-open is not what opens
  // the chat here.
  preferences: { desktop_apps: ["clawbox", "files", "settings"], wp_id: "clawbox" },
};

const chatOpen = (page: Page) => expect(page.getByTestId("chat-popup")).toHaveCSS("pointer-events", "auto");

/**
 * A phone held upright (TASK-2778): no fold and no pills. The composer is one
 * rounded box — the text across the top, then "+", the model pill, the
 * microphone and Send on one row under it — and the long labels are read in
 * the model sheet the pill opens.
 */
async function assertPortraitComposer(
  page: Page,
  composer: Locator,
  viewport: { width: number; height: number },
  modelLabel: string,
  locale: string,
  testInfo: TestInfo,
) {
  const primary = composer.locator(".chat-composer-primary");
  async function assertRow() {
    const geometry = await composer.evaluate(el => {
      const row = el.querySelector(".chat-composer-primary")!;
      const field = row.querySelector("textarea")!.getBoundingClientRect();
      const order = [...row.children].map(node => node.getAttribute("data-testid") ?? node.tagName);
      const controls = [...row.querySelectorAll("button")].map(node => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      });
      return {
        order, controls, fieldBottom: field.bottom, fieldWidth: field.width, rowWidth: row.getBoundingClientRect().width,
        rows: el.children.length, pills: el.querySelectorAll(".header-dropdown-trigger").length,
        scrollWidth: el.scrollWidth, width: el.clientWidth,
      };
    });
    // Send keeps its place whether or not anything is typed, the microphone too.
    expect(geometry.order).toEqual(["TEXTAREA", "composer-options-toggle", "DIV", "voice-record", "chat-send"]);
    expect(geometry.rows).toBe(1);
    expect(geometry.pills).toBe(0);
    expect(geometry.fieldWidth).toBeGreaterThan(geometry.rowWidth * 0.8);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    for (const box of geometry.controls) {
      // Under the text, inside the screen, and a thumb's size.
      expect(box.y).toBeGreaterThanOrEqual(geometry.fieldBottom - 0.5);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(viewport.width);
      expect(box.bottom).toBeLessThanOrEqual(viewport.height);
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.width).toBeGreaterThanOrEqual(40);
    }
    for (let i = 0; i < geometry.controls.length; i++) {
      for (const b of geometry.controls.slice(i + 1)) {
        const a = geometry.controls[i];
        expect(a.right <= b.x + 0.5 || b.right <= a.x + 0.5 || a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5).toBe(true);
      }
    }
  }
  await assertRow();
  await page.screenshot({ path: testInfo.outputPath("composer-idle.png") });
  await primary.locator("textarea").fill(locale === "bg" ? "Напиши кратък отговор" : "Schreibe eine kurze Antwort");
  await expect(primary.getByTestId("chat-send")).toBeEnabled();
  // Upright the microphone stays beside Send while the owner types.
  await expect(page.getByTestId("voice-record")).toHaveCount(1);
  await assertRow();
  await page.screenshot({ path: testInfo.outputPath("composer-typing.png") });
  // The pill opens the model sheet, the full label in it and inside the screen.
  await page.getByTestId("chat-model-pill").click();
  const sheet = page.getByTestId("chat-model-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(modelLabel, { exact: true })).toBeVisible();
  // Measured once its slide up from the bottom edge has landed.
  await expect.poll(async () => {
    const box = await sheet.boundingBox();
    return box ? Math.round(box.y + box.height) : -1;
  }).toBe(viewport.height);
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.x).toBeGreaterThanOrEqual(0);
  expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: testInfo.outputPath("model-sheet.png") });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
}
// A closed chat is not rendered at all (ChatPopup returns null while !isOpen).
const chatClosed = (page: Page) => expect(page.getByTestId("chat-popup")).toHaveCount(0);

for (const locale of ["bg", "de"]) {
  for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 740, height: 360 }, { width: 390, height: 360 }]) {
    test.describe(`composer ${locale} ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport, hasTouch: true, isMobile: true });
      test("keeps primary actions and long picker labels in separate, non-overlapping rows", async ({ page }, testInfo) => {
        await installFakeGatewaySocket(page);
        await installClawboxMocks(page, {
          ...SETUP,
          preferences: { ...SETUP.preferences, ui_language: locale },
        });
        const label = locale === "bg" ? "Персонализиран асистент за програмиране" : "Benutzerdefinierter Programmierassistent";
        const modelLabel = locale === "bg" ? "Разширен модел за сложни задачи" : "Erweitertes Modell für komplexe Aufgaben";
        await page.route("**/setup-api/chat/model", route => route.fulfill({
          json: {
            activeOptionId: "anthropic", activeModel: "anthropic/custom-long-model", activeSource: "primary",
            options: [{ id: "anthropic", provider: "anthropic", label, model: "anthropic/custom-long-model", available: true, settingsSection: "ai", isLocal: false }],
            primary: { available: true, model: "anthropic/custom-long-model", label },
            local: { available: false, model: null, label: null },
          },
        }));
        await page.route("**/setup-api/ai-models/catalog?**", route => route.fulfill({
          json: { provider: "anthropic", defaultModelId: "custom-long-model", allowCustom: true, models: [
            { id: "custom-long-model", label: modelLabel }, { id: "other", label: "Other" },
          ] },
        }));
        await page.goto("/");
        await chatOpen(page);
        const composer = page.getByTestId("chat-composer");
        const primary = composer.locator(".chat-composer-primary");
        const pills = composer.locator(".header-dropdown-trigger");
        // A phone held upright carries the microphone in the input row
        // (TASK-1003). Either way up a phone opens in fullscreen chat
        // (TASK-1157): the fold control leads the input row and the
        // attachment, Create and the pickers wait behind it.
        const portrait = viewport.height > viewport.width;
        const fold = page.getByTestId("composer-options-toggle");
        await expect(page.getByTestId("voice-record")).toBeEnabled();
        // The greeting turn is over, so the slot beside the field is at rest.
        await expect(page.getByText("Hello from the fake gateway")).toBeVisible();
        if (portrait) {
          await assertPortraitComposer(page, composer, viewport, modelLabel, locale, testInfo);
          return;
        }
        // Folded by default — and the choice still legible without a tap.
        await expect(pills).toHaveCount(0);
        await expect(page.getByTestId("chat-pill-summary")).toBeVisible();
        await fold.click();
        await expect(pills).toHaveCount(3);
        await expect(pills.nth(1)).toContainText(modelLabel);
        await assertLayout(false, true);
        // Measure the composer in the state a phone actually opens in.
        await fold.click();
        async function assertLayout(typing: boolean, unfolded = false) {
          const geometry = await composer.evaluate(el => {
            const primary = el.querySelector(".chat-composer-primary")!.getBoundingClientRect();
            const voiceRowEl = el.querySelector(".chat-composer-voice-row");
            const voiceRow = voiceRowEl ? (() => {
              const r = voiceRowEl.getBoundingClientRect();
              const mic = voiceRowEl.querySelector("button")!.getBoundingClientRect();
              return {
                top: r.top, bottom: r.bottom, left: r.left, right: r.right,
                buttons: voiceRowEl.querySelectorAll("button").length,
                micCentre: mic.left + mic.width / 2, micWidth: mic.width, micHeight: mic.height,
              };
            })() : null;
            const primaryOrder = [...el.querySelector(".chat-composer-primary")!.children]
              .map(node => node.getAttribute("data-testid") ?? node.tagName);
            const composerBox = el.getBoundingClientRect();
            const buttons = [...el.querySelectorAll("button, textarea")].map(node => {
              const r = node.getBoundingClientRect();
              return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
            });
            const pills = [...el.querySelectorAll(".header-dropdown-trigger")].map(node => node.getBoundingClientRect().y);
            const micEl = el.querySelector('[data-testid="voice-record"], [data-testid="voice-stop"]');
            const mic = micEl ? (r => ({ width: r.width, height: r.height }))(micEl.getBoundingClientRect()) : null;
            const rows = el.children.length;
            return {
              buttons, pills, primaryBottom: primary.bottom, scrollWidth: el.scrollWidth, width: el.clientWidth,
              voiceRow, primaryOrder, mic, rows, composerCentre: composerBox.left + composerBox.width / 2,
            };
          });
          // The fold control first, in place of the paperclip it tucks away.
          expect(geometry.primaryOrder[0]).toBe("composer-options-toggle");
          // The whole composer: the input row alone while folded, the picker
          // row under it once unfolded.
          expect(geometry.rows).toBe(unfolded ? 2 : 1);
          // Landscape only from here: upright has its own layout (above).
          expect(geometry.voiceRow).toBeNull();
          expect(geometry.primaryOrder[2]).toBe(typing ? "chat-send" : "voice-record");
          expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
          for (const box of geometry.buttons) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(viewport.width);
            expect(box.bottom).toBeLessThanOrEqual(viewport.height);
            expect(box.height).toBeGreaterThanOrEqual(36);
          }
          for (let i = 0; i < geometry.buttons.length; i++) {
            for (const b of geometry.buttons.slice(i + 1)) {
              const a = geometry.buttons[i];
              expect(a.right <= b.x + 0.5 || b.right <= a.x + 0.5 || a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5).toBe(true);
            }
          }
          if (unfolded) {
            expect(geometry.pills).toHaveLength(3);
            expect(Math.min(...geometry.pills)).toBeGreaterThanOrEqual(geometry.primaryBottom);
            expect(Math.max(...geometry.pills) - Math.min(...geometry.pills)).toBeLessThan(1);
          } else {
            expect(geometry.pills).toHaveLength(0);
          }
        }
        await assertLayout(false);
        await page.screenshot({ path: testInfo.outputPath("composer-idle.png") });
        await primary.locator("textarea").fill(locale === "bg" ? "Напиши кратък отговор" : "Schreibe eine kurze Antwort");
        await expect(primary.getByTestId("chat-send")).toBeVisible();
        await expect(page.getByTestId("voice-record")).toHaveCount(0);
        await assertLayout(true);
        await page.screenshot({ path: testInfo.outputPath("composer-typing.png") });
        // Truncated values still open a full, usable picker inside the viewport
        // — on a phone that means unfolding the row they live on first.
        await fold.click();
        await pills.nth(1).click();
        const menu = page.getByRole("listbox");
        await expect(menu).toBeVisible();
        await expect(menu.getByText(modelLabel, { exact: true })).toBeVisible();
        const menuBox = (await menu.boundingBox())!;
        expect(menuBox.x).toBeGreaterThanOrEqual(0);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
        await page.keyboard.press("Escape");
      });
    });
  }
}

/**
 * Fullscreen chat (TASK-1157): a phone opens with the header folded into a slim
 * strip and the composer down to the text box and its send action, so the
 * conversation gets the screen. Every folded control is one tap away, leaving
 * fullscreen is remembered across a reload, and the conversation's text size
 * steps without touching anything around it.
 *
 * Landscape only since TASK-2778: upright, the slim bar below is the only
 * header and there is no fullscreen mode to leave.
 */
for (const viewport of [{ width: 740, height: 360 }]) {
  test.describe(`fullscreen chat ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test("gives the conversation the screen, keeps every control reachable, and remembers the choice", async ({ page }, testInfo) => {
      await installFakeGatewaySocket(page);
      await installClawboxMocks(page, SETUP);
      await page.goto("/");
      await chatOpen(page);
      await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

      const strip = page.getByTestId("chat-header-strip");
      const header = page.getByTestId("chat-header");
      const transcript = page.getByTestId("chat-transcript");
      await expect(strip).toBeVisible();
      await expect(header).toBeHidden();
      // The chat slides up from the bottom on a phone (with a little spring);
      // measure it once it has landed at the top.
      await expect.poll(async () => {
        const first = (await strip.boundingBox())?.y ?? -1;
        await page.waitForTimeout(120);
        const second = (await strip.boundingBox())?.y ?? -2;
        return Math.abs(first - second) < 0.5 && Math.round(second) === 0;
      }).toBe(true);
      const stripBox = (await strip.boundingBox())!;
      expect(stripBox.height).toBeLessThanOrEqual(36);
      // The strip's three controls — the header toggle, text size, fullscreen —
      // sit inside the screen and above the minimum target size.
      const stripControls = await strip.evaluate(el => [...el.querySelectorAll("button")].map(b => {
        const r = b.getBoundingClientRect();
        return { x: r.x, right: r.right, width: r.width, height: r.height };
      }));
      expect(stripControls).toHaveLength(3);
      for (const box of stripControls) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(viewport.width);
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
      }
      const fullscreenHeight = (await transcript.boundingBox())!.height;
      await page.screenshot({ path: testInfo.outputPath("fullscreen.png") });

      // The header opens UNDER the strip, so the toggle just pressed stays put.
      const toggle = page.getByTestId("chat-header-toggle");
      const toggleBefore = (await toggle.boundingBox())!;
      await toggle.click();
      await expect(header).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("chat-popup-close")).toBeInViewport();
      expect(Math.abs((await toggle.boundingBox())!.y - toggleBefore.y)).toBeLessThan(1);
      expect((await header.boundingBox())!.y).toBeGreaterThanOrEqual(stripBox.y + stripBox.height - 1);
      await page.screenshot({ path: testInfo.outputPath("fullscreen-header-open.png") });
      await toggle.click();
      await expect(header).toBeHidden();

      // The conversation's text size, and nothing around it.
      const reply = page.getByText("Hello from the fake gateway");
      const replyHeight = (await reply.boundingBox())!.height;
      const fieldFont = await page.locator("[data-testid='chat-composer'] textarea").evaluate(el => getComputedStyle(el).fontSize);
      await page.getByTestId("chat-text-size-toggle").click();
      await page.getByTestId("chat-text-size-larger").click();
      await page.getByTestId("chat-text-size-larger").click();
      await expect(page.getByTestId("chat-text-size-value")).toHaveText("130%");
      await expect(transcript).toHaveAttribute("data-chat-text-scale", "1.3");
      await expect.poll(async () => (await reply.boundingBox())!.height / replyHeight).toBeGreaterThan(1.2);
      expect(await page.locator("[data-testid='chat-composer'] textarea").evaluate(el => getComputedStyle(el).fontSize)).toBe(fieldFont);
      // No sideways scrolling: the larger text re-flows inside the same frame.
      const overflow = await transcript.evaluate(el => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath("text-130.png") });
      await page.getByTestId("chat-text-size-reset").click();
      await expect(transcript).not.toHaveAttribute("data-chat-text-scale");
      await page.getByTestId("chat-text-size-toggle").click();

      // Leaving fullscreen brings the header and every composer control back…
      await page.getByTestId("chat-fullscreen-toggle").click();
      await expect(strip).toHaveCount(0);
      await expect(header).toBeVisible();
      await expect(page.getByTestId("chat-composer-row")).toBeVisible();
      await expect(page.getByTestId("chat-attach")).toBeVisible();
      const headerControls = await header.evaluate(el => [...el.querySelectorAll("button")].map(b => {
        const r = b.getBoundingClientRect();
        return { x: r.x, right: r.right };
      }));
      for (const box of headerControls) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(viewport.width);
      }
      // …at a clear cost to the conversation, which is what fullscreen buys back.
      const standardHeight = (await transcript.boundingBox())!.height;
      expect(fullscreenHeight - standardHeight).toBeGreaterThanOrEqual(40);
      await page.screenshot({ path: testInfo.outputPath("standard.png") });

      // …and the choice survives a reload.
      await page.reload();
      await chatOpen(page);
      await expect(page.getByTestId("chat-header")).toBeVisible();
      await expect(page.getByTestId("chat-header-strip")).toHaveCount(0);
      await page.getByTestId("chat-fullscreen-toggle").click();
      await expect(page.getByTestId("chat-header-strip")).toBeVisible();
      await expect(page.getByTestId("chat-header")).toBeHidden();
    });
  });
}

/**
 * A phone held upright (TASK-2778): one slim bar — the menu, and the title once
 * there is a conversation — a menu from the left with everything the header
 * held, and bottom sheets for "+" and the model, each a modal that Escape and
 * a tap beside it close.
 */
test.describe("a phone held upright 360x780", () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  test("trades the header for a slim bar and a menu from the left, and keeps every control reachable", async ({ page }, testInfo) => {
    await installFakeGatewaySocket(page);
    await installClawboxMocks(page, SETUP);
    await page.goto("/");
    await chatOpen(page);
    await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

    const bar = page.getByTestId("chat-phone-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("chat-header")).toBeHidden();
    await expect(page.getByTestId("chat-header-strip")).toHaveCount(0);
    await expect(page.getByTestId("chat-fullscreen-toggle")).toHaveCount(0);
    // The chat slides up from the bottom; measure the bar once it has landed.
    await expect.poll(async () => {
      const first = (await bar.boundingBox())?.y ?? -1;
      await page.waitForTimeout(120);
      const second = (await bar.boundingBox())?.y ?? -2;
      return Math.abs(first - second) < 0.5 && Math.round(second) === 0;
    }).toBe(true);
    const menuButton = page.getByTestId("chat-phone-menu-button");
    const buttonBox = (await menuButton.boundingBox())!;
    expect(buttonBox.width).toBeGreaterThanOrEqual(40);
    expect(buttonBox.height).toBeGreaterThanOrEqual(40);
    // The conversation has a reply, so its name stands in the middle.
    await expect(page.getByTestId("chat-phone-title")).toHaveText("ClawBox");
    await page.screenshot({ path: testInfo.outputPath("portrait-bar.png") });

    // The menu comes in from the left, over a backdrop, with what the header held.
    await menuButton.click();
    const menu = page.getByRole("dialog", { name: "Menu" });
    await expect(menu).toBeVisible();
    await expect.poll(async () => Math.round((await menu.boundingBox())?.x ?? -1)).toBe(0);
    await expect(menu.getByRole("button", { name: "New chat" })).toBeEnabled();
    await expect(menu.getByTestId("chat-phone-menu-chat")).toHaveCount(1);
    await expect(menu.getByRole("button", { name: "Show the desktop" })).toBeInViewport();
    const menuControls = await menu.evaluate(el => [...el.querySelectorAll("button")].map(b => {
      const r = b.getBoundingClientRect();
      return { x: r.x, right: r.right, width: r.width, height: r.height };
    }));
    for (const box of menuControls) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(360);
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(40);
    }
    // The conversation's text size, from the menu, and nothing around it.
    await menu.getByRole("button", { name: "Larger text" }).click();
    await expect(page.getByTestId("chat-transcript")).toHaveAttribute("data-chat-text-scale", "1.15");
    await page.screenshot({ path: testInfo.outputPath("portrait-menu.png") });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(menuButton).toBeFocused();

    // "+" and the model pill each open a bottom sheet over the composer.
    for (const [opener, name] of [["composer-options-toggle", "Chat options"], ["chat-model-pill", "Model"]] as const) {
      const control = page.getByTestId(opener);
      if (await control.count() === 0) continue;
      await control.click();
      const sheet = page.getByRole("dialog", { name });
      await expect(sheet).toBeVisible();
      await expect.poll(async () => {
        const box = await sheet.boundingBox();
        return box ? Math.round(box.y + box.height) : -1;
      }).toBe(780);
      await page.screenshot({ path: testInfo.outputPath(`portrait-sheet-${opener}.png`) });
      // A tap beside it closes it.
      await page.mouse.click(180, 40);
      await expect(sheet).toHaveCount(0);
    }
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("lands in the chat with a compact microphone, and moves to the desktop and back", async ({ page }, testInfo) => {
    await installFakeGatewaySocket(page);
    await installClawboxMocks(page, SETUP);
    await page.goto("/");

    await chatOpen(page);
    await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

    const record = page.getByTestId("voice-record");
    await expect(record).toBeVisible();
    await expect(record).toBeEnabled();
    const box = await record.boundingBox();
    // Upright, the microphone rides the input row beside Send at the 44px every
    // control in that row gets (TASK-1003 — it used to hold a 56px row of its
    // own, which cost the conversation a third of the screen).
    expect(box?.width).toBe(44);
    expect(box?.height).toBe(44);
    await expect(page.getByTestId("chat-composer-voice-row")).toHaveCount(0);
    // Inside the screen, in the lower part where a thumb reaches.
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(box?.y ?? 0).toBeGreaterThan(844 / 2);
    await page.screenshot({ path: testInfo.outputPath("phone-chat.png") });

    // Upright the header is gone (TASK-2778); the way to the desktop is in the
    // menu the slim bar opens.
    await expect(page.getByTestId("chat-popup-close")).toBeHidden();
    await page.getByTestId("chat-phone-menu-button").click();
    await page.getByTestId("chat-phone-menu-desktop").click();
    await chatClosed(page);
    await expect(page.getByTestId("desktop-root")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("phone-desktop.png") });

    const crab = page.getByTestId("shelf-chat-button");
    await expect(crab).toBeVisible();
    await crab.click();
    await chatOpen(page);
    // Rotation past the desktop breakpoint must not strand the composer.
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByTestId("chat-send")).toBeInViewport();
    await expect(page.getByTestId("voice-record")).toBeInViewport();
    const composerBox = (await page.getByTestId("chat-composer").boundingBox())!;
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("phone-wide-landscape.png") });
  });

  test("shows the recording state without enlarging the primary row", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      class FakeRecorder {
        static isTypeSupported() { return true; }
        state = "inactive";
        mimeType = "audio/webm";
        ondataavailable: ((e: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        onerror: (() => void) | null = null;
        start() { this.state = "recording"; }
        stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob([new Uint8Array([1])]) }); this.onstop?.(); }
      }
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      });
      (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
    });
    await installFakeGatewaySocket(page);
    await installClawboxMocks(page, SETUP);
    await page.goto("/");

    await chatOpen(page);
    const record = page.getByTestId("voice-record");
    await expect(record).toBeEnabled();
    await record.click();
    const stop = page.getByTestId("voice-stop");
    await expect(stop).toBeVisible();
    await expect(stop).toHaveClass(/chat-voice-large--recording/);
    const box = await stop.boundingBox();
    expect(box?.width).toBe(44);
    // The one control toggles in place: the stop stands where the microphone
    // stood, on the input row (TASK-1003), and no second button appears.
    await expect(page.getByTestId("chat-composer-primary")).toContainText("stop");
    await expect(page.getByTestId("chat-composer-voice-row")).toHaveCount(0);
    await expect(page.getByTestId("voice-record")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("phone-recording.png") });
  });
});

for (const { locale, viewport } of [
  { locale: "en", viewport: { width: 390, height: 844 } },
  { locale: "bg", viewport: { width: 360, height: 800 } },
]) {
  test.describe(`portrait composer with a reply in flight, ${locale} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test("puts the red Stop in Send's slot, with the microphone right before it", async ({ page }, testInfo) => {
      await page.addInitScript(() => { (window as unknown as { __holdReplies?: boolean }).__holdReplies = true; });
      await installFakeGatewaySocket(page);
      await installClawboxMocks(page, { ...SETUP, preferences: { ...SETUP.preferences, ui_language: locale } });
      await page.goto("/");
      await chatOpen(page);
      await expect(page.getByTestId("voice-record")).toBeEnabled();
      await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

      const primary = page.getByTestId("chat-composer-primary");
      const field = primary.locator("textarea");
      await field.fill(locale === "bg" ? "Напиши кратък отговор" : "Write a short answer");
      const sendBox = (await primary.getByTestId("chat-send").boundingBox())!;
      await primary.getByTestId("chat-send").click();

      const stop = primary.getByTestId("chat-stop");
      await expect(stop).toBeVisible();
      await expect(page.getByTestId("chat-send")).toHaveCount(0);
      // The same slot Send had: the thumb does not move sideways. Upright
      // (TASK-2778) that slot ends the row under the text (the row itself may
      // move up or down as the cleared field shrinks back to one line).
      const stopBox = (await stop.boundingBox())!;
      expect(Math.abs(stopBox.x - sendBox.x)).toBeLessThan(1);
      expect(Math.abs(stopBox.width - sendBox.width)).toBeLessThan(1);
      const fieldBox = (await field.boundingBox())!;
      expect(stopBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 0.5);
      await expect(stop).toHaveCSS("color", "rgb(239, 68, 68)");

      // The microphone rides the same row (TASK-1003), right before Stop — so
      // the row reads … → microphone → Stop, and there is no row of its own
      // left to check.
      await expect(page.getByTestId("chat-composer-voice-row")).toHaveCount(0);
      const micBox = (await primary.getByTestId("voice-record").boundingBox())!;
      expect(stopBox.x).toBeGreaterThanOrEqual(micBox.x + micBox.width);
      expect(stopBox.x - (micBox.x + micBox.width)).toBeLessThanOrEqual(12);
      // On Stop's row, not under it.
      expect(Math.abs((micBox.y + micBox.height) - (stopBox.y + stopBox.height))).toBeLessThan(1);
      await page.screenshot({ path: testInfo.outputPath("portrait-in-flight.png") });
    });
  });
}

test.describe("on a big screen", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps the desktop, with the chat closed", async ({ page }, testInfo) => {
    await installFakeGatewaySocket(page);
    await installClawboxMocks(page, SETUP);
    await page.goto("/");

    await expect(page.getByTestId("desktop-root")).toBeVisible();
    await chatClosed(page);
    await page.screenshot({ path: testInfo.outputPath("desktop.png") });
  });
});
