// What became of a draft after it left the approval queue.
//
// WHY THIS EXISTS. email-pending.ts is a queue, and a queue's whole discipline
// is that approving READS-AND-REMOVES in one synchronous step — that is what
// makes "one draft can only be sent once" true without a lock. The cost is that
// the moment a draft is decided it stops existing, and every surface that had
// it on screen is left to guess. The chat batch card guessed "still waiting",
// because it holds its drafts in component state and had nothing to re-read: an
// owner who approved on Telegram came back to a live "Approve & send" button
// over a message that was already in somebody's inbox.
//
// So a draft leaving the queue writes one short receipt here, and every surface
// renders from it. The queue stays the single source of truth for "is this
// waiting"; this file is the single source of truth for "and if not, why not".
//
// A SEPARATE FILE, not a status column on the pending row. email-pending.json
// is read by every build of this software that has ever shipped, and a terminal
// row inside it would read as a WAITING draft to an older one — a downgrade
// would resurrect sent mail as approvable. Nothing outside this module knows
// this file exists, so nothing older can misread it.
//
// NO BODY, EVER. The surfaces that show a decided draft already have its text
// (the chat card froze it; Settings shows the subject). Copying 20,000
// characters of agent-composed prose into a second file would be a second place
// to be careful with it for no gain.
//
// IT IS A RECEIPT, NOT AN ARCHIVE: capped and expiring, so a box that sends
// mail every day does not accumulate a log nobody reads.

import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
// One direction only: this module knows about the queue, the queue knows
// nothing about receipts. Reversing that would make a draft's ending a
// precondition of queueing one.
import { dropDuplicatesOf, type PendingEmail } from "@/lib/email-pending";
// For the one judgement below, and nothing else: whether a send that threw was
// a refusal the mail server spoke or a silence this box cannot read.
import { SmtpError } from "@/lib/smtp-client";

const OUTCOMES_PATH = path.join(DATA_DIR, "email-outcomes.json");

/**
 * How many receipts are kept.
 *
 * Comfortably more than MAX_PENDING, so emptying a full queue in one batch
 * leaves a receipt for every draft in it — a cap that could drop one would put
 * back exactly the "the card cannot say what happened" hole this file closes.
 */
export const MAX_OUTCOMES = 40;

/**
 * How long a receipt is worth keeping.
 *
 * A day: long enough for "I approved that on my phone this morning" to still be
 * answerable at the desktop, short enough that this is never a record of who
 * was mailed last month. Enforced on READ, like the approval prompts' TTL, so
 * an expired receipt is already gone by the time anything asks.
 */
export const OUTCOME_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Why a draft is no longer waiting.
 *
 *   "sent"        it went out, and the mail server accepted it;
 *   "rejected"    the owner deleted it; nothing was sent;
 *   "failed"      the mail server refused it, in so many words;
 *   "unconfirmed" the send was attempted and the box never learned the answer;
 *   "duplicate"   it was an exact copy of one that WAS sent, so it was resolved
 *                 rather than mailed a second time — `sentAs` names the one
 *                 that actually went.
 *
 * WHY "unconfirmed" IS NOT "failed". approveBatch already writes it down: once
 * bytes are on the wire, "it failed" and "the server took it and the connection
 * dropped before saying so" are indistinguishable from here — which is why a
 * draft is never requeued after that point. A receipt saying "Not sent" over
 * that case would be a positive claim nothing in the process can support, and
 * the owner acts on it by sending the message again. A refusal the mail server
 * actually spoke ("mailbox unavailable") is a different thing and keeps its own
 * word.
 */
export type EmailOutcomeKind = "sent" | "rejected" | "failed" | "unconfirmed" | "duplicate";

export interface EmailOutcome {
  /** The draft id the surfaces know it by. */
  id: string;
  kind: EmailOutcomeKind;
  /** Epoch ms. */
  at: number;
  to: string[];
  subject: string;
  /** For "duplicate": the id whose send covered this one. */
  sentAs?: string;
  /** For "failed" and "unconfirmed": customer-readable, never an SMTP transcript. */
  error?: string;
}

/** What a caller has to be able to name. The queue's own rows satisfy it. */
export type DecidedDraft = { id: string; to: string[]; subject: string };

function isOutcome(value: unknown): value is EmailOutcome {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string"
    && (v.kind === "sent" || v.kind === "rejected" || v.kind === "failed"
      || v.kind === "unconfirmed" || v.kind === "duplicate")
    && typeof v.at === "number"
    && Array.isArray(v.to)
    && v.to.every((r) => typeof r === "string")
    && typeof v.subject === "string"
  );
}

/**
 * Read, dropping anything expired or malformed.
 *
 * A corrupt file means "no receipts", never a throw: this is the tidiest part
 * of the feature and it must not be able to take the approval queue down.
 */
