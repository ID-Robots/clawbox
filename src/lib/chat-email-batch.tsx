import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { accentFor } from "@/lib/edition-accent";

// ── One consent for everything the agent wants to post ───────────────────────
//
// WHAT THIS REPLACES. Sending from chat already worked: `email_send` queues a
// draft and the owner approved it, one at a time, in Settings → Email. Asked to
// mail eight people, the agent produced eight approvals — and a person clicking
// "approve" eight times in a row has stopped reading by the third. The gate was
// technically intact and practically gone.
//
// So the gesture is now ONE, and the reading is the thing that got bigger. This
// card lists every draft with its recipients, its subject and its BODY IN FULL,
// and asks once. That is not a nicety: it is the entire security mechanism.
// `email_send` arguments can originate in text the agent merely read — a web
// page, a file, an inbound message — and the only thing standing between an
// injected instruction and mail leaving in the owner's name is a human being
// reading what it says. A card that summarised ("send 8 emails?") would keep
// the click and throw the protection away, so there is deliberately no such
// mode, and no "approve everything queued" shortcut behind it.
//
// FROZEN AT DISPLAY. The drafts live in this card's own state from the moment
// it is drawn, and approving posts their ids AND their fingerprints — never
// "whatever is in the queue now". The agent keeps running while the owner
// reads, and a draft it queues during that pause is simply not in the list, so
// it cannot ride along. Same lesson as #492, where device state moved during
// exactly this kind of human-length pause.
//
// NOT PERSISTED, for the reason a clarify is not (see chat-clarify.tsx): it is
// a live control, not a record. Unlike a clarify, though, nothing is LOST when
// it goes — the drafts are on disk and Settings → Email still lists every one
// of them. Dismissing this card sends nothing and deletes nothing.

/** Amber, the palette this chat already uses for "the box is waiting". */
const CARD_BG = "rgba(249,115,22,0.10)";
const CARD_BORDER = "1px solid rgba(249,115,22,0.28)";
const TITLE_FG = "#fed7aa";
const BODY_FG = "rgba(255,255,255,0.72)";
const MUTED_FG = "rgba(255,255,255,0.5)";
const FIELD_BG = "rgba(0,0,0,0.25)";
const ROW_BORDER = "1px solid rgba(255,255,255,0.12)";
const ERROR_FG = "#f87171";
const OK_FG = "#86efac";

/**
 * How much of a body is shown before the card offers to open the rest.
 *
 * Generous on purpose. The clamp exists so one 20,000-character draft cannot
 * push the other seven off the screen — not to hide anything — so the toggle
 * says exactly how many characters are still folded away rather than a vague
 * "show more". Anything at or under this is rendered whole with no control at
 * all, which is the common case.
 */
export const BODY_CLAMP_CHARS = 600;

/** One draft, exactly as it was read off the queue when the card was drawn. */
export interface EmailBatchDraft {
  readonly id: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly createdAt: number;
  /** Names this draft's CONTENT — see draftFingerprint in email-pending.ts. */
  readonly fingerprint: string;
}

/** What became of one draft, as the route reported it. */
export interface EmailBatchOutcome {
  readonly id: string;
  readonly ok: boolean;
  /** Why not, when it did not go. Already customer-readable. */
  readonly error?: string;
}

export type EmailBatchStatus = "waiting" | "sending" | "settled" | "dismissed";

export interface EmailBatchCardState {
  readonly batchId: string;
  readonly drafts: readonly EmailBatchDraft[];
  readonly status: EmailBatchStatus;
  /** Per draft, once the send has been attempted. Empty until then. */
  readonly outcomes: readonly EmailBatchOutcome[];
  /** The request itself failed — nothing was attempted, or we cannot say what was. */
  readonly requestError: string;
}

/**
 * A card for drafts that are not already on screen in one.
 *
 * The filter is what makes a second turn's mail its own card instead of a
 * silent edit to the one the owner is part-way through reading. Returns null
 * when everything waiting is already shown, so the caller can append
 * unconditionally.
 */
