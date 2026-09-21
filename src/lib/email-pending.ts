// Outbound mail the agent wants to send and the owner has not agreed to yet.
//
// WHY A STORE AND NOT A PROMPT: there is no human in the loop at the moment the
// agent decides to send. ClawBox registers its MCP server into Hermes with
// `trust: full` (scripts/register-mcp.sh) because the appliance agent runs
// headless and one-shot — an approval prompt would have nobody to answer it and
// would hang the turn. So consent cannot be synchronous. It is made
// asynchronous instead: the send becomes a draft on disk, the agent is told so
// in the same breath, and the owner approves or deletes it in Settings → Email
// whenever they next look.
//
// This is the difference between the send budget in /email/send (a blast-radius
// limit — it bounds a runaway, it cannot stop the first message) and this file
// (actual consent — nothing reaches the wire without a click).
//
// STORAGE: data/email-pending.json, written 0600 via temp+rename, the same
// discipline config-store uses for the credentials themselves. It is a separate
// file rather than a config key because it is a queue with a lifecycle and a
// cap, and mixing it into the settings blob would put agent-supplied text into
// the file every settings read parses.
//
// WHAT IS IN IT: recipient, subject and body — text the agent composed, which
// on a bad day is text an ATTACKER composed via prompt injection. It is never
// executed, never re-parsed as configuration, and everything that renders it
// (the Settings strip, the MCP reply) treats it as untrusted content.

import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import { EMAIL_ADDRESS_RE } from "@/lib/smtp-client";

const PENDING_PATH = path.join(DATA_DIR, "email-pending.json");

/**
 * How many drafts may wait at once.
 *
 * When it is full, queueing FAILS rather than evicting the oldest. Evicting
 * would hand an injected agent a way to push a real draft out of the owner's
 * view by queueing twenty more — the queue would become a place things quietly
 * disappear from, which is the opposite of what it is for.
 */
export const MAX_PENDING = 20;

/**
 * What one message may be. Exported and imported by /setup-api/email/send
 * rather than restated there: the route checks them first so a caller hears
 * about a 30,000-character body before the send budget is spent, and this
 * module checks them again because it is the last step before a file write.
 * Two copies of the same numbers would drift into a route that accepts what
 * the queue then refuses.
 */
export const MAX_RECIPIENTS = 10;
export const MAX_SUBJECT_LEN = 200;
export const MAX_BODY_LEN = 20_000;

/**
 * The repertoire a stored draft may be made of.
 *
 * These two patterns are the whole answer to "what can end up in
 * email-pending.json". They are anchored and they name the characters that ARE
 * allowed instead of the ones that are not, so a draft reaches the disk only
 * when every character in it is one this file already knew about — the queue
 * never takes the caller's bytes on trust and writes them straight out.
 *
 * What they keep out is not cosmetic:
 *   - C0/C1 controls and DEL. The subject becomes a mail header and the body
 *     becomes the DATA section; both are also echoed back to the agent and
 *     rendered in Settings, where an ANSI escape is a way to make one draft
 *     read as another.
 *   - CR and LF in the SUBJECT specifically — a header value with a line break
 *     in it is a header injection. A body is allowed them; that is what a body
 *     is.
 *   - U+2028/U+2029, the bidi overrides and embeddings (U+202A-U+202E) and the
 *     bidi isolates (U+2066-U+2069), and U+FEFF: characters whose only effect
 *     here would be to make the approval prompt read differently from what
 *     gets sent.
 *
 * Everything else is allowed — every script, every emoji — because people
 * write mail in their own language. Zero-width joiners are deliberately still
 * in: they are load-bearing in Persian, in Hindi and in emoji sequences.
 */
const DRAFT_SUBJECT_RE = /^[\u0020-\u007e\u00a0-\u2027\u202f-\u2065\u206a-\ufefe\uff00-\uffff]+$/;
const DRAFT_BODY_RE = /^[\t\n\r\u0020-\u007e\u00a0-\u2027\u202f-\u2065\u206a-\ufefe\uff00-\uffff]+$/;

/** How much of the body the approvals strip shows before the owner opens it. */
export const PREVIEW_CHARS = 160;

