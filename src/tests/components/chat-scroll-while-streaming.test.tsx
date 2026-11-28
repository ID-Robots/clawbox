// Scrolling the chat while the bot writes (TASK-2222), on both surfaces that
// share the transcript: the full-page chat (`/app/clawbox`, ChatApp) and the
// mascot chat (ChatPopup).
//
// While a reply streamed, the chat could not be scrolled: both surfaces
// `scrollIntoView`-ed an end sentinel two frames after EVERY change of the
// streaming text, wherever the reader was, so each chunk put a reader who had
// scrolled up back at the bottom — and the chat looked frozen. On a real board
// (Hermes, a long reply) six wheel ticks up moved the view DOWN, and it was
// pulled back to the bottom in 89 of 100 samples over the next five seconds.
//
// These pin the three things the owner expects, on the real components
// against a scripted gateway:
//   1. the reply is followed while the reader is at the bottom;
//   2. a reader who scrolls up — even a few pixels — is left there by every
//      chunk and by the finished answer;
//   3. back at the very bottom, the reply is followed again.
//
// The transcript gets a browser's geometry, and `scrollIntoView` does what a
// browser's does — scrolls the transcript to the element — so a component
// that scrolls by any route is caught, not just by the hook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// See test-timeout-hygiene.test.ts: a jsdom mount of a chat costs seconds
// under a full parallel run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SESSION = "agent:main:main";
const CLIENT = 300;

type Frame = Record<string, unknown>;
const instances: FakeGatewayWs[] = [];

class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    instances.push(this);
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Frame;
    try { frame = JSON.parse(raw) as Frame; } catch { return; }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } });
      return;
    }
    if (frame.method === "chat.history") {
      // A conversation already under way, so the mascot chat does not greet.
      this.respond(id, {
        messages: [
          { role: "user", content: "Tell me about the box.", timestamp: 1787236200000 },
          { role: "assistant", content: [{ type: "text", text: "It is a small computer." }], timestamp: 1787236201000 },
        ],
      });
      return;
    }
    this.respond(id, {});
  }

  close() { this.readyState = FakeGatewayWs.CLOSED; }
  addEventListener() {}
  removeEventListener() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  pushChat(state: string, message: unknown) {
    this.emit({ type: "event", event: "chat", payload: { sessionKey: SESSION, state, message } });
  }
}

/** A transcript as tall as its text, its position clamped to it, as a browser keeps it. */
function browserGeometry(el: HTMLElement) {
  const height = () => 1200 + (el.textContent ?? "").length * 3;
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => CLIENT });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, height() - CLIENT)); },
  });
  return { bottom: () => height() - CLIENT, distance: () => height() - CLIENT - top };
}

/** The reader turns the wheel: the wheel event, then the scroll it makes. */
function wheel(el: HTMLElement, deltaY: number) {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
  el.scrollTop = el.scrollTop + deltaY;
  el.dispatchEvent(new Event("scroll"));
}

/** Long enough for any frame or timer a chunk schedules to have run. */
async function frames(ms = 60) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** The reply so far, `n` sentences long. */
const replyOf = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence ${i + 1} of a long answer about the box.`).join(" ");

async function chunk(ws: FakeGatewayWs, n: number) {
  await act(async () => {
    ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: replyOf(n) }] });
    await Promise.resolve();
  });
  await waitFor(() => expect(document.body.textContent).toContain(`Sentence ${n} of`));
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

beforeEach(() => {
  instances.length = 0;
  window.localStorage.clear();
  resetHarnessCache();
  // What a browser's does: brings the element into view by scrolling the
  // transcript holding it — for an end-of-transcript sentinel, to the bottom.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    const scroller = this.closest<HTMLElement>('[data-testid="chat-transcript"], [data-testid="chatapp-transcript"]');
    if (scroller && scroller !== this) scroller.scrollTop = scroller.scrollHeight;
  };
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SURFACES = [
  { name: "the full-page chat", mount: () => render(<ChatApp />), testId: "chatapp-transcript" },
  { name: "the mascot chat", mount: () => render(<ChatPopup isOpen onClose={() => {}} />), testId: "chat-transcript" },
] as const;

describe.each(SURFACES)("$name, while the bot writes", ({ mount, testId }) => {
  async function open() {
    mount();
    await screen.findByText("It is a small computer.");
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    const ws = instances[instances.length - 1];
    const transcript = screen.getByTestId(testId);
    const geometry = browserGeometry(transcript);
    return { ws, transcript, geometry };
  }

  it("follows the reply, leaves a reader who scrolled up where they are, and follows again at the very bottom", async () => {
    const { ws, transcript, geometry } = await open();

    // 1. At the bottom, the reply is followed chunk by chunk.
    for (let n = 1; n <= 3; n++) {
      await chunk(ws, n);
      await waitFor(() => expect(geometry.distance()).toBe(0));
    }

    // 2. The reader turns the wheel up a little — well inside the 80 px the
    // chat used to still call "the bottom" — and then further.
    wheel(transcript, -30);
    await frames();
    expect(geometry.distance()).toBe(30);
    wheel(transcript, -400);
    const readingAt = transcript.scrollTop;
    for (let n = 4; n <= 12; n++) {
      await chunk(ws, n);
      await frames();
      expect(transcript.scrollTop).toBe(readingAt);
    }
    // The finished answer replaces the streaming bubble: still left alone.
    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: [{ type: "text", text: `${replyOf(12)} The end.` }] });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.body.textContent).toContain("The end."));
    await frames(400);
    expect(transcript.scrollTop).toBe(readingAt);
    expect(geometry.distance()).toBeGreaterThan(400);

    // 3. Back at the very bottom, the next reply is followed again.
    wheel(transcript, geometry.distance() + 500);
    expect(geometry.distance()).toBe(0);
    for (let n = 1; n <= 3; n++) {
      await chunk(ws, n);
      await waitFor(() => expect(geometry.distance()).toBe(0), { timeout: 3_000 });
    }
  });

  it("lands the owner on the bottom when they send, wherever they had scrolled to", async () => {
    const { ws, transcript, geometry } = await open();
    await chunk(ws, 6);
    await waitFor(() => expect(geometry.distance()).toBe(0));
    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: [{ type: "text", text: replyOf(6) }] });
      await Promise.resolve();
    });
    wheel(transcript, -800);
    await frames(400);
    expect(geometry.distance()).toBeGreaterThan(300);

    const composers = document.querySelectorAll("textarea");
    const composer = composers[composers.length - 1] as HTMLTextAreaElement;
    await waitFor(() => expect(composer).not.toBeDisabled());
    fireEvent.change(composer, { target: { value: "And the memory?" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(document.body.textContent).toContain("And the memory?"));
    await waitFor(() => expect(geometry.distance()).toBe(0));
  });
});
