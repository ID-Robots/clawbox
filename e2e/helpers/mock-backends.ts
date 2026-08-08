import type { Page } from "@playwright/test";

/**
 * Replace `window.WebSocket` with a fake that completes the terminal handshake
 * entirely in-browser. The terminal app talks to `/terminal-ws`, which only
 * `production-server.js` proxies to the PTY server — the standalone e2e server
 * and CI runners have no such backend, so without this the terminal window
 * errors out and unmounts. Any non-terminal socket falls through to the real
 * WebSocket, so this is safe to install globally in a spec.
 *
 * Mirrors the inline fake terminal-reconnect.spec.ts uses; kept here so any
 * terminal-backed spec can share it.
 */
export async function mockTerminalWebSocket(page: Page) {
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
              data: JSON.stringify({ type: "output", data: "ready\r\n" }),
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
}
