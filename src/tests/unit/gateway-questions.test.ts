// The agent's own `ask_user` question, as the ClawBox chat has to read it.
//
// THE FAILURE. `ask_user` registers a gateway question, broadcasts
// `question.requested` and blocks the turn on `question.waitAnswer` for its
// whole timeout (900 s by default). ClawBox rendered nothing for that event, so
// the chat showed a tool pill stuck on "running" and then a reply beginning
// "No answer arrived; proceed with best judgment." — the tool's own
// `noAnswerResult`. The question was never on screen; there was nothing to
// press.
//
// EVERYTHING HERE IS THE GATEWAY'S OWN SHAPE, read off the pinned 2026.8.1
// core rather than invented: `QuestionRecordSchema`
// (`{id, questions[], agentId?, sessionKey?, runId?, createdAtMs, expiresAtMs,
// status, answers?, resolvedBy?}`), `QuestionSchema`
// (`{questionId, header, question, options[{label, description?}],
// multiSelect?, isOther?, isSecret?, secretStore?}`),
// `QuestionResolvedEventSchema` (`{id, status}` plus `answers` when answered —
// and NO session key), `QuestionListResultSchema` and
// `QuestionResolveResultSchema` (`{status: "answered", answers}` or
// `{status: "cancelled"}`).

import { describe, expect, it, vi } from "vitest";

import {
  buildQuestionAnswers,
  describeQuestionAnswer,
  loadPendingQuestions,
  markQuestionBusy,
  mergeQuestionCard,
  questionBelongsToSession,
  questionIsActionable,
  questionsAfterReplay,
  questionsAfterResolution,
  questionsAfterResolve,
  readQuestionCard,
  readQuestionList,
  readQuestionResolution,
  QUESTION_NO_OUTCOME_RECORDED,
  QUESTION_REQUESTED_EVENT,
  QUESTION_RESOLVED_EVENT,
  type QuestionCard,
} from "@/lib/gateway-questions";

const NOW = 1_788_300_000_000;
const SESSION = "agent:main:main";

function question(overrides: Record<string, unknown> = {}) {
  return {
    questionId: "deploy_target",
    header: "Deploy",
    question: "Where should this go?",
    options: [
      { label: "Staging", description: "Safe. Rebuilds in about 2 minutes." },
      { label: "Production" },
    ],
    isOther: true,
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "ask_9f21",
    questions: [question()],
    agentId: "main",
    sessionKey: SESSION,
    runId: "run-1",
    createdAtMs: NOW - 1_000,
    expiresAtMs: NOW + 900_000,
    status: "pending",
    ...overrides,
  };
}

