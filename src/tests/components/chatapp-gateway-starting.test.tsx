/**
 * The full-page chat's starting-retry ladder, on the surface a phone lands on.
 *
 * `/app/clawbox` retries a connect the gateway refused only because it is still
 * booting, up to STARTING_MAX_RETRIES (40) three seconds apart. The timer was
 * cleared only by the NEXT retry and its callback tested nothing, so a window
 * closed inside one of those three-second waits went on opening sockets and
 * fetching `/setup-api/gateway/ws-config` for the best part of two minutes for a
 * component that no longer existed — and then set state on it.
 *
 * The refusal frame is the core's own, field for field
 * (`rejectGatewayStartupConnect`, v2026.9.3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SESSION = "agent:main:main";
const instances: FakeGatewayWs[] = [];
let refusals = 0;
let wsConfigFetches = 0;

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    instances.push(this);
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
          error: {
            code: "UNAVAILABLE",
            message: "gateway starting; retry shortly",
            retryable: true,
            details: { reason: "startup-sidecars" },
          },
        }), 0);
        return;
      }
      setTimeout(() => this.emit({
        type: "res", id, ok: true,
        payload: { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } },
      }), 0);
      return;
    }
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload: { messages: [], questions: [] } }), 0);
  }

  close() { this.closed = true; this.readyState = 3; }
  addEventListener() {}
  removeEventListener() {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      wsConfigFetches += 1;
      return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

beforeEach(() => {
  instances.length = 0;
  refusals = 0;
  wsConfigFetches = 0;
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs);
  installFetch();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the full page's starting-retry ladder", () => {
  it("stops the moment the window is closed, instead of reconnecting into nothing", async () => {
    refusals = 40;
    const view = render(<ChatApp />);
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(1));

    // One retry has been armed and is waiting out its three seconds.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(2));

    const socketsAtUnmount = instances.length;
    const fetchesAtUnmount = wsConfigFetches;
    view.unmount();

    // The ladder's whole remaining budget: nothing more may be opened.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(instances.length).toBe(socketsAtUnmount);
    expect(wsConfigFetches).toBe(fetchesAtUnmount);
  });

  it("still climbs the ladder while the page is up, and connects when the gateway is ready", async () => {
    refusals = 2;
    render(<ChatApp />);
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(3));
    // The refused sockets were closed; the accepted one is still open.
    expect(instances.slice(0, 2).every((s) => s.closed)).toBe(true);
    await waitFor(() => expect(instances[instances.length - 1].closed).toBe(false));
  });

  it("does not paint the error panel when the browser fires close for the refused socket", async () => {
    // A real socket fires `close` for the close() the retry branch calls, and
    // this component's close handler paints "Could not connect" whenever no
    // connect has succeeded yet — which, mid-ladder, is always. The fake
    // above never fires it, so the handler has to be DETACHED before the
    // close for this to hold, and that is what is pinned here.
    refusals = 2;
    render(<ChatApp />);
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(instances[0].closed).toBe(true));
    await act(async () => { instances[0].onclose?.(); });
    expect(document.body.textContent).not.toContain("Could not connect to gateway");

    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(instances[instances.length - 1].closed).toBe(false));
    expect(document.body.textContent).not.toContain("Could not connect to gateway");
  });
});
