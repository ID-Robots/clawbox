import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The header names the model the box runs, and the box can be told to run
 * another one from outside this tab — Settings in a second window, the phone,
 * the CLI. Seen on a box (2026-09-17): the model was switched elsewhere and
 * the open popup's header kept the old name until a reload. The popup must
 * re-read the model when the owner comes back to the tab, and on its own
 * while the tab stays on screen.
 */

const MAIN = "agent:main:main";

function modelState(label: string, model: string) {
  return {
    activeOptionId: "primary",
    activeModel: model,
    activeSource: "primary",
    activeLabel: label,
    options: [{
      id: "primary", label, model, provider: "anthropic", available: true, settingsSection: "ai", isLocal: false,
    }],
    primary: { available: true, label, model },
    local: { available: false, label: null, model: null },
  };
}

let served = modelState("Model Before", "anthropic/model-before");
let modelReads = 0;

const sockets: FakeGatewayWs[] = [];

class FakeGatewayWs {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

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
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }], timestamp: 500 }] });
      return;
    }
    this.respond(id, {});
  }

  close() { this.readyState = FakeGatewayWs.CLOSED; }

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

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
      modelReads += 1;
      const snapshot = served;
      return { ok: true, json: async () => snapshot };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

async function mounted() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  await screen.findByText("Ready.");
  await screen.findByText("Model Before");
}

describe("the header's model after a switch made elsewhere", () => {
  beforeEach(() => {
    served = modelState("Model Before", "anthropic/model-before");
    modelReads = 0;
    sockets.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    setVisibility("visible");
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("is re-read when the owner comes back to the tab", async () => {
    await mounted();
    served = modelState("Model After", "anthropic/model-after");

    setVisibility("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

    await screen.findByText("Model After");
    expect(screen.queryByText("Model Before")).toBeNull();
  });

  it("is re-read when the window regains focus", async () => {
    await mounted();
    served = modelState("Model After", "anthropic/model-after");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await screen.findByText("Model After");
  });

  it("is re-read on its own while the tab stays on screen, and not while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mounted();
    const before = modelReads;
    served = modelState("Model After", "anthropic/model-after");

    // Past MODEL_STATE_POLL_MS (60 s), the backstop tick behind the
    // visibility/focus handlers above.
    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(modelReads).toBe(before);
    expect(screen.queryByText("Model After")).toBeNull();

    setVisibility("visible");
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    await screen.findByText("Model After");
    expect(modelReads).toBeGreaterThan(before);
  });
});
