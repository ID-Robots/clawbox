/**
 * The agent's own question, as a card in the mascot chat (OpenClaw edition).
 *
 * THE FAILURE THIS ENDS. An OpenClaw agent that calls `ask_user` is parked by
 * the gateway on a question record and waits up to fifteen minutes for an
 * answer. ClawBox rendered nothing for it: the turn showed "ask user · running…"
 * and then sat there, because the only place the question exists for a webchat
 * client is the `question.requested` broadcast and nothing read it. The option
 * labels never reach the transcript at all — with `deliver:false` the gateway
 * puts no prompt text on the chat stream, and the `agent`/`stream:'tool'` event
 * that does carry the whole `ask_user` argument object is read for its
 * `toolCallId`, `name` and `phase` only.
 *
 * Every frame below is the real one. They were captured from an OpenClaw box
 * (core tag v2026.9.3) by sending one `ask_user` turn in an isolated session
 * and recording what came back, with the ids replaced. A fake gateway that
 * agreed with the implementation instead of with the harness is what let the
 * approval card ship dropping every live event once already.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// A jsdom mount of `ChatPopup` — the fake gateway handshake, the model seed,
// the transcript — costs seconds under a full parallel run, and a case does it
// once and then waits on several sub-5 s `waitFor`s in series. Every component
// suite that mounts it declares both ceilings; `test-timeout-hygiene.test.ts`
// is the rule.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SEED_TEXT = "Ready when you are.";
const SESSION = "agent:main:main";
const QUESTION_ID = "ask_0000000000000000000000000000test";

/** The `question.requested` payload as the box broadcast it — the RECORD itself. */
function questionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: QUESTION_ID,
    questions: [
      {
        questionId: "colour",
        header: "Colour",
        question: "Which colour do you prefer?",
        options: [
          { label: "Amber (Recommended)", description: "Warm golden orange; lively and easy on the eyes." },
          { label: "Teal", description: "Cool blue-green; calm and a bit technical." },
          { label: "Indigo", description: "Deep blue-violet; serious and quiet." },
        ],
        // `multiSelect` and `isSecret` are absent in the real frame when they
        // do not apply; only `isOther` is written, and `ask_user` always sets it.
        isOther: true,
      },
    ],
    agentId: "main",
    sessionKey: SESSION,
    runId: "run-1",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 900_000,
    status: "pending",
    ...overrides,
  };
}

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