/**
 * How long an identical message counts as the SAME message.
 *
 * The case this exists for is a retry, not a coincidence. `email_send` reaches
 * the device over HTTP with a 60 s budget, and a route that had already written
 * the draft but answered late used to be asked to write it again — the owner's
 * box produced two identical drafts, ids one apart, from one request. Five
 * minutes covers a timeout and the retry behind it with room to spare, and is
 * far short of the interval at which a person plausibly asks for the same
 * message, word for word, to the same address, twice.
 *
 * It is only half the guard. The other half is that a fold only ever happens
 * into a draft that is STILL WAITING — see queuePending.
 *
 * WHAT THE FOLD THEREFORE DOES NOT COVER: a retry that lands after the owner
 * has already approved the first draft. There is nothing waiting to fold into,
 * so a fresh draft is queued and he is asked about a message that has gone. The
 * queue is deliberately not given a memory of decided drafts — folding into one
 * would swallow a second message he really did ask for — and the tool that used
 * to produce that retry no longer asks for one (mcp/tools/email.ts).
 *
 * Nor can the receipts store close the rest of this window as it stands: it
 * deliberately keeps NO body (email-outcomes.ts), so it cannot produce a
 * `draftContentKey` and can recognise a retry only by recipients and subject.
 * Closing it would mean giving a receipt a content-key column — a hash, never
 * the text — which is a change to that file, not a lookup this one is missing.
 */
export const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export interface PendingEmail {
  id: string;
  to: string[];
  subject: string;
  body: string;
  /** Epoch ms. */
  createdAt: number;
}

/** What the Settings panel gets. Full body included — the owner is approving it. */
export interface PendingEmailView {
  id: string;
  to: string[];
  subject: string;
  preview: string;
  body: string;
  createdAt: number;
  /** See draftFingerprint. Travels with the draft so a surface can send it back. */
  fingerprint: string;
}

export type QueueResult =
  | {
      ok: true;
      draft: PendingEmail;
      /**
       * The draft returned was ALREADY in the queue and nothing new was
       * written. The caller has to say so rather than report a second queued
       * message — an agent told "queued" twice tells the owner two emails are
       * waiting when one is.
       */
      deduped: boolean;
    }
  | { ok: false; error: string; reason: "full" | "invalid" };

/**
 * What `claimPendingIfUnchanged` can say. "changed" is not "gone": the draft is
 * still queued and untouched, it simply is not the one the owner read.
 */
export type ClaimResult =
  | { ok: true; draft: PendingEmail }
  | { ok: false; reason: "gone" | "changed" };

/**
 * A short, stable name for exactly this draft's CONTENT.
 *
 * WHY IT EXISTS. The batch approval card in chat shows the owner every
 * recipient, subject and body and then asks for one click. Between the card
 * rendering and that click there is a human-length pause — the whole point of
 * the card is that he READS it — and the agent is still running. Anything that
 * treats "approved" as "send whatever is in the queue now" would send messages
 * that were never on screen. That is the shape of the bug found in #492, where
 * device state moved during exactly such a dialog pause.
 *
 * So approval names the drafts it means. The id list alone already fixes the
 * "eight became twelve" case, because a draft queued during the pause is not in
 * it. This fingerprint closes the other half: an id that still exists but no
 * longer holds the text the owner read. The store has no update path today, so
 * that cannot happen yet — which is the reason to nail it down now rather than
 * after someone adds an edit button.
 *
 * SHA-256 over a canonical array, not over the object: `JSON.stringify` of an
 * object follows insertion order, so two equal drafts built by different code
 * paths could fingerprint differently. The array fixes the order at the one
 * place that defines it. Truncated to 32 hex characters — this is a change
 * detector, not a MAC, and nothing about it is a secret the owner does not
 * already have on screen.
 */
