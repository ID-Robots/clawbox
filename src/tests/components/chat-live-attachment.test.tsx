import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { describeChatFailure } from "@/lib/chat-error-text";

// Both surfaces mount the fake gateway handshake, the history restore and the
// transcript in jsdom, which costs seconds under a full parallel run; see
// test-timeout-hygiene.test.ts for why the ceiling is declared per file.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * TASK-1372 — a file the agent sends shows its card live, exactly once.
 *
 * Seen on a box after a send from the full-page chat (`/app/clawbox`): the
 * reply's words appeared live, its download card only after a reload. The
 * gateway's live `final` frame often arrives WITHOUT the attachment; the
 * transcript append the gateway stores carries it, and `chat.history` reads
 * it back. The mascot chat learned to subscribe to those appends and re-read
 * on each `session.message` push; the full-page chat had not.
 *
 * Both orders are driven against both surfaces, because both happen: the final
 * landing first (its bubble has no card until the re-read replaces it) and the
 * push landing first (the re-read paints the card, and the stripped final that
 * follows must not add a second bubble).
 */

const MAIN = "agent:main:main";
const PROMPT = "send me the weekly report";
const REPLY = "Here is the weekly report you asked for.";
// A file the agent wrote, named the way the harness names it: a MEDIA: line in
// the stored reply text.
const FILE_PATH = "/tmp/clawbox-outbox/weekly-report.pdf";
const SEED_TEXT = "Ready when you are.";
/** What the device stamps — deliberately far behind the browser's Date.now(). */
const SERVER_TS = 1_000;

function userMessage(text: string, timestamp: number, idempotencyKey?: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp, ...(idempotencyKey ? { idempotencyKey } : {}) };
}

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

/** The stored reply: the words AND the file. */
const STORED_REPLY = assistantMessage(`${REPLY}\n\nMEDIA:${FILE_PATH}`, SERVER_TS + 1);
/** The live final as the gateway often sends it: the words, the file stripped. */
const LIVE_FINAL = { role: "assistant", content: [{ type: "text", text: REPLY }] };

let history: unknown[] = [];
let historyReads = 0;
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
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
      return;
    }
    if (frame.method === "chat.history") {
      historyReads += 1;
      this.respond(id, { messages: history });
      return;
    }
    this.respond(id, { runId: "r1", status: "started" });
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
const bubbles = (text: string) => screen.queryAllByText(text).filter((el) => el.tagName !== "TEXTAREA");
const fileCards = () => document.querySelectorAll('[data-testid="chat-file-card"]');

/** The run id the surface generated for the turn it just sent. */
function lastSentRunId(): string {
  const send = sent.filter((f) => f.method === "chat.send").pop();
  return String((send?.params as { idempotencyKey?: string })?.idempotencyKey ?? "");
}

async function flush() {
  // The fake socket answers on a later macrotask; give it, and React, a turn.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function sendPrompt() {
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: PROMPT } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(lastSentRunId()).not.toBe(""));
  await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));
}

/** The gateway now holds the turn and the reply, its file intact. */
function storeTurn() {
  history = [
    assistantMessage(SEED_TEXT, SERVER_TS - 10),
    userMessage(PROMPT, SERVER_TS, `${lastSentRunId()}:user`),
    STORED_REPLY,
  ];
}

function pushFinal() {
  socket()?.emit({ type: "event", event: "chat", payload: { sessionKey: MAIN, runId: lastSentRunId(), state: "final", message: LIVE_FINAL } });
}

/** The transcript gained the stored reply; the surface should re-read. */
async function pushStoredReply(sessionKey = MAIN) {
  const before = historyReads;
  socket()?.emit({ type: "event", event: "session.message", payload: { sessionKey, agentId: "main", message: STORED_REPLY } });
  if (sessionKey !== MAIN) return;
  // The re-read is coalesced over a short window, then answered a macrotask
  // later: wait for the request, then flush the answer into the render.
  await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3_000 });
  await flush();
}

/** Exactly one reply bubble, exactly one card, and the prompt shown once. */
async function expectReplyOnceWithItsCard() {
  await waitFor(() => expect(fileCards()).toHaveLength(1));
  expect(bubbles(REPLY)).toHaveLength(1);
  expect(bubbles(PROMPT)).toHaveLength(1);
  expect(fileCards()[0].textContent).toContain("weekly-report.pdf");
  expect(document.body.textContent).not.toContain(`MEDIA:${FILE_PATH}`);
}

const SURFACES = [
  { name: "the full-page chat (ChatApp)", mount: () => render(<ChatApp />) },
  { name: "the mascot chat (ChatPopup)", mount: () => render(<ChatPopup isOpen onClose={() => {}} />) },
] as const;