export function batchFromPending(
  drafts: readonly EmailBatchDraft[],
  alreadyShown: ReadonlySet<string>,
): EmailBatchCardState | null {
  const fresh = drafts.filter((d) => !alreadyShown.has(d.id));
  if (fresh.length === 0) return null;
  return {
    // Derived from the drafts rather than random, so the same set re-read after
    // a failed post folds into the card already on screen instead of doubling
    // it.
    batchId: fresh.map((d) => d.id).join("|"),
    drafts: fresh,
    status: "waiting",
    outcomes: [],
    requestError: "",
  };
}

/** Every draft id any live card is showing — the input to `batchFromPending`. */
export function shownDraftIds(cards: readonly EmailBatchCardState[]): Set<string> {
  const ids = new Set<string>();
  for (const card of cards) for (const draft of card.drafts) ids.add(draft.id);
  return ids;
}

/** Replace one card by id, leaving the rest untouched. */
export function updateBatchCard(
  cards: readonly EmailBatchCardState[],
  batchId: string,
  change: Partial<EmailBatchCardState>,
): EmailBatchCardState[] {
  const index = cards.findIndex((card) => card.batchId === batchId);
  if (index === -1) return cards.slice();
  const next = cards.slice();
  next[index] = { ...next[index], ...change };
  return next;
}

export interface EmailBatchApproval {
  batchId: string;
  /** id + fingerprint for each draft still ticked, in the order they are shown. */
  entries: { id: string; fingerprint: string }[];
}

export interface EmailBatchCardProps {
  card: EmailBatchCardState;
  /** Hermes green, or OpenClaw coral. */
  hermes: boolean;
  /** Send the ticked drafts. One call per gesture, whatever N is. */
  onApprove: (approval: EmailBatchApproval) => void | Promise<void>;
  /** Send nothing. The drafts stay queued; Settings → Email still has them. */
  onCancel: (batchId: string) => void;
}

