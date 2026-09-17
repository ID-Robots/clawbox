import { describe, expect, it } from "vitest";
import {
  QUESTION_NO_OUTCOME_RECORDED,
  markQuestionBusy,
  mergeQuestionCard,
  questionBelongsToSession,
  questionIsActionable,
  questionResolveParams,
  questionSkipParams,
  questionsAfterList,
  questionsAfterResolve,
  questionsAfterResolvedEvent,
  readQuestionRecord,
  type QuestionCard,
} from "@/lib/gateway-questions";

/**
 * The gateway's own question protocol, pinned to frames CAPTURED FROM A BOX.
 *
 * `REQUESTED` below is the `question.requested` payload an OpenClaw box
 * (core tag v2026.9.3) broadcast for a real `ask_user` turn, byte for byte
 * except for the ids, which are replaced with fixed ones. `RESOLVED` is the
 * `question.resolved` event that followed, and `RESOLVE_RESULT` is what
 * `question.resolve` itself answered. Everything asserted here is the
 * harness's shape, not this module's idea of it — which is the whole point:
 * a fixture written from the implementation agrees with the implementation and
 * with nothing else.
 *
 * Two shapes in the capture are worth naming, because getting either wrong is
 * silent: `question.requested` carries the RECORD ITSELF, not an envelope
 * around it the way `session.approval` does; and `multiSelect`, `isSecret` and
 * `runId` are simply ABSENT when they do not apply rather than present-and-false.
 */
const REQUESTED = {
  id: "ask_0000000000000000000000000000test",
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
      isOther: true,
    },
  ],
  agentId: "main",
  sessionKey: "agent:main:clawbox-probe",
  runId: "probe-1",
  createdAtMs: 1_789_648_635_922,
  expiresAtMs: 1_789_649_535_922,
  status: "pending",
};

const RESOLVED = {
  id: "ask_0000000000000000000000000000test",
  status: "answered",
  answers: { answers: { colour: ["Amber (Recommended)"] } },
};

const RESOLVE_RESULT = {
  status: "answered",
  answers: { answers: { colour: ["Amber (Recommended)"] } },
};

const BOUND = "agent:main:clawbox-probe";

function card(): QuestionCard {
  const read = readQuestionRecord(REQUESTED);
  if (!read) throw new Error("the captured record must read");
  return read;
}

describe("readQuestionRecord", () => {
  it("reads the captured question.requested payload as the record itself", () => {
    expect(card()).toEqual({
      id: "ask_0000000000000000000000000000test",
      sessionKey: "agent:main:clawbox-probe",
      runId: "probe-1",
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
          // Absent in the frame; the card needs a definite answer to both.
          multiSelect: false,
          isSecret: false,
          isOther: true,
        },
      ],
      createdAtMs: 1_789_648_635_922,
      expiresAtMs: 1_789_649_535_922,
      status: "pending",
    });
  });

  it("refuses a record it cannot put a complete card behind", () => {
    expect(readQuestionRecord(null)).toBeNull();
    expect(readQuestionRecord({ ...REQUESTED, questions: [] })).toBeNull();
    expect(readQuestionRecord({ ...REQUESTED, status: "unknown" })).toBeNull();
    // A question with no id could be shown but never answered: `question.resolve`
    // keys the answers by it, so a card behind it is a control that cannot work.
    expect(
      readQuestionRecord({ ...REQUESTED, questions: [{ ...REQUESTED.questions[0], questionId: "" }] }),
    ).toBeNull();
  });
});

describe("questionBelongsToSession", () => {
  it("adopts the bound session, in either spelling", () => {
    expect(questionBelongsToSession(card(), BOUND)).toBe(true);
    expect(questionBelongsToSession(card(), "AGENT:MAIN:CLAWBOX-PROBE")).toBe(true);
    expect(
      questionBelongsToSession({ ...card(), sessionKey: "main" }, "agent:main:main"),
    ).toBe(true);
  });

  it("does not adopt another conversation, or one with no session at all", () => {
    expect(questionBelongsToSession(card(), "agent:main:main")).toBe(false);
    expect(questionBelongsToSession({ ...card(), sessionKey: "" }, BOUND)).toBe(false);
  });
});

