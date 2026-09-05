import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, render, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * A state updater is a PURE function of the previous state, and React is
 * entitled to call it twice.
 *
 * Both chat surfaces appended the interrupted turn from INSIDE the
 * `setStreaming` updater on a gateway abort:
 *
 *   setStreaming(prev => {
 *     const kept = dropUnfinishedDirective(prev)
 *     if (kept.trim()) setMessages(msgs => [...msgs, { … }])   // <- side effect
 *     return ''
 *   })
 *
 * Under Strict Mode — and under concurrent rendering, which is not a dev-only
 * behaviour — that runs twice and the owner's interrupted answer is appended
 * to the transcript TWICE. CodeRabbit raised it on both surfaces during PR
 * #605 and it was refuted there as pre-existing and out of scope; this is the
 * card it was deferred to (TASK-703).
 *
 * Strict Mode is how the test provokes it, not what the fix is for: the same
 * double-invocation is what React does when it re-renders a component whose
 * update was interrupted, which is why the rule is "no side effects in an
 * updater" rather than "no side effects in an updater in development".
 */

const REPLY = "Half an answer before the owner pressed Stop.";

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
    setTimeout(
      () => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }),
      0,
    );
  }

  send(raw: string) {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: [] });
      return;
    }
    this.respond(id, {});
  }

  close() {
    this.readyState = FakeGatewayWs.CLOSED;
  }

  addEventListener() {}
  removeEventListener() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  pushChat(state: string, message: unknown) {
    this.emit({
      type: "event",
      event: "chat",
      payload: { sessionKey: "agent:main:main", state, message },
    });
  }
}

async function socket() {
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return instances[instances.length - 1];
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
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
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/** How many times `needle` appears in what is on screen. */
function occurrences(needle: string): number {
  return (document.body.textContent ?? "").split(needle).length - 1;
}

/** Let the handshake and the one `chat.history` round-trip settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Push a partial reply, then the abort the Stop button produces. */
async function streamThenAbort(ws: FakeGatewayWs): Promise<void> {
  await settle();
  await act(async () => {
    ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: REPLY }] });
    await Promise.resolve();
  });
  await act(async () => {
    ws.pushChat("aborted", { role: "assistant", content: [{ type: "text", text: "" }] });
    await Promise.resolve();
  });
}

beforeEach(() => {
  // jsdom has no `scrollIntoView`, and `scrollToBottomAfterLayout` (src/lib/scroll.ts)
  // calls it from a double-rAF — OUTSIDE any test body, so vitest counts the
  // TypeError as an unhandled error and the whole components project exits 1
  // while every assertion here passes. Every other chat suite in this repo
  // stubs it for the same reason.
  Element.prototype.scrollIntoView = vi.fn();
  instances.length = 0;
  resetHarnessCache();
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an interrupted turn is appended once, however many times React renders", () => {
  it("full-screen chat", async () => {
    render(
      <StrictMode>
        <ChatApp />
      </StrictMode>,
    );
    const ws = await socket();

    await streamThenAbort(ws);

    // Once. Twice is the defect: the streaming bubble is gone by now, so every
    // copy on screen is an appended transcript entry.
    expect(occurrences(REPLY)).toBe(1);
  });

  it("mascot popup", async () => {
    render(
      <StrictMode>
        <ChatPopup isOpen onClose={() => {}} />
      </StrictMode>,
    );
    const ws = await socket();

    await streamThenAbort(ws);

    expect(occurrences(REPLY)).toBe(1);
  });

  it("keeps the interrupted answer above the error line, as it was", async () => {
    // Moving the append out of the updater also moved it in TIME: on beta it
    // was queued during the render pass, i.e. AFTER the system error line the
    // handler had already queued, so the owner saw the red line and then the
    // fragment. Outside the updater it queues first. Same commit either way,
    // but the two bubbles swap — a customer-visible change with nothing
    // pinning it. Pinned here: the answer the box managed to write comes
    // first, and the line explaining that it stopped comes after it.
    render(
      <StrictMode>
        <ChatApp />
      </StrictMode>,
    );
    const ws = await socket();
    await settle();
    await act(async () => {
      ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: REPLY }] });
      await Promise.resolve();
    });
    await act(async () => {
      ws.emit({
        type: "event",
        event: "chat",
        payload: {
          sessionKey: "agent:main:main",
          state: "error",
          message: { role: "assistant", content: [{ type: "text", text: "" }] },
          errorMessage: "gateway said no",
        },
      });
      await Promise.resolve();
    });

    const rendered = document.body.textContent ?? "";
    const reply = rendered.indexOf(REPLY);
    // The failure notice, whatever its wording — the surface picks between a
    // sanitised gateway line and its own generic one.
    const notice = rendered.search(/Error:|did not go through|could not|failed|try again/i);
    expect(reply, `the interrupted answer was not kept:\n${rendered}`).toBeGreaterThan(-1);
    expect(notice, `no failure notice was shown:\n${rendered}`).toBeGreaterThan(-1);
    expect(reply, `the notice came before the answer:\n${rendered}`).toBeLessThan(notice);
  });

  // The behavioural cases above pin the two paths that were reported. The RULE
  // — no state write inside any state updater, anywhere in the UI tree — is
  // pinned by `src/tests/unit/state-updater-purity.test.ts`, which reads the
  // tree with the TypeScript compiler instead of a regex and so needs neither
  // jsdom nor React.
});
