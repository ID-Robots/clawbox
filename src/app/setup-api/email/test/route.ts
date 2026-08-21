// POST /setup-api/email/test — really send one message, to the user's own
// address, over the configured SMTP server.
//
// This is the button that turns "it saved" into "it works". Authentication
// already passed at configure time; what this proves in addition is that the
// provider will ACCEPT a message from this device — a separate failure mode
// (Gmail refusing a From: that isn't the signed-in account, a provider blocking
// a residential IP, a relay that authenticates everyone and delivers nothing).
//
// The recipient is fixed to the configured account. A caller-supplied recipient
// would turn a Settings button into an open relay for anything that can reach
// the route.

import { NextResponse } from "next/server";
import { getEmailCredentials, toSmtpConfig } from "@/lib/email-config";
import { sendMail, SmtpError } from "@/lib/smtp-client";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const settings = await getEmailCredentials();
    if (!settings) {
      return NextResponse.json(
        { error: "Email is not set up on this device yet.", kind: "unconfigured" },
        { status: 400 },
      );
    }

    const now = new Date();
    try {
      const { messageId } = await sendMail(toSmtpConfig(settings), {
        from: settings.address,
        fromName: settings.fromName || "ClawBox",
        to: [settings.address],
        subject: "ClawBox test email",
        text: [
          "This is a test message from your ClawBox.",
          "",
          `Sent: ${now.toISOString()}`,
          `Server: ${settings.smtpHost}:${settings.smtpPort}`,
          "",
          "If you can read this, the device can send email — and so can its agent.",
        ].join("\n"),
      });
      return NextResponse.json({ success: true, messageId, sentAt: now.toISOString() });
    } catch (err) {
      if (err instanceof SmtpError) {
        console.error(`[email/test] send failed: kind=${err.kind} host=${settings.smtpHost}`);
        return NextResponse.json({ error: err.message, kind: err.kind, detail: err.detail }, { status: 400 });
      }
      console.error("[email/test] send failed: kind=unknown");
      return NextResponse.json(
        { error: "Could not send the test message.", kind: "network" },
        { status: 400 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Test failed" },
      { status: 500 },
    );
  }
}
