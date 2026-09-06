import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * The reconnect ladder has to be able to END (TASK-712).
 *
 * `new WebSocket(wsUrl)` throws synchronously on a malformed URL — a bad
 * `wsUrl` out of `/setup-api/gateway/ws-config` is enough. That catch set
 * `status: 'error'` without tearing the reconnect overlay down, unlike the
 * other terminal-failure paths, so `reloadingSkill` stayed true, the
 * safety-net retry effect stayed armed, and every 3 s it RESET the retry
 * counter to zero and connected again. The two branches that can end the
 * ladder are both gated on that counter, so it could never be reached: one
 * doomed attempt every three seconds for as long as the chat window is open,
 * behind an overlay that never comes down.
 *
 * The first throw is terminal now rather than the start of a budgeted ladder,
 * and that is deliberate: every trigger that exists today is deterministic —
 * `/setup-api/gateway/ws-config` always answers `<scheme>://<host>`, so what is
 * left is mixed content, a CSP `connect-src` block, or a url the browser's own
 * parser refuses, and a retry fixes none of them. If `wsUrl` ever becomes
 * proxy-derived or configurable the throw becomes transient, and this path
 * would then want the retry budget the other three have.
 */

const RETRY_DELAY = 3000;

const ctorUrls: string[] = [];

class ThrowingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  constructor(url: string) {
    ctorUrls.push(url);
    // What a browser throws for a URL its WebSocket parser rejects.
    throw new SyntaxError("The URL's scheme must be either 'ws' or 'wss'.");
  }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      // Answered on a later tick, as a real network call is. It matters: the
      // `connecting` render has to land BEFORE the constructor throws, or the
      // status never leaves `error` from React's point of view and the retry
      // effect would look bounded here while looping on a real box.
      await new Promise((r) => setTimeout(r, 10));
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

/** Raises the reconnect overlay the way a provider change does, then reconnects. */
async function raiseOverlayAndReconnect() {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("clawbox:primary-ai-configured", { detail: {} }));
    await vi.advanceTimersByTimeAsync(50);
  });
}

describe("a WebSocket constructor that throws ends the reconnect ladder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ctorUrls.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", ThrowingWebSocket as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("stops trying instead of reconnecting every 3 s forever", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await raiseOverlayAndReconnect();

    const attemptsBefore = ctorUrls.length;
    expect(attemptsBefore).toBeGreaterThan(0);

    // Ten retry windows, one `act` each so every re-render lands and the
    // safety-net effect gets its chance to re-arm. The ladder's budget is far
    // smaller than ten, so a ladder that can exhaust stopped long before this.
    for (let i = 0; i < 10; i++) {
      // Two `act`s per window: one to fire the retry timer (which renders
      // `connecting`), one to let the ws-config answer arrive and the
      // constructor throw (which renders `error` again, re-arming the effect).
      await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_DELAY); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    }

    expect(ctorUrls.length).toBe(attemptsBefore);
  });

  it("takes the overlay down so the owner gets the error and a Try again", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await raiseOverlayAndReconnect();

    // The overlay hides the error panel while it is up, so a stuck overlay is
    // what the owner actually sees: a spinner that never resolves.
    expect(screen.queryByText(/Switching AI provider/i)).toBeNull();
    expect(screen.getByText(/WebSocket creation failed/i)).toBeTruthy();
  });
});
