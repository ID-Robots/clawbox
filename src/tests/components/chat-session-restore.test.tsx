import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run, and the
// reconnect case below waits out two real 3 s retry delays on top. See
// test-timeout-hygiene.test.ts for why the ceiling is declared per file.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The restore clocks, shortened so every ending is reached in well under a
// second. ChatPopup reads them from this module, so the component under test
// runs exactly the rules the shipped values run — only faster.
vi.mock("@/lib/chat-session-restore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-session-restore")>();
  return {
    ...actual,
    GATEWAY_REQUEST_TIMEOUT_MS: 400,
    RESTORE_HANDSHAKE_TIMEOUT_MS: 200,
    RECONNECT_DEADLINE_MS: 5_000,
    HISTORY_ATTEMPT_TIMEOUT_MS: 150,
    HISTORY_RESTORE_DEADLINE_MS: 600,
    HISTORY_RETRY_DELAYS_MS: [50, 50],
  };
});

/**
 * TASK-1158 — restoring a conversation must end, and end with a choice.
 *
 * Reproduced from a box's own journal (2026-09-24): the gateway held this
 * chat's `chat.send` for 40 minutes and its `sessions.patch` calls for 35–40
 * behind a busy session, and had answered `chat.history` with "session history
 * is rebuilding; retry shortly" 45 times that week. The chat gave a reconnect
 * no deadline, the connect frame no timeout, and a failed history read only a
 * console line. Each case below is one way a restore can end: normal, stale,
 * busy, timeout, failed — and the retry out of each.
 */

type HistoryAnswer = "ok" | "rebuilding" | "unknown-session" | "hang";

let historyAnswer: HistoryAnswer = "ok";
let history: unknown[] = [];
/** Sockets that open but never say a word — a wedged or swapping gateway. */
let wedged = false;
let ackSends = true;
const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];

const assistant = (text: string, timestamp = 1_700_000_000_000) =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp });

class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState: number = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event?: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    sockets.push(this);
    if (wedged) {
      // Accepted, never answered: no challenge, no close event, nothing.
      this.readyState = FakeGatewayWs.CONNECTING;
      return;
    }
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
      if (historyAnswer === "hang") return;
      if (historyAnswer === "rebuilding") {
        this.refuse(id, { code: "UNAVAILABLE", message: "session history is rebuilding; retry shortly" });
        return;
      }
      if (historyAnswer === "unknown-session") {
        this.refuse(id, { code: "INVALID_REQUEST", message: "unknown session" });
        return;
      }
      this.respond(id, { messages: history });
      return;
    }
    if (frame.method === "chat.send" && !ackSends) return;
    this.respond(id, { runId: "r1", status: "started" });
  }

  close() { this.closed = true; this.readyState = FakeGatewayWs.CLOSED; }

  /** The gateway going away under a connected chat (a restart). */
  drop() {
    this.readyState = FakeGatewayWs.CLOSED;
    this.onclose?.({ code: 1006, reason: "" } as CloseEvent);
  }

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  private refuse(id: string, error: Record<string, unknown>) {
    setTimeout(() => this.emit({ type: "res", id, ok: false, error }), 0);
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

const historyKeys = () => sent
  .filter((f) => f.method === "chat.history")
  .map((f) => (f.params as { sessionKey?: string }).sessionKey);

const restorePanel = () => screen.queryByTestId("chat-restore-failed");

async function mount() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
}

