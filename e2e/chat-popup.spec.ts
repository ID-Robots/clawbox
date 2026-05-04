import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

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
                message: { text: "Hello from the" },
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
                message: { text: "Hello from the fake gateway" },
              },
            });
          }, 50);
          return;
        }

        if (message.method === "chat.abort") {
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

test("chat popup connects, streams a reply, and supports panel docking", async ({ page }) => {
  await installFakeGatewaySocket(page);

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
      ui_mascot_hidden: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

  const chatInput = page.locator("textarea").last();
  await chatInput.fill("What changed?");
  await page.getByTitle("Send").click();
  await expect(page.getByText("What changed?")).toBeVisible();

  await page.getByTitle("Dock to right").click();
  await expect(page.getByTitle("Undock panel")).toBeVisible();
  await page.getByTitle("Undock panel").click();
  await expect(page.getByTitle("Dock to right")).toBeVisible();
});

test("chat popup lets you switch to Local AI when it is configured", async ({ page }) => {
  await installFakeGatewaySocket(page);

  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      telegram_configured: true,
    },
    preferences: {
      ui_mascot_hidden: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

  // Provider dropdown is a custom popover (HeaderDropdown), not a
  // native <select>, so we drive it via click-on-trigger / click-on-
  // option instead of selectOption().
  const providerTrigger = page.getByRole("button", { name: "Chat provider" });
  await expect(providerTrigger).toBeVisible();
  await providerTrigger.click();
  await page.keyboard.press("Escape");

  await providerTrigger.click();
  await page.getByRole("option", { name: /Gemma 4 Local/ }).click();
  await expect(page.getByText("Switched chat to llamacpp/gemma4-e2b-it-q4_0.")).toBeVisible();
});

test("chat popup opens Local AI settings when local AI is not configured", async ({ page }) => {
  await installFakeGatewaySocket(page);

  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      local_ai_configured: false,
      local_ai_provider: null,
      local_ai_model: null,
      telegram_configured: true,
    },
    preferences: {
      ui_mascot_hidden: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

  await page.getByRole("button", { name: "Chat provider" }).click();
  await page.getByRole("option", { name: "Local AI - Set up in Settings" }).click();

  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible();
  await expect(settingsWindow.getByText("No local model configured")).toBeVisible();
});