describe("resolve params", () => {
  it("sends answers in the shape the manager validates", () => {
    expect(questionResolveParams("q1", { colour: ["Teal"] })).toEqual({
      id: "q1",
      answers: { answers: { colour: ["Teal"] } },
    });
  });

  it("sends a Skip as cancel, which is the protocol's only skip", () => {
    // An empty answer is NOT a skip: the gateway's own validateAnswers refuses
    // a question with no value ("requires an answer"), so a skip built that way
    // comes back as an error with the agent still parked.
    expect(questionSkipParams("q1")).toEqual({ id: "q1", cancel: true });
  });
});

describe("outcomes", () => {
  it("closes the card on the resolved event, keeping what was recorded", () => {
    const after = questionsAfterResolvedEvent([card()], RESOLVED);
    expect(after[0].status).toBe("answered");
    expect(after[0].answers).toEqual({ colour: ["Amber (Recommended)"] });
  });

  it("ignores a resolved event for a question this surface never drew", () => {
    const cards = [card()];
    expect(questionsAfterResolvedEvent(cards, { id: "other", status: "expired" })).toEqual(cards);
  });

  it("folds the gateway's own resolve result back in", () => {
    const busy = markQuestionBusy([card()], card().id, "submit");
    expect(busy[0].busy).toBe("submit");
    const after = questionsAfterResolve(busy, card().id, RESOLVE_RESULT);
    expect(after[0].status).toBe("answered");
    expect(after[0].busy).toBeUndefined();
  });

  it("keeps the card open when the answer did not reach the gateway", () => {
    const after = questionsAfterResolve([card()], card().id, new Error("Not connected"));
    expect(after[0].status).toBe("pending");
    expect(after[0].error).toBe("Not connected");
  });

  it("keeps the card open when the gateway recorded no outcome it could read", () => {
    const after = questionsAfterResolve([card()], card().id, { applied: true });
    expect(after[0].status).toBe("pending");
    expect(after[0].error).toBe(QUESTION_NO_OUTCOME_RECORDED);
  });
});

describe("questionsAfterList", () => {
  it("is authoritative: a pending card the list does not mention is gone", () => {
    const stale: QuestionCard = { ...card(), id: "ask_stale" };
    const after = questionsAfterList([stale], { questions: [REQUESTED] }, BOUND);
    expect(after.map((entry) => entry.id)).toEqual([card().id]);
  });

  it("keeps terminal cards — they are the record of what happened", () => {
    const settled: QuestionCard = { ...card(), id: "ask_done", status: "cancelled" };
    const after = questionsAfterList([settled], { questions: [REQUESTED] }, BOUND);
    expect(after.map((entry) => entry.id)).toEqual(["ask_done", card().id]);
  });

  it("keeps a question raised while the list was in flight", () => {
    // The answer describes the gateway at the moment it READ the list. A
    // `question.requested` that landed after we asked cannot be in it, and
    // dropping it would be the same silent disappearance this feature ends.
    const fresh: QuestionCard = { ...card(), id: "ask_fresh", createdAtMs: 2_000 };
    const after = questionsAfterList([fresh], { questions: [] }, BOUND, 1_000);
    expect(after.map((entry) => entry.id)).toEqual(["ask_fresh"]);
    // One raised BEFORE we asked and absent from the answer is genuinely gone.
    const older: QuestionCard = { ...card(), id: "ask_older", createdAtMs: 500 };
    expect(questionsAfterList([older], { questions: [] }, BOUND, 1_000)).toEqual([]);
  });

  it("drops rows belonging to another conversation", () => {
    const after = questionsAfterList([], { questions: [REQUESTED] }, "agent:main:main");
    expect(after).toEqual([]);
  });
});

describe("mergeQuestionCard", () => {
  it("replaces by id and keeps a press still in flight", () => {
    const busy = markQuestionBusy([card()], card().id, "submit");
    const merged = mergeQuestionCard(busy, card());
    expect(merged).toHaveLength(1);
    expect(merged[0].busy).toBe("submit");
  });
});

describe("questionIsActionable", () => {
  it("stops offering controls once the window has closed", () => {
    expect(questionIsActionable(card(), 1_789_648_700_000)).toBe(true);
    expect(questionIsActionable(card(), 1_789_649_535_923)).toBe(false);
    expect(questionIsActionable({ ...card(), status: "answered" }, 1_789_648_700_000)).toBe(false);
  });
});