describe("reading one question record", () => {
  it("reads the whole card, descriptions included", () => {
    const card = readQuestionCard(record());
    expect(card).not.toBeNull();
    expect(card!.id).toBe("ask_9f21");
    expect(card!.sessionKey).toBe(SESSION);
    expect(card!.status).toBe("pending");
    expect(card!.expiresAtMs).toBe(NOW + 900_000);
    expect(card!.questions).toHaveLength(1);
    expect(card!.questions[0].header).toBe("Deploy");
    expect(card!.questions[0].multiSelect).toBe(false);
    expect(card!.questions[0].isOther).toBe(true);
    // The description is the half the owner decides on; a card that dropped it
    // would show "Staging" and "Production" and nothing about the cost.
    expect(card!.questions[0].options).toEqual([
      { label: "Staging", description: "Safe. Rebuilds in about 2 minutes." },
      { label: "Production" },
    ]);
  });

  it("carries multiSelect through", () => {
    const card = readQuestionCard(record({ questions: [question({ multiSelect: true })] }));
    expect(card!.questions[0].multiSelect).toBe(true);
  });

  it("offers free text for a question with no options, whatever isOther says", () => {
    // A question with neither options nor a text box is a card with no answer
    // on it, which is the state this whole feature exists to remove.
    const card = readQuestionCard(record({ questions: [question({ options: [], isOther: undefined })] }));
    expect(card!.questions[0].isOther).toBe(true);
  });

  it("does not invent free text for a question that offers options and refuses it", () => {
    const card = readQuestionCard(record({ questions: [question({ isOther: undefined })] }));
    expect(card!.questions[0].isOther).toBe(false);
  });

  it("refuses a request whose question asks for a secret", () => {
    // This chat has no masked input. Rendering it as an ordinary text box
    // would put a credential in a visible field, in React state and in the
    // transcript's own DOM.
    expect(readQuestionCard(record({ questions: [question({ isSecret: true, options: [] })] }))).toBeNull();
    expect(
      readQuestionCard(
        record({ questions: [question({ options: [], secretStore: { name: "API_KEY", kind: "secret" } })] }),
      ),
    ).toBeNull();
  });

  it("refuses a request it could only read PART of", () => {
    // The gateway refuses a resolve that leaves any question unanswered, so a
    // card drawn over a subset would offer a Send that can only be refused.
    const partial = record({ questions: [question(), { questionId: "x" }] });
    expect(readQuestionCard(partial)).toBeNull();
  });

  it("refuses a question id the gateway itself would not accept", () => {
    // A qid becomes a property name — on the answers map, on the card's draft,
    // and on the map posted back to `question.resolve` — so it is REBUILT from
    // the gateway's own alphabet (`QuestionIdSchema`, snake_case opening with
    // a letter) rather than tested and passed through. `__proto__` is outside
    // it by construction, and an id the gateway would refuse can answer
    // nothing anyway.
    for (const bad of ["__proto__", "Deploy", "deploy-target", "deploy target", "9lives", ""]) {
      expect(readQuestionCard(record({ questions: [question({ questionId: bad })] })), bad).toBeNull();
    }
  });

  it("drops an answer filed under a name that is not a question id", () => {
    const card = readQuestionCard(
      record({
        status: "answered",
        answers: { answers: { __proto__: ["polluted"], deploy_target: ["Staging"] } },
      }),
    );
    expect(card!.answers).toEqual({ deploy_target: ["Staging"] });
    expect(Object.getPrototypeOf(card!.answers)).toBe(Object.prototype);
  });

  it("does not read Object's own members as an answer or a draft", () => {
    // `constructor` IS a legal question id under the gateway's rule, so a bare
    // `map[qid]` would hand back Object's own constructor for a question
    // nobody has answered.
    const questions = readQuestionCard(
      record({ questions: [question({ questionId: "constructor" })] }),
    )!.questions;
    expect(buildQuestionAnswers(questions, {})).toBeNull();
  });

  it("refuses what it cannot act on at all", () => {
    expect(readQuestionCard(null)).toBeNull();
    expect(readQuestionCard("ask_1")).toBeNull();
    expect(readQuestionCard(record({ id: "" }))).toBeNull();
    expect(readQuestionCard(record({ status: "waiting" }))).toBeNull();
    expect(readQuestionCard(record({ questions: [] }))).toBeNull();
    expect(readQuestionCard(record({ questions: "nope" }))).toBeNull();
  });

  it("leaves a card with no stated expiry answerable", () => {
    // Falling back to `createdAtMs` would grey the card out the instant it
    // appeared, over a question the gateway is still holding open.
    const card = readQuestionCard(record({ expiresAtMs: undefined }));
    expect(card!.expiresAtMs).toBe(Number.POSITIVE_INFINITY);
    expect(questionIsActionable(card!, NOW)).toBe(true);
  });

  it("keeps the answers of a record that is already answered", () => {
    const card = readQuestionCard(
      record({ status: "answered", answers: { answers: { deploy_target: ["Staging"] } } }),
    );
    expect(card!.status).toBe("answered");
    expect(card!.answers).toEqual({ deploy_target: ["Staging"] });
  });
});

describe("the terminal event", () => {
  it("reads an answered resolution", () => {
    expect(
      readQuestionResolution({
        id: "ask_9f21",
        status: "answered",
        answers: { answers: { deploy_target: ["Staging"] } },
      }),
    ).toEqual({ id: "ask_9f21", status: "answered", answers: { deploy_target: ["Staging"] } });
  });

  it("reads a cancelled and an expired one", () => {
    expect(readQuestionResolution({ id: "a", status: "cancelled" })).toEqual({ id: "a", status: "cancelled" });
    expect(readQuestionResolution({ id: "a", status: "expired" })).toEqual({ id: "a", status: "expired" });
  });

  it("refuses a pending or unreadable one", () => {
    expect(readQuestionResolution({ id: "a", status: "pending" })).toBeNull();
    expect(readQuestionResolution({ status: "answered" })).toBeNull();
    expect(readQuestionResolution(null)).toBeNull();
  });

  it("settles the card it names and leaves every other one alone", () => {
    const cards = [readQuestionCard(record())!, readQuestionCard(record({ id: "ask_other" }))!];
    const next = questionsAfterResolution(cards, { id: "ask_9f21", status: "cancelled" });
    expect(next[0].status).toBe("cancelled");
    expect(next[1].status).toBe("pending");
  });

  it("leaves a card this surface never drew alone", () => {
    // The event carries no session key, so the id IS the filter.
    const cards = [readQuestionCard(record())!];
    expect(questionsAfterResolution(cards, { id: "somebody-elses", status: "answered" })).toBe(cards);
  });
});

