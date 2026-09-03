import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@/tests/helpers/test-utils";
import { installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * The agent asking a question, on screen and answerable.
 *
 * The unit tests prove the adapter reads the frame. What they cannot prove is
 * the half the customer actually gets: that the card appears attached to the
 * live turn, that clicking it POSTs something the answer route can act on, and
 * that a batch posts once PER QUESTION — the agent unblocks only when every
 * qid has come back, so a surface that posted once for the whole request would
 * leave it parked exactly as it was before any of this existed.
 */

/** Resolves the streamed body's next chunk, so a test can pace the stream. */
let releaseChunk: ((chunk: string | null) => void) | null = null;
/** Bodies POSTed to the answer route, in order. */
let clarifyPosts: Record<string, unknown>[] = [];
/** What that route answers next. Replaced by the test that wants an expiry. */
let clarifyReply: () => { ok: boolean; status: number; payload: unknown };

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE Response whose chunks are handed out one `releaseChunk` at a time. */
function pacedStream(): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              releaseChunk = (chunk) =>
                chunk === null ? resolve({ done: true }) : resolve({ done: false, value: encoder.encode(chunk) });
            }),
        };
      },
    },
  } as unknown as Response;
}

/**
 * The shared Hermes box, with the turn upgraded to a real stream.
 *
 * `installHermesBox` answers every route this surface needs and answers the
 * chat route with one JSON body — which is the right default for it and no use
 * here, because a clarify only exists mid-stream. So the helper's fetch is
 * kept for everything else and only the two chat routes are taken over. The
 * clarify route is matched FIRST: its path starts with the chat route's own.
 */
function installStreamingBox(): HermesBox {
  const box = installHermesBox();
  box.facts.hermesStreamsTurns = true;
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/hermes/chat/clarify")) {
        clarifyPosts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        const answer = clarifyReply();
        return { ok: answer.ok, status: answer.status, json: async () => answer.payload };
      }
      if (url.includes("/setup-api/hermes/chat")) return pacedStream();
      return inner(input as RequestInfo, init);
    }),
  );
  return box;
}

async function send(textarea: HTMLElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(releaseChunk).not.toBeNull());
}

