import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

test("terminal can open and connect to the websocket backend", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;

    class FakeTerminalWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = FakeTerminalWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onclose: ((event: CloseEvent | Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      private fallback: WebSocket | null = null;

      constructor(url: string) {
        if (!url.includes("/terminal-ws") && !url.includes(":3006")) {
          this.fallback = new NativeWebSocket(url);
          this.readyState = this.fallback.readyState;
          this.fallback.onopen = (event) => {
            this.readyState = this.fallback?.readyState ?? FakeTerminalWebSocket.CLOSED;
            this.onopen?.(event);
          };
          this.fallback.onmessage = (event) => this.onmessage?.(event as MessageEvent<string>);
          this.fallback.onclose = (event) => {
            this.readyState = FakeTerminalWebSocket.CLOSED;
            this.onclose?.(event);
          };
          this.fallback.onerror = (event) => this.onerror?.(event);
          return;
        }

        setTimeout(() => {
          this.readyState = FakeTerminalWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({ type: "output", data: "ready\\r\\n" }),
            } as MessageEvent<string>);
          }, 20);
        }, 20);
      }

      send(raw: string) {
        if (this.fallback) {
          this.fallback.send(raw);
        }
      }

      close() {
        if (this.fallback) {
          this.fallback.close();
          return;
        }
        this.readyState = FakeTerminalWebSocket.CLOSED;
        this.onclose?.({ code: 1000 } as CloseEvent);
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeTerminalWebSocket,
    });
  });

  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openLauncher(page);
  const terminalButton = page.getByTestId("app-launcher").getByRole("button", { name: "Terminal" });
  await terminalButton.focus();
  await terminalButton.press("Enter");

  const terminalWindow = page.getByTestId("chrome-window-terminal");
  await expect(terminalWindow).toBeVisible();
  await expect(terminalWindow.locator(".xterm")).toBeVisible();
  await expect(terminalWindow.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
});
