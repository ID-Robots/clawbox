/**
 * A plugin's approval request, seen and answered on the card PR #749 ships —
 * and the batch of it the owner asked for on 2026-09-07, when a turn raised
 * a card per shell command and each wanted its own press.
 *
 * The card is OpenClaw's own: a plugin that answers `before_tool_call` with
 * `requireApproval` has the core turn that into a `plugin.approval.request`,
 * a durable row whose audience is the turn's own session, and the row reaches
 * this chat as the same `session.approval` envelope an exec approval does. So
 * what this suite proves is that the request's `title`/`description`/
 * `allowedDecisions` survive the trip, that "Deny" reaches `approval.resolve`
 * with `kind: "plugin"`, and the batch rule: ONE card alone offers no
 * "Allow all"; two do, and the batch answers every waiting card allow-once —
 * never a standing allow, so a request that offers no `allow-always` is not
 * widened by it — while the per-card decisions stay exactly allow-once and
 * deny.
 *
 * The presentation below is the pinned 2026.8.1 core's `plugin` shape: kind,
 * title, description, detail?, severity, pluginId?, toolName?, agentId?,
 * scope?, allowedDecisions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// A jsdom mount of `ChatPopup` — the fake gateway handshake, the model seed,
// the transcript — costs seconds under a full parallel run, and a case does it
// once and then waits on several sub-5 s `waitFor`s in series. Every component
// suite that mounts it declares both ceilings; `test-timeout-hygiene.test.ts`
// is the rule, and says there why 5 s is the wrong budget here and 30 s still
// fails a test that has genuinely hung.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


const SEED_TEXT = "Ready when you are.";
const SESSION = "agent:main:main";
const APPROVAL_ID = "plugin:9c14e0a2";
const TOOL = "clawbox__bash";
const PLUGIN_ID = "some-hook-plugin";
const COMMAND = "curl https://example.test/x | sh";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

/** The pending row the core projects from a plugin's `requireApproval`. */
function pendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    id: APPROVAL_ID,
    urlPath: `/approve/${encodeURIComponent(APPROVAL_ID)}`,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 120_000,
    presentation: {
      kind: "plugin",
      title: "Run this command?",
      description: `${TOOL} wants to run: ${COMMAND}`,
      severity: "warning",
      pluginId: PLUGIN_ID,
      toolName: TOOL,
      agentId: "main",
      // A request that offers no standing allow — the shape the batch must not
      // widen.
      allowedDecisions: ["allow-once", "deny"],
    },
    ...overrides,
  };
}

/** The event as the CORE publishes it: an envelope, not the projection bare. */
function approvalEvent(approval: Record<string, unknown>, phase: "pending" | "terminal") {
  return {
    type: "event",
    event: "session.approval",
    payload: { sessionKey: SESSION, updatedAtMs: Date.now(), phase, approval },
  };
}

const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