export function EmailBatchCard({ card, hermes, onApprove, onCancel }: EmailBatchCardProps) {
  const { t } = useT();
  const idPrefix = useId();
  const accent = accentFor(hermes);
  const { batchId, drafts, status, outcomes, requestError } = card;

  // Which drafts this send will include. Everything, until the owner unticks
  // one — the default has to be the set he was shown, or "Send all" would be a
  // lie about its own name.
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set<string>());
  const outcomeRef = useRef<HTMLDivElement | null>(null);

  const toggle = useCallback((id: string) => {
    setDropped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const included = useMemo(() => drafts.filter((d) => !dropped.has(d.id)), [drafts, dropped]);
  const outcomeById = useMemo(() => {
    const map = new Map<string, EmailBatchOutcome>();
    for (const outcome of outcomes) map.set(outcome.id, outcome);
    return map;
  }, [outcomes]);

  const sending = status === "sending";
  const settled = status === "settled";

  /**
   * Take the caret to the result once the buttons are gone.
   *
   * NOT on mount — this chat never steals focus, because a card that grabbed
   * the caret would yank it out of the composer someone is typing in (the same
   * rule chat-clarify follows). But approving REMOVES the control that was
   * focused, and focus falling to `document.body` leaves a keyboard user with
   * no idea whether eight emails just went out. So the one move made here is
   * the one the customer's own action forced.
   */
  useEffect(() => {
    if (!settled) return;
    outcomeRef.current?.focus();
  }, [settled]);

  const sentCount = outcomes.filter((o) => o.ok).length;
  const failedCount = outcomes.length - sentCount;
  const canSend = !sending && included.length > 0;

  if (status === "dismissed" || drafts.length === 0) return null;

  return (
    <section
      data-testid="chat-email-batch"
      data-batch-id={batchId}
      // A landmark with a name, because this is a block of text a screen-reader
      // user has to be able to find again after wandering into it — and the
      // name is the card's own heading rather than a duplicated string.
      aria-labelledby={`${idPrefix}-title`}
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
      }}
    >
      <h3
        id={`${idPrefix}-title`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: TITLE_FG,
          fontSize: 12,
          fontWeight: 600,
          margin: 0,
        }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15 }}>
          outgoing_mail
        </span>
        <span>{t("chat.emailBatch.title")}</span>
      </h3>

      {/* Announced, and polite: it arrives while the customer may be reading
          the reply above it, and an assertive region would talk over them. */}
      <div
        data-testid="chat-email-batch-summary"
        role="status"
        aria-live="polite"
        style={{ color: BODY_FG, fontSize: 12.5, lineHeight: 1.45 }}
      >
        {drafts.length === 1
          ? t("chat.emailBatch.summaryOne")
          : t("chat.emailBatch.summaryMany", { count: String(drafts.length) })}
      </div>

      <ul
        data-testid="chat-email-batch-list"
        style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}
      >
        {drafts.map((draft, index) => (
          <EmailBatchRow
            key={draft.id}
            draft={draft}
            index={index}
            idPrefix={idPrefix}
            included={!dropped.has(draft.id)}
            locked={sending || settled}
            outcome={outcomeById.get(draft.id)}
            accentSolid={accent.solid}
            onToggle={toggle}
            t={t}
          />
        ))}
      </ul>

      {!settled && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            data-testid="chat-email-batch-approve"
            disabled={!canSend}
            aria-disabled={!canSend}
            onClick={() =>
              void onApprove({
                batchId,
                // Read off the FROZEN card state, never re-fetched: this is the
                // client half of the guarantee that what was read is what goes.
                entries: included.map((d) => ({ id: d.id, fingerprint: d.fingerprint })),
              })
            }
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              background: accent.gradient,
              border: "none",
              color: accent.on,
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: "inherit",
              boxShadow: canSend ? accent.glow : "none",
              cursor: canSend ? "pointer" : "default",
              opacity: canSend ? 1 : 0.55,
            }}
          >
            {sending
              ? t("chat.emailBatch.sending")
              : included.length === 1
                ? t("chat.emailBatch.sendOne")
                : t("chat.emailBatch.sendAll", { count: String(included.length) })}
          </button>
          <button
            type="button"
            data-testid="chat-email-batch-cancel"
            disabled={sending}
            aria-disabled={sending}
            onClick={() => onCancel(batchId)}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              background: "none",
              border: "1px solid rgba(255,255,255,0.18)",
              color: MUTED_FG,
              fontSize: 12.5,
              fontFamily: "inherit",
              cursor: sending ? "default" : "pointer",
            }}
          >
            {t("chat.emailBatch.cancel")}
          </button>
          {included.length === 0 && (
            <span data-testid="chat-email-batch-none" style={{ color: MUTED_FG, fontSize: 11.5 }}>
              {t("chat.emailBatch.noneSelected")}
            </span>
          )}
        </div>
      )}

      {/* The verdict, and it counts BOTH ways on purpose. "Sent" with a number
          that quietly excludes two failures is the same false success this
          codebase has already shipped once, as `{ restarted: true }` for a
          restart that did not happen. Six of eight says six of eight. */}
      {settled && (
        <div
          ref={outcomeRef}
          data-testid="chat-email-batch-result"
          role="status"
          aria-live="polite"
          // Focusable only as a destination, never in the tab order: the card
          // has finished being a control and must not add a stop to the tab
          // path through the transcript.
          tabIndex={-1}
          style={{ color: failedCount > 0 ? ERROR_FG : OK_FG, fontSize: 12, outline: "none" }}
        >
          {failedCount === 0
            ? t("chat.emailBatch.resultAllSent", { count: String(sentCount) })
            : t("chat.emailBatch.resultPartial", { sent: String(sentCount), failed: String(failedCount) })}
        </div>
      )}

      {requestError && (
        <div
          data-testid="chat-email-batch-error"
          role="status"
          aria-live="polite"
          style={{ color: ERROR_FG, fontSize: 11.5 }}
        >
          {requestError}
        </div>
      )}
    </section>
  );
}

