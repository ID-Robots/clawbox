/**
 * TASK-2702. Right after a network switch the gateway restarts, and the first
 * message went out while it was still starting: the core refused `chat.send`
 * with its retryable startup refusal, and the chat put "Error: chat.send
 * unavailable during gateway startup" in front of the owner (a second try
 * worked). The chat now waits that out under "Starting up, one moment…" and
 * sends the same turn again.
 *
 * The fake gateway is the one chat-fix-error-and-message-events.test.tsx uses,
 * refusing the first `chat.send` the way the core does (2026.11.5,
 * `unavailableDuringStartup` in its request authorization).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { dispatchChatMessage } from "@/lib/ui-events";

// The same ceilings every suite that mounts ChatPopup declares (test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SEED_TEXT = "Ready when you are.";
const SESSION = "agent:main:main";

const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;
let refuseSends = 0;

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
      this.reply({ type: "res", id, ok: true, payload: { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.reply({ type: "res", id, ok: true, payload: { messages: [{ role: "assistant", content: [{ type: "text", text: SEED_TEXT }], timestamp: 500 }] } });
      return;
    }
    if (frame.method === "chat.send" && refuseSends > 0) {
      refuseSends--;
      this.reply({
        type: "res",
        id,
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "chat.send unavailable during gateway startup",
          retryable: true,
          retryAfterMs: 500,
          details: { reason: "startup-sidecars", method: "chat.send" },
        },
      });
      return;
    }
    this.reply({ type: "res", id, ok: true, payload: { runId: "r1", status: "started" } });
  }

  close() {}

  private reply(frame: unknown) {
    setTimeout(() => this.emit(frame), 0);
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

const sends = () => sent.filter((f) => f.method === "chat.send");

describe("a message sent while the gateway is still starting", () => {
  beforeEach(() => {
    sent.length = 0;
    sockets.length = 0;
    refuseSends = 0;
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

  it("waits under 'Starting up, one moment…' and sends the same turn again, never showing the refusal", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByText(SEED_TEXT);
    refuseSends = 1;

    act(() => { dispatchChatMessage("hello after the switch"); });

    // Rendered with no i18n provider, so `t` answers the key ("Starting up, one moment…" in English).
    expect(await screen.findByText("chat.startingUp")).toBeInTheDocument();
    await waitFor(() => expect(sends()).toHaveLength(2), { timeout: 5_000 });
    // One turn: the retry carries the refused send's idempotency key.
    const keys = sends().map((f) => (f.params as { idempotencyKey?: string }).idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    await waitFor(() => expect(screen.queryByText("chat.startingUp")).toBeNull());
    expect(screen.queryByText(/unavailable during gateway startup/)).toBeNull();
  });

  it("Stop during that wait ends it: the turn is never sent again", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByText(SEED_TEXT);
    refuseSends = 99;

    act(() => { dispatchChatMessage("hello after the switch"); });
    expect(await screen.findByText("chat.startingUp")).toBeInTheDocument();
    expect(sends()).toHaveLength(1);

    fireEvent.click(screen.getByTestId("chat-stop"));
    // The run ends at once (a Stop, not a failure): no status line, no error.
    await waitFor(() => expect(screen.queryByText("chat.startingUp")).toBeNull());
    // Past the first two waits (1 s, then 2 s): nothing more goes out.
    await act(async () => { await new Promise((r) => setTimeout(r, 3500)); });
    expect(sends()).toHaveLength(1);
    expect(screen.queryByText("chat.startingUp")).toBeNull();
    expect(screen.queryByText(/unavailable during gateway startup/)).toBeNull();
  });

  it("a new chat during that wait drops the old message instead of sending it into the fresh one", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByText(SEED_TEXT);
    refuseSends = 99;

    act(() => { dispatchChatMessage("hello after the switch"); });
    expect(await screen.findByText("chat.startingUp")).toBeInTheDocument();
    expect(sends()).toHaveLength(1);

    fireEvent.click(screen.getByTestId("chat-tab-restart"));
    await waitFor(() => expect(sent.some((f) => f.method === "sessions.reset")).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 3500)); });
    expect(sends()).toHaveLength(1);
  });

  it("closing the tab during that wait drops its message instead of sending it to a deleted conversation", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByText(SEED_TEXT);
    const plus = await screen.findByTestId("chat-new-tab");
    await waitFor(() => expect(plus).not.toBeDisabled());
    fireEvent.click(plus);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    refuseSends = 99;

    act(() => { dispatchChatMessage("hello from the second tab"); });
    expect(await screen.findByText("chat.startingUp")).toBeInTheDocument();
    expect(sends()).toHaveLength(1);
    const tabKey = (sends()[0].params as { sessionKey?: string }).sessionKey;
    expect(tabKey).not.toBe(SESSION);

    fireEvent.click(screen.getAllByTestId("chat-tab-close")[0]);
    await act(async () => { await new Promise((r) => setTimeout(r, 3500)); });
    expect(sends()).toHaveLength(1);
  });
});
