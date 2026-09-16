import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

/**
 * Chat-first on a phone (src/lib/mobile-chat-first.ts): the page lands in the
 * chat with a thumb-sized microphone, the desktop is one labelled tap away and
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

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("lands in the chat with a large microphone, and moves to the desktop and back", async ({ page }, testInfo) => {
    await installFakeGatewaySocket(page);
    await installClawboxMocks(page, SETUP);
    await page.goto("/");

    await chatOpen(page);
    await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

    const record = page.getByTestId("voice-record");
    await expect(record).toBeVisible();
    await expect(record).toBeEnabled();
    const box = await record.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(64);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(64);
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
  });

  test("shows the recording state on the large button", async ({ page }, testInfo) => {
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
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(64);
    await page.screenshot({ path: testInfo.outputPath("phone-recording.png") });
  });
});

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
