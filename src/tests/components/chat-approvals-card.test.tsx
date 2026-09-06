/**
 * The approve/deny card in the ClawBox chat, driven by the harness's own
 * approval lifecycle (TASK-704).
 *
 * The failure it exists to end is on the box's own record: `approval.history`
 * holds `system-agent:2e94af8f…`, `status: "expired"`, "OpenClaw change /
 * restart the Gateway" — the agent asked, no ClawBox surface rendered the
 * question, and it timed out. TASK-612 patched that with a sentence in the
 * workspace guide telling the agent not to ask.
 *
 * Everything the fake gateway answers here is the pinned 2026.8.1 core's own
 * shape: the `approvalReplay` the `includeApprovals: true` subscribe returns,
 * the `session.approval` event, and `approval.resolve`'s
 * `{applied, approval}` — "first-answer outcome plus the canonical recorded
 * state returned to all contenders".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

const SEED_TEXT = "Ready when you are.";
const SESSION = "agent:main:main";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

/** The pending row the gateway hands back, exec kind. */
function pendingExec(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    id: "exec:3f1c",
    urlPath: "/approve/exec%3A3f1c",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 120_000,
    presentation: {
      kind: "exec",
      commandText: "systemctl restart clawbox-gateway",
      host: "local",
      allowedDecisions: ["allow-once", "deny"],
    },
    ...overrides,
  };
}

const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

/** What the next `approval.resolve` answers with, and whether it may. */
let resolveAnswer: { ok: boolean; payload?: unknown; error?: string } = {
  ok: true,
  payload: {
    applied: true,
    approval: { status: "allowed", decision: "allow-once", reason: "user", resolvedAtMs: Date.now() },
  },
};
/** The pending set the subscribe replays. */
let replay: unknown[] = [];

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
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: [assistantMessage(SEED_TEXT, 500)] });
      return;
    }
    if (frame.method === "sessions.messages.subscribe") {
      this.respond(id, {
        approvalReplay: { sessionKey: SESSION, updatedAtMs: Date.now(), approvals: replay, truncated: false },
      });
      return;
    }
    if (frame.method === "approval.resolve") {
      if (!resolveAnswer.ok) {
        setTimeout(() => this.emit({ type: "res", id, ok: false, error: { message: resolveAnswer.error } }), 0);
        return;
      }
      this.respond(id, resolveAnswer.payload);
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
    return { ok: true, json: async () => ({}) };
  }));
}

/** Every frame of one method the gateway has been sent. */
function framesFor(method: string): Array<Record<string, unknown>> {
  return sent.filter((frame) => frame.method === method);
}

function cards(): HTMLElement[] {
  return screen.queryAllByTestId("chat-approval");
}

function decisionButton(decision: string): HTMLElement {
  const found = screen
    .queryAllByTestId("chat-approval-decision")
    .find((el) => el.getAttribute("data-decision") === decision);
  if (!found) throw new Error(`no ${decision} button`);
  return found;
}

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

