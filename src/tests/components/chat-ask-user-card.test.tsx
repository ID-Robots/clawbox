/**
 * The `ask_user` question card in the ClawBox chat.
 *
 * THE FAILURE IT ENDS. OpenClaw's `ask_user` tool registers a gateway
 * question, broadcasts `question.requested` and then blocks the turn on
 * `question.waitAnswer` for its whole timeout — 900 seconds by default. The
 * Control UI draws that as a card with the options and a "type your own
 * answer" box. ClawBox drew nothing, so the chat showed a tool pill stuck on
 * "running" and, a quarter of an hour later, a reply beginning "No answer
 * arrived; proceed with best judgment." (the tool's own `noAnswerResult`).
 *
 * Everything the fake gateway answers here is the pinned 2026.8.1 core's own
 * shape: `QuestionRecordSchema` for the event and for `question.list`, the
 * narrow `{id, status}` (plus `answers`) of `question.resolved` — which
 * carries NO session key — and `question.resolve`'s
 * `{status: "answered", answers}`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { I18nProvider } from "@/lib/i18n";
import { resetHarnessCache } from "@/lib/client-harness";

// A jsdom mount of `ChatPopup` — the fake gateway handshake, the model seed,
// the transcript — costs seconds under a full parallel run, and a case does it
// once and then waits on several sub-5 s `waitFor`s in series. Every component
// suite that mounts it declares both ceilings; `test-timeout-hygiene.test.ts`
// is the rule.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SEED_TEXT = "Ready when you are.";
const SESSION = "agent:main:main";
const QUESTION_ID = "ask_9f21";

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

/** The record the gateway broadcasts and `question.list` answers with. */
function pendingQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: QUESTION_ID,
    questions: [
      {
        questionId: "deploy_target",
        header: "Deploy",
        question: "Where should I deploy this?",
        options: [
          { label: "Staging", description: "Safe. Rebuilds in about 2 minutes." },
          { label: "Production", description: "Goes live for everyone." },
        ],
        isOther: true,
      },
    ],
    agentId: "main",
    // The CANONICAL store key, which is what the gateway records — not
    // necessarily byte-identical to the key the chat bound.
    sessionKey: SESSION,
    runId: "run-1",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 900_000,
    status: "pending",
    ...overrides,
  };
}

const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