/** Hand the stream one chunk and let the component settle. */
async function push(chunk: string | null) {
  await waitFor(() => expect(releaseChunk).not.toBeNull());
  const release = releaseChunk!;
  releaseChunk = null;
  release(chunk);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A turn that has reached the point of asking. */
async function askQuestion(payload: unknown): Promise<void> {
  const box = installStreamingBox();
  const textarea = await mountHermesChat(box);
  await send(textarea, "Ship it");
  await push(frame("clarify", payload));
  await waitFor(() => expect(screen.getByTestId("chat-clarify")).toBeTruthy());
}

const SINGLE = {
  requestId: "req-single",
  questions: [{ qid: "", question: "Deploy to production?", choices: ["Yes", "No"], multiSelect: false }],
};

beforeEach(() => {
  releaseChunk = null;
  clarifyPosts = [];
  clarifyReply = () => ({ ok: true, status: 200, payload: { status: "ok" } });
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("a clarify the agent is parked on", () => {
  it("renders the question and every choice it offered", async () => {
    await askQuestion(SINGLE);
    expect(screen.getByText("Deploy to production?")).toBeTruthy();
    const choices = screen.getAllByTestId("chat-clarify-choice");
    expect(choices.map((button) => button.textContent)).toEqual(["Yes", "No"]);
  });

  it("posts the chosen label, with no questionId, when a choice is clicked", async () => {
    // A single clarify arrives with an empty qid, and the route wants the
    // field OMITTED rather than sent empty — an empty `questionId` would look
    // like a batch member the request has no such question for.
    await askQuestion(SINGLE);
    fireEvent.click(screen.getAllByTestId("chat-clarify-choice")[0]);
    await waitFor(() => expect(clarifyPosts).toHaveLength(1));
    expect(clarifyPosts[0]).toEqual({ requestId: "req-single", answer: "Yes" });
  });

  it("collapses the question once it is answered, so it cannot be answered twice", async () => {
    // The gateway would accept a second answer for the same qid. That is
    // exactly why the control is taken away: two answers to one question is a
    // confusion the customer cannot see and the agent cannot resolve.
    await askQuestion(SINGLE);
    fireEvent.click(screen.getAllByTestId("chat-clarify-choice")[0]);
    await waitFor(() => expect(screen.getByTestId("chat-clarify-answered")).toBeTruthy());
    expect(screen.queryAllByTestId("chat-clarify-choice")).toHaveLength(0);
    expect(screen.queryAllByTestId("chat-clarify-text")).toHaveLength(0);
  });

  it("sends what the customer typed, even when choices were offered", async () => {
    // An agent's guess at the options is a guess. The free-text field is
    // always there so an answer that is not on the list does not have to be
    // rounded to the nearest wrong one.
    await askQuestion(SINGLE);
    fireEvent.change(screen.getByTestId("chat-clarify-text"), { target: { value: "staging first" } });
    fireEvent.click(screen.getByTestId("chat-clarify-submit"));
    await waitFor(() => expect(clarifyPosts).toHaveLength(1));
    expect(clarifyPosts[0]).toEqual({ requestId: "req-single", answer: "staging first" });
  });

  it("sends a multi-select answer as a JSON array, in the order it was asked", async () => {
    // A comma-joined string would be indistinguishable from one choice whose
    // label contains a comma, and the route parses JSON.
    await askQuestion({
      requestId: "req-multi",
      questions: [{ qid: "", question: "Which boxes?", choices: ["Alpha", "Beta", "Gamma"], multiSelect: true }],
    });
    const boxes = screen.getAllByTestId("chat-clarify-check");
    // Ticked back to front: the answer must still read the way the question did.
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByTestId("chat-clarify-submit"));
    await waitFor(() => expect(clarifyPosts).toHaveLength(1));
    expect(clarifyPosts[0]).toEqual({ requestId: "req-multi", answer: JSON.stringify(["Alpha", "Beta"]) });
  });
});

describe("a batch of clarify questions", () => {
  const BATCH = {
    requestId: "req-batch",
    questions: [
      { qid: "q1", question: "Which branch?", choices: ["main", "beta"], multiSelect: false },
      { qid: "q2", question: "Notify the team?", choices: ["Yes", "No"], multiSelect: false },
    ],
  };

  it("posts once per question, each naming its own questionId", async () => {
    // The agent unblocks only when EVERY qid has come back. One POST for the
    // whole request would leave it parked.
    await askQuestion(BATCH);
    expect(screen.getAllByTestId("chat-clarify-question")).toHaveLength(2);
    const choices = screen.getAllByTestId("chat-clarify-choice");
    fireEvent.click(choices[1]); // "beta" for q1
    await waitFor(() => expect(clarifyPosts).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("chat-clarify-choice")[0]); // "Yes" for q2
    await waitFor(() => expect(clarifyPosts).toHaveLength(2));
    expect(clarifyPosts).toEqual([
      { requestId: "req-batch", answer: "beta", questionId: "q1" },
      { requestId: "req-batch", answer: "Yes", questionId: "q2" },
    ]);
  });

  it("skips a question with an empty answer, which still counts as answered", async () => {
    await askQuestion(BATCH);
    fireEvent.click(screen.getAllByTestId("chat-clarify-skip")[0]);
    await waitFor(() => expect(clarifyPosts).toHaveLength(1));
    expect(clarifyPosts[0]).toEqual({ requestId: "req-batch", answer: "", questionId: "q1" });
    // Answered, not cancelled: the question is gone from the card.
    expect(screen.getAllByTestId("chat-clarify-answered")).toHaveLength(1);
  });

  it("confirm-and-continue answers everything still outstanding, in one gesture", async () => {
    // An untouched question goes as an empty answer — the documented skip —
    // because otherwise the button would say "continue" and continue nothing.
    await askQuestion(BATCH);
    fireEvent.click(screen.getAllByTestId("chat-clarify-choice")[0]); // "main" for q1
    await waitFor(() => expect(clarifyPosts).toHaveLength(1));
    fireEvent.click(screen.getByTestId("chat-clarify-confirm"));
    await waitFor(() => expect(clarifyPosts).toHaveLength(2));
    expect(clarifyPosts[1]).toEqual({ requestId: "req-batch", answer: "", questionId: "q2" });
  });
});

describe("a clarify that was replayed or has run out", () => {
  it("renders one card when the same requestId arrives twice", async () => {
    // A reconnect replays the prompt the agent is still parked on. Appending
    // it would leave the customer with two identical cards, one of which is a
    // ghost — and no way to tell which.
    await askQuestion(SINGLE);
    await push(frame("clarify", { ...SINGLE, answered: { "": "" } }));
    await waitFor(() => expect(screen.getAllByTestId("chat-clarify")).toHaveLength(1));
    // …and the replay's locked answer collapses the question it names.
    expect(screen.getByTestId("chat-clarify-answered")).toBeTruthy();
  });

  it("says the customer's own message answered it, with nothing left to click", async () => {
    // TASK-610. A message typed into the composer while the agent is parked is
    // delivered as the ANSWER, so the card that comes back names it as the
    // answer rather than sitting there as a form the customer has already
    // replied to — and offers no control that would answer it a second time.
    await askQuestion({ ...SINGLE, answered: { "": "the second one" } });
    // The answered LINE, not the form: the text itself rides through the
    // translator, which this environment stubs to the key.
    expect(screen.getByTestId("chat-clarify-answered")).toBeTruthy();
    expect(screen.queryAllByTestId("chat-clarify-choice")).toHaveLength(0);
    expect(screen.queryAllByTestId("chat-clarify-text")).toHaveLength(0);
  });

  it("goes dead in place when the agent stops waiting", async () => {
    // The card stays on screen — a question that silently vanished would read
    // as an answer that was sent — but nothing on it can be posted any more.
    await askQuestion(SINGLE);
    await push(frame("clarifyExpire", { requestId: "req-single" }));
    await waitFor(() => expect(screen.getByTestId("chat-clarify-expired")).toBeTruthy());
    for (const control of [
      ...screen.getAllByTestId("chat-clarify-choice"),
      ...screen.getAllByTestId("chat-clarify-text"),
      ...screen.getAllByTestId("chat-clarify-skip"),
      ...screen.getAllByTestId("chat-clarify-submit"),
    ]) {
      expect(control).toBeDisabled();
    }
    fireEvent.click(screen.getAllByTestId("chat-clarify-choice")[0]);
    expect(clarifyPosts).toHaveLength(0);
    // Polite, never assertive: this row sits among live controls, and an
    // assertive region talks over whatever is being read or typed.
    expect(screen.getByTestId("chat-clarify-expired").getAttribute("aria-live")).toBe("polite");
  });

  it("flips the card to expired rather than erroring when the route says so", async () => {
    // The agent simply stopped waiting. A red "could not send" would invite a
    // retry that can never succeed.
    await askQuestion(SINGLE);
    clarifyReply = () => ({ ok: true, status: 200, payload: { status: "expired" } });
    fireEvent.click(screen.getAllByTestId("chat-clarify-choice")[0]);
    await waitFor(() => expect(screen.getByTestId("chat-clarify-expired")).toBeTruthy());
    expect(screen.queryByTestId("chat-clarify-error")).toBeNull();
  });

  it("hands the control back, politely, when the answer could not be sent", async () => {
    // The one failure a customer cannot see and cannot recover from is a
    // question that looks answered and never reached the agent.
    await askQuestion(SINGLE);
    clarifyReply = () => ({ ok: false, status: 503, payload: {} });
    fireEvent.click(screen.getAllByTestId("chat-clarify-choice")[0]);
    await waitFor(() => expect(screen.getByTestId("chat-clarify-error")).toBeTruthy());
    expect(screen.getByTestId("chat-clarify-error").getAttribute("aria-live")).toBe("polite");
    expect(screen.getAllByTestId("chat-clarify-choice")).toHaveLength(2);
  });

  it("is gone once the turn ends, because there is no longer anything to answer", async () => {
    // It is deliberately not persisted either: see the note on `clarifies` in
    // ChatPopup. A card that outlived its turn would be a control posting into
    // a request nothing is parked on.
    await askQuestion(SINGLE);
    await push(frame("done", { text: "Deployed.", harness: "hermes", sessionId: "20260825_120000_aaaaaa" }));
    await push(null);
    await waitFor(() => expect(screen.queryByTestId("chat-clarify")).toBeNull());
  });
});
