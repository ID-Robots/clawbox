/**
 * Two window events reach the chat from outside it: FIX_ERROR_EVENT (the
 * "Fix this" button on an error) and CHAT_MESSAGE_EVENT (the Coding Agent's
 * New wizard). Both must land as the OWNER'S turn through the one send path
 * — the queued-sends drain — so what goes to the gateway is a `chat.send`
 * frame with exactly the handed-over text, in order with anything typed.
 *
 * The fake gateway is the one chat-queue-starvation.test.tsx uses: a
 * WebSocket that answers connect and history, and records every frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { buildFixErrorPrompt, dispatchChatMessage, dispatchFixError } from "@/lib/ui-events";

const SEED_TEXT = "Ready when you are.";
const SESSION = "agent:main:main";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

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
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: [assistantMessage(SEED_TEXT, 500)] });
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
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

/** Texts of every chat.send frame the gateway has seen, in arrival order. */
function sentChatTexts(): string[] {
  return sent
    .filter((f) => f.method === "chat.send")
    .map((f) => String((f.params as { message?: string; text?: string })?.message
      ?? (f.params as { text?: string })?.text ?? ""));
}

function emitFinal(text: string) {
  socket()?.emit({
    type: "event",
    event: "chat",
    payload: { sessionKey: SESSION, state: "final", message: assistantMessage(text, Date.now()) },
  });
}

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

describe("events handed to the chat from outside it", () => {
  beforeEach(() => {
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

  it("sends a CHAT_MESSAGE_EVENT's text as the owner's turn, verbatim", async () => {
    await mountReady();
    const text = 'Create a new ClawBox app called "Timer": a 25/5 timer.\nScaffold it as a code project from the "app" template, build it with the coding agent, verify it in the browser, and put it on my desktop.';
    act(() => { dispatchChatMessage(text); });
    await waitFor(() => expect(sentChatTexts()).toEqual([text]));
    // It reads as the owner's message in the transcript, not as a system line.
    expect(await screen.findByText(/Create a new ClawBox app called "Timer"/)).toBeInTheDocument();
  });

  it("sends a FIX_ERROR_EVENT as the investigation prompt, through the same path", async () => {
    await mountReady();
    const ctx = { source: "Files app", message: "EACCES: permission denied" };
    act(() => { dispatchFixError(ctx); });
    await waitFor(() => expect(sentChatTexts()).toEqual([buildFixErrorPrompt(ctx)]));
  });

  it("queues behind a turn already in flight rather than starting a second run", async () => {
    await mountReady();
    act(() => { dispatchFixError({ source: "Files app", message: "first" }); });
    await waitFor(() => expect(sentChatTexts()).toHaveLength(1));
    act(() => { dispatchChatMessage("second, handed over mid-answer"); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    // Strictly one run at a time: the handed-over text waits for the final.
    expect(sentChatTexts()).toHaveLength(1);
    await act(async () => { emitFinal("done with the first"); });
    await waitFor(() => expect(sentChatTexts()[1]).toBe("second, handed over mid-answer"));
  });

  it("ignores an event with nothing to say", async () => {
    await mountReady();
    act(() => { dispatchChatMessage("   "); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(sentChatTexts()).toEqual([]);
  });
});
