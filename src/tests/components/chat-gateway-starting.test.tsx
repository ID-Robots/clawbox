import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A gateway that is still booting accepts the socket and refuses the connect
 * frame with `UNAVAILABLE` / `retryable: true` / `details.reason:
 * "startup-sidecars"` and the sentence "gateway starting; retry shortly" —
 * every restart passes through that state for ten to twenty seconds, and any
 * model switch used to cause one. The chat surfaced it as the error panel with
 * a Retry button (seen on a box, 2026-09-17). A refusal that ends on its own is
 * a reconnect, not an error.
 *
 * The frame below is the core's own, field for field
 * (`rejectGatewayStartupConnect` in
 * `src/gateway/server/ws-connection/connect-admission.ts` at v2026.9.3), so
 * this suite exercises the structured test the client actually makes rather
 * than the English fallback behind it.
 */

const sockets: FakeGatewayWs[] = [];
let refusals = 0;

class FakeGatewayWs {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      if (refusals > 0) {
        refusals -= 1;
        setTimeout(() => this.emit({
          type: "res", id, ok: false,
          error: { code: "UNAVAILABLE", message: "gateway starting; retry shortly", retryable: true, details: { reason: "startup-sidecars" } },
        }), 0);
        return;
      }
      setTimeout(() => this.emit({ type: "res", id, ok: true, payload: { type: "hello-ok", protocol: 4, snapshot: { sessionDefaults: { mainSessionKey: "main" } }, auth: { role: "operator", scopes: [] } } }), 0);
      return;
    }
    if (frame.method === "chat.history") {
      setTimeout(() => this.emit({ type: "res", id, ok: true, payload: { messages: [] } }), 0);
      return;
    }
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload: {} }), 0);
  }

  close() { this.closed = true; this.readyState = FakeGatewayWs.CLOSED; }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

describe("a gateway that is still starting", () => {
  beforeEach(() => {
    sockets.length = 0;
    refusals = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetHarnessCache();
  });

  it("keeps connecting through the refusal and never offers Retry", async () => {
    refusals = 2;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle();

    // Two sockets were refused; the panel with the gateway's sentence and the
    // Retry button must not have appeared for either.
    await waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByText(/retry shortly/i)).toBeNull();
    expect(screen.queryByText("chat.retry")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await settle();

    // The third socket is accepted: the chat is connected, with no Retry ever shown.
    await waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(3));
    await settle();
    expect(screen.queryByText(/retry shortly/i)).toBeNull();
    expect(screen.queryByText("chat.retry")).toBeNull();
    expect(sockets.slice(0, 2).every((s) => s.closed)).toBe(true);
    expect(sockets[sockets.length - 1].closed).toBe(false);
  });
});