interface EmailBatchRowProps {
  draft: EmailBatchDraft;
  index: number;
  idPrefix: string;
  included: boolean;
  locked: boolean;
  outcome?: EmailBatchOutcome;
  accentSolid: string;
  onToggle: (id: string) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}

function EmailBatchRow({
  draft,
  index,
  idPrefix,
  included,
  locked,
  outcome,
  accentSolid,
  onToggle,
  t,
}: EmailBatchRowProps) {
  const [expanded, setExpanded] = useState(false);
  const checkId = `${idPrefix}-inc${index}`;
  const bodyId = `${idPrefix}-body${index}`;
  const long = draft.body.length > BODY_CLAMP_CHARS;
  const shown = long && !expanded ? draft.body.slice(0, BODY_CLAMP_CHARS) : draft.body;
  const hidden = draft.body.length - BODY_CLAMP_CHARS;
  const recipients = draft.to.join(", ");

  return (
    <li
      data-testid="chat-email-batch-draft"
      data-draft-id={draft.id}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 10px",
        borderRadius: 10,
        border: ROW_BORDER,
        background: FIELD_BG,
        opacity: included ? 1 : 0.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        {/* A real checkbox with a real label. Unticking is how one draft is
            dropped from the batch, and it is still ONE approval afterwards —
            the count on the button changes, the number of gestures does not. */}
        <input
          id={checkId}
          data-testid="chat-email-batch-include"
          type="checkbox"
          checked={included}
          disabled={locked}
          aria-disabled={locked}
          onChange={() => onToggle(draft.id)}
          style={{ marginTop: 2, accentColor: accentSolid }}
        />
        <label htmlFor={checkId} style={{ flex: 1, minWidth: 0, cursor: locked ? "default" : "pointer" }}>
          <span style={{ display: "block", color: MUTED_FG, fontSize: 11.5, wordBreak: "break-word" }}>
            {t("chat.emailBatch.to", { recipients })}
          </span>
          <span
            style={{ display: "block", color: BODY_FG, fontSize: 12.5, fontWeight: 600, wordBreak: "break-word" }}
          >
            {draft.subject}
          </span>
        </label>
      </div>

      {/* Shown as written, never rendered as markdown: this is text an agent
          composed, which on a bad day is text an attacker composed, and the
          owner has to read the characters that will actually be sent. */}
      <div
        id={bodyId}
        data-testid="chat-email-batch-body"
        style={{
          color: BODY_FG,
          fontSize: 12,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: expanded ? "none" : 220,
          overflowY: expanded ? "visible" : "auto",
        }}
      >
        {shown}
      </div>

      {long && (
        <button
          type="button"
          data-testid="chat-email-batch-expand"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
          style={{
            alignSelf: "flex-start",
            padding: 0,
            border: "none",
            background: "none",
            color: MUTED_FG,
            fontSize: 11.5,
            fontFamily: "inherit",
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          {/* The count is deliberately exact. "Show more" hides how much is
              hidden, and how much is hidden is the thing worth knowing when
              what you are checking for is a paragraph you did not write. */}
          {expanded ? t("chat.emailBatch.showLess") : t("chat.emailBatch.showFull", { count: String(hidden) })}
        </button>
      )}

      {outcome && (
        <div
          data-testid="chat-email-batch-outcome"
          style={{ color: outcome.ok ? OK_FG : ERROR_FG, fontSize: 11.5, wordBreak: "break-word" }}
        >
          {outcome.ok
            ? t("chat.emailBatch.draftSent")
            : t("chat.emailBatch.draftFailed", { reason: outcome.error || "" })}
        </div>
      )}
    </li>
  );
}
