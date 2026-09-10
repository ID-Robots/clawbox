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
import { getKnown } from "@/lib/config-store";
import { DEFAULT_IMAP_HOST, DEFAULT_SMTP_HOST, DEFAULT_SMTP_PORT, EMAIL_KEYS, publicEmailStatus } from "@/lib/email-config";
import { countPending } from "@/lib/email-pending";
import { getActiveHarness } from "@/lib/harness";
import { hermesEmailState } from "@/lib/hermes-email";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await publicEmailStatus();
    const harness = await getActiveHarness();
    // WHY `configured: false` IS NOT ALWAYS "THERE IS NO ACCOUNT".
    //
    // `config-store`'s ordinary read answers `{}` to a missing file, an EACCES
    // from a `data/config.json` an update left root-owned, an EIO and a
    // half-written JSON alike — right for the settings it was written for, and
    // a guess here. Nothing on a SCREEN needs the difference; the MCP server
    // does, because it WITHDRAWS email_list/email_read from a running agent on
    // a definite "no" (mcp/lib/context.ts probeEmailReadStatus), and one
    // unreadable moment must not look like the owner switching reading off.
    //
    // Asked HERE rather than inside `publicEmailStatus`, which five other
    // callers share and none of them needs this: the question is about the
    // store, not about the account, and this is the one reader that acts on it.
    // ONE strict read, and only when the answer is ambiguous — an account that
    // resolved is itself proof the store was readable.
    //
    // Absent rather than `false` when all is well, so a build that predates the
    // field cannot be read as one promising a readable store.
    const storeUnreadable = status.configured ? false : !(await getKnown(EMAIL_KEYS.address)).known;

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