describe("a pending operator approval in the ClawBox chat", () => {
  beforeEach(() => {
    sent.length = 0;
    sockets.length = 0;
    replay = [];
    resolveAnswer = {
      ok: true,
      payload: {
        applied: true,
        approval: { status: "allowed", decision: "allow-once", reason: "user", resolvedAtMs: Date.now() },
      },
    };
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

  it("asks the harness for its approvals on the subscribe it already makes", async () => {
    await mountReady();

    await waitFor(() => expect(framesFor("sessions.messages.subscribe")).toHaveLength(1));
    // The whole data path, and the reason there is no poll and no second RPC.
    expect(framesFor("sessions.messages.subscribe")[0].params).toEqual({
      key: SESSION,
      includeApprovals: true,
    });
  });

  it("renders the pending set the subscribe replayed", async () => {
    replay = [pendingExec()];
    await mountReady();

    const card = await screen.findByTestId("chat-approval");
    expect(card.getAttribute("data-approval-kind")).toBe("exec");
    expect(card.getAttribute("data-approval-status")).toBe("pending");
    expect(card.textContent).toContain("systemctl restart clawbox-gateway");
    expect(decisionButton("allow-once")).toBeTruthy();
    expect(decisionButton("deny")).toBeTruthy();
    // The request offered two decisions, so exactly two are offered back.
    expect(screen.queryAllByTestId("chat-approval-decision")).toHaveLength(2);
  });

  it("renders one raised while the owner is watching", async () => {
    await mountReady();
    expect(cards()).toHaveLength(0);

    act(() => {
      socket()?.emit({ type: "event", event: "session.approval", payload: pendingExec() });
    });

    await screen.findByTestId("chat-approval");
  });

  it("resolves it exactly once, through the gateway's own resolver", async () => {
    replay = [pendingExec()];
    await mountReady();
    await screen.findByTestId("chat-approval");

    fireEvent.click(decisionButton("allow-once"));

    await waitFor(() => expect(framesFor("approval.resolve")).toHaveLength(1));
    expect(framesFor("approval.resolve")[0].params).toEqual({
      id: "exec:3f1c",
      // Explicit, never inferred from the id's prefix.
      kind: "exec",
      decision: "allow-once",
    });
    await waitFor(() =>
      expect(screen.getByTestId("chat-approval").getAttribute("data-approval-status")).toBe("allowed"),
    );

    // A second press cannot spend a second resolve: the card is settled.
    expect(screen.queryAllByTestId("chat-approval-decision")).toHaveLength(0);
    expect(framesFor("approval.resolve")).toHaveLength(1);
  });

  it("shows the answer given in Telegram rather than resolving it again", async () => {
    // The other half of "exactly once". `/approve <id> <decision>` in the
    // owner's own Telegram chat is the harness's native path and resolves the
    // same approval; this chat learns about it through `session.approval` and
    // must show the recorded end state without sending anything.
    replay = [pendingExec()];
    await mountReady();
    await screen.findByTestId("chat-approval");

    act(() => {
      socket()?.emit({
        type: "event",
        event: "session.approval",
        payload: {
          ...pendingExec(),
          status: "denied",
          reason: "user",
          resolvedAtMs: Date.now(),
        },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("chat-approval").getAttribute("data-approval-status")).toBe("denied"),
    );
    expect(framesFor("approval.resolve")).toHaveLength(0);
    expect(screen.queryAllByTestId("chat-approval-decision")).toHaveLength(0);
  });

  it("takes the canonical answer when somebody else answered first, and calls it no failure", async () => {
    replay = [pendingExec()];
    resolveAnswer = {
      ok: true,
      payload: {
        applied: false,
        approval: { status: "allowed", decision: "allow-once", reason: "user", resolvedAtMs: Date.now() },
      },
    };
    await mountReady();
    await screen.findByTestId("chat-approval");

    fireEvent.click(decisionButton("deny"));

    await waitFor(() =>
      expect(screen.getByTestId("chat-approval").getAttribute("data-approval-status")).toBe("allowed"),
    );
    expect(screen.queryByTestId("chat-approval-error")).toBeNull();
    expect(framesFor("approval.resolve")).toHaveLength(1);
  });

  it("says so when the answer did not reach the box, and does not claim a decision", async () => {
    replay = [pendingExec()];
    resolveAnswer = { ok: false, error: "Not connected" };
    await mountReady();
    await screen.findByTestId("chat-approval");

    fireEvent.click(decisionButton("allow-once"));

    await screen.findByTestId("chat-approval-error");
    expect(screen.getByTestId("chat-approval").getAttribute("data-approval-status")).toBe("pending");
    // And the owner can try again: the buttons are still there.
    expect(decisionButton("allow-once")).toBeTruthy();
  });

  it("refuses an approval whose window has already closed, honestly", async () => {
    replay = [pendingExec({ expiresAtMs: Date.now() - 1 })];
    await mountReady();

    const card = await screen.findByTestId("chat-approval");
    expect(card.getAttribute("data-approval-status")).toBe("expired");
    expect(screen.queryAllByTestId("chat-approval-decision")).toHaveLength(0);
    // The card STAYS. TASK-612's failure was a question that vanished.
    expect(screen.getByTestId("chat-approval-result").textContent).toBeTruthy();
  });

  it("keeps asking for approvals after the owner switches conversation", async () => {
    // The sibling call site. The opt-in is per subscribe call and NOT sticky:
    // the core removes an existing approval subscription when the same session
    // is subscribed again without the flag — so a second subscribe that forgot
    // it would turn the cards off on the next tab switch, with nothing on
    // screen to say so.
    await mountReady();
    await waitFor(() => expect(framesFor("sessions.messages.subscribe")).toHaveLength(1));

    // Every subscribe this component makes carries the opt-in, whichever key.
    const subscribes = framesFor("sessions.messages.subscribe");
    for (const frame of subscribes) {
      expect((frame.params as { includeApprovals?: unknown }).includeApprovals).toBe(true);
    }
    // And it is the only shape the helper can produce: there is one call site
    // for both, so a subscribe without the flag cannot be written by accident.
    expect(
      sent.filter(
        (frame) =>
          frame.method === "sessions.messages.subscribe" &&
          (frame.params as { includeApprovals?: unknown }).includeApprovals !== true,
      ),
    ).toEqual([]);
  });

  it("stops offering a button the moment the window closes", async () => {
    // Not at the next render that happens to occur. A button that cannot work
    // is the UI's own false success, and pressing it would come back as "that
    // did not reach the box" over a gateway that answered perfectly well.
    replay = [pendingExec({ expiresAtMs: Date.now() + 120 })];
    await mountReady();

    const card = await screen.findByTestId("chat-approval");
    expect(card.getAttribute("data-approval-status")).toBe("pending");
    expect(screen.queryAllByTestId("chat-approval-decision")).toHaveLength(2);

    await waitFor(
      () => expect(screen.getByTestId("chat-approval").getAttribute("data-approval-status")).toBe("expired"),
      { timeout: 2_000 },
    );
    expect(screen.queryAllByTestId("chat-approval-decision")).toHaveLength(0);
    // Nothing was asked of the gateway to learn that.
    expect(framesFor("approval.resolve")).toHaveLength(0);
  });

  it("costs nothing for an ordinary turn", async () => {
    // `hello there` must not touch the approval surface at all: no resolve, no
    // extra subscribe, and no card.
    await mountReady();
    const subscribes = framesFor("sessions.messages.subscribe").length;

    act(() => {
      socket()?.emit({
        type: "event",
        event: "chat",
        payload: { sessionKey: SESSION, state: "final", message: assistantMessage("hello there", Date.now()) },
      });
    });
    await screen.findByText("hello there");

    expect(framesFor("approval.resolve")).toHaveLength(0);
    expect(framesFor("sessions.messages.subscribe")).toHaveLength(subscribes);
    expect(cards()).toHaveLength(0);
  });
});
