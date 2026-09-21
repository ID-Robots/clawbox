// /setup-api/email/pending — the owner's approval queue for outgoing mail.
//
//   GET                             list what is waiting
//   POST { action: "approve" }      send one draft now, through the normal SMTP path
//   POST { action: "reject" }       delete one draft
//   POST { action: "approve_batch" } send a NAMED SET of drafts on one consent
//   POST { action: "reject_batch" }  delete a NAMED SET of drafts on one gesture
//
// WHY THE BATCH ACTION EXISTS. One draft, one click was correct and unusable:
// an agent asked to mail eight people produced eight separate approvals, and a
// person clicking eight times in a row is a person who has stopped reading. The
// chat surface now collects everything waiting into a single card that shows
// every recipient, subject and BODY in full, and asks once. The reading is the
// safety mechanism — it is what lets a human catch an injected instruction — so
// the card never degrades to "send 8 emails?" and this route never grew a "send
// everything queued" shortcut that would have made such a card optional.
//
// AUTHORIZATION IS STRICTER HERE THAN ANYWHERE ELSE IN THIS SUBTREE, and that
// is the entire point of the route. src/middleware.ts admits a caller to
// /setup-api/* on a session cookie OR the MCP bearer token. The agent holds
// that bearer. If this route accepted it, a prompt-injected agent could queue a
// draft and approve it on the next tool call — the gate would authenticate the
// exact party it exists to stop.
//
// So every method here re-checks with hasOwnerSession() and takes a session
// cookie only. See src/lib/owner-session.ts. The /setup-api/email prefix is
// already on PRE_AUTH_SENSITIVE_PREFIXES, so this is a second, narrower check
// inside a door middleware has already guarded — never a replacement for it.
//
// Approving sends through sendMail directly rather than by re-POSTing to
// /email/send: that route's hourly budget belongs to the AGENT, and the person
// at the keyboard must never be locked out of their own outbox by the agent
// having spent it (same reasoning as /email/test having its own budget).

import { NextResponse } from "next/server";
import { getEmailCredentials, toSmtpConfig } from "@/lib/email-config";
import {
  claimPending,
  claimPendingIfUnchanged,
  getPending,
  listPending,
  MAX_PENDING,
  removePending,
  restorePending,
  type PendingEmail,
} from "@/lib/email-pending";
// A draft that leaves the queue leaves a receipt behind it, so the surfaces
// that had it on screen can say what became of it instead of going on offering
// an Approve button for a message that is already sent. See email-outcomes.ts.
import {
  getOutcome,
  listOutcomes,
  outcomeKindFor,
  recordOutcome,
  resolveSent,
  type EmailOutcomeKind,
} from "@/lib/email-outcomes";
// A draft decided here must not leave a live button in the owner's chat. The
// button could not send it twice — claimPending already made that impossible —
// but a control whose only possible answer is "that is no longer waiting" is a
// control that should not still be there.
import { retireChatPrompt } from "@/lib/email-approval";
import { hasOwnerSession } from "@/lib/owner-session";
import { sendMail, SmtpError } from "@/lib/smtp-client";

export const dynamic = "force-dynamic";

/**
 * The refusal every non-owner caller gets. Deliberately identical whether the
 * caller sent no credential or a perfectly valid MCP bearer: "your token works
 * elsewhere but not here" is a hint worth not giving.
 */
function forbidden() {
  return NextResponse.json(
    { error: "Approving email needs a signed-in browser session.", kind: "owner_only" },
    { status: 403 },
  );
}