describe("restoring a conversation (TASK-1158)", () => {
  beforeEach(() => {
    sockets.length = 0;
    sent.length = 0;
    historyAnswer = "ok";
    history = [assistant("Welcome back — here is where we left off.")];
    wedged = false;
    ackSends = true;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessCache();
  });

  it("normal: the conversation comes back and no choice is offered", async () => {
    await mount();
    await screen.findByText("Welcome back — here is where we left off.");
    expect(restorePanel()).toBeNull();
    expect(historyKeys()).toEqual(["agent:main:main"]);
  });

  it("stale: waits out 'history is rebuilding' and shows the conversation", async () => {
    historyAnswer = "rebuilding";
    await mount();
    await waitFor(() => expect(historyKeys().length).toBeGreaterThanOrEqual(2));
    historyAnswer = "ok";
    await screen.findByText("Welcome back — here is where we left off.", {}, { timeout: 3_000 });
    expect(restorePanel()).toBeNull();
  });

  it("busy: stops retrying at the deadline, says so, and Try again brings it back", async () => {
    historyAnswer = "rebuilding";
    await mount();
    const panel = await screen.findByTestId("chat-restore-failed", {}, { timeout: 3_000 });
    expect(panel.textContent).toMatch(/still busy on the box/i);
    // Not an empty conversation pretending to be a new one.
    expect(screen.queryByText("chat.saySomething")).toBeNull();
    // Bounded: the retries ended with the panel, and nothing is still asking.
    const reads = historyKeys().length;
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(historyKeys().length).toBe(reads);

    historyAnswer = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Welcome back — here is where we left off.");
    await waitFor(() => expect(restorePanel()).toBeNull());
  });

  it("restart mid-restore: a restore the dropped socket called off runs again on the next hello", async () => {
    historyAnswer = "rebuilding";
    await mount();
    await screen.findByTestId("chat-restore-status", {}, { timeout: 3_000 });
    // The gateway restarts while the restore is still waiting out "rebuilding".
    // The hello after a restart keeps the painted transcript and reads nothing
    // of its own, so the interrupted restore has to be run again — or the
    // conversation stays empty under a "Restoring…" line nothing is behind.
    historyAnswer = "ok";
    act(() => { sockets[0].drop(); });
    await screen.findByText("Welcome back — here is where we left off.", {}, { timeout: 8_000 });
    await waitFor(() => expect(screen.queryByTestId("chat-restore-status")).toBeNull());
    expect(restorePanel()).toBeNull();
  });

  it("timeout: a history read nobody answers ends in the choice instead of an endless wait", async () => {
    historyAnswer = "hang";
    await mount();
    const panel = await screen.findByTestId("chat-restore-failed", {}, { timeout: 3_000 });
    expect(panel.textContent).toMatch(/did not answer/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a new chat" })).toBeTruthy();
  });

  it("failed: a refusal waiting cannot fix is not retried, and Start a new chat opens a fresh conversation", async () => {
    historyAnswer = "unknown-session";
    await mount();
    const panel = await screen.findByTestId("chat-restore-failed", {}, { timeout: 3_000 });
    expect(panel.textContent).toMatch(/could not be restored/i);
    expect(historyKeys()).toEqual(["agent:main:main"]);

    historyAnswer = "ok";
    history = [];
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    await waitFor(() => expect(historyKeys().length).toBe(2));
    const [, fresh] = historyKeys();
    // A NEW session beside the stuck one — nothing was reset or deleted.
    // Same agent, its own session: the key `newTab` mints (openclaw-gateway-adapter).
    expect(fresh).toMatch(/^agent:main:clawbox-[0-9a-f]{12}$/);
    expect(sent.some((f) => f.method === "sessions.reset" || f.method === "sessions.delete")).toBe(false);
    await waitFor(() => expect(restorePanel()).toBeNull());
  });

  it("busy send: a turn the gateway never acknowledges is not 'send it again' — it offers the way out", async () => {
    await mount();
    await screen.findByText("Welcome back — here is where we left off.");
    ackSends = false;
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "are you there?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(sent.some((f) => f.method === "chat.send")).toBe(true));

    await screen.findByText(/has not taken this message yet/i, {}, { timeout: 3_000 });
    expect(screen.queryByText(/send it again/i)).toBeNull();
    const panel = await screen.findByTestId("chat-restore-failed");
    expect(panel.textContent).toMatch(/still busy on the box/i);
    // The composer is free again rather than stuck on a turn that never started.
    expect(screen.queryByTestId("chat-turn-status")).toBeNull();
  });

  it("reconnect: a gateway that accepts the socket and never answers ends in an error with Retry, not an endless 'Restarting chat…'", async () => {
    await mount();
    await screen.findByText("Welcome back — here is where we left off.");

    // The gateway restarts under a connected chat, and comes back wedged.
    wedged = true;
    act(() => { sockets[0].drop(); });
    await screen.findByText(/Restarting chat/i);

    // Every wedged attempt is cut off by its handshake clock and retried, until
    // the reconnect's own deadline ends the ladder — then the error panel.
    await screen.findByText("Could not connect to gateway", {}, { timeout: 12_000 });
    expect(screen.queryByText(/Restarting chat/i)).toBeNull();
    const attempts = sockets.length - 1;
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(sockets.slice(1).every((s) => s.closed)).toBe(true);
    // Nothing left running behind the error panel.
    await act(async () => { await new Promise((r) => setTimeout(r, 3_500)); });
    expect(sockets.length - 1).toBe(attempts);

    // Retry, against a gateway that answers again, restores the conversation.
    wedged = false;
    fireEvent.click(screen.getByText("chat.retry"));
    await waitFor(() => expect(sockets.length).toBe(attempts + 2));
    await waitFor(() => expect(screen.queryByText("Could not connect to gateway")).toBeNull());
    await waitFor(() => expect(historyKeys().length).toBe(2));
    await screen.findByText("Welcome back — here is where we left off.");
  });
});

/**
 * The full-page chat (`/app/clawbox` — "Open in new tab", and where a phone
 * lands) restores the same conversation over its own socket, and had the same
 * two holes: a handshake nobody answered left "Connecting…" up for good, and a
 * failed history read only reached the console. Same rules, same clocks.
 */
describe("restoring a conversation on the full-page chat (TASK-1158)", () => {
  const panel = () => screen.queryByTestId("chatapp-restore-failed");

  beforeEach(() => {
    sockets.length = 0;
    sent.length = 0;
    historyAnswer = "ok";
    history = [assistant("Welcome back — here is where we left off.")];
    wedged = false;
    ackSends = true;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessCache();
  });

  async function mountPage() {
    render(<ChatApp />);
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  }

  it("normal: the conversation comes back and no panel is shown", async () => {
    await mountPage();
    await screen.findByText("Welcome back — here is where we left off.");
    expect(panel()).toBeNull();
    expect(historyKeys()).toEqual(["agent:main:main"]);
  });

  it("stale: waits out 'history is rebuilding' and shows the conversation", async () => {
    historyAnswer = "rebuilding";
    await mountPage();
    await waitFor(() => expect(historyKeys().length).toBeGreaterThanOrEqual(2));
    historyAnswer = "ok";
    await screen.findByText("Welcome back — here is where we left off.", {}, { timeout: 3_000 });
    expect(panel()).toBeNull();
  });

  it("busy: stops at the deadline instead of an empty 'new' conversation, and Try again brings it back", async () => {
    historyAnswer = "rebuilding";
    await mountPage();
    const failed = await screen.findByTestId("chatapp-restore-failed", {}, { timeout: 3_000 });
    expect(failed.textContent).toMatch(/still busy on the box/i);
    expect(screen.queryByText("chat.saySomething")).toBeNull();
    const reads = historyKeys().length;
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(historyKeys().length).toBe(reads);

    historyAnswer = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Welcome back — here is where we left off.");
    await waitFor(() => expect(panel()).toBeNull());
  });

  it("timeout and failed: each ends in the panel with its own reason", async () => {
    historyAnswer = "hang";
    await mountPage();
    const timedOut = await screen.findByTestId("chatapp-restore-failed", {}, { timeout: 3_000 });
    expect(timedOut.textContent).toMatch(/did not answer/i);

    historyAnswer = "unknown-session";
    const before = historyKeys().length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(panel()?.textContent).toMatch(/could not be restored/i));
    // A refusal waiting cannot fix is asked once, not retried.
    expect(historyKeys().length).toBe(before + 1);
  });

  it("handshake: a gateway that accepts the socket and never answers ends in the error panel, and Retry recovers", async () => {
    wedged = true;
    await mountPage();
    await screen.findByText("Could not connect to gateway", {}, { timeout: 3_000 });
    expect(sockets[0].closed).toBe(true);
    // Nothing left running behind the error panel.
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(sockets.length).toBe(1);

    wedged = false;
    fireEvent.click(screen.getByText("chat.retry"));
    await screen.findByText("Welcome back — here is where we left off.");
    expect(screen.queryByText("Could not connect to gateway")).toBeNull();
  });
});
