// GET /setup-api/email/status — what the Settings panel and the tray read.
//
// The address comes back MASKED (k••••i@example.com) and the password only as a
// boolean. The panel's job is "confirm this is the right account", which the
// masked form answers; nothing in the UI needs the address back in full, so
// nothing gets it.
//
// On Hermes the response also reports whether the INBOUND adapter is wired,
// read from ~/.hermes/.env rather than from ClawBox's own store — same lesson
// as the Telegram status route: what ClawBox saved is not evidence of what the
// agent will actually do.

import { NextResponse } from "next/server";
import { DEFAULT_IMAP_HOST, DEFAULT_SMTP_HOST, DEFAULT_SMTP_PORT, publicEmailStatus } from "@/lib/email-config";
import { getActiveHarness } from "@/lib/harness";
import { hermesEmailState } from "@/lib/hermes-email";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await publicEmailStatus();
    const harness = await getActiveHarness();

    // Only Hermes can receive mail; the UI hides the inbound fields otherwise
    // rather than offering a switch that does nothing.
    const inboundSupported = harness === "hermes";

    const base = {
      ...status,
      harness,
      inboundSupported,
      defaults: {
        smtpHost: DEFAULT_SMTP_HOST,
        smtpPort: DEFAULT_SMTP_PORT,
        imapHost: DEFAULT_IMAP_HOST,
      },
    };

    if (!inboundSupported) {
      return NextResponse.json({ ...base, inbound: false });
    }

    try {
      const hermes = await hermesEmailState();
      return NextResponse.json({
        ...base,
        // Hermes' adapter needs all of address + password + IMAP host to run.
        inbound: Boolean(hermes.address && hermes.hasPassword && hermes.imapHost),
        imapHost: hermes.imapHost ?? status.imapHost,
        allowedSenders: hermes.allowedSenders.length > 0 ? hermes.allowedSenders : status.allowedSenders,
      });
    } catch {
      // Couldn't read Hermes' env — report what ClawBox knows rather than
      // claiming the feature is gone.
      return NextResponse.json({ ...base, inboundUnknown: true });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 },
    );
  }
}