describe("which conversation a question belongs to", () => {
  it("matches the canonical store key against the bound one", () => {
    // `resolveStoredSessionKeyForAgentStore` puts the `agent:<id>:` namespace
    // in front of a bare key, so a byte-for-byte comparison would drop the
    // card for exactly the conversation the question was asked in.
    expect(questionBelongsToSession("agent:main:main", "main")).toBe(true);
    expect(questionBelongsToSession("main", "agent:main:main")).toBe(true);
    expect(questionBelongsToSession(SESSION, SESSION)).toBe(true);
  });

  it("keeps another tab's question out of this one", () => {
    expect(questionBelongsToSession("agent:main:main", "agent:main:clawbox-abc")).toBe(false);
  });

  it("shows a question the gateway did not place", () => {
    expect(questionBelongsToSession("", SESSION)).toBe(true);
  });
});

describe("the pending replay", () => {
  it("reads the pending set off question.list", () => {
    const cards = readQuestionList({ questions: [record(), record({ id: "b" })] });
    expect(cards.map((card) => card.id)).toEqual(["ask_9f21", "b"]);
  });

  it("drops a row that is no longer pending", () => {
    expect(readQuestionList({ questions: [record({ status: "answered" })] })).toEqual([]);
  });

  it("reads nothing out of a payload it cannot use", () => {
    expect(readQuestionList(null)).toEqual([]);
    expect(readQuestionList({})).toEqual([]);
  });

  it("takes down a pending card the list no longer mentions", () => {
    // `question.list` answers the pending set and only that, so a card it does
    // not mention was resolved while this socket was away. Leaving it up would
    // offer a button the gateway refuses.
    const prev = [readQuestionCard(record())!];
    expect(questionsAfterReplay(prev, [])).toEqual([]);
  });

  it("keeps a settled card, which is the record of what happened", () => {
    const prev = [readQuestionCard(record({ status: "expired" }))!];
    expect(questionsAfterReplay(prev, [])).toHaveLength(1);
  });

  it("asks the gateway and hands the answer back with the key it asked about", () => {
    const request = vi.fn().mockResolvedValue({ questions: [record()] });
    const apply = vi.fn();
    return loadPendingQuestions(request, SESSION, apply).then(() => {
      expect(request).toHaveBeenCalledWith("question.list", {});
      expect(apply).toHaveBeenCalledTimes(1);
      // The key travels WITH the answer: this call is not cancelled when the
      // owner switches conversation, so a slow list for the tab they left
      // must not land under the tab they are in.
      expect(apply.mock.calls[0][1]).toBe(SESSION);
      expect((apply.mock.calls[0][0] as QuestionCard[]).map((c) => c.id)).toEqual(["ask_9f21"]);
    });
  });

  it("drops another conversation's question from the replay", () => {
    const request = vi.fn().mockResolvedValue({
      questions: [record({ sessionKey: "agent:main:clawbox-other" })],
    });
    const apply = vi.fn();
    return loadPendingQuestions(request, SESSION, apply).then(() => {
      expect(apply.mock.calls[0][0]).toEqual([]);
    });
  });

  it("leaves the chat as it was when the gateway has no such RPC", () => {
    const request = vi.fn().mockRejectedValue(new Error("unknown method"));
    const apply = vi.fn();
    return loadPendingQuestions(request, SESSION, apply).then(() => {
      expect(apply).not.toHaveBeenCalled();
    });
  });
});