export async function GET(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();
  try {
    // Both halves in one answer, deliberately: a surface that read the queue
    // and the receipts in two requests could see a draft in neither, and would
    // render the one state that is never true — nothing at all.
    return NextResponse.json({ pending: listPending(), outcomes: listOutcomes() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the approval queue" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();

  let body: { action?: unknown; id?: unknown; drafts?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "approve_batch") return approveBatch(request, body.drafts);
  if (action === "reject_batch") return rejectBatch(body.drafts);

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "A draft id is required" }, { status: 400 });

  if (action === "reject") {
    // Read before the remove so the receipt can name the message. Both calls
    // are synchronous with nothing between them, which is what keeps the
    // removal itself the single atomic step the queue documents.
    const doomed = getPending(id);
    if (!removePending(id)) return staleAnswer(id);
    // Deliberately does NOT resolve duplicates. Nothing was delivered, so
    // nothing is covered — and deleting a message the owner did not point at
    // is not this route's to do.
    if (doomed) recordOutcome(doomed, "rejected");
    await retireChatPrompt(id);
    return NextResponse.json({ success: true, rejected: true });
  }

  if (action !== "approve") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const settings = await getEmailCredentials();
  if (!settings) {
    return NextResponse.json(
      { error: "This device has no email account connected.", kind: "unconfigured" },
      { status: 409 },
    );
  }

  // Claim BEFORE sending: read-and-remove in one step, so a double click or a
  // retry cannot put the same message on the wire twice. The cost is that a
  // draft whose send then fails is gone from the queue — which is why the
  // failure response below hands the whole message back, so nothing the owner
  // approved is lost to a transient SMTP error.
  const draft = claimPending(id);
  if (!draft) return staleAnswer(id);
  // After the claim and before the send: the draft can no longer be sent by a
  // tap, so the button is already dead and taking it away now is honest either
  // way the send goes.
  await retireChatPrompt(draft.id);

  try {
    const { messageId } = await sendMail(
      toSmtpConfig(settings),
      {
        from: settings.address,
        fromName: settings.fromName || "ClawBox",
        to: draft.to,
        subject: draft.subject,
        text: draft.body,
      },
      { signal: request.signal },
    );
    // Past the wire, so the twins really are covered. Their buttons go too,
    // and their receipts are what tells the owner where they went.
    for (const twin of resolveSent(draft)) await retireChatPrompt(twin.id);
    return NextResponse.json({ success: true, approved: true, messageId, recipients: draft.to.length });
  } catch (err) {
    const kind = err instanceof SmtpError ? err.kind : "network";
    const error = err instanceof SmtpError ? err.message : "Could not send the message.";
    // The draft is out of the queue and no twin is touched — nothing is covered
    // by a send that did not happen. WHICH failure it was decides what the
    // receipt may claim: a refusal the mail server spoke is "not sent", while a
    // dropped connection is a thing this process cannot know either way, and
    // saying "not sent" there is how an owner is talked into sending twice.
    //
    // COMPUTED ONCE AND SENT BACK, not just written down. The receipt and the
    // answer are this one request's two statements about one message, and they
    // used to disagree: the receipt said `unconfirmed` while the response said
    // only "send_failed", which every surface renders as a definite failure.
    // Two screens contradicting each other about mail that may well have gone
    // out is how an owner is talked into sending it twice.
    console.error(`[email/pending] approved send failed: kind=${kind} host=${settings.smtpHost}`);
    const ending = outcomeKindFor(err);
    recordOutcome(draft, ending, { error });
    return NextResponse.json(
      {
        error,
        kind,
        ending,
        // The draft is already out of the queue — return it so the panel can
        // show what was lost rather than silently swallowing the owner's mail.
        draft: { to: draft.to, subject: draft.subject, body: draft.body },
      },
      { status: 502 },
    );
  }
}

// ── One gesture, a named set of drafts thrown away ───────────────────────────

/**
 * Delete exactly the drafts named, and say what became of each one.
 *
 * WHY THIS EXISTS. The chat card's "Send nothing" used to be a client-side
 * gesture: it dropped the card from the browser's state and left every draft in
 * the queue, so the surface's next visibility-gated read found them and offered
 * them again fifteen seconds later. The owner's words were "when I click
 * dismiss nothing happens; it returns after 20 secs", and he was describing the
 * mechanism exactly. A control whose only effect is to hide itself until the
 * next poll is not a control.
 *
 * FROZEN, exactly as approving is, and for the mirrored reason. The entries
 * carry the fingerprint each draft was shown with, so a draft queued while the
 * owner was reading is not in the list and cannot be swept up by a gesture
 * aimed at what was on screen — and a draft whose text moved is refused rather
 * than deleted, because throwing away words the owner never read is the same
 * failure as sending them.
 *
 * Nothing here touches the network or needs a mail account: an owner whose
 * provider is down must still be able to empty their own queue.
 */
async function rejectBatch(raw: unknown): Promise<NextResponse> {
  const parsed = parseBatch(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const results: RejectOutcome[] = [];
  for (const entry of parsed.entries) {
    const claim = claimPendingIfUnchanged(entry.id, entry.fingerprint);
    if (!claim.ok) {
      results.push(
        claim.reason === "gone"
          ? whatBecameOf(entry.id)
          : {
              id: entry.id,
              ok: false,
              reason: "changed",
              error: "That draft changed after it was shown, so it was not deleted.",
            },
      );
      continue;
    }
    // Deliberately NOT resolveSent's duplicate sweep: nothing was delivered, so
    // nothing is covered, and a twin the owner did not name is still theirs.
    recordOutcome(claim.draft, "rejected");
    await retireChatPrompt(claim.draft.id);
    results.push({ id: claim.draft.id, ok: true });
  }

  const rejected = results.filter((r) => r.ok).length;
  // A draft the store had already answered for — sent, deleted, refused,
  // covered — is not a failure to delete. It is not waiting any more, which is
  // what the gesture was for, and the receipt says which ending it had. Counted
  // apart, the same way approveBatch counts its duplicates apart: reporting it
  // among the failures would put a red verdict on a card where nothing went
  // wrong, which is the reading that trains an owner to ignore the line.
  // EVERY ending, deliberately — and deliberately unlike `approveBatch`, which
  // counts only the two that mean the message arrived. The gesture here is
  // "stop waiting for this", and a draft that was sent, refused, deleted or
  // left unconfirmed is not waiting under any of them.
  const resolved = results.filter((r) => !r.ok && r.ending !== undefined).length;
  // What is left is a real refusal: a draft whose text moved, or one that left
  // the queue with no word about it at all.
  const failed = results.length - rejected - resolved;
  // 207 for anything short of everything, the same rule approveBatch keeps: a
  // caller reading only the status line must not mistake "one of two" for done.
  return NextResponse.json(
    { success: failed === 0, rejected, resolved, failed, results },
    { status: failed === 0 ? 200 : 207 },
  );
}

/**
 * A row for a draft that was already out of the queue when the gesture landed.
 *
 * "No longer waiting" was all this used to say, and it is the least useful true
 * sentence available: the draft may have been SENT from Settings a minute ago,
 * refused by the mail server, deleted on Telegram, or covered by an identical
 * message. The receipts know which — and the card settles on this answer, after
 * which no later poll can correct it, so a vague word here is permanent.
 *
 * So the receipt is read and its ending travels back. `ok` is true only for a
 * send: everything else did not reach anybody, whatever the reason.
 */
function whatBecameOf(id: string): GoneOutcome {
  const receipt = getOutcome(id);
  if (!receipt) {
    return { id, ok: false, reason: "gone", error: "That draft is no longer waiting." };
  }
  return {
    id,
    // Never true, whatever the receipt says: THIS request did not send and did
    // not delete it. What the ending was is `ending`, and the surface renders
    // that; the counters here stay about what this gesture actually did.
    ok: false,
    reason: receipt.kind === "duplicate" ? "duplicate" : "gone",
    ending: receipt.kind,
    at: receipt.at,
    error: receipt.error ?? endingSentence(receipt.kind),
  };
}

/**
 * The single-draft answer for a decision that had already been made elsewhere.
 *
 * THE SAME RECEIPT THE BATCH PATHS READ, and it is the sibling call site this
 * codebase keeps leaving unguarded. `approveBatch` and `rejectBatch` were
 * taught to ask `whatBecameOf`; these two branches, sixty lines away, went on
 * answering the bare "That draft is no longer waiting." — and their only caller
 * is Settings → Email, which paints any non-OK answer red.
 *
 * The owner tapped *Approve & send* in Telegram, the message went out, and the
 * desktop row was still on screen because the queue is re-read on a schedule.
 * Clicking Approve there produced a red error over a send that succeeded, next
 * to a green "Sent ✓" in the handled strip below it — one message, two verdicts,
 * and the red one is the one he acts on.
 *
 * Still a 404: the request really did not do anything, and a caller reading the
 * status line must not be told otherwise. What changes is that the body now
 * says WHICH ending it was, so the surface can tell "already sent" from "the
 * mail server refused it" instead of rendering both as a failure of the click.
 */
function staleAnswer(id: string): NextResponse {
  const became = whatBecameOf(id);
  return NextResponse.json(
    {
      error: became.error,
      // Unchanged, and deliberately: `kind` here is the REFUSAL vocabulary the
      // single-draft path has always spoken ("gone", "unconfigured",
      // "owner_only"), not the receipt's. The ending rides beside it.
      kind: "gone",
      // The ending and nothing else. The receipt's timestamp is deliberately
      // NOT copied here: the handled strip already renders it from the receipt
      // in the next queue read, and a second source for one fact is how two
      // surfaces come to disagree about when a message went.
      ...(became.ending ? { ending: became.ending } : {}),
    },
    { status: 404 },
  );
}

/**
 * What to say about an ending, for a caller that renders no words of its own.
 *
 * Every kind gets a case and there is no `default`: the compiler then refuses a
 * new `EmailOutcomeKind` that nobody worded, rather than letting it fall
 * through to a sentence that contradicts the `ending` on its own row.
 */
function endingSentence(kind: EmailOutcomeKind): string {
  switch (kind) {
    case "sent":
      return "That message was already sent.";
    case "rejected":
      return "That draft was deleted.";
    case "duplicate":
      return "An identical message was sent, so this copy was not sent again.";
    case "failed":
      // Reached only when the receipt carried no words of its own, which
      // `recordOutcome` allows for an empty error string.
      return "That message was not sent: the mail server refused it.";
    case "unconfirmed":
      return "That message was handed to the mail server and the answer never came back.";
  }
}

/**
 * A row for a draft that had already left the queue, and what became of it.
 *
 * `ending` is the receipt's word, absent only when there is no receipt — it
 * expired, or the draft was decided by a build older than this one.
 */
type GoneOutcome = {
  id: string;
  ok: false;
  reason: "gone" | "changed" | "duplicate";
  ending?: EmailOutcomeKind;
  at?: number;
  error: string;
};

/** One row of a delete: this request removed it, or it had already gone. */
type RejectOutcome = { id: string; ok: true } | GoneOutcome;

// ── One consent, a named set of drafts ───────────────────────────────────────

/** One entry of the frozen set: which draft, and what it said when it was read. */
interface BatchEntry {
  id: string;
  fingerprint: string;
}

/**
 * What happened to one draft. Reported per draft and never summed into a
 * verdict, because the summing is where the lie gets in: this codebase has
 * already shipped one `{ restarted: true }` for a restart that failed, and a
 * batch that reports "sent" while two messages never left is the same bug with
 * more at stake — the owner believes eight people heard from him.
 */
type BatchOutcome =
  | { id: string; ok: true; recipients: number; messageId?: string }
  /**
   * A draft that was already out of the queue. "duplicate" is deliberately its
   * own reason and NOT a failure: an identical message reached the recipient,
   * so the copy was resolved rather than mailed twice. Reporting it among the
   * failures put a red "not sent" on a card where nothing went wrong — the
   * false FAILURE that mirrors the `{ restarted: true }` this route's header
   * warns about.
   */
  | GoneOutcome
  | {
      id: string;
      ok: false;
      reason: "send_failed";
      error: string;
      /** The SMTP failure's own kind — "auth", "network", … — never an ending. */
      kind?: string;
      /**
       * What the RECEIPT says, which is the only one of the two words a surface
       * may render. "failed" is a refusal the mail server spoke; "unconfirmed"
       * is a silence this box cannot read either way, and rendering that as a
       * failure is what makes an owner send the message a second time.
       */
      ending: "failed" | "unconfirmed";
      /** Returned for a draft that was claimed and then failed — see below. */
      draft?: { to: string[]; subject: string; body: string };
    };

/**
 * The set the owner actually read, or a 400 saying why it is not one.
 *
 * Every rule here is about the card being a faithful record of a decision: a duplicate
 * id would send one message twice off one tick, an entry with no fingerprint
 * could not be checked against what was on screen, and a list longer than the
 * queue can hold did not come from a queue.
 */
function parseBatch(raw: unknown): { ok: true; entries: BatchEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "A batch needs at least one draft" };
  }
  if (raw.length > MAX_PENDING) {
    return { ok: false, error: `At most ${MAX_PENDING} drafts may be approved at once` };
  }
  const entries: BatchEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { ok: false, error: "Invalid draft entry" };
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const fingerprint = typeof row.fingerprint === "string" ? row.fingerprint : "";
    if (!id || !fingerprint) return { ok: false, error: "Each draft needs an id and a fingerprint" };
    if (seen.has(id)) return { ok: false, error: "The same draft appears twice in the batch" };
    seen.add(id);
    entries.push({ id, fingerprint });
  }
  return { ok: true, entries };
}