describe.each(SURFACES)("a file the agent sends, in $name", ({ mount }) => {
  beforeEach(() => {
    // Seeded non-empty: on an empty transcript the mascot chat may greet and
    // gate the composer, and the send under test would never happen.
    history = [assistantMessage(SEED_TEXT, SERVER_TS - 10)];
    historyReads = 0;
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

  async function mountReady() {
    mount();
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByText(SEED_TEXT);
  }

  it("subscribes to the session's transcript appends", async () => {
    await mountReady();
    await waitFor(() => expect(sent.some((f) => f.method === "sessions.messages.subscribe")).toBe(true));
    const subscribe = sent.find((f) => f.method === "sessions.messages.subscribe");
    expect((subscribe?.params as { key?: string }).key).toBe(MAIN);
  });

  it("final without the file, then session.message with it: the card appears live, once", async () => {
    await mountReady();
    await sendPrompt();

    await act(async () => { pushFinal(); });
    // The live final painted the words — and, as on the box, no card.
    await waitFor(() => expect(bubbles(REPLY)).toHaveLength(1));
    expect(fileCards()).toHaveLength(0);

    storeTurn();
    await pushStoredReply();

    // Without a reload: the re-read replaced the card-less bubble with the
    // stored reply instead of adding a second one.
    await expectReplyOnceWithItsCard();
  });

  it("session.message first, then the stripped final: no duplicate bubble", async () => {
    await mountReady();
    await sendPrompt();

    storeTurn();
    await pushStoredReply();
    await expectReplyOnceWithItsCard();

    // The live final lands after the re-read, with the same words and no file.
    await act(async () => { pushFinal(); });
    await flush();

    await expectReplyOnceWithItsCard();
  });

  it("session.message first, then a final that DOES carry the file: still one bubble", async () => {
    await mountReady();
    await sendPrompt();

    storeTurn();
    await pushStoredReply();
    await expectReplyOnceWithItsCard();

    // Not every final is stripped: this one names the same file.
    await act(async () => {
      socket()?.emit({
        type: "event",
        event: "chat",
        payload: { sessionKey: MAIN, runId: lastSentRunId(), state: "final", message: { role: "assistant", content: [{ type: "text", text: `${REPLY}\n\nMEDIA:${FILE_PATH}` }] } },
      });
    });
    await flush();

    await expectReplyOnceWithItsCard();
  });

  it("the same, for the gateway's own outgoing-media attachment", async () => {
    // How a box's gateway actually stores a file the agent sent (TASK-892): a
    // structured attachment whose URL is in the gateway's media tree, not a
    // MEDIA: line — and the live final carries neither.
    await mountReady();
    await sendPrompt();

    await act(async () => { pushFinal(); });
    await waitFor(() => expect(bubbles(REPLY)).toHaveLength(1));
    expect(fileCards()).toHaveLength(0);

    const stored = {
      role: "assistant",
      content: [
        { type: "text", text: REPLY },
        {
          type: "attachment",
          attachment: { url: "/api/chat/media/outgoing/agent%3Amain%3Amain/0f3c9a/full", kind: "document", mimeType: "application/pdf" },
        },
      ],
      timestamp: SERVER_TS + 1,
    };
    history = [
      assistantMessage(SEED_TEXT, SERVER_TS - 10),
      userMessage(PROMPT, SERVER_TS, `${lastSentRunId()}:user`),
      stored,
    ];
    const before = historyReads;
    socket()?.emit({ type: "event", event: "session.message", payload: { sessionKey: MAIN, message: stored } });
    await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3_000 });
    await flush();

    await waitFor(() => expect(fileCards()).toHaveLength(1));
    expect(bubbles(REPLY)).toHaveLength(1);
    expect(bubbles(PROMPT)).toHaveLength(1);
  });

  it("a push for another session neither re-reads nor changes the transcript", async () => {
    await mountReady();
    await sendPrompt();
    await act(async () => { pushFinal(); });
    await waitFor(() => expect(bubbles(REPLY)).toHaveLength(1));

    const reads = historyReads;
    storeTurn();
    await act(async () => { await pushStoredReply("agent:main:some-other-session"); });
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

    expect(historyReads).toBe(reads);
    expect(fileCards()).toHaveLength(0);
    expect(bubbles(REPLY)).toHaveLength(1);
  });
});

describe("the full-page chat's own notes across a transcript re-read", () => {
  beforeEach(() => {
    history = [assistantMessage(SEED_TEXT, SERVER_TS - 10)];
    historyReads = 0;
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

  it("keeps a failed turn's line, which the gateway's transcript cannot carry", async () => {
    render(<ChatApp />);
    await screen.findByText(SEED_TEXT);
    await sendPrompt();

    await act(async () => {
      socket()?.emit({ type: "event", event: "chat", payload: { sessionKey: MAIN, runId: lastSentRunId(), state: "error", errorMessage: "model exploded" } });
    });
    const line = describeChatFailure("model exploded");
    await screen.findByText(line);

    // The gateway stored the turn; its append is pushed, and the page re-reads.
    history = [assistantMessage(SEED_TEXT, SERVER_TS - 10), userMessage(PROMPT, SERVER_TS, `${lastSentRunId()}:user`)];
    const before = historyReads;
    socket()?.emit({ type: "event", event: "session.message", payload: { sessionKey: MAIN, message: history[1] } });
    await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3_000 });
    await flush();

    expect(screen.getAllByText(line)).toHaveLength(1);
    expect(bubbles(PROMPT)).toHaveLength(1);
    // Still after the turn it belongs to.
    const text = document.body.textContent ?? "";
    expect(text.indexOf(line)).toBeGreaterThan(text.indexOf(PROMPT));
  });
});