function readAll(now: number): EmailOutcome[] {
  try {
    if (!fs.existsSync(OUTCOMES_PATH)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(OUTCOMES_PATH, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOutcome).filter((o) => o.at > now - OUTCOME_TTL_MS);
  } catch {
    return [];
  }
}

/** 0600 via temp+rename, the discipline email-pending.ts and config-store use. */
function writeAll(entries: EmailOutcome[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${OUTCOMES_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not break the receipt
  }
  fs.renameSync(tmp, OUTCOMES_PATH);
}

/**
 * Write down what happened to one draft.
 *
 * Never throws. Every caller has already done the thing being recorded — the
 * message is sent, the draft is deleted — and a receipt that could not be
 * written must not turn a completed action into a failed one. It is logged
 * instead, because a missing receipt is exactly what makes a surface go quiet.
 *
 * Read-modify-write in one synchronous run, for the same reason the queue's
 * claim is: one JS thread means a second caller cannot start until this one has
 * returned, so two receipts cannot race in the shared `.tmp` path. An await in
 * here would remove that.
 */
export function recordOutcome(
  draft: DecidedDraft,
  kind: EmailOutcomeKind,
  extra: { sentAs?: string; error?: string } = {},
): void {
  try {
    const now = Date.now();
    const entry: EmailOutcome = {
      id: draft.id,
      kind,
      at: now,
      to: draft.to,
      subject: draft.subject,
      ...(extra.sentAs ? { sentAs: extra.sentAs } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    };
    // A repeat for the same id is the newer word on it; there is only ever one
    // ending per draft.
    const kept = readAll(now).filter((o) => o.id !== entry.id);
    // Oldest dropped first: `kept` is append-ordered, so the tail is newest.
    writeAll([...kept, entry].slice(-MAX_OUTCOMES));
  } catch (err) {
    console.error("[email/outcomes] could not record:", err instanceof Error ? err.message : err);
  }
}

/**
 * A draft has just been SENT — write its receipt and resolve its exact twins.
 *
 * The one place all three approval surfaces agree, and the reason it is a
 * function rather than four lines copied into each of them: the desktop panel,
 * the batch card's route and the Telegram bot all end a send here, and a fix
 * applied to two of the three is this codebase's most-repeated defect.
 *
 * WHAT "RESOLVE" MEANS. A twin is a draft saying exactly what this one said to
 * exactly the same people (draftContentKey). It has now been delivered — the
 * words reached the recipient — so it is taken out of the queue and recorded as
 * covered by this send rather than left with a button whose only outcome is
 * mailing a stranger the same message twice. It is never itself put on the
 * wire; the guarantee "one draft, one send" is untouched.
 *
 * CALL IT ONLY AFTER THE SEND SUCCEEDED. After a failure nothing was delivered,
 * so nothing is covered and the twins are still the owner's to decide about.
 *
 * A twin named in the SAME gesture is resolved like any other. Two identical
 * rows on one card are not two consents — they say the same words to the same
 * people, and mailing both is exactly the duplicate this exists to stop.
 *
 * NEVER THROWS, and that is load-bearing rather than tidy. Every caller reaches
 * this INSIDE the try that wraps `sendMail`, past the point where the message
 * has actually gone. An fs error escaping here would be caught by that handler,
 * reported to the owner as "Could not send the message", and would overwrite
 * this draft's "sent" receipt with a "failed" one — a delivered email reported
 * as a failure, which is how a person is talked into sending it twice.
 * `recordOutcome` and `dropDuplicatesOf` each swallow their own errors; this
 * catch is the backstop for anything neither of them owns.
 *
 * Returns the twins so the caller can take their chat buttons down too — that
 * belongs to the caller because email-approval.ts owns the Telegram side and
 * must not be imported from here.
 */
export function resolveSent(draft: PendingEmail): PendingEmail[] {
  recordOutcome(draft, "sent");
  try {
    const twins = dropDuplicatesOf(draft);
    for (const twin of twins) recordOutcome(twin, "duplicate", { sentAs: draft.id });
    return twins;
  } catch (err) {
    console.error("[email/outcomes] could not resolve duplicates:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * What a failed send may be RECORDED as.
 *
 * An SmtpError is the mail server's own refusal, quoted — it really was not
 * sent. Anything else is a dropped connection, an abort or a surprise, and this
 * process cannot tell "it failed" from "it was accepted and the connection
 * dropped before saying so"; a claimed draft is never requeued for exactly that
 * reason. The receipt says the same thing rather than a confident "not sent"
 * the owner would act on by re-sending.
 *
 * A network-kind SmtpError is the same uncertainty wearing the mail server's
 * type, so it is treated as unconfirmed too.
 *
 * HERE, not beside either caller: the desktop route and the Telegram callback
 * both classify a failed send, and this one judgement decides whether the owner
 * is told "not sent" or "could not be confirmed". Two copies is how the Telegram
 * path — the one nobody exercises by hand — comes to disagree.
 */
export function outcomeKindFor(err: unknown): "failed" | "unconfirmed" {
  return err instanceof SmtpError && err.kind !== "network" ? "failed" : "unconfirmed";
}

/** Newest first — the same order the queue itself is listed in. */
export function listOutcomes(): EmailOutcome[] {
  return readAll(Date.now())
    .slice()
    .sort((a, b) => b.at - a.at);
}

export function getOutcome(id: string): EmailOutcome | null {
  return readAll(Date.now()).find((o) => o.id === id) ?? null;
}

/** Used when the account is disconnected, alongside clearPending(). */
export function clearOutcomes(): void {
  try {
    if (fs.existsSync(OUTCOMES_PATH)) fs.unlinkSync(OUTCOMES_PATH);
  } catch {
    // best-effort
  }
}
