// /setup-api/email/pending — the owner's approval queue for outgoing mail.
//
//   GET                             list what is waiting
//   POST { action: "approve" }      send one draft now, through the normal SMTP path
//   POST { action: "reject" }       delete one draft
//   POST { action: "approve_batch" } send a NAMED SET of drafts on one consent
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
  listPending,
  MAX_PENDING,
  removePending,
  restorePending,
  type PendingEmail,
} from "@/lib/email-pending";
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
    return NextResponse.json({ pending: listPending() });
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

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "A draft id is required" }, { status: 400 });

  if (action === "reject") {
    if (!removePending(id)) {
      return NextResponse.json({ error: "That draft is no longer waiting.", kind: "gone" }, { status: 404 });
    }
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
  if (!draft) {
    return NextResponse.json({ error: "That draft is no longer waiting.", kind: "gone" }, { status: 404 });
  }
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
    return NextResponse.json({ success: true, approved: true, messageId, recipients: draft.to.length });
  } catch (err) {
    const kind = err instanceof SmtpError ? err.kind : "network";
    console.error(`[email/pending] approved send failed: kind=${kind} host=${settings.smtpHost}`);
    return NextResponse.json(
      {
        error: err instanceof SmtpError ? err.message : "Could not send the message.",
        kind,
        // The draft is already out of the queue — return it so the panel can
        // show what was lost rather than silently swallowing the owner's mail.
        draft: { to: draft.to, subject: draft.subject, body: draft.body },
      },
      { status: 502 },
    );
  }
}

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
  | {
      id: string;
      ok: false;
      reason: "gone" | "changed" | "send_failed";
      error: string;
      kind?: string;
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
      results.push({
        id: entry.id,
        ok: false,
        reason: claim.reason,
        error:
          claim.reason === "gone"
            ? "That draft is no longer waiting."
            : "That draft changed after it was shown, so it was not sent.",
      });
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
      results.push({ id: draft.id, ok: true, recipients: draft.to.length, ...(messageId ? { messageId } : {}) });
    } catch (err) {
      const kind = err instanceof SmtpError ? err.kind : "network";
      const error = err instanceof SmtpError ? err.message : "Could not send the message.";
      // Never the recipient, never the subject, never a line of the body: this
      // log is the one part of an approved send that outlives the request.
      console.error(`[email/pending] batch send failed: kind=${kind} host=${settings.smtpHost}`);
      results.push({
        id: draft.id,
        ok: false,
        reason: "send_failed",
        error,
        kind,
        draft: { to: draft.to, subject: draft.subject, body: draft.body },
      });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
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
    { success: everythingWent, approved: true, sent, failed, skipped, results },
    { status: everythingWent ? 200 : 207 },
  );
}
