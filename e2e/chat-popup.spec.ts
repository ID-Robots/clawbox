import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openChatPopup } from "./helpers/clawbox";

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
          // The popup greets an empty transcript with a "hi" of its own, and
          // that turn is answered here like any other. The owner's turn gets a
          // reply that names it, so a test can tell the two apart: asserting
          // the greeting's words after typing found that bubble AND the new
          // one — the same text twice, which a strict locator refuses — and
          // passed only when it looked before the second reply landed.
          const sent = String((message.params as { message?: unknown } | undefined)?.message ?? "");
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

  await openChatPopup(page);
  await expect(page.getByTestId("chat-popup")).toBeVisible();

  const chatInput = page.locator("textarea").last();
  await chatInput.fill("What changed?");
  await page.getByTitle("Send").click();
  // Exact: the reply below quotes the question, and a substring match would
  // find both bubbles.
  await expect(page.getByText("What changed?", { exact: true })).toBeVisible();
  await expect(page.getByText("Fake gateway heard: What changed?", { exact: true })).toBeVisible();

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

  await openChatPopup(page);
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

  // Provider dropdown is a custom popover (HeaderDropdown), not a
  // native <select>. Open via click on the trigger, pick the option
  // by accessible name. The previous Escape sanity-check was native-
  // select-specific (to confirm the browser's built-in dropdown
  // dismissed) — for the popover, Escape is a closer-of-popover-AND-
  // close-of-chat-popup ambiguity since the chat panel also handles
  // Escape, so we just exercise the open/select flow that users hit.
  const providerTrigger = page.getByRole("button", { name: "Chat provider" });
  await expect(providerTrigger).toBeVisible();
  await providerTrigger.click();
  await page.getByRole("option", { name: /Gemma 4 Local/ }).click();
  await expect(page.getByText(/Switched chat to Gemma 4 Local/)).toBeVisible();
});

test("chat popup provider dropdown stays visible at viewport edges", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 260 });
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

  await openChatPopup(page);
  await expect(page.getByTestId("chat-popup")).toBeVisible();
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

  // Push the popup into the bottom-right corner of a viewport that is barely
  // taller than the popup itself. The provider pill sits in the composer row
  // under the textarea, so with the popup's bottom edge 20px above the
  // viewport's there is no room for a list to drop DOWN from it — the popover
  // has to flip upward, and stay inside the viewport when it does. (The popup
  // must stay on screen for the pill to be clickable at all: a popup placed
  // any lower would put the composer, and the pill, below the fold.)
  await page.getByTestId("chat-popup").evaluate((el) => {
    Object.assign(el.style, {
      left: "216px",
      top: "20px",
      right: "auto",
      bottom: "auto",
      width: "416px",
      height: "220px",
    });
  });

  const providerTrigger = page.getByRole("button", { name: "Chat provider" });
  await expect(providerTrigger).toBeInViewport();
  const triggerBox = await providerTrigger.boundingBox();
  await providerTrigger.click();

  const listbox = page.getByRole("listbox", { name: "Chat provider" });
  await expect(listbox).toBeVisible();
  await expect(providerTrigger).toHaveAttribute("aria-controls", await listbox.getAttribute("id") ?? "");
  await page.waitForTimeout(150);

  const bounds = await listbox.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  expect(bounds.left).toBeGreaterThanOrEqual(8);
  expect(bounds.top).toBeGreaterThanOrEqual(8);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 8);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 8);
  // Inside the viewport BECAUSE it flipped: the list sits above the pill it
  // opened from, not squeezed into the 20px under it.
  expect(triggerBox).not.toBeNull();
  expect(bounds.bottom).toBeLessThanOrEqual(triggerBox!.y);
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

  await openChatPopup(page);
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

  await page.getByRole("button", { name: "Chat provider" }).click();
  await page.getByRole("option", { name: "Local AI - Set up in Settings" }).click();

  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible();

  // Settings opens straight on Local AI — not on Providers, where the window
  // opens by default. The sidebar row carries the reason the chat sent us here
  // as its sr-only subtitle, and the pane is the on-device inventory, in
  // which the model the chat could not switch to reads as absent.
  const localAiNav = settingsWindow.getByRole("navigation").getByRole("button", { name: /Local AI/ });
  await expect(localAiNav).toContainText("Not configured");
  const localAi = settingsWindow.getByTestId("local-ai-panel");
  await expect(localAi).toContainText("AI that runs on this box, and what each part is doing right now.");
  await expect(localAi.getByTestId("local-model-llamacpp").getByText("Not installed", { exact: true })).toBeVisible();
  await expect(settingsWindow.getByTestId("ai-provider-list")).toHaveCount(0);
});
