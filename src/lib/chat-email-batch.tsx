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
// a live control that becomes a record. What it is NOT is the authority on what
// is waiting — the queue is, and the card re-reads it (`reconcileBatchCards`):
// a draft decided in Settings, in another tab or on Telegram loses its checkbox
// here and says which ending it had, instead of keeping a live Approve button
// over mail that has already gone.
//
// DISMISSING DELETES. It used to drop the card and leave every draft queued,
// which read to the owner as "when I click dismiss nothing happens; it returns
// after 20 secs" — because the surface's next scheduled read found them still
// waiting and offered them again. A control whose only effect is to hide itself
// until the next poll is not a control, so the button now says what it does and
// the drafts really go.

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
 * Amber: "look at this", not "this went wrong".
 *
 * The one ending that is neither — a send the box handed over and never heard
 * back about. Settings → Email paints the same case the same way, so the two
 * surfaces do not disagree about how alarming it is.
 */
const WARN_FG = "#fcd34d";

/**
 * How much of a body is shown before the card offers to open the rest.
 *
 * Generous on purpose. The clamp exists so one 20,000-character draft cannot
 * push the other seven off the screen — not to hide anything — so the toggle
 * says exactly how many characters are still folded away rather than a vague
 * "show more". Anything at or under this is rendered whole with no control at
 * all, which is the common case.
 *
 * COUNTED IN CODE POINTS, not in UTF-16 units — see `bodyChars` below.
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
  /**
   * Whether this is what the GESTURE asked for — not whether the message went
   * out. It decides the COLOUR of the row and which side of the verdict it
   * counts on; `kind` alone decides the words.
   *
   * The two are not the same, and reading the ending alone gets both crossed
   * cases backwards. A draft the owner pressed *Delete without sending* on,
   * answered "sent" because Telegram approved it forty seconds earlier, is the
   * worst outcome available on that click — and `ok` from the ending painted it
   * green, the box congratulating him for the one thing he was preventing. The
   * mirror is just as wrong: an approve answered "deleted" is not good news.
   *
   * A poll has no gesture to compare against, so a receipt read by
   * `reconcileBatchCards` is `ok` when the message went out — which is what the
   * card was offering to do.
   */
  readonly ok: boolean;
  /** Why not, when it did not go. Already customer-readable. */
  readonly error?: string;
  /**
   * Which ending this was, when the card learned it from the STORE rather than
   * from its own approval request. `ok` alone cannot tell a message the owner
   * deleted from one the mail server refused, and those are not the same news.
   * Absent for the card's own send, which has nothing to disambiguate.
   */
  readonly kind?: "sent" | "rejected" | "failed" | "unconfirmed" | "duplicate" | "gone";
  /** When it happened, epoch ms — only from a receipt. */
  readonly at?: number;
}

/**
 * `deleting` is its own state and not a second name for `sending`.
 *
 * They looked interchangeable — both mean "a request this card made is in
 * flight" — and sharing one made the card's primary button read "Sending…"
 * while the drafts were being thrown away, over messages the owner had just
 * said must not be sent. On a slow round trip that is several seconds of the
 * surface asserting the opposite of what it is doing.
 */
export type EmailBatchStatus = "waiting" | "sending" | "deleting" | "settled";

