import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";
import { waitForChatSession } from "@/tests/helpers/chat-connected";

// Mounting ChatPopup in jsdom costs seconds under a full parallel run; see
// `test-timeout-hygiene.test.ts` for why every suite that does declares this.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Both chat surfaces subscribe to the gateway's progress card (TASK-896): a
 * `progressCard.get` for the bound session after the handshake, another on
 * every `progressCard.changed` naming that session, and the card drawn in the
 * column between the transcript and the composer.
 */

const SEED_TEXT = "Your tabby is ready";
let serverCard: Record<string, unknown> | null = null;
const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1];

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

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
    switch (frame.method) {
      case "connect":
        this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
        return;
      case "chat.history":
        this.respond(id, { messages: [{ role: "assistant", content: [{ type: "text", text: SEED_TEXT }], timestamp: 500 }] });
        return;
      case "progressCard.get":
        this.respond(id, { card: serverCard });
        return;
      default:
        this.respond(id, {});
    }
  }

  close() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  changed(sessionKey: string, revision: number | null) {
    act(() => this.emit({ type: "event", event: "progressCard.changed", payload: { sessionKey, revision } }));
  }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    if (url.includes("/setup-api/harness/active")) return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    if (url.includes("/setup-api/chat/capabilities")) {
      return { ok: true, json: async () => ({ harness: "openclaw", facts: { hasClawaiToken: true, hermesSupportsImages: false, onboardingArmed: true } }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return {
        ok: true,
        json: async () => ({
          activeOptionId: "primary",
          activeModel: "claude-opus-4",
          activeSource: "primary",
          activeLabel: "Anthropic Claude",
          options: [{
            id: "primary", label: "Anthropic Claude", model: "claude-opus-4",
            provider: "anthropic", available: true, settingsSection: "ai", isLocal: false,
          }],
          primary: { available: true, label: "Anthropic Claude", model: "claude-opus-4" },
          local: { available: false, label: null, model: null },
        }),
      };
    }
    if (url.includes("/setup-api/chat/spoken-history")) return { ok: true, json: async () => ({ items: [] }) };
    return { ok: true, json: async () => ({}) };
  }));
}

const cardGets = () => sent.filter((frame) => frame.method === "progressCard.get");

function wireCard(revision: number, markdown: string, steps: Array<{ step: string; status: string }> = []) {
  return { sessionKey: "agent:main:main", revision, updatedAt: Date.now() - 5 * 60_000, markdown, steps };
}

beforeEach(() => {
  serverCard = wireCard(1, "**Overnight coding queue**", [
    { step: "Build", status: "completed" },
    { step: "Test", status: "in_progress" },
  ]);
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
});

describe("ChatPopup — the task progress card", () => {
  it("reads the bound session's card after the handshake and pins it above the composer", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitForChatSession();
    const card = await screen.findByTestId("chat-progress-card");

    expect(cardGets()[0]?.params).toEqual({ sessionKey: "agent:main:main" });
    expect(card).toHaveTextContent("Overnight coding queue");
    expect(screen.getAllByTestId("chat-progress-step").map((li) => li.getAttribute("data-status"))).toEqual(["completed", "in_progress"]);

    // In the column, never over it: after the transcript, before the composer, inside neither.
    const composer = screen.getByTestId("chat-composer");
    const transcript = screen.getByText(SEED_TEXT).closest("[id]") as HTMLElement;
    expect(card.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer.contains(card)).toBe(false);
    expect(transcript.contains(card)).toBe(false);
    expect(card.parentElement).toBe(composer.parentElement);
  });

  it("replaces the card on a change to this session and removes it on a clear", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitForChatSession();
    await screen.findByTestId("chat-progress-card");
    const before = cardGets().length;

    serverCard = wireCard(2, "Only the note now.");
    socket().changed("agent:main:main", 2);
    await waitFor(() => expect(screen.getByTestId("chat-progress-card")).toHaveAttribute("data-revision", "2"));
    expect(cardGets()).toHaveLength(before + 1);
    expect(screen.getAllByTestId("chat-progress-card")).toHaveLength(1);
    expect(screen.queryByTestId("chat-progress-step")).toBeNull();
    expect(screen.getByTestId("chat-progress-card")).toHaveTextContent("Only the note now.");

    serverCard = null;
    socket().changed("agent:main:main", null);
    await waitFor(() => expect(screen.queryByTestId("chat-progress-card")).toBeNull());
  });

  it("does not re-read for another session's card", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitForChatSession();
    await screen.findByTestId("chat-progress-card");
    const before = cardGets().length;
    socket().changed("agent:main:telegram-dm", 7);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cardGets()).toHaveLength(before);
  });

  it("shows nothing when the session has no card", async () => {
    serverCard = null;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitForChatSession();
    await waitFor(() => expect(cardGets().length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("chat-progress-card")).toBeNull();
  });
});

describe("ChatApp — the task progress card", () => {
  it("reads the card after the handshake, follows changes, and sits between the messages and the text box", async () => {
    render(<ChatApp />);
    const card = await screen.findByTestId("chat-progress-card");
    expect(cardGets()[0]?.params).toEqual({ sessionKey: "agent:main:main" });
    expect(card).toHaveTextContent("Overnight coding queue");
    const textbox = screen.getByRole("textbox");
    expect(card.compareDocumentPosition(textbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    serverCard = wireCard(3, "Next lane.");
    socket().changed("agent:main:main", 3);
    await waitFor(() => expect(screen.getByTestId("chat-progress-card")).toHaveTextContent("Next lane."));

    serverCard = null;
    socket().changed("agent:main:main", null);
    await waitFor(() => expect(screen.queryByTestId("chat-progress-card")).toBeNull());
  });
});