describe("merging", () => {
  it("replaces a card with the same id in place", () => {
    const first = readQuestionCard(record())!;
    const second = readQuestionCard(record({ status: "answered" }))!;
    const merged = mergeQuestionCard([first], second);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("answered");
  });

  it("keeps a press in flight while the card is still pending", () => {
    const busy = markQuestionBusy([readQuestionCard(record())!], "ask_9f21");
    expect(mergeQuestionCard(busy, readQuestionCard(record())!)[0].busy).toBe(true);
    // …and drops it the moment the gateway says the question is over.
    expect(mergeQuestionCard(busy, readQuestionCard(record({ status: "cancelled" }))!)[0].busy).toBeUndefined();
  });
});

describe("resolving", () => {
  const cards = () => [readQuestionCard(record())!];

  it("records the canonical outcome the gateway answered with", () => {
    const next = questionsAfterResolve(cards(), "ask_9f21", {
      status: "answered",
      answers: { answers: { deploy_target: ["Staging"] } },
    });
    expect(next[0].status).toBe("answered");
    expect(next[0].answers).toEqual({ deploy_target: ["Staging"] });
    expect(next[0].busy).toBeUndefined();
  });

  it("records a cancel the gateway reports back", () => {
    expect(questionsAfterResolve(cards(), "ask_9f21", { status: "cancelled" })[0].status).toBe("cancelled");
  });

  it("keeps the card pending with the gateway's own words on a refusal", () => {
    const next = questionsAfterResolve(cards(), "ask_9f21", new Error("question 'ask_9f21' is already expired"));
    expect(next[0].status).toBe("pending");
    expect(next[0].busy).toBeUndefined();
    expect(next[0].error).toBe("question 'ask_9f21' is already expired");
  });

  it("says so, rather than claiming an outcome, when the answer is unreadable", () => {
    const next = questionsAfterResolve(cards(), "ask_9f21", { applied: true });
    expect(next[0].status).toBe("pending");
    expect(next[0].error).toBe(QUESTION_NO_OUTCOME_RECORDED);
  });
});

describe("what may be sent", () => {
  const single = readQuestionCard(record())!.questions;
  const multi = readQuestionCard(record({ questions: [question({ multiSelect: true })] }))!.questions;
  const batch = readQuestionCard(
    record({ questions: [question(), question({ questionId: "rebuild", question: "Rebuild first?" })] }),
  )!.questions;

  it("builds the map question.resolve wants", () => {
    expect(buildQuestionAnswers(single, { deploy_target: ["Staging"] })).toEqual({
      answers: { deploy_target: ["Staging"] },
    });
  });

  it("refuses a request with any question unanswered", () => {
    // `validateAnswers` throws "requires an answer" for exactly this, so the
    // Send button stays dark rather than bright-then-refused.
    expect(buildQuestionAnswers(batch, { deploy_target: ["Staging"] })).toBeNull();
    expect(buildQuestionAnswers(single, {})).toBeNull();
    expect(buildQuestionAnswers(single, { deploy_target: ["   "] })).toBeNull();
  });

  it("refuses two values for a single-select question, and allows them for a multi", () => {
    expect(buildQuestionAnswers(single, { deploy_target: ["Staging", "Production"] })).toBeNull();
    expect(buildQuestionAnswers(multi, { deploy_target: ["Staging", "Production"] })).toEqual({
      answers: { deploy_target: ["Staging", "Production"] },
    });
  });

  it("trims what it sends", () => {
    expect(buildQuestionAnswers(single, { deploy_target: ["  Staging "] })).toEqual({
      answers: { deploy_target: ["Staging"] },
    });
  });
});

describe("small things the card leans on", () => {
  it("names the two events the gateway broadcasts", () => {
    expect(QUESTION_REQUESTED_EVENT).toBe("question.requested");
    expect(QUESTION_RESOLVED_EVENT).toBe("question.resolved");
  });

  it("reads a recorded answer as a person does", () => {
    expect(describeQuestionAnswer(["Staging", "Production"])).toBe("Staging, Production");
    expect(describeQuestionAnswer(undefined)).toBe("");
  });

  it("refuses to act on a card whose window has closed", () => {
    const card = readQuestionCard(record({ expiresAtMs: NOW - 1 }))!;
    expect(questionIsActionable(card, NOW)).toBe(false);
  });

  it("refuses to act twice while one press is in flight", () => {
    const [card] = markQuestionBusy([readQuestionCard(record())!], "ask_9f21");
    expect(questionIsActionable(card, NOW)).toBe(false);
  });
});
