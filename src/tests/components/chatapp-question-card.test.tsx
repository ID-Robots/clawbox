/**
 * The same question card on the OTHER surface — `/app/clawbox` (ChatApp), the
 * page behind "Open in new tab" and the one a phone lands on.
 *
 * A chat feature is written ONCE and both surfaces get it. A question that
 * could only be answered on the desktop would be a question the owner never
 * sees when the box asks while they are away from it, and the run would sit
 * parked for its full fifteen minutes exactly as it did before.
 *
 * Frames are the ones captured from an OpenClaw box (core tag v2026.9.3); see
 * chat-question-card.test.tsx for how, and for what the capture settled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SESSION = "agent:main:main";
const QUESTION_ID = "ask_0000000000000000000000000000test";
const SEED_TEXT = "Ready when you are.";

function questionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: QUESTION_ID,
    questions: [
      {
        questionId: "colour",
        header: "Colour",
        question: "Which colour do you prefer?",
        options: [
          { label: "Amber (Recommended)", description: "Warm golden orange." },
          { label: "Teal", description: "Cool blue-green." },
        ],
        isOther: true,
      },
    ],
    agentId: "main",
    sessionKey: SESSION,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 900_000,
    status: "pending",
    ...overrides,
  };
}

type Frame = Record<string, unknown>;
const sent: Frame[] = [];
const instances: FakeGatewayWs[] = [];

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    instances.push(this);
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Frame;
    try { frame = JSON.parse(raw) as Frame; } catch { return; }
    if (frame.type !== "req") return;
    sent.push(frame);
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, {
        messages: [{ role: "assistant", content: [{ type: "text", text: SEED_TEXT }], timestamp: 500 }],
      });
      return;
    }
    if (frame.method === "question.list") {
      this.respond(id, { questions: [] });
      return;
    }
    if (frame.method === "question.resolve") {
      this.respond(id, { status: "answered", answers: { answers: { colour: ["Teal"] } } });
      return;
    }
    this.respond(id, {});
  }

  close() { this.readyState = 3; }
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
    return { ok: true, json: async () => ({}) };
  }));
}

const framesFor = (method: string) => sent.filter((frame) => frame.method === method);

beforeEach(() => {
  sent.length = 0;
  instances.length = 0;
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatApp renders the gateway question", () => {
  it("shows the card and answers it with the gateway's own params", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SEED_TEXT));
    await act(async () => {
      instances[instances.length - 1].emit({
        type: "event",
        event: "question.requested",
        payload: questionRecord(),
      });
      await Promise.resolve();
    });

    const card = await screen.findByTestId("chat-question");
    expect(card.textContent).toContain("Which colour do you prefer?");
    fireEvent.click((await screen.findAllByTestId("chat-question-option"))[1]);
    fireEvent.click(screen.getByTestId("chat-question-submit"));

    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    expect(framesFor("question.resolve")[0].params).toEqual({
      id: QUESTION_ID,
      answers: { answers: { colour: ["Teal"] } },
    });
  });

  it("asks the gateway what is still open on every hello", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(framesFor("question.list").length).toBeGreaterThan(0));
    expect(framesFor("question.list")[0].params).toEqual({});
  });

  it("ignores a question raised in another conversation", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SEED_TEXT));
    await act(async () => {
      instances[instances.length - 1].emit({
        type: "event",
        event: "question.requested",
        payload: questionRecord({ sessionKey: "agent:main:clawbox-other" }),
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("chat-question")).toBeNull();
  });
});
