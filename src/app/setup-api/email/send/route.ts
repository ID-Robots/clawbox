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
// The budget below is the containment that does apply. It is a blast-radius
// limit, not consent: it cannot stop the first injected message, it bounds a
// runaway or a mass-mail to a few messages an hour. Enforced HERE rather than
// in the MCP tool because this is where the credentials are — a compromised or
// re-implemented MCP client cannot route around it.
//
// The owner's own "Send test email" button is /email/test, a different route
// with its own budget, so the person at the keyboard is never locked out by the
// agent having spent this one.

import { NextResponse } from "next/server";
import { getEmailCredentials, toSmtpConfig } from "@/lib/email-config";
import { checkRateLimit } from "@/lib/rate-limit";
import { isEmailAddress, isHeaderSafe, sendMail, SmtpError } from "@/lib/smtp-client";

export const dynamic = "force-dynamic";

const MAX_RECIPIENTS = 10;
const MAX_SUBJECT_LEN = 200;
const MAX_BODY_LEN = 20_000;

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

    if (!checkRateLimit("email-send", SEND_BUDGET_KEY, SEND_BUDGET)) {
      console.error("[email/send] refused: agent send budget exhausted");
      return NextResponse.json(
        {
          error: `This ClawBox has already sent ${SEND_BUDGET.max} emails in the last hour and will not send more for now.`,
          kind: "rate_limited",
        },
        { status: 429 },
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
      return NextResponse.json({ success: true, messageId, recipients: recipients.length });
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
