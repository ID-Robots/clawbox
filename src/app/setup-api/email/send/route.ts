// POST /setup-api/email/send — the backend behind the `email_send` MCP tool.
//
// It exists so the MCP server stays a thin caller of the device's own API
// (mcp/README.md's rule) instead of carrying a second copy of the SMTP client
// and a second reader of the credential store.
//
// It is NOT a general mail API: the sender is always the configured account,
// the body is plain text, there are no attachments, and the whole route sits
// behind the session/MCP-bearer gate in src/middleware.ts (the /setup-api/email
// subtree is on the pre-auth sensitive list, so it is unreachable during the
// open-AP setup window).
//
// CONTAINMENT — READ THIS BEFORE RELAXING THE BUDGET BELOW.
// There is NO human in the loop on a ClawBox. ClawBox registers its MCP server
// into Hermes with `trust: full` (scripts/register-mcp.sh), deliberately: the
// appliance agent runs headless and one-shot, so an approval prompt would have
// nobody to answer it and would hang the turn. So `email_send` executes
// unsupervised, and its arguments can originate in text the agent merely READ —
// a web page, a file, an inbound message. A sent email cannot be recalled.
//
// TWO DIFFERENT THINGS GUARD THIS ROUTE, and they are not interchangeable:
//
//   The BUDGET below is a blast-radius limit. It cannot stop the first injected
//   message; it bounds a runaway or a mass-mail to a few messages an hour.
//
//   The APPROVAL GATE (settings.askBeforeSend, default ON for new accounts) is
//   actual consent: with it on, this route never reaches the SMTP client at all
//   — the message becomes a draft the owner approves by hand in Settings. It is
//   the answer to "not send emails without my permission"; the budget never was.
//
// Both are enforced HERE rather than in the MCP tool because this is where the
// credentials are — a compromised or re-implemented MCP client cannot route
// around either one. The budget still applies with the gate on: queueing is
// cheap but not free, and 5 drafts an hour is already more than a person wants
// to triage.
//
// The owner's own "Send test email" button is /email/test, a different route
// with its own budget, so the person at the keyboard is never locked out by the
// agent having spent this one.

import { NextResponse } from "next/server";
import { getEmailCredentials, toSmtpConfig } from "@/lib/email-config";
import { notifyOwner } from "@/lib/email-notify";
import { OPEN_EMAIL_SETTINGS } from "@/lib/notify-action";
// Asking in chat is a NOTIFICATION, not a second gate: it posts the draft and a
// button to a bot ClawBox owns exclusively. Nothing this route returns can
// approve anything, and the agent reading the answer cannot press the button.
// See src/lib/email-approval.ts.
import { sendApprovalPrompt } from "@/lib/email-approval";
import { OFFER_BUDGET_MS, offerReplyApproval } from "@/lib/email-approval-reply";
// The message limits live with the queue that has the final say on them, so a
// route that accepts a message the queue then refuses cannot drift into
// existence — the caller would have spent the send budget on a 400.
import {
  MAX_BODY_LEN,
  MAX_RECIPIENTS,
  MAX_SUBJECT_LEN,
  queuePending,
} from "@/lib/email-pending";
import { checkRateLimit } from "@/lib/rate-limit";
import { isEmailAddress, isHeaderSafe, sendMail, SmtpError } from "@/lib/smtp-client";

export const dynamic = "force-dynamic";


/**
 * One shared budget for the whole device, not per client IP: the caller is
 * always the agent on loopback, so an IP key would be a single bucket wearing a
 * misleading name — and `x-forwarded-for` is client-controlled here anyway
 * (see src/lib/rate-limit.ts).
 */
const SEND_BUDGET = { windowMs: 60 * 60 * 1000, max: 5 } as const;
const SEND_BUDGET_KEY = "agent";

