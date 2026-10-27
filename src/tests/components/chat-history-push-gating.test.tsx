import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { resetChatPhoneLayoutMemory } from "@/lib/chat-phone-layout";

/**
 * Nobody is reading it, so nobody pays for it.
 *
 * The desktop panel stays MOUNTED behind the desktop with the popup shut, and a
 * browser tab spends most of its life in the background — but the gateway keeps
 * pushing `session.message` either way, and each of those used to cost a whole
 * 50-message `chat.history` (~206 KB, and a synchronous scan on the box) to
 * repaint a transcript no one could see. An audit measured 46 such reads an
 * hour with the popup closed.
 *
 * What is pinned here: pushes arriving while the panel is shut or the window is
 * hidden cost NO read at all, however many of them there are; opening the panel
 * or bringing the window forward costs exactly ONE, carrying all of them; and a
 * popup someone is looking at still refreshes on every push, which is the
 * behaviour the suppression must not swallow.
 *
 * The count is taken off the wire — `chat.history` frames on the fake socket —
 * because that is the traffic the audit measured, and because a read that is
 * merely scheduled and never sent would still be a lie.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MAIN = "agent:main:main";

const assistant = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });

let histories: Record<string, unknown[]> = {};
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
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: histories[String(params.sessionKey)] ?? [] });
      return;
    }
    this.respond(id, {});
  }

  close() {}
  addEventListener() {}
  removeEventListener() {}

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
    if (url.includes("/setup-api/chat/tabs")) {
      return { ok: true, json: async () => ({ tabs: [], active: null }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

/** The tab's visibility, which jsdom otherwise fixes at "visible" for good. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
}

const historyReads = () => sent.filter((frame) => frame.method === "chat.history");

/** One pushed append, as the gateway sends it when another device's turn lands. */
function push(text: string, timestamp: number) {
  // The box stored it before it pushed it, as it does: the read the push asks
  // for is what puts it on screen.
  histories[MAIN] = [...(histories[MAIN] ?? []), assistant(text, timestamp)];
  act(() => {
    socket()?.emit({
      type: "event",
      event: "session.message",
      payload: { sessionKey: MAIN, message: assistant(text, timestamp) },
    });
  });
}

async function settle(ms = 40) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** The connect hello reads the transcript once; everything after it is under test. */
async function mounted(isOpen: boolean) {
  const view = render(<ChatPopup isOpen={isOpen} onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await waitFor(() => expect(historyReads().length).toBeGreaterThan(0));
  await settle(120);
  return view;
}

beforeEach(() => {
  histories = { [MAIN]: [assistant("Good morning from main", 500)] };
  sent.length = 0;
  sockets.length = 0;
  window.localStorage.clear();
  resetHarnessCache();
  resetChatPhoneLayoutMemory();
  setVisibility("visible");
  installFetch();
  vi.stubGlobal("WebSocket", FakeGatewayWs);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetHarnessCache();
  resetChatPhoneLayoutMemory();
});

describe("a pushed append while nobody is looking at the chat", () => {
  it("costs no history read with the panel shut, and exactly one when it opens", async () => {
    const view = await mounted(false);
    const before = historyReads().length;

    // Five appends, spread past the 400 ms coalescing window so a read that was
    // merely deferred would have fired by now.
    for (let i = 0; i < 5; i++) {
      push(`Another device said ${i}`, 600 + i);
      await settle(120);
    }
    expect(historyReads().length).toBe(before);

    // Opening the panel is the moment the difference becomes visible: ONE read
    // for all five, not five — and it carries every append that was skipped.
    view.rerender(<ChatPopup isOpen onClose={() => {}} />);
    await settle(120);
    expect(historyReads().length).toBe(before + 1);
    await waitFor(() => expect(document.body.textContent ?? "").toContain("Another device said 4"));
  });

  it("costs no history read in a hidden tab, and exactly one when the window comes back", async () => {
    setVisibility("hidden");
    const view = await mounted(true);
    const before = historyReads().length;

    for (let i = 0; i < 3; i++) {
      push(`Another device said ${i}`, 600 + i);
      await settle(150);
    }
    expect(historyReads().length).toBe(before);

    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle(120);
    expect(historyReads().length).toBe(before + 1);

    // Nothing is left owed: a second visibility change reads nothing.
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle(120);
    expect(historyReads().length).toBe(before + 1);

    view.rerender(<ChatPopup isOpen onClose={() => {}} />);
    await settle(120);
    expect(historyReads().length).toBe(before + 1);
  });

  it("still refetches on every push for a popup someone is looking at", async () => {
    await mounted(true);
    const before = historyReads().length;

    push("A turn from the phone", 600);
    await settle(600);

    expect(historyReads().length).toBe(before + 1);
    // The read is what puts the pushed turn on screen.
    await waitFor(() => expect(document.body.textContent ?? "").toContain("A turn from the phone"));
  });
});