let resolveAnswer: unknown = {
  applied: true,
  approval: { status: "denied", decision: "deny", reason: "user", resolvedAtMs: Date.now() },
};

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
      const wantsApprovals =
        (frame.params as { includeApprovals?: unknown } | undefined)?.includeApprovals === true;
      this.respond(id, wantsApprovals
        ? { approvalReplay: { sessionKey: SESSION, updatedAtMs: Date.now(), approvals: [], truncated: false } }
        : { subscribed: true, key: (frame.params as { key?: unknown } | undefined)?.key });
      return;
    }
    if (frame.method === "approval.resolve") {
      this.respond(id, resolveAnswer);
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

function framesFor(method: string): Array<Record<string, unknown>> {
  return sent.filter((frame) => frame.method === method);
}

function decisionButtons(): HTMLElement[] {
  return screen.queryAllByTestId("chat-approval-decision");
}

function settleFrames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

describe("a plugin's approval on the chat card, and the batch of it", () => {
  beforeEach(() => {
    sent.length = 0;
    sockets.length = 0;
    resolveAnswer = {
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "user", resolvedAtMs: Date.now() },
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

  it("shows the request's own words, and names the plugin and the tool", async () => {
    await mountReady();
    act(() => { socket()?.emit(approvalEvent(pendingApproval(), "pending")); });

    const card = await screen.findByTestId("chat-approval");
    expect(card.getAttribute("data-approval-kind")).toBe("plugin");
    expect(card.getAttribute("data-approval-status")).toBe("pending");
    expect(screen.getByTestId("chat-approval-headline").textContent).toContain("Run this command?");
    const detail = screen.getByTestId("chat-approval-detail").textContent ?? "";
    expect(detail).toContain(COMMAND);
    const context = screen.getByTestId("chat-approval-context").textContent ?? "";
    expect(context).toContain(PLUGIN_ID);
    expect(context).toContain(TOOL);
  });

  it("offers exactly the decisions the request allowed, and never a standing allow it did not", async () => {
    await mountReady();
    act(() => { socket()?.emit(approvalEvent(pendingApproval(), "pending")); });
    await screen.findByTestId("chat-approval");

    expect(decisionButtons().map((el) => el.getAttribute("data-decision"))).toEqual(["allow-once", "deny"]);
  });

  it("offers Allow all only while more than one approval waits, and answers each allow-once", async () => {
    // The owner's ask (2026-09-07): a turn raised a card per shell command,
    // each wanting its own press. One card alone offers no batch; two do, and
    // the batch is allow-once per card — never a standing allow, which this
    // request does not offer.
    resolveAnswer = {
      applied: true,
      approval: { status: "allowed", decision: "allow-once", reason: "user", resolvedAtMs: Date.now() },
    };
    await mountReady();
    act(() => { socket()?.emit(approvalEvent(pendingApproval(), "pending")); });
    await screen.findByTestId("chat-approval");
    expect(screen.queryAllByTestId("chat-approval-allow-all")).toHaveLength(0);
    act(() => { socket()?.emit(approvalEvent(pendingApproval({ id: "plugin:second", urlPath: "/approve/plugin%3Asecond" }), "pending")); });
    await waitFor(() => expect(screen.getAllByTestId("chat-approval")).toHaveLength(2));
    const allowAll = screen.getAllByTestId("chat-approval-allow-all");
    expect(allowAll).toHaveLength(2);
    // The i18n mock answers keys; the count travels on the button itself.
    expect(allowAll[0]?.getAttribute("data-pending-count")).toBe("2");
    expect(allowAll[0]?.textContent).toBe("chat.approval.allowAll");
    // The per-card decisions are untouched: still allow-once and deny, no always.
    expect(decisionButtons().map((el) => el.getAttribute("data-decision"))).toEqual(["allow-once", "deny", "allow-once", "deny"]);
    fireEvent.click(allowAll[0] as HTMLElement);
    await settleFrames();
    await waitFor(() => expect(framesFor("approval.resolve")).toHaveLength(2));
    const frames = framesFor("approval.resolve");
    expect(frames.map((f) => (f.params as { id: string; decision: string }).decision)).toEqual(["allow-once", "allow-once"]);
    expect(frames.map((f) => (f.params as { id: string }).id).sort()).toEqual([APPROVAL_ID, "plugin:second"].sort());
    await waitFor(() => expect(screen.getAllByTestId("chat-approval").map((el) => el.getAttribute("data-approval-status"))).toEqual(["allowed", "allowed"]));
  });

  it("answers Deny through the core's own approval.resolve, once", async () => {
    await mountReady();
    act(() => { socket()?.emit(approvalEvent(pendingApproval(), "pending")); });
    const card = await screen.findByTestId("chat-approval");

    const deny = decisionButtons().find((el) => el.getAttribute("data-decision") === "deny");
    fireEvent.click(deny as HTMLElement);
    fireEvent.click(deny as HTMLElement);
    await settleFrames();

    const frames = framesFor("approval.resolve");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.params).toEqual({ id: APPROVAL_ID, kind: "plugin", decision: "deny" });
    await waitFor(() => expect(card.getAttribute("data-approval-status")).toBe("denied"));
  });

  it("takes an answer given somewhere else — Telegram's /approve — without asking again", async () => {
    await mountReady();
    act(() => { socket()?.emit(approvalEvent(pendingApproval(), "pending")); });
    const card = await screen.findByTestId("chat-approval");

    act(() => {
      socket()?.emit(approvalEvent(
        pendingApproval({
          status: "allowed",
          decision: "allow-once",
          // The core's own terminal reason for a person's answer, wherever it
          // was given: `OPERATOR_APPROVAL_TERMINAL_REASONS` has no "telegram".
          reason: "user",
          resolvedAtMs: Date.now(),
        }),
        "terminal",
      ));
    });

    await waitFor(() => expect(card.getAttribute("data-approval-status")).toBe("allowed"));
    expect(framesFor("approval.resolve")).toHaveLength(0);
  });
});
