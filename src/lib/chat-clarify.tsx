import { useCallback, useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { plainTextForLabel } from "@/lib/chat-markdown";
import type { ClarifyQuestion } from "@/lib/harness/transport";

// ── The agent asking the customer a question, mid-turn ───────────────────────
//
// WHAT THIS REPLACES. A Hermes agent that needed a decision emitted a clarify
// frame, the surface dropped it, and the turn then died on its 180s deadline
// while the agent sat parked for an hour waiting for an answer nothing could
// send. From the customer's side that is a chat that stopped mid-sentence for
// no reason. This is the control that answers it.
//
// WHY IT IS NOT A MESSAGE. Everything else in this transcript is a record: it
// is written into `ChatMessage`, cached, and replayed after a refresh. A
// clarify is the opposite — it is live for exactly as long as the agent is
// parked, and an answer posted to an expired request reaches nothing. So it is
// rendered beside the in-flight turn and deliberately not persisted; see the
// comment at its render site in ChatPopup.
//
// WHY THE CONTROLS ARE REAL ELEMENTS. Choices are `<button>`s and multi-select
// choices are real `<input type="checkbox">` with a real `<label>`, never a
// span with an onClick — the same rule the image preview follows in ChatPopup,
// and for the same reason: a customer answering from the keyboard has to be
// able to reach the answer. Nothing here takes focus, either: this chat has no
// focus trap anywhere, and a card that grabbed the caret would yank it out of
// the composer the customer is already typing in.
//
// State (what is typed, what is ticked) lives HERE, per card, for the reason
// ReasoningDisclosure keeps its own `open`: a draft belongs to the prompt that
// is collecting it, and lifting it into the transcript would mean a re-render
// of the message list could reshuffle a half-filled form.

/** Amber, the palette this chat already uses for "the box is waiting". */
const CARD_BG = "rgba(249,115,22,0.10)";
const CARD_BORDER = "1px solid rgba(249,115,22,0.28)";
const QUESTION_FG = "#fed7aa";
const BODY_FG = "rgba(255,255,255,0.72)";
const MUTED_FG = "rgba(255,255,255,0.5)";
const CHOICE_BG = "rgba(255,255,255,0.06)";
const CHOICE_BORDER = "1px solid rgba(255,255,255,0.16)";
const INPUT_BG = "rgba(0,0,0,0.25)";
const ERROR_FG = "#f87171";

/**
 * One live clarify, as the surface holds it.
 *
 * Kept beside the renderer rather than with ChatPopup's other state because
 * every field exists to answer a rendering question: is this question still
 * askable (`answered`), is the whole card dead (`expired`), and did the last
 * post fail (`failed`).
 */
export interface ClarifyCardState {
  readonly requestId: string;
  readonly questions: ClarifyQuestion[];
  /** qid → the answer already locked in. A batch fills in one key at a time. */
  readonly answered: Record<string, string>;
  /** The agent stopped waiting; nothing posted now can reach the turn. */
  readonly expired: boolean;
  /** The last answer could not be delivered — the control comes back. */
  readonly failed: boolean;
}

/**
 * Add a clarify, or fold a REPLAY into the one already on screen.
 *
 * The de-duplication rule lives here rather than inline at the call site
 * because it is the whole correctness of a reconnect: the gateway replays the
 * prompt it is still parked on, and a surface that appended it would show the
 * customer two identical cards, one of which is answerable and one of which is
 * a ghost. `requestId` is the identity — a replay carries the same one.
 *
 * A replay's `answered` is merged ON TOP of what is already known rather than
 * replacing it, because the local card may hold an answer that is still in
 * flight and therefore not yet in the server's map. Losing it would put a
 * question the customer has already answered back in front of them.
 */
export function upsertClarifyCard(
  cards: ClarifyCardState[],
  incoming: { requestId: string; questions: ClarifyQuestion[]; answered?: Record<string, string> },
): ClarifyCardState[] {
  const index = cards.findIndex((card) => card.requestId === incoming.requestId);
  if (index === -1) {
    return [
      ...cards,
      {
        requestId: incoming.requestId,
        questions: incoming.questions,
        answered: { ...(incoming.answered ?? {}) },
        expired: false,
        failed: false,
      },
    ];
  }
  const next = cards.slice();
  next[index] = {
    ...next[index],
    questions: incoming.questions,
    answered: { ...next[index].answered, ...(incoming.answered ?? {}) },
  };
  return next;
}

/** Mark one card dead, leaving it on screen. Returns `cards` when nothing matched. */
export function expireClarifyCard(cards: ClarifyCardState[], requestId: string): ClarifyCardState[] {
  const index = cards.findIndex((card) => card.requestId === requestId);
  if (index === -1 || cards[index].expired) return cards;
  const next = cards.slice();
  next[index] = { ...next[index], expired: true };
  return next;
}

/**
 * The answer a multi-select question posts.
 *
 * A JSON array string, which is the shape the answer route parses — a
 * comma-joined string would be indistinguishable from one choice whose label
 * happens to contain a comma.
 */
export function encodeMultiSelectAnswer(values: string[]): string {
  return JSON.stringify(values);
}

/**
 * A locked answer, as a person reads it.
 *
 * A multi-select answer is on the wire as JSON and must never be shown that
 * way; anything that is not a JSON array is already prose and is shown as
 * written. An empty answer is the deliberate skip, which has its own word.
 */
export function describeClarifyAnswer(answer: string, skippedLabel: string): string {
  if (!answer) return skippedLabel;
  if (!answer.startsWith("[")) return answer;
  try {
    const parsed: unknown = JSON.parse(answer);
    if (Array.isArray(parsed)) {
      const values = parsed.filter((value): value is string => typeof value === "string");
      return values.length > 0 ? values.join(", ") : skippedLabel;
    }
  } catch {
    // Not JSON after all — free text that happens to open with a bracket.
  }
  return answer;
}

export interface ClarifyPromptProps {
  card: ClarifyCardState;
  /**
   * Deliver one answer. `qid` is empty for a single clarify, which is what
   * tells the caller to omit `questionId` — see ClarifyQuestion in transport.
   * An empty `answer` is a skip, and counts as answered.
   */
  onAnswer: (requestId: string, qid: string, answer: string) => void;
}

export function ClarifyPrompt({ card, onAnswer }: ClarifyPromptProps) {
  // The hook rather than a dozen label props: ReasoningDisclosure takes its one
  // string from the caller, but this card has twelve, and threading them all
  // through ChatPopup's render would put the translation table's shape into a
  // component that has no other reason to know it. `useT` needs no provider of
  // its own — with none above it, it falls back to the key.
  const { t } = useT();
  // Stable per-card prefix so a batch's three "type an answer" inputs each get
  // their own `<label htmlFor>` instead of three labels pointing at the first.
  const idPrefix = useId();
  // What the customer has typed but not yet sent, per qid.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // What is ticked but not yet sent, per qid. Ordered by the CHOICE order
  // rather than the click order, so the answer reads the way the question asked.
  const [ticked, setTicked] = useState<Record<string, string[]>>({});

  const setDraft = useCallback((qid: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [qid]: value }));
  }, []);

  const toggleTick = useCallback((qid: string, choice: string, choices: string[]) => {
    setTicked((prev) => {
      const current = prev[qid] ?? [];
      const next = current.includes(choice)
        ? current.filter((value) => value !== choice)
        : choices.filter((value) => value === choice || current.includes(value));
      return { ...prev, [qid]: next };
    });
  }, []);

  const { requestId, questions, answered, expired, failed } = card;

  /**
   * What one question would post right now, or null when it has nothing to say.
   *
   * Free text WINS for a single-select question — the customer typed instead of
   * picking — and JOINS the ticks for a multi-select one, where "these two plus
   * something you did not offer" is a sensible answer and the alternative is
   * silently dropping what they typed.
   */
  const draftAnswerFor = useCallback(
    (question: ClarifyQuestion): string | null => {
      const typed = (drafts[question.qid] ?? "").trim();
      if (question.multiSelect) {
        const picked = ticked[question.qid] ?? [];
        const values = typed ? [...picked, typed] : picked;
        return values.length > 0 ? encodeMultiSelectAnswer(values) : null;
      }
      return typed ? typed : null;
    },
    [drafts, ticked],
  );

  const submit = useCallback(
    (qid: string, answer: string) => {
      onAnswer(requestId, qid, answer);
      // The draft has left the building. Clearing it now means a failed post
      // hands back an EMPTY control rather than a pre-filled one the customer
      // might send twice without noticing.
      setDrafts((prev) => ({ ...prev, [qid]: "" }));
      setTicked((prev) => ({ ...prev, [qid]: [] }));
    },
    [onAnswer, requestId],
  );

  const isBatch = questions.length > 1;
  const outstanding = questions.filter((question) => !(question.qid in answered));

  /**
   * Send every question that is still open, in one gesture.
   *
   * A question the customer never touched goes as an empty answer — the
   * documented SKIP — because that is what "continue" has to mean here: the
   * agent unblocks only once EVERY qid has been answered, so a button that left
   * the untouched ones outstanding would say "continue" and continue nothing.
   * Only offered for a batch; a single question already has its own submit and
   * its own skip, and a third control saying the same thing is noise.
   */
  const confirmAll = useCallback(() => {
    for (const question of outstanding) submit(question.qid, draftAnswerFor(question) ?? "");
  }, [outstanding, submit, draftAnswerFor]);

  if (questions.length === 0) return null;

  return (
    <div
      data-testid="chat-clarify"
      data-request-id={requestId}
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
        // Expired is a state to SEE, not only to be told about: the card stays
        // on screen so a question never silently vanishes, and it has to be
        // obvious at a glance that it is no longer a control.
        opacity: expired ? 0.55 : 1,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, color: QUESTION_FG, fontSize: 12, fontWeight: 600 }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15 }}>
          help
        </span>
        <span>{t("chat.clarify.title")}</span>
      </div>

      {questions.map((question, index) => {
        const labelId = `${idPrefix}-q${index}`;
        const inputId = `${idPrefix}-a${index}`;
        const locked = question.qid in answered;
        // Markdown source must never become an accessible name — it is read out
        // character for character. See plainTextForLabel.
        const spoken = plainTextForLabel(question.question);
        const draft = draftAnswerFor(question);
        const submitDisabled = expired || draft === null;

        return (
          <div
            key={question.qid || `single-${index}`}
            data-testid="chat-clarify-question"
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <div id={labelId} style={{ color: BODY_FG, fontSize: 13, lineHeight: 1.4, wordBreak: "break-word" }}>
              {question.question}
            </div>

            {locked ? (
              // A locked question collapses to what was chosen. The gateway
              // would happily accept a second answer for the same qid, which is
              // exactly why the control is taken away: two answers to one
              // question is a confusion the customer cannot see and the agent
              // cannot resolve.
              <div data-testid="chat-clarify-answered" style={{ color: MUTED_FG, fontSize: 12.5, wordBreak: "break-word" }}>
                {t("chat.clarify.answered", {
                  answer: describeClarifyAnswer(answered[question.qid], t("chat.clarify.skipped")),
                })}
              </div>
            ) : (
              <>
                {question.choices.length > 0 && (
                  <div
                    // The offered answers are ONE control, not several loose
                    // ones: without the group a screen reader reads three
                    // unrelated checkboxes with no idea which question they
                    // belong to. Named by the question's own element, so the
                    // name cannot drift from what is on screen.
                    role="group"
                    aria-labelledby={labelId}
                    style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
                  >
                    {question.multiSelect
                      ? question.choices.map((choice, choiceIndex) => {
                          // Keyed by POSITION, not by the label: the choices
                          // come off the wire and nothing stops an agent
                          // offering the same word twice, which would give two
                          // checkboxes one id and make the second label point
                          // at the first box.
                          const checkId = `${inputId}-c${choiceIndex}`;
                          return (
                            <label
                              key={checkId}
                              htmlFor={checkId}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "4px 10px",
                                borderRadius: 999,
                                background: CHOICE_BG,
                                border: CHOICE_BORDER,
                                color: BODY_FG,
                                fontSize: 12.5,
                                cursor: expired ? "default" : "pointer",
                              }}
                            >
                              <input
                                id={checkId}
                                data-testid="chat-clarify-check"
                                type="checkbox"
                                checked={(ticked[question.qid] ?? []).includes(choice)}
                                disabled={expired}
                                aria-disabled={expired}
                                onChange={() => toggleTick(question.qid, choice, question.choices)}
                              />
                              <span>{choice}</span>
                            </label>
                          );
                        })
                      : question.choices.map((choice, choiceIndex) => (
                          // A real button, so it is in the tab order and both
                          // Enter and Space work. No `aria-pressed`: this is a
                          // submit, not a toggle — the answer is gone the
                          // instant it is clicked and the question collapses,
                          // so a pressed state would describe a control that no
                          // longer exists.
                          <button
                            key={`${inputId}-c${choiceIndex}`}
                            type="button"
                            data-testid="chat-clarify-choice"
                            disabled={expired}
                            aria-disabled={expired}
                            onClick={() => submit(question.qid, choice)}
                            style={{
                              padding: "4px 10px",
                              borderRadius: 999,
                              background: CHOICE_BG,
                              border: CHOICE_BORDER,
                              color: BODY_FG,
                              fontSize: 12.5,
                              fontFamily: "inherit",
                              cursor: expired ? "default" : "pointer",
                            }}
                          >
                            {choice}
                          </button>
                        ))}
                  </div>
                )}

                {/* Free text is offered even when choices are — an agent's
                    guess at the options is a guess, and a customer whose answer
                    is not on the list must not be pushed into a wrong one. */}
                <label htmlFor={inputId} style={{ color: MUTED_FG, fontSize: 11.5 }}>
                  {question.choices.length > 0 ? t("chat.clarify.other") : t("chat.clarify.chooseOption")}
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <input
                    id={inputId}
                    data-testid="chat-clarify-text"
                    type="text"
                    value={drafts[question.qid] ?? ""}
                    disabled={expired}
                    aria-disabled={expired}
                    onChange={(event) => setDraft(question.qid, event.target.value)}
                    onKeyDown={(event) => {
                      // Enter sends, the way the composer's own textarea does.
                      // Nothing is sent from an empty field: an empty answer is
                      // a deliberate skip with its own button, and arriving at
                      // it by a stray keystroke cannot be undone.
                      if (event.key !== "Enter" || expired) return;
                      const value = draftAnswerFor(question);
                      if (value === null) return;
                      event.preventDefault();
                      submit(question.qid, value);
                    }}
                    style={{
                      flex: "1 1 160px",
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
                  <button
                    type="button"
                    data-testid="chat-clarify-submit"
                    // Named with the question it answers: a batch renders three
                    // buttons that all read "Send answer" to someone listing
                    // controls rather than looking at the screen.
                    aria-label={t("chat.clarify.submitFor", { question: spoken })}
                    disabled={submitDisabled}
                    aria-disabled={submitDisabled}
                    onClick={() => draft !== null && submit(question.qid, draft)}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 8,
                      background: CHOICE_BG,
                      border: CHOICE_BORDER,
                      color: BODY_FG,
                      fontSize: 12.5,
                      fontFamily: "inherit",
                      cursor: submitDisabled ? "default" : "pointer",
                      opacity: submitDisabled ? 0.5 : 1,
                    }}
                  >
                    {t("chat.clarify.submit")}
                  </button>
                  <button
                    type="button"
                    data-testid="chat-clarify-skip"
                    aria-label={t("chat.clarify.skipFor", { question: spoken })}
                    disabled={expired}
                    aria-disabled={expired}
                    // An empty answer. Not a cancel — the question counts as
                    // ANSWERED and the agent stops waiting on it, which is the
                    // only way out of a batch the customer cannot answer.
                    onClick={() => submit(question.qid, "")}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 8,
                      background: "none",
                      border: "none",
                      color: MUTED_FG,
                      fontSize: 12,
                      fontFamily: "inherit",
                      textDecoration: "underline",
                      cursor: expired ? "default" : "pointer",
                    }}
                  >
                    {t("chat.clarify.skip")}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}

      {isBatch && !expired && outstanding.length > 0 && (
        <button
          type="button"
          data-testid="chat-clarify-confirm"
          onClick={confirmAll}
          style={{
            alignSelf: "flex-start",
            padding: "5px 12px",
            borderRadius: 8,
            background: "rgba(249,115,22,0.22)",
            border: "1px solid rgba(249,115,22,0.4)",
            color: QUESTION_FG,
            fontSize: 12.5,
            fontWeight: 500,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          {t("chat.clarify.confirm")}
        </button>
      )}

      {/* Polite, never assertive — the same rule the attachment-error and
          voice-status rows follow. This row sits among live controls, and an
          assertive region talks over whatever the customer is in the middle of
          reading or typing. */}
      {expired && (
        <div data-testid="chat-clarify-expired" role="status" aria-live="polite" style={{ color: MUTED_FG, fontSize: 11.5 }}>
          {t("chat.clarify.expired")}
        </div>
      )}
      {failed && !expired && (
        <div data-testid="chat-clarify-error" role="status" aria-live="polite" style={{ color: ERROR_FG, fontSize: 11.5 }}>
          {t("chat.clarify.sendFailed")}
        </div>
      )}
    </div>
  );
}
