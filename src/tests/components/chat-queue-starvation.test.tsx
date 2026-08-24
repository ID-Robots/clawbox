import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * TASK-517: three chat messages were accepted, shown in the transcript, and
 * never answered. The durable session file proved the gateway received all
 * three (U2 U3 U4 U1 A1 U5 A5 …) and produced no answer for the starved ones.
 *
 * The reachable client defect behind it: `sendMessage` decides queue-or-start
 * from the render-time `sending` closure. When a send lands in the window
 * between the commit where `sending` flipped false (previous turn's `final`)
 * and the commit after the drain effect started the next queued run, the
 * handler still sees `sending === false` and calls `startRun` directly — a
 * SECOND run goes to the gateway while the drained one is in flight,
 * overwriting `runIdRef` and racing the server, exactly the shape that leaves
 * accepted turns unanswered.
 *
 * This test makes that window deterministic: the fake gateway dispatches a
 * user keydown synchronously the moment the drained run's `chat.send` frame
 * arrives — i.e. mid-window, with the stale handlers still bound. The
 * invariant asserted is strict serialization: never a second `chat.send`
 * before the previous run's `final`, and FIFO order for everything queued.
 */

const SEED_TS = 500;
const SEED_TEXT = "Ready when you are.";
const SESSION = "agent:main:main";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

const SEED = assistantMessage(SEED_TEXT, SEED_TS);

let history: unknown[] = [];
/** Every request frame the component sent. */
const sent: Array<Record<string, unknown>> = [];
/** Called synchronously when a chat.send frame arrives, then cleared. */
let onChatSend: (() => void) | null = null;

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
      this.respond(id, { messages: history });
      return;
    }
    if (frame.method === "chat.send" && onChatSend) {
      // Fire exactly once, synchronously — this is the stale-closure window.
      const hook = onChatSend;
      onChatSend = null;
      hook();
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
    payload: {
      sessionKey: SESSION,
      state: "final",
      message: assistantMessage(text, Date.now()),
    },
  });
}

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

async function typeAndSend(text: string) {
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("chat send queue under a race with the drain", () => {
  beforeEach(() => {
    history = [SEED];
    sent.length = 0;
    sockets.length = 0;
    onChatSend = null;
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

  it("never starts a second run before the previous one's final (TASK-517)", async () => {
    await mountReady();

    // A starts a run; B and C queue behind it.
    await typeAndSend("msg A");
    await waitFor(() => expect(sentChatTexts()).toHaveLength(1));
    await typeAndSend("msg B");
    await typeAndSend("msg C");
    await flush();
    expect(sentChatTexts()).toHaveLength(1);

    // The user types D while A is still answering — the input commits well
    // before the race. Only the Enter lands in the window.
    const composer = await screen.findByRole("textbox");
    fireEvent.change(composer, { target: { value: "msg D" } });
    await flush();

    // The moment the drain dispatches B's frame, the Enter lands — with the
    // handlers still bound to the commit where `sending` was false. The
    // unfixed component starts D as a SECOND concurrent run.
    onChatSend = () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: false });
    };
    await act(async () => { emitFinal("answer A"); });
    await flush();

    // Strict serialization: B went out, D must NOT have — it belongs behind C.
    expect(sentChatTexts()).toEqual(["msg A", "msg B"]);

    // Each final releases exactly the next queued turn, in FIFO order.
    await act(async () => { emitFinal("answer B"); });
    await flush();
    expect(sentChatTexts()).toEqual(["msg A", "msg B", "msg C"]);

    await act(async () => { emitFinal("answer C"); });
    await flush();
    expect(sentChatTexts()).toEqual(["msg A", "msg B", "msg C", "msg D"]);

    await act(async () => { emitFinal("answer D"); });
    await flush();
    // Nothing extra ever went out, and every user turn reached the gateway.
    expect(sentChatTexts()).toEqual(["msg A", "msg B", "msg C", "msg D"]);
  });

  it("a double Enter in the same window starts one run and queues the other", async () => {
    await mountReady();

    // No queue involved: the composer is idle, and two sends land in the same
    // pre-commit window (fast double Enter). The unfixed closure check starts
    // both as concurrent runs.
    const textarea = await screen.findByRole("textbox");
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "first" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      fireEvent.change(textarea, { target: { value: "second" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    });
    await flush();

    expect(sentChatTexts()).toEqual(["first"]);

    await act(async () => { emitFinal("answer first"); });
    await flush();
    expect(sentChatTexts()).toEqual(["first", "second"]);
  });
});