export interface EmailBatchCardState {
  readonly batchId: string;
  readonly drafts: readonly EmailBatchDraft[];
  readonly status: EmailBatchStatus;
  /** Per draft, once the send has been attempted. Empty until then. */
  readonly outcomes: readonly EmailBatchOutcome[];
  /** The request itself failed — nothing was attempted, or we cannot say what was. */
  readonly requestError: string;
  /**
   * This card settled because the owner pressed something ON IT, so the caret
   * may follow the control that just disappeared.
   *
   * A card can also settle because a background poll found its drafts already
   * decided elsewhere, and that must NOT move the caret: the most common
   * trigger is `window.focus` — the owner clicking back into the tab — and
   * taking focus there yanks it out of the composer they are typing in. See
   * the effect below, whose own rule is that the one move it makes is the one
   * the customer's action forced.
   */
  readonly settledByOwner?: boolean;
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

/**
 * Bring every live card back into step with the STORE.
 *
 * WHY THE CARD CANNOT JUST TRUST ITSELF. The drafts are frozen at display on
 * purpose — that is what stops a draft queued during the reading pause from
 * riding along on the tap. The mistake was to freeze the VERDICT with them: the
 * card had no way to learn that a draft had been approved in Settings, in
 * another tab, or with a button in Telegram, so it went on offering "Approve &
 * send" for a message that was already sent. Harmless on the wire — the route
 * answers "gone" — and a lie on the screen, which is what the owner acts on.
 *
 * Freezing what is ASKED and refreshing the ANSWER are different things. The
 * text on the card never changes; what stops is the claim that it is waiting.
 *
 * `pendingIds` is the queue as the server just reported it and `resolved` the
 * receipts beside it, so one read of /setup-api/email/pending answers both. A
 * draft in neither is recorded as "gone": it left the queue before receipts
 * existed, or its receipt has expired, and either way it is not waiting.
 *
 * A card mid-`sending` is left alone — its own approval request owns it and
 * will settle it — and so is one already settled.
 *
 * Returns the SAME array when nothing moved, the way `updateBatchCard` does: a
 * fresh copy would be a state change React re-renders for on every poll.
 */
export function reconcileBatchCards(
  cards: EmailBatchCardState[],
  pendingIds: ReadonlySet<string>,
  resolved: ReadonlyMap<string, EmailBatchOutcome>,
): EmailBatchCardState[] {
  let moved = false;
  const next = cards.map((card) => {
    if (card.status !== "waiting") return card;
    const decided = new Set(card.outcomes.map((o) => o.id));
    /**
     * The ones only GUESSED at, which a real receipt may still correct.
     *
     * Every approval path claims the draft out of the queue BEFORE `sendMail`
     * and writes the receipt only after it resolves, so for the length of an
     * SMTP conversation the draft is in neither list. A poll landing in that
     * window — `installPendingRefresh` fires on focus and visibilitychange, not
     * only on the timer — recorded "gone" and then never looked again, leaving
     * a permanent shrug over a message that went out. So "gone" is provisional:
     * it still DECIDES the draft, or a card could never settle and would keep a
     * live Approve button over mail that is no longer waiting, but a later
     * receipt replaces it. The reconcile moves towards better information
     * rather than towards its first guess.
     */
    const guessed = new Set(card.outcomes.filter((o) => o.kind === "gone").map((o) => o.id));
    const added: EmailBatchOutcome[] = [];
    for (const draft of card.drafts) {
      if (pendingIds.has(draft.id)) continue;
      const receipt = resolved.get(draft.id);
      // Already answered for, and only a provisional "gone" may be revised —
      // and only by a receipt, never by a second guess.
      if (decided.has(draft.id) && !(guessed.has(draft.id) && receipt)) continue;
      added.push(receipt ?? { id: draft.id, ok: false, kind: "gone" });
      decided.add(draft.id);
    }
    if (added.length === 0) return card;
    moved = true;
    const replaced = new Set(added.map((o) => o.id));
    const outcomes = [...card.outcomes.filter((o) => !replaced.has(o.id)), ...added];
    // Settled only once EVERY draft on it has an ending. Until then the card
    // is still a live control for the ones that are genuinely still waiting.
    const everyOne = card.drafts.every((d) => decided.has(d.id));
    return {
      ...card,
      outcomes,
      // A request error is an absolute claim — "nothing was sent", "they could
      // not be deleted" — made when the answer never arrived. The store has now
      // said what actually happened, and leaving the old sentence up would put
      // "Nothing was sent" in red directly under "2 sent." in green.
      requestError: "",
      ...(everyOne ? { status: "settled" as const } : {}),
    };
  });
  return moved ? next : cards;
}

/**
 * Fold the answer to THIS card's own request into it.
 *
 * MERGE, NEVER REPLACE, and that is the whole point. A poll can have written
 * outcomes into a waiting card for drafts decided elsewhere (`reconcileBatchCards`),
 * and those drafts are deliberately not in the request the owner then made —
 * they were already excluded from the ticked set. Overwriting `outcomes` with
 * the response therefore erased them: the row lost its verdict line, its
 * checkbox came back ticked, and the summary counted one message on a card
 * showing two. The card is settled by then, so no later poll could repair it.
 *
 * The RESPONSE WINS for an id it does mention. A poll landing while the request
 * was in flight can have recorded a premature "gone" for a draft the route was
 * at that moment sending, and the route's own word is the later, better one.
 *
 * SETTLED ONLY WHEN EVERY DRAFT HAS AN ENDING — the same rule
 * `reconcileBatchCards` uses. A card that settles with a draft still undecided
 * is a card nothing can ever update again: the reconcile skips settled cards,
 * and `batchFromPending` will not rebuild one for a draft already on screen.
 *
 * `settledByOwner` rides along because this settle IS the customer's own
 * action, which is what licenses moving the caret to the result.
 */
export function settleCard(
  cards: EmailBatchCardState[],
  batchId: string,
  answered: readonly EmailBatchOutcome[],
): EmailBatchCardState[] {
  const index = cards.findIndex((card) => card.batchId === batchId);
  if (index === -1) return cards;
  const card = cards[index];
  const responded = new Set(answered.map((o) => o.id));
  const outcomes = [...card.outcomes.filter((o) => !responded.has(o.id)), ...answered];
  const decided = new Set(outcomes.map((o) => o.id));
  const everyOne = card.drafts.every((d) => decided.has(d.id));
  const next = cards.slice();
  next[index] = {
    ...card,
    outcomes,
    requestError: "",
    status: everyOne ? "settled" : "waiting",
    ...(everyOne ? { settledByOwner: true } : {}),
  };
  return next;
}

/** Replace one card by id, leaving the rest untouched. */
export function updateBatchCard(
  cards: EmailBatchCardState[],
  batchId: string,
  change: Partial<EmailBatchCardState>,
): EmailBatchCardState[] {
  const index = cards.findIndex((card) => card.batchId === batchId);
  // The SAME array back when nothing matched, the way expireClarifyCard does
  // it: a fresh copy would be a state change React has to re-render for, in the
  // one case where nothing changed.
  if (index === -1) return cards;
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
  /**
   * Send none of them and DELETE them. Named the same way approving is, and
   * for the mirrored reason: a draft queued while the owner was reading is not
   * on this card and must not be swept away by a gesture aimed at what was.
   */
  onCancel: (approval: EmailBatchApproval) => void | Promise<void>;
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

  const outcomeById = useMemo(() => {
    const map = new Map<string, EmailBatchOutcome>();
    for (const outcome of outcomes) map.set(outcome.id, outcome);
    return map;
  }, [outcomes]);
  /**
   * What this send would cover — never a draft that already has an ending.
   *
   * The second clause is what keeps the count honest once a draft has been
   * decided somewhere else: "Send all 2" over one waiting message and one
   * already-sent one is the same lie as the button itself, in a smaller place.
   */
  const included = useMemo(
    () => drafts.filter((d) => !dropped.has(d.id) && !outcomeById.has(d.id)),
    [drafts, dropped, outcomeById],
  );

  const sending = status === "sending";
  const deleting = status === "deleting";
  /** A request this card made is in flight; neither button may be pressed. */
  const busy = sending || deleting;
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
  const settledByOwner = card.settledByOwner === true;
  useEffect(() => {
    if (!settled || !settledByOwner) return;
    outcomeRef.current?.focus();
  }, [settled, settledByOwner]);

  /**
   * Went out, and going out is what the click asked for.
   *
   * Keyed on the ENDING and on `ok` together, because "it was sent" and "that
   * is what you wanted" are different facts — see `sentElsewhereCount`. A row
   * with no ending at all is this card's own send, which has nothing to
   * disambiguate.
   */
  const sentCount = outcomes.filter((o) => o.ok && (o.kind === "sent" || o.kind === undefined)).length;
  /**
   * Went out although the click asked for it NOT to.
   *
   * The owner pressed *Delete without sending* and one of the drafts had been
   * approved on Telegram while he was reading. It really was sent, so the row
   * says so — but it is the worst news on the card, not a success, and it must
   * never be added to the green count that answers "did what I clicked work?".
   */
  const sentElsewhereCount = outcomes.filter((o) => !o.ok && o.kind === "sent").length;
  /**
   * Endings that are not failures.
   *
   * A draft the owner deleted, and one an identical message already covered,
   * both leave the queue without being sent — and neither is anything gone
   * wrong. Counting them as failures made "Delete without sending" answer with
   * "0 sent, 2 not sent." in the colour that means something needs doing, which
   * is a false alarm about the owner's own deliberate act.
   *
   * On the ENDING alone: a deletion is a deletion whether or not it is what
   * this particular click asked for, and `ok` is now true for both of these
   * under a delete gesture.
   */
  const discardedCount = outcomes.filter((o) => o.kind === "rejected" || o.kind === "duplicate").length;
  // An unconfirmed send is not a failure to report as one: nobody knows what
  // happened, and the row says exactly that.
  const unconfirmedCount = outcomes.filter((o) => o.kind === "unconfirmed").length;
  /**
   * Decided somewhere else, and this card never learned which ending it had.
   *
   * Not a failure either: the draft is not waiting because Settings, another
   * tab or the Telegram bot dealt with it — most often by SENDING it. A verdict
   * calling that "not sent" is the false failure this card keeps having to be
   * talked out of, and it is the one the owner acts on by sending again.
   */
  const elsewhereCount = outcomes.filter((o) => o.kind === "gone").length;
  const failedCount =
    outcomes.length - sentCount - sentElsewhereCount - discardedCount - unconfirmedCount - elsewhereCount;
  /**
   * Settled, with nothing to show for it.
   *
   * A card only settles once every draft on it has an ending, so this needs a
   * card with no drafts at all — which `drafts.length === 0` returns null for
   * below. It is kept as the belt on the braces: a verdict computed from
   * `failedCount` alone would find zero failures and render the all-sent line
   * with a count of nought, "0 sent." in the colour that means it went well,
   * and that is the one sentence this card must never be able to produce.
   */
  const nothingAttempted = outcomes.length === 0;
  const noneSelected = included.length === 0;
  const canSend = !busy && !noneSelected;
  /**
   * The id of the sentence explaining why the buttons are inert.
   *
   * Named rather than inlined because both controls point at it: an unassociated
   * sibling `<span>` is invisible to a screen reader that has just landed on a
   * button it cannot press.
   */
  const noneId = `${idPrefix}-none`;

  if (drafts.length === 0) return null;

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
            included={!dropped.has(draft.id) && !outcomeById.has(draft.id)}
            locked={busy || settled || outcomeById.has(draft.id)}
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
            /* `aria-disabled`, never the native `disabled`. A disabled button is
               out of the sequential focus order, so a keyboard or screen-reader
               user who unticks every draft tabs past both controls AND past the
               sentence beside them, and is left with a card that has gone
               silent for no reason they can discover. The button stays
               reachable and announces itself as unavailable; the HANDLER below
               is what makes it unpressable.

               The described reason is wired for the EMPTY SELECTION only, and
               that is the whole of it: that state is indefinite and its label
               ("Send it") explains nothing, so it needs a sentence. Being busy
               is momentary and already spoken — the primary button's own label
               becomes "Sending…" / "Deleting…" and the card's summary is a
               polite live region — so a second description there would repeat
               what the accessible name just said. */
            aria-disabled={!canSend}
            aria-describedby={noneSelected ? noneId : undefined}
            onClick={() => {
              // The guard the removed `disabled` attribute used to be. It is
              // the real one either way: `disabled` is a hint to the browser,
              // this is the rule.
              if (!canSend) return;
              void onApprove({
                batchId,
                // Read off the FROZEN card state, never re-fetched: this is the
                // client half of the guarantee that what was read is what goes.
                entries: included.map((d) => ({ id: d.id, fingerprint: d.fingerprint })),
              });
            }}
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
            // Nothing ticked, nothing to delete — the same rule the send
            // button follows, so neither control ever claims to act on an
            // empty set. Announced rather than enforced by the attribute, for
            // the reason written on the send button above.
            aria-disabled={!canSend}
            aria-describedby={noneSelected ? noneId : undefined}
            onClick={() => {
              if (!canSend) return;
              void onCancel({
                batchId,
                // The TICKED set, the same one the send button acts on. A
                // checkbox this file documents as "how one draft is dropped
                // from the batch" cannot mean "spare it" for one button and
                // "delete it anyway" for the other — and of the two readings,
                // the one that destroys less is the one to be wrong about.
                entries: included.map((d) => ({ id: d.id, fingerprint: d.fingerprint })),
              });
            }}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              background: "none",
              border: "1px solid rgba(255,255,255,0.18)",
              color: MUTED_FG,
              fontSize: 12.5,
              fontFamily: "inherit",
              cursor: canSend ? "pointer" : "default",
              opacity: canSend ? 1 : 0.55,
            }}
          >
            {deleting
              ? t("chat.emailBatch.deleting")
              : included.length === 1 || noneSelected
                ? t("chat.emailBatch.cancelOne")
                : t("chat.emailBatch.cancel", { count: String(included.length) })}
          </button>
          {noneSelected && (
            <span id={noneId} data-testid="chat-email-batch-none" style={{ color: MUTED_FG, fontSize: 11.5 }}>
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
          style={{
            color:
              failedCount > 0 || nothingAttempted
                ? ERROR_FG
                : unconfirmedCount > 0 || sentElsewhereCount > 0
                  ? WARN_FG
                  : sentCount > 0
                    ? OK_FG
                    : MUTED_FG,
            fontSize: 12,
            outline: "none",
          }}
        >
          {/* In order of what the owner needs to know: a real failure first,
              then a send nobody could confirm — which outranks the good news
              beside it, because it is the one line he has to act on — then a
              message that went out when he was asking for it NOT to, then what
              went, then what he threw away, and last the case where this card
              did none of it.

              The sent-elsewhere line NAMES THE DELETIONS TOO. "1 sent." over a
              *Delete without sending* both painted the one thing he was
              preventing as success and dropped the deletion he did get, because
              a single sentence can only be the head of the chain once. */}
          {nothingAttempted
            ? t("chat.emailBatch.resultNone")
            : failedCount > 0
              ? t("chat.emailBatch.resultPartial", { sent: String(sentCount), failed: String(failedCount) })
              : unconfirmedCount > 0
                ? t("chat.emailBatch.resultUnconfirmed", {
                    sent: String(sentCount),
                    unconfirmed: String(unconfirmedCount),
                  })
                : sentElsewhereCount > 0
                  ? discardedCount > 0
                    ? t("chat.emailBatch.resultDiscardedSentElsewhere", {
                        discarded: String(discardedCount),
                        sent: String(sentElsewhereCount),
                      })
                    : t("chat.emailBatch.resultSentElsewhere", { count: String(sentElsewhereCount) })
                  : sentCount > 0
                    ? t("chat.emailBatch.resultAllSent", { count: String(sentCount) })
                    : discardedCount > 0
                      ? t("chat.emailBatch.resultDiscarded", { count: String(discardedCount) })
                      : t("chat.emailBatch.resultElsewhere")}
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

/**
 * One line saying what became of one draft.
 *
 * Every ending gets its own sentence, because they are not interchangeable to
 * the person reading them: "the mail server refused it" is a thing to act on,
 * "you deleted it" is not, and "an identical copy was sent" is the difference
 * between a bug and a duplicate that was handled. A single "not sent" over all
 * three is the shape of unhelpfulness this card exists to avoid.
 *
 * The time is shown only when the card LEARNED the ending rather than caused
 * it: after its own send there is nothing to place in time — the owner just
 * pressed the button — while "sent at 11:34" is exactly what answers "did that
 * go out before I left?".
 */
/**
 * What colour one ending is written in.
 *
 * Only two of the six are news: a mail server's refusal, which needs doing
 * something about, and a send nobody could confirm, which needs looking at. The
 * rest are the record of something that already went as it should — including
 * the owner's own deletion, which spent a release painted the same red as a
 * failure and read as an error report about his own click.
 */
function outcomeColor(outcome: EmailBatchOutcome): string {
  if (outcome.kind === "unconfirmed") return WARN_FG;
  // A send is green only when sending is what the click asked for. Answered to
  // a *Delete without sending*, the same ending is the worst news on the card —
  // amber, because there is nothing to fix and everything to look at, and
  // certainly not the green that reads as "your deletion worked".
  if (outcome.kind === "sent") return outcome.ok ? OK_FG : WARN_FG;
  if (outcome.kind === "rejected" || outcome.kind === "duplicate" || outcome.kind === "gone") return MUTED_FG;
  if (outcome.ok) return OK_FG;
  return ERROR_FG;
}

function outcomeLine(
  outcome: EmailBatchOutcome,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const wentOut = (): string =>
    outcome.at === undefined
      ? t("chat.emailBatch.draftSent")
      : t("chat.emailBatch.draftSentAt", {
          time: new Date(outcome.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
        });
  switch (outcome.kind) {
    case "rejected":
      return t("chat.emailBatch.draftRemoved");
    case "duplicate":
      return t("chat.emailBatch.draftDuplicate");
    case "gone":
      return t("chat.emailBatch.draftGone");
    case "unconfirmed":
      // Not "not sent": the box handed the message over and never heard back,
      // and telling the owner it failed is how they come to send it twice.
      return t("chat.emailBatch.draftUnconfirmed");
    case "sent":
      // The receipt's own word, whatever the gesture was. `ok` decides the
      // COLOUR of this line, never the words: a card that softened "it went
      // out" because the owner had asked for a deletion would be hiding the one
      // thing he has to know — and the `!outcome.ok` fall-through below would
      // have called it "Not sent", about a message already in an inbox.
      return wentOut();
    default:
      break;
  }
  if (!outcome.ok) return t("chat.emailBatch.draftFailed", { reason: outcome.error || "" });
  return wentOut();
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
  /**
   * The body as CODE POINTS, because `String.prototype.slice` counts UTF-16
   * units and would cut an astral character in half.
   *
   * That is not a cosmetic worry on this card. The owner is being asked to
   * approve the exact characters that will be sent, and a clamp landing between
   * the two halves of a surrogate pair renders a replacement character in the
   * middle of his own message — text that is not what the draft says. The
   * hidden count is wrong the same way: `"🙂".length` is 2, so a body of emoji
   * would claim twice as much was folded away as actually is.
   */
  const bodyChars = useMemo(() => Array.from(draft.body), [draft.body]);
  const long = bodyChars.length > BODY_CLAMP_CHARS;
  const shown = long && !expanded ? bodyChars.slice(0, BODY_CLAMP_CHARS).join("") : draft.body;
  const hidden = bodyChars.length - BODY_CLAMP_CHARS;
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
          data-outcome-kind={outcome.kind ?? (outcome.ok ? "sent" : "failed")}
          style={{ color: outcomeColor(outcome), fontSize: 11.5, wordBreak: "break-word" }}
        >
          {outcomeLine(outcome, t)}
        </div>
      )}
    </li>
  );
}
