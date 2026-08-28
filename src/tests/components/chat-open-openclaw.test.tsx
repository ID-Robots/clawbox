import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * The "+" in the chat strip opens the gateway's own chat UI in a NEW TAB — a
 * fresh OpenClaw session — with the gateway URL and token in the URL, exactly
 * as OpenClawApp's iframe carries them. It used to reset this popup's own
 * thread in place; that is gone, and the test pins that it stays gone: the
 * click must send no `sessions.reset` and leave the transcript alone.
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

describe("the strip's + button", () => {
  beforeEach(() => {
    history = [assistantMessage(SEED_TEXT, 500)];
    sent.length = 0;
    resetFails = false;
    sockets.length = 0;
    resetHarnessCache();
    installFetch();
    vi.stubGlobal("WebSocket", FakeGatewayWs);
    // jsdom has no layout: the transcript's scroll-to-bottom on every new
    // message would otherwise throw off the React tree as an unhandled error.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the gateway's chat UI in a new tab, with the gateway URL and token", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await mountReady();
    fireEvent.click(screen.getByRole("button", { name: "Open in OpenClaw" }));
    expect(open).toHaveBeenCalledWith(
      "/chat?gatewayUrl=ws%3A%2F%2Flocalhost%2Fgw#token=t",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not touch this popup's own thread", async () => {
    vi.stubGlobal("open", vi.fn());
    await mountReady();
    fireEvent.click(screen.getByRole("button", { name: "Open in OpenClaw" }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(resetFrames()).toHaveLength(0);
    expect(screen.getByText(SEED_TEXT)).toBeTruthy();
  });
});
