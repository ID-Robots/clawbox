import { useCallback, useId, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { plainTextForLabel } from "@/lib/chat-markdown";
import {
  buildQuestionAnswers,
  describeQuestionAnswer,
  questionIsActionable,
  QUESTION_NO_OUTCOME_RECORDED,
  type AskUserQuestion,
  type QuestionCard,
} from "@/lib/gateway-questions";

// ── The agent's `ask_user` question, as a control ───────────────────────────
//
// The reading and the state machine are `gateway-questions.ts`; this is the
// face. Shaped after `chat-clarify.tsx` and `chat-approvals.tsx` deliberately:
// all three are "the agent has STOPPED and is waiting for the person at the
// box", and three different-looking cards for the same situation would be
// three things for the owner to learn instead of one.
//
// WHAT IT ADDS OVER THE CLARIFY CARD, and why it is not that component with a
// flag on it:
//
//   * an option carries a DESCRIPTION. `ask_user` options are
//     `{label, description?}`, and the description is where the model puts the
//     consequence of the choice — "Rebuilds the index, about 20 minutes". A
//     pill that showed only the label would drop the half the owner decides on.
//   * ONE Send for the whole request. The gateway refuses a `question.resolve`
//     that leaves any question unanswered, so a per-question submit — the
//     clarify card's whole shape, and right there — could only ever be refused
//     here. See the header note in gateway-questions.ts.
//   * therefore NO skip. An empty answer is not a value `validateAnswers`
//     accepts; the way out of a question the owner will not answer is to leave
//     it, and the agent's own timeout carries on.
//
// WHY THE CONTROLS ARE REAL ELEMENTS. Options are `<button role="radio">` for
// a single-select question and real `<input type="checkbox">` with a real
// `<label>` for a multi-select one, never a span with an onClick — the same
// rule the clarify card follows, and for the same reason: somebody answering
// from the keyboard has to be able to reach the answer. Nothing here takes
// focus either; a card that grabbed the caret would yank it out of the
// composer the owner is already typing in.
//
// The draft (what is picked, what is typed) lives HERE, per card, because it
// belongs to the prompt that is collecting it — lifting it into the transcript
// would mean a re-render of the message list could reshuffle a half-filled
// form.

/** Amber, the palette this chat already uses for "the box is waiting". */
const CARD_BG = "rgba(249,115,22,0.10)";
const CARD_BORDER = "1px solid rgba(249,115,22,0.28)";
const TITLE_FG = "#fed7aa";
const BODY_FG = "rgba(255,255,255,0.72)";
const MUTED_FG = "rgba(255,255,255,0.5)";
const CHOICE_BG = "rgba(255,255,255,0.06)";
const CHOICE_BORDER = "1px solid rgba(255,255,255,0.16)";
const PICKED_BG = "rgba(249,115,22,0.22)";
const PICKED_BORDER = "1px solid rgba(249,115,22,0.5)";
const INPUT_BG = "rgba(0,0,0,0.25)";
const ERROR_FG = "#f87171";

/** What the owner has picked and typed, per question id. */
type Draft = Record<string, { picked: string[]; typed: string }>;

const EMPTY_DRAFT = { picked: [] as string[], typed: "" };

/**
 * The values one question would post right now.
 *
 * Free text WINS for a single-select question — the owner typed instead of
 * picking, which is what the `isOther` box is for — and JOINS the ticks for a
 * multi-select one, where "these two plus something you did not offer" is a
 * sensible answer and the alternative is silently dropping what they typed.
 */
/**
 * What is held for one question — `Object.hasOwn` rather than a bare read.
 *
 * A qid is a name the model chose, and `constructor` is a legal one under the
 * gateway's own id rule, so `draft[qid]` on an untouched question would hand
 * back Object's own constructor instead of nothing.
 */
function draftFor(draft: Draft, qid: string) {
  return Object.hasOwn(draft, qid) ? draft[qid] : EMPTY_DRAFT;
}

function valuesFor(question: AskUserQuestion, draft: Draft): string[] {
  const entry = draftFor(draft, question.questionId);
  const typed = entry.typed.trim();
  if (question.multiSelect) return typed ? [...entry.picked, typed] : entry.picked;
  if (typed) return [typed];
  return entry.picked.slice(0, 1);
}

export interface AskUserPromptProps {
  card: QuestionCard;
  /** Now, passed in so the expiry check is the caller's clock and testable. */
  nowMs: number;
  /** Resolve through the gateway. One call per press; the caller marks it busy. */
  onAnswer: (card: QuestionCard, answers: Record<string, string[]>) => void | Promise<void>;
}

export function AskUserPrompt({ card, nowMs, onAnswer }: AskUserPromptProps) {
  const { t } = useT();
  // Stable per-card prefix so a three-question request gets three distinct
  // `<label htmlFor>` targets instead of three labels pointing at the first.
  const idPrefix = useId();
  const [draft, setDraft] = useState<Draft>({});

  const { questions, status, expiresAtMs, busy, error, answers } = card;
  const actionable = questionIsActionable(card, nowMs);
  // Pending but past its window is NOT "still waiting": `question.resolve`
  // would answer QUESTION_ALREADY_TERMINAL, so the card says what the gateway
  // would rather than offering a button that cannot work.
  const lapsed = status === "expired" || (status === "pending" && expiresAtMs <= nowMs);
  const settled = status !== "pending" || lapsed;

  const setPicked = useCallback((qid: string, picked: string[]) => {
    setDraft((prev) => ({ ...prev, [qid]: { ...draftFor(prev, qid), picked } }));
  }, []);

  const setTyped = useCallback((qid: string, typed: string) => {
    setDraft((prev) => ({ ...prev, [qid]: { ...draftFor(prev, qid), typed } }));
  }, []);

  const togglePick = useCallback(
    (question: AskUserQuestion, label: string) => {
      const entry = draftFor(draft, question.questionId);
      if (!question.multiSelect) {
        setPicked(question.questionId, entry.picked[0] === label ? [] : [label]);
        return;
      }
      // Ordered by the OPTION order rather than the click order, so the answer
      // reads the way the question asked it.
      const next = entry.picked.includes(label)
        ? entry.picked.filter((value) => value !== label)
        : question.options
          .map((option) => option.label)
          .filter((value) => value === label || entry.picked.includes(value));
      setPicked(question.questionId, next);
    },
    [draft, setPicked],
  );

  const ready = useMemo(
    () =>
      buildQuestionAnswers(
        questions,
        Object.fromEntries(questions.map((q) => [q.questionId, valuesFor(q, draft)])),
      ),
    [questions, draft],
  );

  const submit = useCallback(
    (answers: Record<string, string[]>) => {
      // The draft has left the building. Clearing it now means a refused
      // resolve hands back an EMPTY card rather than a pre-filled one the
      // owner might send twice without noticing.
      setDraft({});
      return onAnswer(card, answers);
    },
    [card, onAnswer],
  );

  /**
   * One click is the whole answer — but only for the one shape where it can be.
   *
   * A request with a single, single-select question has nothing else to
   * collect, so tapping an option IS the answer and a second press on Send
   * would be ceremony. Any other shape has to gather every question first,
   * because the gateway takes them in one call.
   */
  const oneClick = questions.length === 1 && !questions[0].multiSelect;

  if (questions.length === 0) return null;

  return (
    <div
      data-testid="chat-ask-user"
      data-question-id={card.id}
      data-question-status={lapsed && status === "pending" ? "expired" : status}
      style={{
        alignSelf: "flex-start",
        maxWidth: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 12,
        background: CARD_BG,
        border: CARD_BORDER,
        // Settled is a state to SEE. The card stays so a question the agent
        // asked never silently vanishes, and it is obviously no longer a
        // control.
        opacity: settled ? 0.6 : 1,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, color: TITLE_FG, fontSize: 12, fontWeight: 600 }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15 }}>
          help
        </span>
        <span>{t("chat.askUser.title")}</span>
      </div>

      {questions.map((question, index) => {
        const labelId = `${idPrefix}-q${index}`;
        const inputId = `${idPrefix}-a${index}`;
        const entry = draftFor(draft, question.questionId);
        // Markdown source must never become an accessible name — it is read
        // out character for character. See plainTextForLabel.
        const spoken = plainTextForLabel(question.question);
        const recorded = describeQuestionAnswer(
          answers && Object.hasOwn(answers, question.questionId) ? answers[question.questionId] : undefined,
        );

        return (
          <div
            key={question.questionId}
            data-testid="chat-ask-user-question"
            data-question-multi={question.multiSelect ? "true" : "false"}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            {question.header && (
              <span
                data-testid="chat-ask-user-header"
                style={{
                  alignSelf: "flex-start",
                  padding: "1px 7px",
                  borderRadius: 999,
                  background: "rgba(249,115,22,0.16)",
                  color: TITLE_FG,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.2,
                }}
              >
                {question.header}
              </span>
            )}
            <div id={labelId} style={{ color: BODY_FG, fontSize: 13, lineHeight: 1.4, wordBreak: "break-word" }}>
              {question.question}
            </div>

            {settled ? (
              <div
                data-testid="chat-ask-user-answered"
                style={{ color: MUTED_FG, fontSize: 12.5, wordBreak: "break-word" }}
              >
                {status === "answered"
                  // A recorded answer this could not read leaves the sentence
                  // with a dangling colon, so the ending that says only THAT
                  // it was answered is its own line rather than an empty
                  // interpolation.
                  ? (recorded
                    ? t("chat.askUser.answered", { answer: recorded })
                    : t("chat.askUser.answeredUnknown"))
                  : status === "cancelled"
                    ? t("chat.askUser.cancelled")
                    : t("chat.askUser.expired")}
              </div>
            ) : (
              <>
                {question.options.length > 0 && (
                  <div
                    // The offered answers are ONE control, not several loose
                    // ones: without the group a screen reader reads four
                    // unrelated buttons with no idea which question they
                    // belong to. Named by the question's own element, so the
                    // name cannot drift from what is on screen.
                    // A radiogroup only when the options are a CHOICE the
                    // card is still holding. On the one-click shape they are
                    // submits — the answer is gone the instant one is pressed
                    // and the card collapses — so a radio role would describe
                    // a control that no longer exists. Same rule the clarify
                    // card states for its own single-select choices.
                    role={question.multiSelect || oneClick ? "group" : "radiogroup"}
                    aria-labelledby={labelId}
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    {question.options.map((option, optionIndex) => {
                      // Keyed by POSITION, not by the label: the options come
                      // off the wire, and two options with one word between
                      // them would give two inputs one id.
                      const optionId = `${inputId}-o${optionIndex}`;
                      const picked = entry.picked.includes(option.label);
                      const body = (
                        <>
                          <span style={{ fontWeight: 500 }}>{option.label}</span>
                          {option.description && (
                            <span
                              data-testid="chat-ask-user-description"
                              style={{ display: "block", color: MUTED_FG, fontSize: 11.5, lineHeight: 1.35, marginTop: 2 }}
                            >
                              {option.description}
                            </span>
                          )}
                        </>
                      );
                      const shell = {
                        display: "block",
                        width: "100%",
                        textAlign: "left" as const,
                        padding: "6px 10px",
                        borderRadius: 10,
                        background: picked ? PICKED_BG : CHOICE_BG,
                        border: picked ? PICKED_BORDER : CHOICE_BORDER,
                        color: BODY_FG,
                        fontSize: 12.5,
                        fontFamily: "inherit",
                        cursor: actionable ? "pointer" : "default",
                        // The one rule that makes this readable on a phone: a
                        // long label wraps inside its own row instead of
                        // pushing the card wider than the panel.
                        wordBreak: "break-word" as const,
                      };
                      if (question.multiSelect) {
                        return (
                          <label
                            key={optionId}
                            htmlFor={optionId}
                            style={{ ...shell, display: "flex", alignItems: "flex-start", gap: 8 }}
                          >
                            <input
                              id={optionId}
                              data-testid="chat-ask-user-option"
                              data-option-label={option.label}
                              type="checkbox"
                              checked={picked}
                              // `aria-disabled`, never the native attribute: a
                              // disabled control leaves the tab order, so a
                              // keyboard user loses the card the moment a
                              // press is in flight. The handler refuses.
                              aria-disabled={!actionable}
                              onChange={() => {
                                if (!actionable) return;
                                togglePick(question, option.label);
                              }}
                              style={{ marginTop: 3 }}
                            />
                            <span style={{ minWidth: 0 }}>{body}</span>
                          </label>
                        );
                      }
                      return (
                        <button
                          key={optionId}
                          type="button"
                          data-testid="chat-ask-user-option"
                          data-option-label={option.label}
                          {...(oneClick ? {} : { role: "radio", "aria-checked": picked })}
                          aria-disabled={!actionable}
                          onClick={() => {
                            if (!actionable) return;
                            if (oneClick) {
                              void submit({ [question.questionId]: [option.label] });
                              return;
                            }
                            togglePick(question, option.label);
                          }}
                          style={shell}
                        >
                          {body}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Free text is offered beside the options, because an agent's
                    guess at the choices is a guess and an owner whose answer is
                    not on the list must not be pushed into a wrong one. Only
                    when the request says so (`isOther`, which `ask_user`
                    always sets) — a question that refuses free text would
                    otherwise get a box whose every answer the gateway rejects
                    as an unknown option. */}
                {question.isOther && (
                  <>
                    <label htmlFor={inputId} style={{ color: MUTED_FG, fontSize: 11.5 }}>
                      {t("chat.askUser.other")}
                    </label>
                    <input
                      id={inputId}
                      data-testid="chat-ask-user-text"
                      type="text"
                      value={entry.typed}
                      // Named with the question it answers: a three-question
                      // request draws three boxes that all read "Type your own
                      // answer here" to somebody listing controls rather than
                      // looking at the screen. The visible label's own words
                      // open the name, so a voice command that speaks what is
                      // on screen still matches it.
                      aria-label={t("chat.askUser.otherFor", { question: spoken })}
                      aria-disabled={!actionable}
                      onChange={(event) => setTyped(question.questionId, event.target.value)}
                      onKeyDown={(event) => {
                        // Enter sends, the way the composer's own textarea
                        // does — but only once the WHOLE request is ready,
                        // since one question's answer cannot be posted alone.
                        if (event.key !== "Enter" || !actionable || !ready) return;
                        event.preventDefault();
                        void submit(ready.answers);
                      }}
                      style={{
                        minWidth: 0,
                        padding: "5px 8px",
                        borderRadius: 8,
                        background: INPUT_BG,
                        border: CHOICE_BORDER,
                        color: BODY_FG,
                        fontSize: 12.5,
                        fontFamily: "inherit",
                      }}
                    />
                  </>
                )}
              </>
            )}
          </div>
        );
      })}

      {settled ? null : (
        <>
          {/* The one state that needs the owner to DO something is the one
              that arrives on its own — from the replay or from a
              `question.requested` push — so it is the one that has to
              announce itself. */}
          <div role="status" aria-live="polite" style={{ color: MUTED_FG, fontSize: 12, lineHeight: 1.4 }}>
            {t("chat.askUser.summary")}
          </div>
          {/* A one-click request answers on the option itself; Send is still
              drawn, because the free-text box needs a way out that is not the
              Enter key alone. */}
          <button
            type="button"
            data-testid="chat-ask-user-send"
            aria-disabled={!actionable || !ready}
            onClick={() => {
              if (!actionable || !ready) return;
              void submit(ready.answers);
            }}
            style={{
              alignSelf: "flex-start",
              padding: "5px 12px",
              borderRadius: 8,
              background: PICKED_BG,
              border: PICKED_BORDER,
              color: TITLE_FG,
              fontSize: 12.5,
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: actionable && ready ? "pointer" : "default",
              opacity: actionable && ready ? 1 : 0.5,
            }}
          >
            {busy ? t("chat.askUser.sending") : t("chat.askUser.send")}
          </button>
        </>
      )}

      {error && (
        // The gateway's OWN words beside the box's. It has permanent refusals
        // on this path — a question it no longer holds, a window that closed,
        // an answer it will not accept — and a fixed "try again" over one of
        // those is a false failure that invites a retry which can never work.
        <div
          data-testid="chat-ask-user-error"
          role="status"
          aria-live="polite"
          style={{ color: ERROR_FG, fontSize: 11.5, wordBreak: "break-word" }}
        >
          <div>{t("chat.askUser.failed")}</div>
          <div data-testid="chat-ask-user-error-reason" style={{ color: MUTED_FG, marginTop: 2 }}>
            {error === QUESTION_NO_OUTCOME_RECORDED ? t("chat.askUser.unreadable") : error}
          </div>
        </div>
      )}
    </div>
  );
}
