// /setup-api/email/pending — the owner's approval queue for outgoing mail.
//
//   GET                        list what is waiting
//   POST { action: "approve" } send it now, through the normal SMTP path
//   POST { action: "reject" }  delete it
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
import { claimPending, listPending, removePending } from "@/lib/email-pending";
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

  let body: { action?: unknown; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "A draft id is required" }, { status: 400 });

  if (action === "reject") {
    return removePending(id)
      ? NextResponse.json({ success: true, rejected: true })
      : NextResponse.json({ error: "That draft is no longer waiting.", kind: "gone" }, { status: 404 });
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
