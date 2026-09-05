import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * Installing a skill must not freeze the chat (TASK-508).
 *
 * The regression these tests lock down was found on a real box: install any
 * skill from the Store and the chat drops a "Reloading skills..." overlay that
 * never clears — measured stuck for five and a half minutes, recoverable only
 * by reloading the page. The overlay's single exit was a post-restart `hello`,
 * and `openclaw-config.ts` had deliberately stopped restarting the gateway on
 * install (SIGUSR1 means "restart" to OpenClaw, not "reload"), so that `hello`
 * never came. Verified on hardware across an install: gateway PID unchanged,
 * NRestarts 0, and the RUNNING session already had the new skill.
 *
 * So the contract is: no overlay, no lost transcript, and one confirmation
 * question sent down the socket that was never dropped.
 */

const SEED_TEXT = "Here's your orange tabby";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

let history: unknown[] = [];
const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

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
    this.respond(id, { runId: "r1", status: "started" });
  }

  close() { this.closed = true; }

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

const sendFrames = () => sent.filter((f) => f.method === "chat.send");

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

async function fireSkillEvent(detail: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("clawbox-skill-installed", { detail }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("a skill change does not freeze the chat", () => {
  beforeEach(() => {
    history = [assistantMessage(SEED_TEXT, 500)];
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

  it("never raises the reconnect overlay", async () => {
    await mountReady();
    await fireSkillEvent({ action: "install", name: "Weather Forecast" });

    // Both labels the overlay can render. Nothing restarted, so neither is
    // allowed to appear — this is the assertion that fails against the old
    // code, where the overlay went up and stayed up.
    expect(screen.queryByText(/Reloading skills/i)).toBeNull();
    expect(screen.queryByText(/Restarting chat/i)).toBeNull();
    expect(screen.queryByText(/Switching AI provider/i)).toBeNull();
  });

  it("keeps the conversation and asks the agent to confirm the new skill", async () => {
    await mountReady();
    const before = sendFrames().length;
    await fireSkillEvent({ action: "install", name: "Weather Forecast" });

    await waitFor(() => expect(sendFrames().length).toBe(before + 1));
    const params = sendFrames()[before].params as Record<string, unknown>;
    expect(String(params.message)).toContain('"Weather Forecast"');
    // The transcript the owner was reading is still there. The old flow wiped
    // it, on the theory that the gateway had restarted underneath — it had not.
    expect(screen.queryByText(SEED_TEXT)).not.toBeNull();
  });

  it("shows the owner the question it asked on their behalf", async () => {
    await mountReady();
    await fireSkillEvent({ action: "install", name: "Weather Forecast" });
    // Sent as a normal turn, so it appears as a bubble rather than happening
    // invisibly: an unexplained answer about a skill would read as the agent
    // talking to itself.
    await screen.findByText(/I just installed the "Weather Forecast" skill/);
  });

  it("does not drop the socket it is still using", async () => {
    await mountReady();
    const ws = socket();
    await fireSkillEvent({ action: "install", name: "Weather Forecast" });
    // The provider path deliberately closes and reconnects because the gateway
    // really is bouncing. Doing that here would throw away a healthy
    // connection and re-run the whole handshake for nothing.
    expect(ws?.closed).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it("waits its turn instead of talking over an answer in flight", async () => {
    // CodeRabbit caught this on the first cut: firing the confirmation while
    // the agent is mid-answer opens a second run on top of a live one, and the
    // chat then reports the first turn finished while it is still working.
    // It takes the same queue a typed message takes.
    await mountReady();
    const input = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "how tall is the Eiffel tower?" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await new Promise((r) => setTimeout(r, 0));
    });
    const duringTurn = sendFrames().length;
    expect(duringTurn).toBeGreaterThan(0);

    await fireSkillEvent({ action: "install", name: "Weather Forecast" });
    // Nothing extra went out while the first turn is still running.
    expect(sendFrames()).toHaveLength(duringTurn);
    // ...and the owner can see it is waiting rather than lost.
    await screen.findByText(/I just installed the "Weather Forecast" skill/);

    // Finish the turn the way the gateway does; the queued confirmation then
    // goes out on its own.
    await act(async () => {
      socket()?.emit({
        type: "event",
        event: "chat",
        payload: {
          runId: "r1",
          sessionKey: "agent:main:main",
          state: "final",
          stopReason: "stop",
          message: { role: "assistant", content: [{ type: "text", text: "330 metres." }], timestamp: 1787260000000 },
        },
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(sendFrames().length).toBe(duringTurn + 1));
    expect(String((sendFrames()[duringTurn].params as Record<string, unknown>).message))
      .toContain('"Weather Forecast"');
  });

  it("handles an uninstall the same way", async () => {
    await mountReady();
    const before = sendFrames().length;
    await fireSkillEvent({ action: "uninstall", id: "weather-forecast" });

    await waitFor(() => expect(sendFrames().length).toBe(before + 1));
    expect(String((sendFrames()[before].params as Record<string, unknown>).message)).toMatch(/removed/i);
    expect(screen.queryByText(/Reloading skills/i)).toBeNull();
    expect(screen.queryByText(SEED_TEXT)).not.toBeNull();
  });
});

/**
 * TASK-544. What the chat SENDS is the only thing the owner and the agent see,
 * and it is the one hop `kind` has to survive: the unit suite calls
 * `buildSkillChangeMessage` directly and the Hermes store suite inspects the
 * dispatched event, so a `kind` dropped in this handler's cast would revert the
 * whole card with both of them green.
 */
describe("what the chat sends carries the kind the sender set", () => {
  beforeEach(() => {
    history = [assistantMessage(SEED_TEXT, 500)];
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

  it("calls a removed webapp an app, all the way to the wire", async () => {
    await mountReady();
    const before = sendFrames().length;

    await fireSkillEvent({ action: "uninstall", name: "Pomodoro", id: "pomodoro-timer", kind: "app" });

    await waitFor(() => expect(sendFrames().length).toBe(before + 1));
    const message = String((sendFrames()[before].params as Record<string, unknown>).message);
    expect(message).toMatch(/"Pomodoro" app .* from the desktop/);
    // And the id the agent can actually look up: `ui_list_apps` reports
    // installed apps by id, never by display name.
    expect(message).toContain("pomodoro-timer");
    expect(message).not.toMatch(/skill/);
  });

  it("still calls a removed skill a skill", async () => {
    await mountReady();
    const before = sendFrames().length;

    await fireSkillEvent({ action: "uninstall", name: "PDF Tools", id: "pdf-tools", kind: "skill" });

    await waitFor(() => expect(sendFrames().length).toBe(before + 1));
    const message = String((sendFrames()[before].params as Record<string, unknown>).message);
    expect(message).toMatch(/"PDF Tools" skill/);
    expect(message).not.toMatch(/\bapp\b/);
  });
});