export function draftFingerprint(
  draft: Pick<PendingEmail, "id" | "to" | "subject" | "body" | "createdAt">,
): string {
  const canonical = JSON.stringify([draft.id, draft.to, draft.subject, draft.body, draft.createdAt]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

/**
 * A short, stable name for what a draft SAYS — the content-only sibling of
 * `draftFingerprint`.
 *
 * The two are deliberately different things and neither can stand in for the
 * other. `draftFingerprint` includes the id and the timestamp, because its job
 * is "is this still the exact row the owner was shown"; two identical messages
 * fingerprint differently, which is right for a freeze and useless for
 * recognising a retry. This one covers recipients, subject and body and nothing
 * else, so a message queued twice has one key both times.
 *
 * NORMALISED, because the two calls are not guaranteed to be byte-identical: a
 * retried tool call can differ in recipient case or padding, in the whitespace
 * a model re-flowed around a subject, or in line endings. What is normalised is
 * only what cannot change the message a person reads:
 *
 *   - recipients trimmed, lower-cased and SORTED — the same two people in the
 *     other order is the same message;
 *   - CRLF folded to LF, since a body differing only in line endings renders
 *     identically and sends identically;
 *   - runs of spaces and tabs collapsed, and the ends trimmed.
 *
 * Case is deliberately KEPT, and so are LINE BREAKS. "Approve the invoice" and
 * "APPROVE THE INVOICE" are not obviously the same message to the person whose
 * name is on them, and neither is one paragraph the same message as three — a
 * re-flowed second draft is a rewrite, and this key decides whether one of them
 * is silently dropped. Only the blank-line runs a mail client would render
 * identically are levelled.
 */
export function draftContentKey(message: { to: string[]; subject: string; body: string }): string {
  const recipients = message.to
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  // `[^\S\n]` is "whitespace that is not a newline": spaces and tabs go, the
  // shape of the message stays.
  //
  // ORDER MATTERS, and it used to be wrong: the blank-line collapse ran BEFORE
  // the spaces around each newline were trimmed, so "a \n \n \n b" still had
  // spaces between its newlines when `\n{3,}` looked and kept all three, while
  // the identical "a\n\n\nb" folded to two. Two renderings of one message got
  // two keys and the second was queued as a new draft. Trim first, then level.
  const flatten = (text: string): string =>
    text.replace(/\r\n/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const canonical = JSON.stringify([recipients, flatten(message.subject), flatten(message.body)]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

function readAll(): PendingEmail[] {
  try {
    if (!fs.existsSync(PENDING_PATH)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(PENDING_PATH, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingEmail);
  } catch {
    // A corrupt queue must not take the email feature down. An unreadable file
    // means "nothing is waiting", and the next queue rewrites it.
    return [];
  }
}

function isPendingEmail(value: unknown): value is PendingEmail {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string"
    && Array.isArray(v.to)
    && v.to.every((r) => typeof r === "string")
    && typeof v.subject === "string"
    && typeof v.body === "string"
    && typeof v.createdAt === "number"
  );
}

function writeAll(drafts: PendingEmail[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Same reasoning as config-store.writeConfig: fresh temp at 0600, chmod in
  // case a stale temp survived a crash at 0644, then atomic rename.
  const tmp = `${PENDING_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(drafts, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not break the queue
  }
  fs.renameSync(tmp, PENDING_PATH);
}

/**
 * Put a message in the queue instead of sending it.
 *
 * Validation is repeated here rather than trusted from the caller: this is the
 * last point before agent-composed text lands on disk, and the route that calls
 * it is not the only conceivable caller.
 */
export function queuePending(input: { to: string[]; subject: string; body: string }): QueueResult {
  // Built one recipient at a time rather than mapped in place: the list that
  // reaches the disk is the one this loop assembled out of strings it has just
  // checked, not the array the caller handed over. The address check is the
  // one the send route already applies — repeated here because this, not the
  // route, is the last point before the text lands in a file.
  const to: string[] = [];
  for (const raw of input.to) {
    const recipient = raw.trim();
    if (!recipient) continue;
    if (recipient.length > 254 || !EMAIL_ADDRESS_RE.test(recipient)) {
      return { ok: false, error: `"${recipient}" is not a valid email address`, reason: "invalid" };
    }
    to.push(recipient);
  }
  if (to.length === 0) return { ok: false, error: "A recipient is required", reason: "invalid" };
  if (to.length > MAX_RECIPIENTS) {
    return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients`, reason: "invalid" };
  }
  const subject = input.subject.trim();
  if (!subject) return { ok: false, error: "A subject is required", reason: "invalid" };
  // Reported apart from the empty case on purpose: an agent told a 30,000-
  // character body is "required" has no reason to shorten it and retries the
  // same input.
  if (subject.length > MAX_SUBJECT_LEN) {
    return {
      ok: false,
      error: `A subject may be at most ${MAX_SUBJECT_LEN} characters`,
      reason: "invalid",
    };
  }
  if (!DRAFT_SUBJECT_RE.test(subject)) {
    return {
      ok: false,
      error: "The subject has characters in it that this ClawBox will not put in a mail header",
      reason: "invalid",
    };
  }
  const body = input.body;
  if (!body) return { ok: false, error: "A message body is required", reason: "invalid" };
  if (body.length > MAX_BODY_LEN) {
    return {
      ok: false,
      error: `A message body may be at most ${MAX_BODY_LEN} characters`,
      reason: "invalid",
    };
  }
  if (!DRAFT_BODY_RE.test(body)) {
    return {
      ok: false,
      error: "The message body has control characters in it that this ClawBox will not store",
      reason: "invalid",
    };
  }

  const drafts = readAll();

  // THE RETRY GUARD, and it sits BEFORE the cap on purpose: a retry that would
  // have folded into a draft already waiting must not be refused for filling a
  // queue it was never going to add to.
  //
  // Matched against drafts that are still WAITING, and only those. There is no
  // memory of decided drafts here, and that is the point: folding into one the
  // owner has already approved would swallow a second message he really did
  // ask for, and a queue is the wrong place to make that guess. The window then
  // bounds how long two identical waiting drafts count as one.
  //
  // Nothing is written on this path. The caller gets the id that is already on
  // disk, and the surfaces go on showing the one card they already had.
  const now = Date.now();
  const key = draftContentKey({ to, subject, body });
  // Distance, not "newer than": a Jetson that wrote a draft before NTP settled
  // (or after a step backwards) leaves `createdAt` in the future, and a
  // one-sided comparison is then permanently true — every later identical
  // message would fold into that one stale draft for ever.
  const already = drafts.find(
    (d) => Math.abs(now - d.createdAt) < DEDUPE_WINDOW_MS && draftContentKey(d) === key,
  );
  if (already) return { ok: true, draft: already, deduped: true };

  if (drafts.length >= MAX_PENDING) {
    return {
      ok: false,
      reason: "full",
      error: `${MAX_PENDING} messages are already waiting for approval. Approve or delete some in Settings → Email first.`,
    };
  }

  const draft: PendingEmail = {
    id: randomUUID(),
    to,
    subject,
    body,
    createdAt: now,
  };
  writeAll([...drafts, draft]);
  return { ok: true, draft, deduped: false };
}

/**
 * Take the RETRY ARTEFACTS of a draft that has just been sent out of the queue,
 * and return them.
 *
 * FOR ONE MOMENT ONLY: straight after a draft has been successfully sent. It
 * must NOT be called after a send that failed, and it is not called on reject —
 * nothing was delivered in either case, so nothing is covered.
 *
 * THE WINDOW IS THE WHOLE SAFETY ARGUMENT, and it is the same one
 * `queuePending` uses. What this sweeps is the second row a timed-out retry
 * left behind: queued within seconds of the first, never meant to exist.
 * Beyond that window an identical message is a SECOND REQUEST — DEDUPE_WINDOW_MS
 * says so in as many words — and deleting one would throw away mail the owner
 * asked for and may already have read and approved. So the comparison is
 * against the sent draft's own `createdAt`, not against "whenever": two
 * reminders queued forty minutes apart are two reminders.
 *
 * IT SWEEPS A TWIN THE SAME GESTURE NAMED, TOO. It used to spare those, on the
 * reading that a batch the owner ticked twice is two consents. It is not: the
 * two rows say the same words to the same people and he cannot tell them apart,
 * the queue itself now refuses to write the second one, and sending both is the
 * duplicate email that started all of this. Approving resolves a twin wherever
 * it was approved from — the owner's rule for every surface, and the batch card
 * is the surface he uses.
 *
 * NEVER THROWS. Every caller reaches this after `sendMail` has already
 * resolved, and a queue file that cannot be rewritten must not turn a delivered
 * email into a reported failure; the worst a swallowed error costs is a twin
 * left waiting, which is where it already was.
 *
 * The draft itself is left alone; its caller owns its lifecycle.
 */
export function dropDuplicatesOf(draft: PendingEmail): PendingEmail[] {
  try {
    const key = draftContentKey(draft);
    const drafts = readAll();
    const twins = drafts.filter(
      (d) =>
        d.id !== draft.id
        && Math.abs(d.createdAt - draft.createdAt) < DEDUPE_WINDOW_MS
        && draftContentKey(d) === key,
    );
    if (twins.length === 0) return [];
    const twinIds = new Set(twins.map((d) => d.id));
    writeAll(drafts.filter((d) => !twinIds.has(d.id)));
    return twins;
  } catch (err) {
    console.error("[email/pending] could not sweep duplicates:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Newest first — the owner wants to see what just arrived. */
export function listPending(): PendingEmailView[] {
  return readAll()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((d) => ({
      id: d.id,
      to: d.to,
      subject: d.subject,
      preview: d.body.slice(0, PREVIEW_CHARS),
      body: d.body,
      createdAt: d.createdAt,
      fingerprint: draftFingerprint(d),
    }));
}

export function countPending(): number {
  return readAll().length;
}

export function getPending(id: string): PendingEmail | null {
  return readAll().find((d) => d.id === id) ?? null;
}

/**
 * Take a draft OUT of the queue, returning it. One draft can only be claimed
 * once: approve reads-and-removes before it sends, so a double click (or a
 * retry) cannot send the same message twice.
 *
 * WHAT MAKES THAT TRUE, and why there is no lock: every step in here is
 * SYNCHRONOUS — readFileSync, then writeFileSync + renameSync — with no await
 * between the read and the write. One JS thread means a second request's call
 * cannot start until this one has returned, so two approvals of the same id
 * cannot both find the draft, and two writers cannot meet in the shared
 * `.tmp` path. One device runs one server process, so there is no writer
 * outside this one either.
 *
 * Which is to say: an await anywhere in here, or a move to fs/promises, would
 * silently remove the guarantee and let one approved message be sent twice.
 */
export function claimPending(id: string): PendingEmail | null {
  const drafts = readAll();
  const found = drafts.find((d) => d.id === id);
  if (!found) return null;
  writeAll(drafts.filter((d) => d.id !== id));
  return found;
}

/**
 * `claimPending`, but only if the draft is still the one the owner was shown.
 *
 * The read, the comparison and the write are one synchronous run for the same
 * reason `claimPending` is — see the note there. An await between the check and
 * the removal would put back the window this function exists to close, and
 * would also let two approvals of one id both pass the check.
 *
 * A mismatch leaves the draft IN the queue. It has not been consented to, and
 * quietly deleting the thing the owner did not approve would lose text he never
 * asked to lose.
 */
export function claimPendingIfUnchanged(id: string, fingerprint: string): ClaimResult {
  const drafts = readAll();
  const found = drafts.find((d) => d.id === id);
  if (!found) return { ok: false, reason: "gone" };
  if (draftFingerprint(found) !== fingerprint) return { ok: false, reason: "changed" };
  writeAll(drafts.filter((d) => d.id !== id));
  return { ok: true, draft: found };
}

/**
 * Put a claimed draft back, unchanged.
 *
 * WHAT IT IS FOR, and the one case it may be used in. `claimPendingIfUnchanged`
 * removes a draft BEFORE the SMTP client is handed it, so a retry cannot put
 * one message on the wire twice. The cost is that a claimed draft whose send
 * then fails is out of the queue — acceptable when a person is watching, since
 * the failure hands the whole message back to them, and NOT acceptable when the
 * request has been abandoned and nobody will read that response.
 *
 * So this exists for exactly one caller: a batch that has claimed a draft and
 * then discovers, BEFORE anything has touched the network, that it must stop.
 * At that instant no duplicate is possible, because no message was sent.
 *
 * It must never be used to put back a draft whose send already began. Once
 * bytes have gone to a mail server, "it failed" and "it was accepted and the
 * connection dropped before it said so" are indistinguishable from here, and
 * requeueing the second one mails a stranger the same message twice.
 *
 * `id` and `createdAt` come back untouched, so the draft fingerprints exactly
 * as it did before — an approval card still on screen stays valid.
 */
export function restorePending(draft: PendingEmail): void {
  const drafts = readAll();
  // Already there: nothing to do, and re-adding would duplicate the draft in
  // the owner's queue.
  if (drafts.some((d) => d.id === draft.id)) return;
  writeAll([...drafts, draft]);
}

/** Reject. Returns false when there was nothing with that id. */
export function removePending(id: string): boolean {
  const drafts = readAll();
  const next = drafts.filter((d) => d.id !== id);
  if (next.length === drafts.length) return false;
  writeAll(next);
  return true;
}

/** Used when the account is disconnected — drafts for a dead account are noise. */
export function clearPending(): void {
  try {
    if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
  } catch {
    // best-effort
  }
}
