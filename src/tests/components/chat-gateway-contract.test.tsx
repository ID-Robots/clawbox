import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * The OpenClaw wire contract, pinned.
 *
 * Every OpenClaw customer is on this path and the installed base for the other
 * harness is close to nothing, so a regression here is the whole risk of
 * putting a transport abstraction under this surface. This test asserts the
 * EXACT method names and parameter shapes the chat puts on the socket, and it
 * is the acceptance criterion for the adapter: it must keep passing unchanged.
 *
 * If a parameter shape has to move to make an adapter fit, that is the design
 * being wrong — not this test.
 */

const SEED_TEXT = "Your tabby is ready";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

let history: unknown[] = [];
const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

class FakeGatewayWs {
  static readonly OPEN = 1;
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
    sent.push(frame);
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: history });
      return;
    }
    if (frame.method === "sessions.reset") {
      history = [];
      this.respond(id, {});
      return;
    }
    this.respond(id, { runId: "r1", status: "started" });
  }

  close() {}

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
    if (url.includes("/setup-api/chat/capabilities")) {
      return { ok: true, json: async () => ({ harness: "openclaw", facts: { hasClawaiToken: true, hermesSupportsImages: false } }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return {
        ok: true,
        json: async () => ({
          activeOptionId: "primary",
          activeModel: "claude-opus-4",
          activeSource: "primary",
          activeLabel: "Anthropic Claude",
          options: [{
            id: "primary", label: "Anthropic Claude", model: "claude-opus-4",
            provider: "anthropic", available: true, settingsSection: "ai", isLocal: false,
          }],
          primary: { available: true, label: "Anthropic Claude", model: "claude-opus-4" },
          local: { available: false, label: null, model: null },
        }),
      };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

const framesFor = (method: string) => sent.filter((f) => f.method === method);

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

describe("gateway wire contract", () => {
  beforeEach(() => {
    history = [assistantMessage(SEED_TEXT, 500)];
    sent.length = 0;
    sockets.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("reads history as chat.history{sessionKey,limit:50}", async () => {
    await mountReady();
    const frames = framesFor("chat.history");
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].params).toEqual({ sessionKey: "agent:main:main", limit: 50 });
  });

  it("subscribes to transcript appends as sessions.messages.subscribe{key}", async () => {
    await mountReady();
    // A generated picture is produced by a SEPARATE background run whose reply
    // reaches the chat stream with its MEDIA: directive stripped, so this
    // subscription is the only way the surface learns the transcript gained
    // something the live turn could not render.
    await waitFor(() => expect(framesFor("sessions.messages.subscribe")).toHaveLength(1));
    expect(framesFor("sessions.messages.subscribe")[0].params).toEqual({ key: "agent:main:main" });
  });

  it("sends a turn as chat.send{sessionKey,message,deliver:false,idempotencyKey}", async () => {
    await mountReady();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello there" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    await waitFor(() => expect(framesFor("chat.send").length).toBeGreaterThan(0));
    const params = framesFor("chat.send")[0].params as Record<string, unknown>;
    expect(params.sessionKey).toBe("agent:main:main");
    expect(params.message).toBe("hello there");
    // `deliver:false` keeps the reply on this socket instead of pushing it out
    // through the delivery channels.
    expect(params.deliver).toBe(false);
    expect(typeof params.idempotencyKey).toBe("string");
    expect(String(params.idempotencyKey).length).toBeGreaterThan(0);
  });

  it("resets as sessions.reset{key,reason:'new'}", async () => {
    await mountReady();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(framesFor("sessions.reset")).toHaveLength(1));
    // `reason: 'new'` is what makes the agent start a fresh thread rather than
    // merely rewinding.
    expect(framesFor("sessions.reset")[0].params).toEqual({
      key: "agent:main:main",
      reason: "new",
    });
  });

  it("pushes the sticky reasoning default as sessions.patch{key,thinkingLevel}", async () => {
    await mountReady();
    await waitFor(() => expect(framesFor("sessions.patch").length).toBeGreaterThan(0));
    const params = framesFor("sessions.patch")[0].params as Record<string, unknown>;
    expect(params.key).toBe("agent:main:main");
    expect(typeof params.thinkingLevel).toBe("string");
  });

  it("stops a run as chat.abort{sessionKey}", async () => {
    await mountReady();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "long one" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    const stop = await screen.findByTitle(/stop/i);
    fireEvent.click(stop);
    await waitFor(() => expect(framesFor("chat.abort")).toHaveLength(1));
    expect(framesFor("chat.abort")[0].params).toEqual({ sessionKey: "agent:main:main" });
  });

  it("auto-greets an empty transcript exactly once, over the same chat.send", async () => {
    history = [];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(framesFor("chat.send").length).toBeGreaterThan(0));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const greets = framesFor("chat.send");
    expect((greets[0].params as Record<string, unknown>).message).toBe("hi");
    expect((greets[0].params as Record<string, unknown>).deliver).toBe(false);
    expect(greets).toHaveLength(1);
  });
});
