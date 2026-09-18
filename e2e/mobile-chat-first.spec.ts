import type { Page } from "@playwright/test";
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
        await expect(pills).toHaveCount(3);
        await expect(page.getByTestId("voice-record")).toBeEnabled();
        // The greeting turn is over, so the slot beside the field is at rest.
        await expect(page.getByText("Hello from the fake gateway")).toBeVisible();
        await expect(pills.nth(1)).toContainText(modelLabel);

        // A phone held upright (TASK-894) gets the microphone on a row of its
        // own; landscape keeps it in the input row beside the field.
        const portrait = viewport.height > viewport.width;
        async function assertLayout(typing: boolean) {
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
            return {
              buttons, pills, primaryBottom: primary.bottom, scrollWidth: el.scrollWidth, width: el.clientWidth,
              voiceRow, primaryOrder, composerCentre: composerBox.left + composerBox.width / 2,
            };
          });
          if (portrait) {
            // attachment → field → Send, the microphone alone, centred, under it.
            expect(geometry.primaryOrder).toEqual(["chat-attach", "TEXTAREA", "chat-send"]);
            expect(geometry.voiceRow).not.toBeNull();
            const row = geometry.voiceRow!;
            expect(row.buttons).toBe(1);
            expect(row.top).toBeGreaterThanOrEqual(geometry.primaryBottom);
            expect(Math.abs(row.micCentre - geometry.composerCentre)).toBeLessThan(1);
            expect(row.micWidth).toBeGreaterThanOrEqual(48);
            expect(row.micHeight).toBeGreaterThanOrEqual(48);
            expect(Math.min(...geometry.pills)).toBeGreaterThanOrEqual(row.bottom);
          } else {
            expect(geometry.voiceRow).toBeNull();
            expect(geometry.primaryOrder[2]).toBe(typing ? "chat-send" : "voice-record");
          }
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
          expect(Math.min(...geometry.pills)).toBeGreaterThanOrEqual(geometry.primaryBottom);
          expect(Math.max(...geometry.pills) - Math.min(...geometry.pills)).toBeLessThan(1);
        }
        await assertLayout(false);
        await page.screenshot({ path: testInfo.outputPath("composer-idle.png") });
        await primary.locator("textarea").fill(locale === "bg" ? "Напиши кратък отговор" : "Schreibe eine kurze Antwort");
        await expect(primary.getByTestId("chat-send")).toBeVisible();
        await expect(page.getByTestId("voice-record")).toHaveCount(portrait ? 1 : 0);
        await assertLayout(true);
        await page.screenshot({ path: testInfo.outputPath("composer-typing.png") });
        // Truncated values still open a full, usable picker inside the viewport.
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
    // Upright, the microphone is alone on its own row at 56px (TASK-894).
    expect(box?.width).toBe(56);
    expect(box?.height).toBe(56);
    // Inside the screen, in the lower part where a thumb reaches.
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(box?.y ?? 0).toBeGreaterThan(844 / 2);
    await page.screenshot({ path: testInfo.outputPath("phone-chat.png") });

    await page.getByTestId("chat-popup-close").click();
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
    expect(box?.width).toBe(56);
    // The one control toggles: the stop stands where the microphone stood.
    await expect(page.getByTestId("chat-composer-voice-row")).toContainText("stop");
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

    test("puts the red Stop in Send's slot beside the field and keeps the microphone alone", async ({ page }, testInfo) => {
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
      // The same slot Send had: the thumb does not move sideways, and it sits
      // on the field's row, bottom-aligned with it (the row itself may move
      // up or down as the cleared field shrinks back to one line).
      const stopBox = (await stop.boundingBox())!;
      expect(Math.abs(stopBox.x - sendBox.x)).toBeLessThan(1);
      expect(Math.abs(stopBox.width - sendBox.width)).toBeLessThan(1);
      const fieldBox = (await field.boundingBox())!;
      expect(Math.abs((stopBox.y + stopBox.height) - (fieldBox.y + fieldBox.height))).toBeLessThan(1);
      // Immediately right of the field.
      expect(stopBox.x).toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width);
      expect(stopBox.x - (fieldBox.x + fieldBox.width)).toBeLessThanOrEqual(12);
      await expect(stop).toHaveCSS("color", "rgb(239, 68, 68)");

      const voiceRow = page.getByTestId("chat-composer-voice-row");
      await expect(voiceRow.locator("button")).toHaveCount(1);
      const micBox = (await voiceRow.locator("button").boundingBox())!;
      expect(micBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
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
