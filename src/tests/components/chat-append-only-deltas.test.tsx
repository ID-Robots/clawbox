import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// Both surfaces mount the fake gateway handshake, the history restore and the
// transcript in jsdom, which costs seconds under a full parallel run; see
// test-timeout-hygiene.test.ts for why the ceiling is declared per file.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A streamed answer grows in the bubble frame by frame (TASK-2228).
 *
 * The gateway sends a run's live text as a snapshot (`message`) only until it
 * knows the socket has a baseline; every later delta frame carries just
 * `deltaText`, the characters added. Both chats read `message` alone, so once
 * the core streamed an answer the bubble showed its first fragment and then
 * stood still until `final`. The frames below are a board's, shortened.
 */

const MAIN = "agent:main:main";
const SEED_TEXT = "Ready when you are.";
const PROMPT = "write three sentences about the sea";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

let histories: Record<string, unknown[]> = {};
const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

class FakeGatewayWs {
  static readonly CONNECTING = 0;
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
    sent.push(frame);
    const id = frame.id as string;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: histories[String(params.sessionKey)] ?? [] });
      return;
    }
    if (frame.method === "chat.send") {
      this.respond(id, { runId: params.idempotencyKey, status: "started" });
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
      return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, headers: new Headers(), json: async () => ({}) };
  }));
}

/** Message bubbles only — never the composer's own draft text. */
const bubbles = (text: string | RegExp) => screen.queryAllByText(text).filter((el) => el.tagName !== "TEXTAREA");

function lastSentRunId(): string {
  const send = sent.filter((f) => f.method === "chat.send").pop();
  return String((send?.params as { idempotencyKey?: string })?.idempotencyKey ?? "");
}

async function push(event: string, payload: Record<string, unknown>) {
  await act(async () => {
    socket()?.emit({ type: "event", event, payload });
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function sendPrompt(): Promise<string> {
  const before = lastSentRunId();
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: PROMPT } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(lastSentRunId()).not.toBe(before));
  await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));
  return lastSentRunId();
}

async function mount(surface: "popup" | "page") {
  if (surface === "popup") render(<ChatPopup isOpen onClose={() => {}} />);
  else render(<ChatApp />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

describe.each([
  ["the mascot chat", "popup"],
  ["the full-page chat", "page"],
] as const)("an answer the gateway streams append-only — %s", (_name, surface) => {
  beforeEach(() => {
    histories = { [MAIN]: [assistantMessage(SEED_TEXT, 500)] };
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

  it("grows the bubble with every frame, then settles on the final", async () => {
    await mount(surface);
    const run = await sendPrompt();
    const delta = (fields: Record<string, unknown>) => push("chat", { runId: run, sessionKey: MAIN, seq: 1, state: "delta", ...fields });

    await delta({ deltaText: "The sea", message: assistantMessage("The sea", 1) });
    await waitFor(() => expect(bubbles("The sea")).toHaveLength(1));

    await delta({ deltaText: " does not remember" });
    await waitFor(() => expect(bubbles("The sea does not remember")).toHaveLength(1));

    await delta({ deltaText: " who threw the stone." });
    await waitFor(() => expect(bubbles("The sea does not remember who threw the stone.")).toHaveLength(1));

    // The core rewrote the text: a replace frame, a snapshot again.
    await delta({ deltaText: "The sea forgets.", replace: true, message: assistantMessage("The sea forgets.", 2) });
    await waitFor(() => expect(bubbles("The sea forgets.")).toHaveLength(1));
    expect(bubbles(/who threw the stone/)).toHaveLength(0);

    await delta({ deltaText: " It always has." });
    await waitFor(() => expect(bubbles("The sea forgets. It always has.")).toHaveLength(1));

    await push("chat", { runId: run, sessionKey: MAIN, state: "final", message: assistantMessage("The sea forgets. It always has.", 3) });
    await waitFor(() => expect(bubbles("The sea forgets. It always has.")).toHaveLength(1));
  });

  it("keeps the frames that arrived while another tab was open", async () => {
    if (surface !== "popup") return;
    await mount(surface);
    const run = await sendPrompt();
    const delta = (fields: Record<string, unknown>) => push("chat", { runId: run, sessionKey: MAIN, state: "delta", ...fields });
    await delta({ deltaText: "The sea", message: assistantMessage("The sea", 1) });
    await waitFor(() => expect(bubbles("The sea")).toHaveLength(1));

    // Another conversation is opened while the answer goes on streaming here.
    const toggle = screen.queryByTestId("chat-header-toggle");
    if (toggle && toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
    const plus = screen.getByTestId("chat-new-tab");
    await waitFor(() => expect(plus).not.toBeDisabled());
    fireEvent.click(plus);
    await waitFor(() => expect(screen.getAllByTestId("chat-tab").find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key")).not.toBe(MAIN));
    await delta({ deltaText: " does not remember" });

    fireEvent.click(screen.getAllByTestId("chat-tab").find((el) => el.getAttribute("data-session-key") === MAIN)!);
    await waitFor(() => expect(screen.getAllByTestId("chat-tab").find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key")).toBe(MAIN));
    await delta({ deltaText: " who threw the stone." });
    await waitFor(() => expect(bubbles("The sea does not remember who threw the stone.")).toHaveLength(1));
  });

  it("paints nothing for another run's append-only frames it has no start for", async () => {
    await mount(surface);
    const run = await sendPrompt();
    await push("chat", { runId: run, sessionKey: MAIN, state: "delta", deltaText: "Tomorrow", message: assistantMessage("Tomorrow", 1) });
    await waitFor(() => expect(bubbles("Tomorrow")).toHaveLength(1));

    await push("chat", { runId: "a-scheduled-turn", sessionKey: MAIN, state: "delta", deltaText: " stray tail" });
    expect(bubbles(/stray tail/)).toHaveLength(0);
  });
});