/**
 * Send exactly the drafts named, and say what became of each one.
 *
 * FROZEN, NOT "EVERYTHING WAITING". The card lists ids and fingerprints and
 * this function sends nothing that is not in that list. A draft the agent
 * queued while the owner was reading is therefore still queued afterwards —
 * which is the property the whole design turns on, because the alternative is
 * mailing text that was never on a screen.
 *
 * SEQUENTIAL, not `Promise.all`. Every send opens its own SMTP connection, and
 * twenty at once on a Jetson against a provider that rate-limits connections is
 * a way to turn a working batch into a partial one. The owner made one gesture;
 * a few seconds spent honouring it in order costs nothing.
 *
 * CLAIM BEFORE SEND, per draft, exactly as the single-draft path does: a draft
 * is read-and-removed and only then handed to the SMTP client, so a retry or a
 * double click cannot put the same message on the wire twice. The cost is the
 * same one documented there — a draft whose send fails is out of the queue — so
 * the failure carries the whole message back, and nothing the owner approved is
 * lost to a transient error.
 */
async function approveBatch(request: Request, raw: unknown): Promise<NextResponse> {
  const parsed = parseBatch(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const settings = await getEmailCredentials();
  if (!settings) {
    return NextResponse.json(
      { error: "This device has no email account connected.", kind: "unconfigured" },
      { status: 409 },
    );
  }
  const smtp = toSmtpConfig(settings);
  const results: BatchOutcome[] = [];

  for (const entry of parsed.entries) {
    // The owner's browser went away mid-batch. Stop rather than keep mailing on
    // behalf of a tab that is gone: nothing here has been claimed yet, so what
    // is left stays queued, and unsent is the recoverable direction. Nothing is
    // recorded for the rest — an aborted request has no reader.
    if (request.signal.aborted) break;

    const claim = claimPendingIfUnchanged(entry.id, entry.fingerprint);
    if (!claim.ok) {
      // A draft can be "gone" because an EARLIER entry in this very batch was
      // its identical twin and covered it, or because another surface decided
      // it while the card sat on screen. "No longer waiting" over all of those
      // is the least useful true sentence available — and the card settles on
      // it, after which no poll can correct it. The receipt knows which ending
      // it was, so it is asked, and the answer travels back with the row.
      // Never as a SEND, though: this request sent nothing of the kind.
      results.push(
        claim.reason === "gone"
          ? whatBecameOf(entry.id)
          : {
              id: entry.id,
              ok: false,
              reason: "changed",
              error: "That draft changed after it was shown, so it was not sent.",
            },
      );
      continue;
    }

    const draft: PendingEmail = claim.draft;

    // Claimed, but the tab went away in the moment between the claim and the
    // first byte. Nothing has reached a mail server, so putting the draft back
    // cannot duplicate anything — and NOT putting it back would delete a
    // message the owner never got told about, because an abandoned request has
    // no reader for the response that would have carried it.
    //
    // The window this closes is the safe one. An abort that lands once the send
    // is already in flight is deliberately NOT recovered: from here "it failed"
    // and "the server took it and the connection dropped before saying so" look
    // identical, and requeueing the second one mails a stranger twice. Never
    // sending twice is the invariant the single-draft path documents too.
    if (request.signal.aborted) {
      restorePending(draft);
      break;
    }
    // Only now, past the point where restorePending could put it back: a draft
    // that goes back into the queue keeps its chat button, because it is still
    // waiting and the owner can still answer it.
    await retireChatPrompt(draft.id);

    try {
      const { messageId } = await sendMail(
        smtp,
        {
          from: settings.address,
          fromName: settings.fromName || "ClawBox",
          to: draft.to,
          subject: draft.subject,
          text: draft.body,
        },
        { signal: request.signal },
      );
      // Same settlement the single-draft path makes, and it matters more here:
      // the twin is usually ON THIS VERY CARD. The pair the owner met came from
      // one request, so both rows say the same words to the same people and he
      // cannot tell them apart — ticking both is one decision about one
      // message, not two. Resolving here is what stops the next iteration of
      // this loop from mailing it a second time; the entry is answered
      // "duplicate" below, out of the failures.
      for (const twin of resolveSent(draft)) await retireChatPrompt(twin.id);
      results.push({ id: draft.id, ok: true, recipients: draft.to.length, ...(messageId ? { messageId } : {}) });
    } catch (err) {
      const kind = err instanceof SmtpError ? err.kind : "network";
      const error = err instanceof SmtpError ? err.message : "Could not send the message.";
      // Never the recipient, never the subject, never a line of the body: this
      // log is the one part of an approved send that outlives the request.
      console.error(`[email/pending] batch send failed: kind=${kind} host=${settings.smtpHost}`);
      // One judgement, written to the receipt AND carried on the row — see the
      // single-draft catch above for why the two must not be allowed to drift.
      const ending = outcomeKindFor(err);
      recordOutcome(draft, ending, { error });
      results.push({
        id: draft.id,
        ok: false,
        reason: "send_failed",
        error,
        kind,
        ending,
        draft: { to: draft.to, subject: draft.subject, body: draft.body },
      });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  // Counted apart from the failures, and out of the 207: a copy that needed no
  // send of its own is not something that went wrong, and a status line that
  // called it one would train the owner to ignore the line that matters.
  const duplicates = results.filter((r) => !r.ok && r.reason === "duplicate").length;
  /**
   * Sent somewhere else, with a receipt to prove it.
   *
   * The draft went out from Settings or from Telegram while the card sat on
   * screen. Nothing went wrong — the words reached the recipient, which is what
   * the gesture asked for — so counting it among the failures put a red verdict
   * and a 207 on a batch where every message arrived.
   *
   * NAMED ENDINGS, NOT "has an ending", and both halves of that are
   * load-bearing.
   *
   *   `reason === "gone"` keeps `send_failed` rows out: they carry an `ending`
   *   too now, and a predicate that only asked whether one was present would
   *   swallow the very failures this count exists to leave alone.
   *
   *   The KIND check keeps the other three out. `whatBecameOf` says "gone" for
   *   `rejected`, `failed` and `unconfirmed` as well, and under every one of
   *   those the message reached nobody. Subtracting them from `failed` would
   *   answer `success: true` and a 200 over a batch containing a draft the mail
   *   server refused — a caller reading only the status line would conclude
   *   both messages went, which is the one reading this route's header says
   *   must never be possible.
   *
   * `sent` IS THE WHOLE LIST, and deliberately: `whatBecameOf` answers
   * `reason: "duplicate"` for a duplicate receipt, so a row can never be both
   * "gone" and `ending: "duplicate"`, and `duplicates` above counts those. A
   * second clause for them here would be dead today and a double count the day
   * that mapping moved — `failed` is a subtraction, so one row in two buckets
   * takes it negative.
   *
   * And RECEIPT-BACKED throughout: a draft that left the queue with nothing
   * recorded about it is an unknown, not a resolution, and it stays in `failed`.
   *
   * `rejectBatch` deliberately does NOT narrow this way, and the two siblings
   * are supposed to differ: that gesture asks for the draft not to be waiting,
   * and under EVERY ending it is not waiting. Harmonising them would be wrong
   * in one direction or the other.
   */
  const resolved = results.filter((r) => !r.ok && r.reason === "gone" && r.ending === "sent").length;
  const failed = results.length - sent - duplicates - resolved;
  // Entries the loop never reached, because the request was abandoned partway.
  // Counted rather than ignored: with an empty `results` — an abort before the
  // FIRST send — `failed === 0` is true and nothing was sent, so a verdict
  // resting on `failed` alone would call a batch that did nothing a success.
  // That is the precise bug this route exists not to have.
  const skipped = parsed.entries.length - results.length;
  const everythingWent = failed === 0 && skipped === 0;
  // 207 for anything short of everything. A caller that reads only the status
  // line must not be able to mistake "six of eight" for success — which is
  // precisely the reading a 200 invites.
  return NextResponse.json(
    { success: everythingWent, approved: true, sent, failed, duplicates, resolved, skipped, results },
    { status: everythingWent ? 200 : 207 },
  );
}
