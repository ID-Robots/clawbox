import type { Page } from "@playwright/test";

/**
 * A stand-in for the OpenClaw gateway's WebSocket, installed before the page
 * loads: it answers the handshake, an empty transcript, and every chat.send
 * with a reply that names it — and records each sent message on
 * `window.__chatSends` so a spec can read exactly what the composer sent.
 * Shared by the chat specs (chat-popup, chat-drop).
 */
export async function installFakeGatewaySocket(page: Page) {
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
