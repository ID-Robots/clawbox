import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * A gateway that REFUSES the connect frame is a terminal failure too.
 *
 * It is the likeliest of the lot — a protocol skew after an update, a rejected
 * device identity, a denied scope — and the socket stays OPEN while it
 * happens. The reject handler used to set `status: 'error'` and stop there, so
 * two things went wrong at once: the reconnect overlay stayed up and hid the
 * error panel (which is gated on `!reloadingSkill`), and the still-open socket
 * made `connect()` return at its `readyState === OPEN` guard, which killed the
 * safety-net retry AND the manual Try again. The same permanent spinner
 * TASK-712 is about, from a far more common trigger.
 */

const sockets: FakeGatewayWs[] = [];

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
      // Refused, and the socket is left open — which is what a gateway does.
      setTimeout(() => this.emit({
        type: "res",
        id,
        ok: false,
        error: { message: "protocol 4 is newer than this gateway understands" },
      }), 0);
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

describe("a refused connect frame", () => {
  beforeEach(() => {
    sockets.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessCache();
  });

  it("takes the overlay down, shows the reason, and leaves Try again working", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle();

    // A provider change raises the reconnect overlay and reconnects — the
    // window in which the refusal is invisible.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("clawbox:primary-ai-configured", { detail: {} }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();

    expect(screen.queryByText(/Switching AI provider/i)).toBeNull();
    await screen.findByText(/newer than this gateway understands/i);

    // The refused socket was let go, so the retry is not swallowed by the
    // "already open" guard.
    expect(sockets.every((s) => s.closed)).toBe(true);
    const before = sockets.length;
    fireEvent.click(screen.getByText("chat.retry"));
    await waitFor(() => expect(sockets.length).toBe(before + 1));
  });
});
