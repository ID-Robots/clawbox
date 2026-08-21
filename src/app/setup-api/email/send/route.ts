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

import { NextResponse } from "next/server";
import { getEmailCredentials, toSmtpConfig } from "@/lib/email-config";
import { isEmailAddress, isHeaderSafe, sendMail, SmtpError } from "@/lib/smtp-client";

export const dynamic = "force-dynamic";

const MAX_RECIPIENTS = 10;
const MAX_SUBJECT_LEN = 200;
const MAX_BODY_LEN = 20_000;

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

    try {
      const { messageId } = await sendMail(toSmtpConfig(settings), {
        from: settings.address,
        fromName: settings.fromName || "ClawBox",
        to: recipients,
        subject,
        text,
      });
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
