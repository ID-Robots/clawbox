import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { plainTextForLabel } from "@/lib/chat-markdown";
import {
  BODY_FG,
  CARD_BG,
  CARD_BORDER,
  CHOICE_BG,
  CHOICE_BORDER,
  ERROR_FG,
  INPUT_BG,
  MUTED_FG,
  PRIMARY_BG,
  PRIMARY_BORDER,
  TITLE_FG,
} from "@/lib/chat-card-style";
import {
  QUESTION_NO_OUTCOME_RECORDED,
  questionIsActionable,
  type QuestionCard,
  type QuestionItem,
} from "@/lib/gateway-questions";

// ── The OpenClaw agent's question, as a card in this chat ────────────────────
//
// THE SHAPE IS OPENCLAW'S OWN, deliberately. This is the Control UI's docked
// question panel (`ui/src/pages/chat/components/chat-question-card.ts` in the
// pinned core) rendered in the mascot chat: a "Question" line with the step
// counter and a collapse chevron, the question itself, the offered answers as
// selectable rows carrying a title, a subtitle and their number, a free-text
// row when the record accepts one, and Back / Skip / Submit. A box whose chat
// asked the same question in a different shape from the UI on the owner's
// laptop would be a second thing to learn for no gain.
//
// IT IS THE SIBLING OF `ClarifyPrompt`, not a copy of it. Both are "the agent
// stopped and is waiting for you", and they share this chat's card palette
// (chat-card-style.ts) so they read as one idea — but the protocols underneath
// are genuinely different: a Hermes clarify answers one question at a time over
// an HTTP route, while a gateway question record is answered WHOLE, in one
// `question.resolve`, and steps through its questions first. Folding them into
// one component would mean a flag deciding which half of it is live.
//
// WHY THE CARD NEVER JUST DISAPPEARS. A resolved, skipped or expired question
// keeps its card and says which. The failure this feature exists to end is a
// question nobody could answer; a card that vanished with no outcome would read
// as an answer that was sent.

/** How a resolved card reports one question, one line each. */
function terminalAnswer(
  card: QuestionCard,
  question: QuestionItem,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (card.status === "cancelled") return t("chat.question.skipped");
  if (card.status === "expired") return t("chat.question.expired");
  // A credential is never echoed, not even back to the person who typed it:
  // this card sits in a transcript that stays on screen.
  if (question.isSecret) return t("chat.question.answered");
  const answer = card.answers?.[question.questionId];
  return answer && answer.length > 0 ? answer.join(", ") : t("chat.question.answered");
}

export interface QuestionPromptProps {
  card: QuestionCard;
  /** Resolve with every question's values. One call per press. */
  onSubmit: (card: QuestionCard, answers: Record<string, string[]>) => void | Promise<void>;
  /** Resolve as the protocol's only skip — `question.resolve{cancel:true}`. */
  onSkip: (card: QuestionCard) => void | Promise<void>;
}

