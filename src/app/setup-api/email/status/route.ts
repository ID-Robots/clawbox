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
import {
  DEFAULT_IMAP_HOST,
  DEFAULT_SMTP_HOST,
  DEFAULT_SMTP_PORT,
  emailStoreDisagrees,
  publicEmailStatus,
} from "@/lib/email-config";
import { countPending } from "@/lib/email-pending";
import { getActiveHarness } from "@/lib/harness";
import { hermesEmailState } from "@/lib/hermes-email";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await publicEmailStatus();
    const harness = await getActiveHarness();
    // WHY THE STORE IS QUESTIONED AT ALL, and why HERE: `publicEmailStatus` is
    // shared with five callers that want the ACCOUNT, and this is the only
    // reader that acts on the state of the STORE — the MCP server withdraws the
    // mailbox read tools from a running agent on a definite "no".
    // `emailStoreDisagrees` owns the rule and the reasoning.
    //
    // Asked on BOTH branches. `configured: true, canRead: false` is reachable
    // from a store that went unreadable midway through `getEmailCredentials`'
    // per-key reads, and is the same definite "no" as the other branch; the flag
    // is passed so the function knows which of its two questions is the
    // ambiguous one, not whether to look.
    //
    // Absent rather than `false` when all is well, so a build that predates the
    // field cannot be read as one promising a readable store.
    const storeUnreadable = await emailStoreDisagrees(status.configured, status.canRead);

    // Only Hermes can receive mail; the UI hides the inbound fields otherwise
    // rather than offering a switch that does nothing.
    const inboundSupported = harness === "hermes";

    const base = {
      ...status,
      ...(storeUnreadable ? { storeUnreadable: true } : {}),
      harness,
      inboundSupported,
      // The approvals strip needs a count even when the panel has not opened
      // the pending route yet, so the badge can appear on the nav item.
      pendingCount: status.configured ? countPending() : 0,
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
