import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * A sent message must appear once, however far apart the two clocks are.
 *
 * The chat appends the turn locally the moment you press Enter, stamped with
 * `Date.now()` — the BROWSER's clock. `chat.history` then returns that same turn
 * stamped by the DEVICE. Those are two different machines, and the reconcile
 * used to decide "is this still in flight?" by comparing them: keep any local
 * user turn newer than the newest message the server returned.
 *
 * On a browser running ahead of the box that is always true, so the optimistic
 * copy survived a history read that had already echoed it back and the question
 * rendered twice. `sameTranscript` compares timestamps, so the pair never
 * collapsed on a later render either.
 *
 * Reproduced on the box: one "generate bunny image" in the transcript, two
 * bubbles on screen. Image generation makes it easy to hit because the run is
 * long and tool events reconcile throughout, but nothing here is specific to
 * images — any reply slow enough to span a reconcile does it.
 *
 * Two harness details are load-bearing, both learned by getting them wrong:
 *
 * 1. History is seeded NON-EMPTY. On an empty transcript the popup auto-greets
 *    and gates the composer while it bootstraps, so the send never happens and
 *    the test measures nothing.
 * 2. Bubbles are counted excluding the textarea. React renders a controlled
 *    textarea's value as a DOM text node, so a bare `queryAllByText` counts the
 *    unsent draft as if it were a message.
 */

const PROMPT = "generate bunny image";
/** What the device stamps. Deliberately far behind the browser's Date.now(). */
const SERVER_TS = 1000;
const SEED_TS = 500;
const SEED_TEXT = "Ready when you are.";

function userMessage(text: string, timestamp: number, idempotencyKey?: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp, idempotencyKey };
}

/** The run id the component generated for the turn it just sent. */
function lastSentRunId(): string {
  const send = sent.filter((f) => f.method === "chat.send").pop();
  return String((send?.params as { idempotencyKey?: string })?.idempotencyKey ?? "");
}

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

/** A prior turn, so the transcript is never empty and the auto-greet stays off. */
const SEED = assistantMessage(SEED_TEXT, SEED_TS);

/** What the gateway replays. Mutated per test before the reconcile fires. */
let history: unknown[] = [];
let historyReads = 0;
/** Every request frame the component sent. */
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
      historyReads += 1;
      this.respond(id, { messages: history });
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

/** The signal that makes the component re-read `chat.history`. */
function reconcile() {
  socket()?.emit({
    type: "event",
    event: "session.message",
    payload: { sessionKey: "agent:main:main", agentId: "main", message: userMessage(PROMPT, SERVER_TS) },
  });
}

/** Message bubbles only — never the composer's own draft text. */
const bubbles = (text: string) =>
  screen.queryAllByText(text).filter((el) => el.tagName !== "TEXTAREA");

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  // The seed turn proves history landed and the composer is no longer gated.
  await screen.findByText(SEED_TEXT);
}

async function sendPrompt(text: string) {
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
}

async function reconcileOnce() {
  const before = historyReads;
  reconcile();
  await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3000 });
  // LOAD-BEARING. The request has only been *sent* at this point; the fake
  // socket answers it on a later macrotask. Without flushing, every assertion
  // below runs against pre-reconcile state and the file passes even against
  // the unfixed component — verified. Do not remove as "redundant".
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("optimistic user turns across a history reconcile", () => {
  beforeEach(() => {
    history = [SEED];
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

  it("shows a sent message once when the device clock trails the browser", async () => {
    await mountReady();
    await sendPrompt(PROMPT);
    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));

    // The server now has the turn, stamped with its own much-older clock.
    history = [SEED, userMessage(PROMPT, SERVER_TS)];
    await reconcileOnce();

    // Before the fix this was 2: the optimistic copy outlived the echo purely
    // because the browser's clock was ahead of the device's.
    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));
  });

  it("keeps a turn the server has not stored yet", async () => {
    await mountReady();
    await sendPrompt(PROMPT);
    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));

    // A reconcile that beats the write: history still lacks the new turn.
    // Dropping the local copy here would blank the message the user just sent,
    // which is the failure the in-flight carry exists to prevent.
    await reconcileOnce();

    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));
  });

  it("shows an attachment turn once, though its text differs from the server's", async () => {
    // The bubble reads "📎 pic.png\nwhat is this" while the gateway stores and
    // returns the prompt alone — different strings by construction, so no
    // amount of text matching can pair them. Identity is what closes this.
    await mountReady();
    await sendPrompt(PROMPT);
    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));

    const runId = lastSentRunId();
    expect(runId).not.toBe("");
    // Same turn, as the gateway records it: role-suffixed key, its own clock,
    // and text that does NOT match what the bubble is showing.
    history = [SEED, userMessage("a different projection", SERVER_TS, `${runId}:user`)];
    await reconcileOnce();

    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(0));
  });

  it("keeps both when the same words are deliberately sent twice", async () => {
    // The first copy is already on the server; the second is still in flight.
    // An identity check coarser than per-occurrence counting would swallow the
    // second and lose a message the user really did send.
    history = [SEED, userMessage(PROMPT, SERVER_TS)];
    await mountReady();
    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));

    await sendPrompt(PROMPT);
    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(2));

    await reconcileOnce();

    await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(2));
  });
});