export function QuestionPrompt({ card, onSubmit, onSkip }: QuestionPromptProps) {
  const { t } = useT();
  // Stable per-card prefix: two cards on screen must not hand their inputs the
  // same id, or the second card's label points at the first card's box.
  const idPrefix = useId();
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  // The card's OWN clock. A question's window closes on its own — the gateway
  // refuses a late answer — so the controls have to stop offering themselves at
  // `expiresAtMs` without anything outside having to tick for them. One timer
  // per card, armed only while the card is still open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (card.status !== "pending") return;
    // Clamped rather than skipped when the window has already closed: a
    // REPLAYED record may arrive with an expiry in the past, and the clock this
    // card was mounted with would still say it is open.
    const wait = Math.max(0, card.expiresAtMs - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [card.status, card.expiresAtMs]);

  const questions = card.questions;
  const total = questions.length;
  // A record that shrank under a replay must not leave the stepper past its
  // end; the same guard covers an index left behind by a previous record.
  const step = Math.min(index, Math.max(0, total - 1));
  const question = questions[step];

  const valuesFor = useCallback(
    (item: QuestionItem): string[] => {
      const picked = selected[item.questionId] ?? [];
      // A secret keeps its spaces: a passphrase may legitimately end in one.
      const raw = typed[item.questionId] ?? "";
      const free = item.isSecret ? raw : raw.trim();
      return free ? [...picked, free] : picked;
    },
    [selected, typed],
  );

  const answersForAll = useCallback((): Record<string, string[]> => {
    return Object.fromEntries(questions.map((item) => [item.questionId, valuesFor(item)]));
  }, [questions, valuesFor]);

  const actionable = questionIsActionable(card, now);
  const disabled = !actionable;

  const toggleOption = useCallback(
    (item: QuestionItem, label: string) => {
      setSelected((prev) => {
        const current = prev[item.questionId] ?? [];
        if (item.multiSelect) {
          return {
            ...prev,
            [item.questionId]: current.includes(label)
              ? current.filter((value) => value !== label)
              : [...current, label],
          };
        }
        // Single-select re-click keeps the choice: a radio never deselects, and
        // a person who clicks the same row twice has not changed their mind.
        return { ...prev, [item.questionId]: [label] };
      });
      // Picking an option on a single-select question drops whatever was typed:
      // the gateway takes ONE value there, and sending both would be refused.
      if (!item.multiSelect) setTyped((prev) => ({ ...prev, [item.questionId]: "" }));
    },
    [],
  );

  const setFreeText = useCallback((item: QuestionItem, value: string) => {
    setTyped((prev) => ({ ...prev, [item.questionId]: value }));
    const meaningful = item.isSecret ? value : value.trim();
    if (!item.multiSelect && meaningful) {
      setSelected((prev) => ({ ...prev, [item.questionId]: [] }));
    }
  }, []);

  const submit = useCallback(() => {
    const answers = answersForAll();
    // Every question, or none: the gateway's `validateAnswers` refuses a record
    // with an unanswered question outright, so a partial submit would come back
    // as an error with the agent still parked.
    if (questions.some((item) => (answers[item.questionId] ?? []).length === 0)) return;
    void onSubmit(card, answers);
  }, [answersForAll, card, onSubmit, questions]);

  const advanceOrSubmit = useCallback(() => {
    if (!question || valuesFor(question).length === 0) return;
    if (step < total - 1) {
      setIndex(step + 1);
      return;
    }
    submit();
  }, [question, step, submit, total, valuesFor]);

  const spoken = useMemo(
    () => (question ? question.header || plainTextForLabel(question.question, 60) : ""),
    [question],
  );

  if (!question) return null;

  const progress = `${step + 1}/${total}`;
  const terminal = card.status !== "pending";
  const canAdvance = valuesFor(question).length > 0;
  const chosen = selected[question.questionId] ?? [];
  const draft = typed[question.questionId] ?? "";
  const freeChosen = Boolean(question.isSecret ? draft : draft.trim());
  const optionsId = `${idPrefix}-options-${step}`;
  const otherId = `${idPrefix}-other-${step}`;

  return (
    <div
      data-testid="chat-question"
      data-question-id={card.id}
      data-status={card.status}
      style={{
        alignSelf: "flex-start",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        borderRadius: 12,
        background: CARD_BG,
        border: CARD_BORDER,
        // Settled is a state to SEE: the card stays so the question never
        // silently vanishes, and it has to be obvious it is no longer a control.
        opacity: terminal ? 0.6 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          className="material-symbols-rounded"
          aria-hidden="true"
          style={{ fontSize: 15, color: TITLE_FG }}
        >
          help
        </span>
        <span style={{ color: TITLE_FG, fontSize: 12, fontWeight: 600 }}>
          {t("chat.question.title")}
        </span>
        {total > 1 && (
          <span data-testid="chat-question-progress" style={{ color: MUTED_FG, fontSize: 11.5 }}>
            {progress}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!terminal && (
          <button
            type="button"
            data-testid="chat-question-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("chat.question.expand") : t("chat.question.collapse")}
            onClick={() => setCollapsed((value) => !value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              background: "none",
              border: "none",
              padding: 0,
              color: MUTED_FG,
              cursor: "pointer",
            }}
          >
            <span
              className="material-symbols-rounded"
              aria-hidden="true"
              style={{
                fontSize: 18,
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 120ms ease",
              }}
            >
              expand_more
            </span>
          </button>
        )}
      </div>

      {terminal ? (
        <div data-testid="chat-question-summary" aria-label={t("chat.question.summaryLabel")}>
          {questions.map((item) => (
            <div
              key={item.questionId}
              style={{ color: MUTED_FG, fontSize: 12.5, wordBreak: "break-word" }}
            >
              {item.header ? `${item.header}: ` : ""}
              {terminalAnswer(card, item, t)}
            </div>
          ))}
        </div>
      ) : collapsed ? (
        // Collapsed still says WHAT is waiting. A bar that read only "Question"
        // would hide the one thing the owner needs to decide whether to open it.
        <div style={{ color: BODY_FG, fontSize: 12.5, wordBreak: "break-word" }}>{spoken}</div>
      ) : (
        <>
          <div
            id={optionsId}
            style={{ color: BODY_FG, fontSize: 13.5, lineHeight: 1.4, wordBreak: "break-word" }}
          >
            {question.question}
          </div>

          {question.options.length > 0 && (
            <div
              // ONE control, not several loose ones: without the group a screen
              // reader reads unrelated radios with no idea what they answer.
              role={question.multiSelect ? "group" : "radiogroup"}
              aria-labelledby={optionsId}
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              {question.options.map((option, optionIndex) => {
                const isChosen = chosen.includes(option.label);
                return (
                  <button
                    // Keyed by POSITION: the labels come off the wire, and the
                    // gateway only rejects duplicates case-insensitively — two
                    // rows may still render the same word.
                    key={`${optionsId}-${optionIndex}`}
                    type="button"
                    data-testid="chat-question-option"
                    role={question.multiSelect ? "checkbox" : "radio"}
                    aria-checked={isChosen}
                    disabled={disabled}
                    aria-disabled={disabled}
                    onClick={() => toggleOption(question, option.label)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      textAlign: "left",
                      padding: "7px 10px",
                      borderRadius: 10,
                      background: isChosen ? PRIMARY_BG : CHOICE_BG,
                      border: isChosen ? PRIMARY_BORDER : CHOICE_BORDER,
                      color: BODY_FG,
                      fontFamily: "inherit",
                      cursor: disabled ? "default" : "pointer",
                    }}
                  >
                    <span aria-hidden="true" style={{ width: 12, color: TITLE_FG, fontSize: 12 }}>
                      {isChosen ? "✓" : ""}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>
                        {option.label}
                      </span>
                      {option.description && (
                        <span style={{ display: "block", fontSize: 11.5, color: MUTED_FG }}>
                          {option.description}
                        </span>
                      )}
                    </span>
                    <span aria-hidden="true" style={{ color: MUTED_FG, fontSize: 11 }}>
                      {optionIndex + 1}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* The free-text row, offered only when the gateway would ACCEPT one.
              `ask_user` always sets `isOther`, so it is normally here; a record
              that does not carry it would refuse anything typed, and a box that
              cannot work is worse than no box. A question with no options at
              all is free text by construction. */}
          {(question.isOther || question.options.length === 0) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 10px",
                borderRadius: 10,
                background: freeChosen ? PRIMARY_BG : INPUT_BG,
                border: freeChosen ? PRIMARY_BORDER : CHOICE_BORDER,
              }}
            >
              <input
                id={otherId}
                data-testid="chat-question-other"
                // A credential is typed, never displayed. The masked prompt is
                // the secrets tool's, and this is the one control that can meet
                // one; showing it as plain text would put it on a screen that
                // stays open in a transcript.
                type={question.isSecret ? "password" : "text"}
                autoComplete="off"
                value={draft}
                disabled={disabled}
                aria-disabled={disabled}
                aria-label={t("chat.question.ownAnswerFor", { header: spoken })}
                placeholder={
                  question.options.length > 0
                    ? t("chat.question.other")
                    : t("chat.question.answer")
                }
                onChange={(event) => setFreeText(question, event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends, the way the composer's own textarea does.
                  if (event.key !== "Enter" || disabled) return;
                  if (valuesFor(question).length === 0) return;
                  event.preventDefault();
                  advanceOrSubmit();
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: 0,
                  background: "none",
                  border: "none",
                  outline: "none",
                  color: BODY_FG,
                  fontSize: 12.5,
                  fontFamily: "inherit",
                }}
              />
              {question.options.length > 0 && (
                <span aria-hidden="true" style={{ color: MUTED_FG, fontSize: 11 }}>
                  {question.options.length + 1}
                </span>
              )}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {step > 0 && (
              <button
                type="button"
                data-testid="chat-question-back"
                disabled={disabled}
                aria-disabled={disabled}
                onClick={() => setIndex(step - 1)}
                style={SECONDARY_BUTTON_STYLE}
              >
                {t("chat.question.back")}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              data-testid="chat-question-skip"
              disabled={disabled}
              aria-disabled={disabled}
              onClick={() => void onSkip(card)}
              style={SECONDARY_BUTTON_STYLE}
            >
              {card.busy === "skip" ? t("chat.question.skipping") : t("chat.question.skip")}
            </button>
            <button
              type="button"
              data-testid="chat-question-submit"
              disabled={disabled || !canAdvance}
              aria-disabled={disabled || !canAdvance}
              onClick={advanceOrSubmit}
              style={{
                ...SECONDARY_BUTTON_STYLE,
                background: PRIMARY_BG,
                border: PRIMARY_BORDER,
                color: TITLE_FG,
                fontWeight: 500,
                opacity: disabled || !canAdvance ? 0.5 : 1,
              }}
            >
              {card.busy === "submit"
                ? t("chat.question.submitting")
                : step < total - 1
                  ? t("chat.question.next")
                  : t("chat.question.submit")}
            </button>
          </div>
        </>
      )}

      {/* Polite, never assertive: this row sits among live controls, and an
          assertive region talks over whatever is being read or typed. */}
      {card.error && (
        <div
          data-testid="chat-question-error"
          role="status"
          aria-live="polite"
          style={{ color: ERROR_FG, fontSize: 11.5 }}
        >
          {card.error === QUESTION_NO_OUTCOME_RECORDED
            ? t("chat.question.failed")
            : t("chat.question.submitFailed", { error: card.error })}
        </div>
      )}
    </div>
  );
}

const SECONDARY_BUTTON_STYLE = {
  padding: "5px 12px",
  borderRadius: 8,
  background: CHOICE_BG,
  border: CHOICE_BORDER,
  color: BODY_FG,
  fontSize: 12.5,
  fontFamily: "inherit",
  cursor: "pointer",
} as const;