export async function POST(request: Request) {
  try {
    let body: { to?: unknown; subject?: unknown; body?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const recipients = (typeof body.to === "string" ? body.to.split(/[,;\s]+/) : [])
      .map((r) => r.trim())
      .filter(Boolean);
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const text = typeof body.body === "string" ? body.body : "";

    if (recipients.length === 0) return NextResponse.json({ error: "A recipient is required" }, { status: 400 });
    if (recipients.length > MAX_RECIPIENTS) {
      return NextResponse.json({ error: `At most ${MAX_RECIPIENTS} recipients` }, { status: 400 });
    }
    for (const recipient of recipients) {
      if (!isEmailAddress(recipient)) {
        return NextResponse.json({ error: `"${recipient}" is not a valid email address` }, { status: 400 });
      }
    }
    if (!subject) return NextResponse.json({ error: "A subject is required" }, { status: 400 });
    if (subject.length > MAX_SUBJECT_LEN || !isHeaderSafe(subject)) {
      return NextResponse.json({ error: "Subject is too long or contains line breaks" }, { status: 400 });
    }
    if (!text) return NextResponse.json({ error: "A message body is required" }, { status: 400 });
    if (text.length > MAX_BODY_LEN) {
      return NextResponse.json({ error: "Message body is too long" }, { status: 400 });
    }

    const settings = await getEmailCredentials();
    if (!settings) {
      return NextResponse.json(
        {
          error:
            "Email is not set up on this device. The owner has to add an email account in Settings → Email first.",
          kind: "unconfigured",
        },
        { status: 409 },
      );
    }

    // The budget bounds what the AGENT may ask for, and it is spent here — on
    // the request — rather than on a message leaving the box. That is why it
    // does not say "sent": under the approval gate nothing has been, and a
    // retry that folds into the draft already waiting still costs a slot. Both
    // readings err the same way, towards fewer emails, which is the safe
    // direction for a bound on mail the owner did not type.
    if (!checkRateLimit("email-send", SEND_BUDGET_KEY, SEND_BUDGET)) {
      console.error("[email/send] refused: agent send budget exhausted");
      return NextResponse.json(
        {
          error: `This ClawBox has already handled ${SEND_BUDGET.max} email requests from the assistant in the last hour and will not take more for now.`,
          kind: "rate_limited",
        },
        { status: 429 },
      );
    }

    // THE APPROVAL GATE. Nothing above this point has touched the network, and
    // nothing below it runs when the owner has asked to be asked: the message
    // becomes a draft on disk and the agent is told so. See email-pending.ts
    // for why consent here is asynchronous rather than a prompt.
    if (settings.askBeforeSend) {
      const queued = queuePending({ to: recipients, subject, body: text });
      if (!queued.ok) {
        console.error(`[email/send] not queued: reason=${queued.reason}`);
        return NextResponse.json(
          { error: queued.error, kind: queued.reason === "full" ? "queue_full" : "invalid" },
          { status: queued.reason === "full" ? 429 : 400 },
        );
      }
      // A retry of a call that had already landed. Nothing new was written and
      // nothing new is asked about — sendApprovalPrompt below is idempotent per
      // draft — so this is logged and reported, never treated as a second
      // message. See DEDUPE_WINDOW_MS for why the queue can say this.
      if (queued.deduped) {
        console.error("[email/send] folded into the identical draft already waiting");
      }
      // Ask in chat when the owner has turned that on. Awaited rather than
      // fired and forgotten because the answer below has to be TRUE: an agent
      // told "I asked them on Telegram" when Telegram was unreachable will tell
      // the person the same thing, and they will wait for a message that never
      // arrives. Never throws; see sendApprovalPrompt.
      // ONE CLOCK OVER BOTH FAN-OUTS. `email_send` waits 60 s for this request
      // and two of them can happen inside it — the approvals bot's, and then
      // the reply path's when that one delivered nothing. Serially, on an
      // unreachable Telegram, they can outlast the caller, and a caller that
      // times out over a draft that WAS queued is a false failure. The first
      // fan-out is not this change's and is not bounded here; the second is,
      // and it is the one that would push the total over.
      const askingSince = Date.now();
      const prompt = await sendApprovalPrompt(queued.draft);
      // ...and, when that did not put a question in front of him, ask in the
      // conversation he is already in. Second, never instead: an approvals bot
      // gives him a BUTTON, and a device that has one should not also send a
      // line to type. It self-sequences rather than branching on a flag —
      // `offerReplyApproval` shares the one prompt-per-draft store, so a
      // question the approvals bot has just posted is found and nothing is sent
      // — which also means a prompt that FAILED to deliver falls through to
      // here rather than leaving the owner with nothing at all.
      //
      // Awaited for the same reason the line above is: the agent is told which
      // question was actually asked, and an agent told the wrong one tells the
      // person to look somewhere nothing arrived.
      const reply = queued.deduped
        ? null
        : await offerReplyApproval(queued.draft, askingSince + OFFER_BUDGET_MS);
      // Best effort: a notification that does not appear must not turn a
      // successfully-queued draft into a failed send.
      //
      // NOT on a fold. There is no new draft to be told about, and a second
      // "the assistant wants to send an email" toast for one message is the
      // duplicate this whole change exists to stop, wearing a different coat.
      // (`sendApprovalPrompt` above is already idempotent per draft; this was
      // the half that was not.)
      if (!queued.deduped) {
        // With the destination, the toast's body is the way in: clicking it
        // opens Settings on the Email section rather than leaving the owner to
        // find it. Allowlisted, never a free-form target — see notify-action.ts.
        await notifyOwner(
          `The assistant wants to send an email. Open Settings → Email to approve or delete it.`,
          OPEN_EMAIL_SETTINGS,
        ).catch(() => undefined);
      }
      console.error(`[email/send] queued for owner approval (chat prompt: ${prompt.kind})`);
      return NextResponse.json(
        {
          success: true,
          queued: true,
          // True when this call added nothing: the id is a draft that was
          // already waiting. The agent has to be told, or it reports two
          // messages queued when there is one.
          duplicate: queued.deduped,
          pendingId: queued.draft.id,
          recipients: recipients.length,
          // What the agent may say to the person. A kind, never a chat id and
          // never the code — there is nothing here the agent can act on, and
          // the code is the owner's to type, not the agent's to relay.
          approvalPrompt: prompt.kind,
          // Whether the owner can answer by REPLYING in this conversation.
          // Deliberately not the code itself: an agent that could read it could
          // repeat it back, and a person could not then tell his own approval
          // from one composed for him.
          replyApproval: reply?.kind ?? "off",
        },
        { status: 202 },
      );
    }

    try {
      const { messageId } = await sendMail(
        toSmtpConfig(settings),
        {
          from: settings.address,
          fromName: settings.fromName || "ClawBox",
          to: recipients,
          subject,
          text,
        },
        { signal: request.signal },
      );
      return NextResponse.json({ success: true, queued: false, messageId, recipients: recipients.length });
    } catch (err) {
      if (err instanceof SmtpError) {
        console.error(`[email/send] send failed: kind=${err.kind} host=${settings.smtpHost}`);
        return NextResponse.json({ error: err.message, kind: err.kind }, { status: 502 });
      }
      console.error("[email/send] send failed: kind=unknown");
      return NextResponse.json({ error: "Could not send the message.", kind: "network" }, { status: 502 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Send failed" },
      { status: 500 },
    );
  }
}