/** What the next `question.resolve` answers with, and whether it may. */
let resolveAnswer: { ok: boolean; payload?: unknown; error?: string } = {
  ok: true,
  payload: { status: "answered", answers: { answers: { deploy_target: ["Staging"] } } },
};
/** The pending set `question.list` replays. */
let listed: unknown[] = [];

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
      this.respond(id, { questions: listed });
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
    if (frame.method === "sessions.messages.subscribe") {
      this.respond(id, { subscribed: true });
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

function optionButton(label: string): HTMLElement {
  const found = screen
    .queryAllByTestId("chat-ask-user-option")
    .find((el) => el.getAttribute("data-option-label") === label);
  if (!found) throw new Error(`no option ${label}`);
  return found;
}

function settleFrames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function mountReady(props: { mobile?: boolean } = {}) {
  // Inside the real provider, so the card's sentences are asserted as the
  // owner reads them rather than as translation keys — which is also what
  // proves every key it asks for is in the catalogue.
  render(
    <I18nProvider>
      <ChatPopup isOpen onClose={() => {}} {...props} />
    </I18nProvider>,
  );
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

/** Raise the question the way the gateway does. */
async function raise(record: Record<string, unknown> = pendingQuestion()) {
  act(() => {
    socket()?.emit({ type: "event", event: "question.requested", payload: record });
  });
  return screen.findByTestId("chat-ask-user");
}

describe("the agent's ask_user question in the ClawBox chat", () => {
  beforeEach(() => {
    sent.length = 0;
    sockets.length = 0;
    listed = [];
    resolveAnswer = {
      ok: true,
      payload: { status: "answered", answers: { answers: { deploy_target: ["Staging"] } } },
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

  it("draws the question, its options and their descriptions", async () => {
    const card = await (await mountReady(), raise());

    expect(card.getAttribute("data-question-status")).toBe("pending");
    expect(card.textContent).toContain("Where should I deploy this?");
    // The chip the model chose, and the description under each label — the
    // half the owner actually decides on.
    expect(screen.getByTestId("chat-ask-user-header").textContent).toBe("Deploy");
    expect(card.textContent).toContain("Safe. Rebuilds in about 2 minutes.");
    expect(card.textContent).toContain("Goes live for everyone.");
    expect(optionButton("Staging")).toBeTruthy();
    expect(optionButton("Production")).toBeTruthy();
  });

  it("sends the chosen option back to the waiting ask_user call", async () => {
    await mountReady();
    await raise();

    fireEvent.click(optionButton("Production"));

    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    // The shape `QuestionResolveParamsSchema` takes, and the only one
    // `validateAnswers` accepts.
    expect(framesFor("question.resolve")[0].params).toEqual({
      id: QUESTION_ID,
      answers: { answers: { deploy_target: ["Production"] } },
    });
    await waitFor(() =>
      expect(screen.getByTestId("chat-ask-user").getAttribute("data-question-status")).toBe("answered"),
    );
  });

  it("sends a typed answer the options never offered", async () => {
    await mountReady();
    await raise();

    fireEvent.change(screen.getByTestId("chat-ask-user-text"), { target: { value: "  the Pi in the shed  " } });
    fireEvent.click(screen.getByTestId("chat-ask-user-send"));

    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    expect(framesFor("question.resolve")[0].params).toEqual({
      id: QUESTION_ID,
      answers: { answers: { deploy_target: ["the Pi in the shed"] } },
    });
  });

  it("collects every tick of a multi-select question into one answer", async () => {
    await mountReady();
    await raise(
      pendingQuestion({
        questions: [
          {
            questionId: "channels",
            header: "Notify",
            question: "Where should I tell you?",
            options: [{ label: "Telegram" }, { label: "Email" }, { label: "Desktop" }],
            multiSelect: true,
            isOther: true,
          },
        ],
      }),
    );

    // Real checkboxes, in a group named by the question — ticked, not fired
    // off one at a time, because the gateway takes the whole request at once.
    fireEvent.click(optionButton("Desktop"));
    fireEvent.click(optionButton("Telegram"));
    expect(framesFor("question.resolve")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("chat-ask-user-send"));
    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    // In the OPTION order, not the click order, so the answer reads the way
    // the question asked it.
    expect(framesFor("question.resolve")[0].params).toEqual({
      id: QUESTION_ID,
      answers: { answers: { channels: ["Telegram", "Desktop"] } },
    });
  });

  it("holds a two-question request until both are answered", async () => {
    await mountReady();
    await raise(
      pendingQuestion({
        questions: [
          {
            questionId: "deploy_target",
            header: "Deploy",
            question: "Where should I deploy this?",
            options: [{ label: "Staging" }, { label: "Production" }],
            isOther: true,
          },
          {
            questionId: "rebuild",
            header: "Rebuild",
            question: "Rebuild the index first?",
            options: [{ label: "Yes" }, { label: "No" }],
            isOther: true,
          },
        ],
      }),
    );

    // `validateAnswers` refuses a resolve that omits a question, so one click
    // must not post: it would be refused and the agent would stay parked.
    fireEvent.click(optionButton("Staging"));
    await settleFrames();
    expect(framesFor("question.resolve")).toHaveLength(0);

    fireEvent.click(optionButton("No"));
    fireEvent.click(screen.getByTestId("chat-ask-user-send"));
    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
    expect(framesFor("question.resolve")[0].params).toEqual({
      id: QUESTION_ID,
      answers: { answers: { deploy_target: ["Staging"], rebuild: ["No"] } },
    });
  });

  it("says a question timed out instead of taking a click that goes nowhere", async () => {
    await mountReady();
    await raise();

    act(() => {
      socket()?.emit({
        type: "event",
        event: "question.resolved",
        payload: { id: QUESTION_ID, status: "expired" },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("chat-ask-user").getAttribute("data-question-status")).toBe("expired"),
    );
    // The card STAYS — a question that silently vanished would read as an
    // answer that was sent — and every control on it is gone.
    expect(screen.queryByTestId("chat-ask-user-send")).toBeNull();
    expect(screen.queryAllByTestId("chat-ask-user-option")).toHaveLength(0);
    // Said in the owner's own words, not left as a raw key — the provider
    // loads its catalogue in an effect, so this is a wait and not a read.
    await waitFor(() =>
      expect(screen.getByTestId("chat-ask-user").textContent).toContain("Nobody answered in time"),
    );
  });

  it("refuses to post over a window that closed while nobody was looking", async () => {
    await mountReady();
    // Still `pending` on the gateway's record, but past its own expiry — the
    // resolve would come back QUESTION_ALREADY_TERMINAL.
    await raise(pendingQuestion({ expiresAtMs: Date.now() - 1 }));

    await waitFor(() =>
      expect(screen.getByTestId("chat-ask-user").getAttribute("data-question-status")).toBe("expired"),
    );
    expect(screen.queryByTestId("chat-ask-user-send")).toBeNull();
  });

  it("shows an answer given somewhere else rather than going on waiting", async () => {
    await mountReady();
    await raise();

    act(() => {
      socket()?.emit({
        type: "event",
        event: "question.resolved",
        payload: { id: QUESTION_ID, status: "answered", answers: { answers: { deploy_target: ["Staging"] } } },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("chat-ask-user").getAttribute("data-question-status")).toBe("answered"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-ask-user-answered").textContent).toContain("Answered: Staging"),
    );
  });

  it("gets the card back from question.list after a reload", async () => {
    // The one thing the Hermes clarify card cannot do: a question outlives the
    // browser tab, so the chat asks what is still open on every connect.
    listed = [pendingQuestion()];
    await mountReady();

    await screen.findByTestId("chat-ask-user");
    expect(framesFor("question.list")).toHaveLength(1);
    expect(framesFor("question.list")[0].params).toEqual({});
  });

  it("keeps another conversation's question off this one", async () => {
    await mountReady();

    act(() => {
      socket()?.emit({
        type: "event",
        event: "question.requested",
        payload: pendingQuestion({ sessionKey: "agent:main:clawbox-side" }),
      });
    });
    await settleFrames();

    expect(screen.queryAllByTestId("chat-ask-user")).toHaveLength(0);
  });

  it("draws a question the gateway recorded under the canonical key", async () => {
    // The record's key is the bound key with the agent namespace in front of
    // it; a byte-for-byte comparison would drop the card for exactly the
    // conversation the question was asked in.
    await mountReady();
    await raise(pendingQuestion({ sessionKey: `agent:main:${SESSION}` }));
  });

  it("keeps the card answerable and says why when the gateway refuses", async () => {
    resolveAnswer = { ok: false, error: "question 'ask_9f21' is already answered" };
    await mountReady();
    await raise();

    fireEvent.click(optionButton("Staging"));

    const reason = await screen.findByTestId("chat-ask-user-error-reason");
    // The GATEWAY's own words, never a fixed "try again" over a refusal that
    // can never succeed.
    expect(reason.textContent).toContain("already answered");
    expect(screen.getByTestId("chat-ask-user").getAttribute("data-question-status")).toBe("pending");
    // And the control comes back, because first-answer-wins means pressing
    // again is safe.
    expect(screen.getByTestId("chat-ask-user-send")).toBeTruthy();
  });

  it("never draws a question that asks for a secret", async () => {
    // This chat has no masked input; drawing it would put a credential in a
    // visible field.
    await mountReady();
    act(() => {
      socket()?.emit({
        type: "event",
        event: "question.requested",
        payload: pendingQuestion({
          questions: [
            {
              questionId: "api_key",
              header: "Key",
              question: "Paste the API key",
              options: [],
              isSecret: true,
              secretStore: { name: "API_KEY", kind: "secret" },
            },
          ],
        }),
      });
    });
    await settleFrames();

    expect(screen.queryAllByTestId("chat-ask-user")).toHaveLength(0);
  });

  it("is answerable on a phone, where this chat is the whole surface", async () => {
    // `page.tsx` renders this same popup at phone widths (`mobile={isMobile}`)
    // and the standalone page renders no card at all, so if it were not
    // answerable here it would not be answerable on a phone anywhere.
    await mountReady({ mobile: true });
    await raise();

    fireEvent.click(optionButton("Staging"));

    await waitFor(() => expect(framesFor("question.resolve")).toHaveLength(1));
  });

  it("asks the gateway for the scope those events are guarded by", async () => {
    await mountReady();

    const connect = framesFor("connect")[0].params as { scopes?: string[] };
    expect(connect.scopes).toContain("operator.questions");
  });
});