/** What `question.list` answers with on the next hello. */
let pendingList: unknown[] = [];
/** What the next `question.resolve` answers, and whether it may. */
let resolveAnswer: { ok: boolean; payload?: unknown; error?: string } = {
  ok: true,
  payload: { status: "answered", answers: { answers: { colour: ["Teal"] } } },
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
    if (frame.method === "question.list") {
      this.respond(id, { questions: pendingList });
      return;
    }
    if (frame.method === "question.resolve") {
      if (!resolveAnswer.ok) {
        setTimeout(() => this.emit({ type: "res", id, ok: false, error: { message: resolveAnswer.error } }), 0);
        return;
      }
      this.respond(id, resolveAnswer.payload);
      return;
    }
    this.respond(id, {});
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
    if (url.includes("/setup-api/chat/capabilities")) {
      return {
        ok: true,
        json: async () => ({
          harness: "openclaw",
          facts: { hasClawaiToken: true, hermesSupportsImages: false, onboardingArmed: false },
        }),
      };
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
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

const framesFor = (method: string) => sent.filter((frame) => frame.method === method);

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

async function push(event: string, payload: unknown) {
  await act(async () => {
    socket()?.emit({ type: "event", event, payload });
    await Promise.resolve();
  });
}

beforeEach(() => {
  sent.length = 0;
  sockets.length = 0;
  pendingList = [];
  resolveAnswer = {
    ok: true,
    payload: { status: "answered", answers: { answers: { colour: ["Teal"] } } },
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

describe("the gateway question card", () => {
  it("renders the question, its options and their descriptions", async () => {
    await mountReady();
    await push("question.requested", questionRecord());

    const card = await screen.findByTestId("chat-question");
    expect(card).toHaveAttribute("data-question-id", QUESTION_ID);
    expect(card.textContent).toContain("Which colour do you prefer?");
    const options = await screen.findAllByTestId("chat-question-option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Amber (Recommended)"),
      expect.stringContaining("Teal"),
      expect.stringContaining("Indigo"),
    ]);
    // The subtitle is half the point of the OpenClaw card: an option list of
    // three bare words is a worse question than the one the agent asked.
    expect(options[0].textContent).toContain("Warm golden orange");
    // And the free-text row, because `ask_user` always accepts one.
    expect(screen.getByTestId("chat-question-other")).toBeTruthy();
  });

  it("submits the chosen option as question.resolve{id,answers:{answers}}", async () => {
    await mountReady();
    await push("question.requested", questionRecord());

    const options = await screen.findAllByTestId("chat-question-option");
    fireEvent.click(options[1]);
    fireEvent.click(screen.getByTestId("chat-question-submit"));

    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    expect(framesFor("question.resolve")[0].params).toEqual({
      id: QUESTION_ID,
      answers: { answers: { colour: ["Teal"] } },
    });
  });

  it("submits what was typed when the answer was not on the list", async () => {
    await mountReady();
    await push("question.requested", questionRecord());

    fireEvent.change(await screen.findByTestId("chat-question-other"), {
      target: { value: "  Crimson  " },
    });
    fireEvent.click(screen.getByTestId("chat-question-submit"));

    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    expect(framesFor("question.resolve")[0].params).toEqual({
      id: QUESTION_ID,
      answers: { answers: { colour: ["Crimson"] } },
    });
  });

  it("skips as question.resolve{id,cancel:true}, never as an empty answer", async () => {
    await mountReady();
    await push("question.requested", questionRecord());

    resolveAnswer = { ok: true, payload: { status: "cancelled" } };
    fireEvent.click(await screen.findByTestId("chat-question-skip"));

    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    // The gateway's own validator refuses a question with no value, so a Skip
    // sent as `{colour: []}` would come back an error with the agent parked.
    expect(framesFor("question.resolve")[0].params).toEqual({ id: QUESTION_ID, cancel: true });
    await waitFor(() =>
      expect(screen.getByTestId("chat-question")).toHaveAttribute("data-status", "cancelled"),
    );
  });

  it("closes when another surface answers it", async () => {
    await mountReady();
    await push("question.requested", questionRecord());
    await screen.findByTestId("chat-question");

    // The Control UI, or a phone, answered first. The card must stop offering
    // controls and say what became of it rather than keep saying "waiting".
    await push("question.resolved", {
      id: QUESTION_ID,
      status: "answered",
      answers: { answers: { colour: ["Indigo"] } },
    });

    await waitFor(() =>
      expect(screen.getByTestId("chat-question")).toHaveAttribute("data-status", "answered"),
    );
    expect(screen.queryByTestId("chat-question-submit")).toBeNull();
    expect(screen.getByTestId("chat-question-summary").textContent).toContain("Indigo");
  });

  it("does not render a question raised in another conversation", async () => {
    await mountReady();
    await push("question.requested", questionRecord({ sessionKey: "agent:main:clawbox-other" }));
    // And one that belongs to no conversation on screen at all.
    await push("question.requested", questionRecord({ id: "ask_orphan", sessionKey: undefined }));

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByTestId("chat-question")).toBeNull();
  });

  it("recovers a question still waiting after a reload, through question.list", async () => {
    // `question.requested` is broadcast once and never replayed, so this is the
    // only way a question raised before the page opened is ever seen again.
    pendingList = [questionRecord()];
    await mountReady();

    await waitFor(() => expect(framesFor("question.list").length).toBeGreaterThan(0));
    expect(framesFor("question.list")[0].params).toEqual({});
    const card = await screen.findByTestId("chat-question");
    expect(card.textContent).toContain("Which colour do you prefer?");
  });

  it("steps through a multi-question record and answers it whole", async () => {
    await mountReady();
    await push("question.requested", questionRecord({
      questions: [
        {
          questionId: "colour",
          header: "Colour",
          question: "Which colour do you prefer?",
          options: [{ label: "Teal" }, { label: "Indigo" }],
          isOther: true,
        },
        {
          questionId: "size",
          header: "Size",
          question: "How big?",
          options: [{ label: "Small" }, { label: "Large" }],
          isOther: true,
        },
      ],
    }));

    expect((await screen.findByTestId("chat-question-progress")).textContent).toBe("1/2");
    fireEvent.click((await screen.findAllByTestId("chat-question-option"))[0]);
    // The first press is Next, not Submit: `question.resolve` validates EVERY
    // question in the record, so a partial answer is refused outright.
    fireEvent.click(screen.getByTestId("chat-question-submit"));
    await waitFor(() => expect(screen.getByTestId("chat-question-progress").textContent).toBe("2/2"));
    expect(framesFor("question.resolve")).toHaveLength(0);

    fireEvent.click((await screen.findAllByTestId("chat-question-option"))[1]);
    fireEvent.click(screen.getByTestId("chat-question-submit"));
    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    expect(framesFor("question.resolve")[0].params).toEqual({
      id: QUESTION_ID,
      answers: { answers: { colour: ["Teal"], size: ["Large"] } },
    });
  });

  it("keeps the card open, and says so, when the answer did not get through", async () => {
    await mountReady();
    await push("question.requested", questionRecord());

    resolveAnswer = { ok: false, error: "question 'colour' requires an answer" };
    fireEvent.click((await screen.findAllByTestId("chat-question-option"))[0]);
    fireEvent.click(screen.getByTestId("chat-question-submit"));

    await waitFor(() => expect(screen.getByTestId("chat-question-error")).toBeTruthy());
    expect(screen.getByTestId("chat-question")).toHaveAttribute("data-status", "pending");
    expect(screen.getByTestId("chat-question-submit")).toBeTruthy();
  });
});
