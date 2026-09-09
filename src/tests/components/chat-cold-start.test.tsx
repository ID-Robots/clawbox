import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// Real Nano .199 needed 175 seconds between process start and gateway ready.
// The desktop opened sooner and exhausted its initial socket retry ladder.
let ready = false;
let attempts = 0;
let connected = 0;
let stallHandshake = false;
class ColdGateway {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = ColdGateway.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) {
    attempts++;
    setTimeout(() => {
      if (this.readyState === ColdGateway.CLOSED) return;
      if (!ready) { this.readyState = ColdGateway.CLOSED; this.onclose?.({ code: 1006, reason: "" } as CloseEvent); return; }
      if (stallHandshake) return;
      this.readyState = ColdGateway.OPEN;
      this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });
    }, 1);
  }
  send(raw: string) {
    const f = JSON.parse(raw);
    if (f.type !== "req") return;
    if (f.method === "connect") connected++;
    const payload = f.method === "connect"
      ? { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } }
      : f.method === "chat.history" ? { messages: [{ role: "assistant", content: [{ type: "text", text: "Ready" }] }] } : {};
    setTimeout(() => this.emit({ type: "res", id: f.id, ok: true, payload }), 1);
  }
  close() { this.readyState = ColdGateway.CLOSED; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  for (let left = ms; left > 0; left -= 3000) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(left, 3000)); });
  }
}

describe("cold gateway desktop recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers(); ready = false; attempts = 0; connected = 0; stallHandshake = false;
    resetHarnessCache(); window.localStorage.clear(); Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", ColdGateway as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const u = String(input);
      const data = u.includes("/gateway/ws-config") ? { token: "t", wsUrl: "ws://localhost/gw" }
        : u.includes("/harness/active") ? { active: "openclaw", edition: "openclaw" }
        : u.includes("/chat/model") ? { options: [], activeOptionId: "" }
        : u.includes("/chat/spoken-history") ? { items: [] } : {};
      return { ok: true, json: async () => data };
    }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetHarnessCache(); });

  it("connects without owner Retry when a cold gateway starts after three minutes", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await advance(180_000);
    expect(connected).toBe(0);
    expect(screen.queryByText("Could not connect to gateway")).toBeNull();
    ready = true;
    await advance(5_000);
    expect(connected).toBe(1);
    expect(screen.queryByText("Could not connect to gateway")).toBeNull();
  });

  it("still ends the ladder for a gateway that never starts", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await advance(330_000);
    expect(screen.getByText("Could not connect to gateway")).toBeTruthy();
    expect(attempts).toBeLessThanOrEqual(100);
    const exhausted = attempts;
    await advance(60_000);
    expect(attempts).toBe(exhausted);
  });

  it("ends a pending WebSocket handshake at the shared five-minute deadline", async () => {
    ready = true; stallHandshake = true;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await advance(300_000);
    expect(screen.getByText("Could not connect to gateway")).toBeTruthy();
    expect(attempts).toBe(1);
    expect(connected).toBe(0);
  });

  it("aborts a pending config fetch at the shared five-minute deadline", async () => {
    const original = globalThis.fetch;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/gateway/ws-config")) {
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return original(input, init);
    }));
    render(<ChatPopup isOpen onClose={() => {}} />);
    await advance(300_000);
    expect(signal?.aborted).toBe(true);
    expect(attempts).toBe(0);
    expect(screen.getByText("Could not connect to gateway")).toBeTruthy();
  });

  it("ignores a late config response after unmount even when fetch ignores abort", async () => {
    const original = globalThis.fetch;
    let resolveConfig: ((r: Response) => void) | undefined;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/gateway/ws-config")) {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(resolve => { resolveConfig = resolve; });
      }
      return original(input, init);
    }));
    const view = render(<ChatPopup isOpen onClose={() => {}} />);
    await advance(100);
    expect(resolveConfig).toBeDefined();
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolveConfig?.({ json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) } as Response); });
    await advance(330_000);
    expect(attempts).toBe(0);
  });

  it("cancels startup retries when the chat unmounts", async () => {
    const view = render(<ChatPopup isOpen onClose={() => {}} />);
    await advance(10_000); view.unmount(); const last = attempts;
    await advance(60_000); expect(attempts).toBe(last);
  });
});
