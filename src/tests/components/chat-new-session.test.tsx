import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * "New chat" has to actually reset the agent's thread, not just blank the view.
 *
 * Clearing `messages` alone would look right and be wrong: the next question
 * would still be answered with the previous conversation in context. The button
 * therefore sends the same `sessions.reset` the provider switch already uses,
 * and the transcript is only cleared once the gateway has accepted it.
 *
 * The auto-greet must NOT fire afterwards. It exists to open a first
 * conversation on an empty box; re-arming it here would drop an unasked-for
 * "hi" into the chat the moment the user cleared it.
 */

const SEED_TEXT = "Here's your orange tabby";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

let history: unknown[] = [];
/** Every frame the component sent, so the test can assert on the reset call. */
const sent: Array<Record<string, unknown>> = [];
/** Set to make `sessions.reset` fail, exercising the error path. */
let resetFails = false;

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
      if (resetFails) {
        setTimeout(() => this.emit({ type: "res", id, ok: false, error: { message: "gateway said no" } }), 0);
        return;
      }
      // A real reset empties the transcript the next read returns.
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
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

const resetFrames = () => sent.filter((f) => f.method === "sessions.reset");
const sendFrames = () => sent.filter((f) => f.method === "chat.send");
const historyFrames = () => sent.filter((f) => f.method === "chat.history");

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

describe("new chat button", () => {
  beforeEach(() => {
    history = [assistantMessage(SEED_TEXT, 500)];
    sent.length = 0;
    resetFails = false;
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

  it("resets the agent's session and clears the transcript", async () => {
    await mountReady();

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(resetFrames()).toHaveLength(1));
    // Reason 'new' is what makes the agent start a fresh thread rather than
    // merely rewinding — the provider switch uses the same pair.
    expect(resetFrames()[0].params).toMatchObject({ key: "agent:main:main", reason: "new" });
    await waitFor(() => expect(screen.queryByText(SEED_TEXT)).toBeNull());
  });

  it("does not auto-greet into the chat it just cleared", async () => {
    await mountReady();
    const sendsBefore = sendFrames().length;

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.queryByText(SEED_TEXT)).toBeNull());

    // Force a real history read against the now-empty transcript: that is the
    // branch which would auto-greet if the reset had re-armed `greetedRef`.
    // Asserting on a fixed sleep would only prove "nothing happened for 250ms"
    // without ever exercising it.
    const readsBefore = historyFrames().length;
    socket()?.emit({
      type: "event",
      event: "session.message",
      payload: { sessionKey: "agent:main:main", agentId: "main", message: assistantMessage("", 900) },
    });
    await waitFor(() => expect(historyFrames().length).toBeGreaterThan(readsBefore), { timeout: 3000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(sendFrames()).toHaveLength(sendsBefore);
  });

  it("keeps the transcript and explains itself when the reset fails", async () => {
    await mountReady();
    resetFails = true;

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    // Blanking the view on a failed reset would be the worst outcome: the
    // agent still holds the thread, but the user believes it is gone.
    await screen.findByText(/Could not start a new chat/);
    expect(screen.queryByText(SEED_TEXT)).not.toBeNull();
  });
});
