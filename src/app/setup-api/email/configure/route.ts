// POST /setup-api/email/configure — save the outgoing-mail account.
//
// THE ORDER IS THE POINT: nothing is written until the real SMTP server has
// accepted the address and the password. The Telegram route validates a token's
// SHAPE offline and leaves liveness to /status, because a Telegram token is
// self-describing; an app password is not — a wrong one looks exactly like a
// right one, and the customer would only find out when the agent silently
// failed to send. So this route connects, negotiates TLS and authenticates
// first, and a failure comes back as one plain sentence saying WHICH of the
// three things went wrong.
//
// DELETE disconnects: it clears ClawBox's stored credentials and, on Hermes,
// removes the EMAIL_* block from ~/.hermes/.env.

import { NextResponse } from "next/server";
import {
  clearEmailSettings,
  modeAllowsReading,
  parseEmailConfigure,
  saveEmailSettings,
  toImapConfig,
  toSmtpConfig,
} from "@/lib/email-config";
import { clearPending } from "@/lib/email-pending";
import { ImapError, verifyImap } from "@/lib/imap-client";
import { getActiveHarness } from "@/lib/harness";
import {
  applyHermesEmail,
  clearHermesEmail,
  restartHermesForEmail,
  stopHermesEmailPolling,
  wantsInbound,
} from "@/lib/hermes-email";
import { SmtpError, verifySmtp } from "@/lib/smtp-client";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = parseEmailConfigure(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const settings = parsed.settings;

    // Prove the credentials before persisting them. The signal goes with it so
    // a user who navigates away mid-"Connect" takes the SMTP socket down with
    // the request instead of leaving it to the client's own timeouts.
    try {
      await verifySmtp(toSmtpConfig(settings), { signal: request.signal });
    } catch (err) {
      if (err instanceof SmtpError) {
        // Log the CLASS of failure and the server, never the address or the
        // password — Hermes' own messaging audit line is the model here: key
        // names only, never values.
        console.error(`[email/configure] SMTP verification failed: kind=${err.kind} host=${settings.smtpHost}`);
        return NextResponse.json({ error: err.message, kind: err.kind, detail: err.detail }, { status: 400 });
      }
      console.error("[email/configure] SMTP verification failed: kind=unknown");
      return NextResponse.json(
        { error: "Could not connect to the mail server.", kind: "network" },
        { status: 400 },
      );
    }

    // Same rule for the incoming server, for the same reason: a mode that says
    // "the assistant may read my mail" and cannot actually open the mailbox
    // would only be discovered the first time the owner asked it to look. The
    // derived host (imap.gmail.com from smtp.gmail.com) is exactly the kind of
    // guess that has to be proven rather than assumed — and for Gmail this is
    // also what catches "IMAP is switched off in Gmail's own settings".
    if (modeAllowsReading(settings.mode)) {
      try {
        await verifyImap(toImapConfig(settings), { signal: request.signal });
      } catch (err) {
        if (err instanceof ImapError) {
          console.error(`[email/configure] IMAP verification failed: kind=${err.kind}`);
          return NextResponse.json({ error: err.message, kind: err.kind, detail: err.detail }, { status: 400 });
        }
        console.error("[email/configure] IMAP verification failed: kind=unknown");
        return NextResponse.json(
          { error: "Could not connect to the incoming-mail server.", kind: "network" },
          { status: 400 },
        );
      }
    }

    await saveEmailSettings(settings);

    // Hermes' native adapter is the only way the agent can RECEIVE mail, and it
    // is opt-in. On OpenClaw there is no email channel at all (inventing one
    // would fail the gateway's strict schema and take every other channel down
    // with it), so outbound via the MCP tool is the whole story there.
    const harness = await getActiveHarness();
    if (harness === "hermes") {
      try {
        const { inbound } = await applyHermesEmail(settings);
        if (inbound) {
          // The credentials are already persisted, so a gateway that will not
          // come up is a warning, not a failed save (same contract as
          // /telegram/configure).
          try {
            const running = await restartHermesForEmail(request.signal);
            if (!running) {
              return NextResponse.json({
                success: true,
                inbound: true,
                restarted: false,
                warning: "Saved — will apply on next gateway restart",
              });
            }
          } catch (gatewayErr) {
            console.error("[email/configure] Hermes gateway start failed:", gatewayErr);
            return NextResponse.json({
              success: true,
              inbound: true,
              restarted: false,
              warning: "Saved — will apply on next gateway restart",
            });
          }
        } else {
          // Inbound was NOT asked for. applyHermesEmail has just cleared the
          // EMAIL_* block, but a gateway that is already running keeps polling
          // the old mailbox until it is restarted — the "untick 'Let people
          // write to the assistant' and re-save" path. Only restart one that is
          // already up; never start one here.
          try {
            const restarted = await stopHermesEmailPolling(request.signal);
            return NextResponse.json({ success: true, inbound: false, restarted });
          } catch (gatewayErr) {
            console.error("[email/configure] Hermes gateway restart failed:", gatewayErr);
            return NextResponse.json({
              success: true,
              inbound: false,
              restarted: false,
              warning: "Saved — receiving stops on the next gateway restart",
            });
          }
        }
        return NextResponse.json({ success: true, inbound, restarted: inbound });
      } catch (hermesErr) {
        console.error("[email/configure] Hermes email wiring failed:", hermesErr);
        return NextResponse.json({
          success: true,
          inbound: false,
          restarted: false,
          warning: "Sending works. Receiving could not be enabled on this device.",
        });
      }
    }

    // OpenClaw edition: outbound only. `inbound` is always false here, whatever
    // the form asked for — see the comment above.
    return NextResponse.json({
      success: true,
      inbound: false,
      restarted: false,
      // "read" needs nothing from Hermes — it runs on ClawBox's own IMAP client
      // and is offered on both editions, like sending. Only "answer" depends on
      // Hermes' native adapter.
      ...(wantsInbound(settings)
        ? { warning: "Sending works. Answering senders is only available on the Hermes edition." }
        : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await clearEmailSettings();
    // Drafts waiting on an account that no longer exists can never be approved,
    // and they hold agent-composed text. Disconnecting drops them.
    clearPending();
    if ((await getActiveHarness()) === "hermes") {
      try {
        await clearHermesEmail();
        // Same reasoning as the inbound-off branch of POST: restart a gateway
        // that is running so it drops the adapter, but do not install one on a
        // device whose owner has just disconnected email.
        await stopHermesEmailPolling(request.signal).catch(() => false);
      } catch (err) {
        console.error("[email/configure] Hermes email teardown failed:", err);
      }
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to disconnect" },
      { status: 500 },
    );
  }
}
