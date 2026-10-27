import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, render, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";
import { resetChatPhoneLayoutMemory } from "@/lib/chat-phone-layout";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * The full-page chat reads the transcript only for eyes that are on it.
 *
 * This page has no open/closed state — it is a route — but it spends most of
 * its life in a background tab, and the gateway keeps pushing `session.message`
 * either way. Each push used to cost a whole 50-message `chat.history` for a
 * window nobody was looking at. What is pinned here: pushes into a hidden tab
 * cost no read, however many arrive; bringing the tab forward costs exactly one,
 * carrying all of them; and a visible page still refetches per push.
 *
 * `ChatPopup` carries the same gate for its shut-panel case, and the delta
 * cursor in the adapter is pinned separately.
 */

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
      return { ok: true, json: async () => ({ token: "***", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    if (url.includes("/setup-api/chat/tabs")) {
      return { ok: true, json: async () => ({ tabs: [], closed: [], active: null }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
}

const historyReads = () => sent.filter((frame) => frame.method === "chat.history");

function push(text: string, timestamp: number) {
  histories[MAIN] = [...(histories[MAIN] ?? []), assistant(text, timestamp)];
  act(() => {
    socket()?.emit({
      type: "event",
      event: "session.message",
      payload: { sessionKey: MAIN, message: assistant(text, timestamp) },
    });
  });
}

async function settle(ms = 60) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
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

describe("the full-page chat", () => {
  it("reads nothing while its tab is hidden, and once when it comes back", async () => {
    const view = render(<ChatApp />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await waitFor(() => expect(historyReads().length).toBeGreaterThan(0));
    await settle(150);

    setVisibility("hidden");
    const before = historyReads().length;
    await settle(50);
    for (let i = 0; i < 3; i++) {
      push(`Another device said ${i}`, 600 + i);
      await settle(150);
    }
    expect(historyReads().length).toBe(before);

    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle(150);
    expect(historyReads().length).toBe(before + 1);
    await waitFor(() => expect(document.body.textContent ?? "").toContain("Another device said 2"));

    // Nothing is left owed, and no timer pays a second visit.
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle(150);
    expect(historyReads().length).toBe(before + 1);
    void view;
  });

  it("still refetches per push while the tab is visible", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await waitFor(() => expect(historyReads().length).toBeGreaterThan(0));
    await settle(150);

    const before = historyReads().length;
    push("A turn from the phone", 600);
    await settle(600);

    expect(historyReads().length).toBe(before + 1);
    await waitFor(() => expect(document.body.textContent ?? "").toContain("A turn from the phone"));
  });
});
