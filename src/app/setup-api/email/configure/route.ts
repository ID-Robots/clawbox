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
  parseEmailConfigure,
  saveEmailSettings,
  toSmtpConfig,
} from "@/lib/email-config";
import { getActiveHarness } from "@/lib/harness";
import { applyHermesEmail, clearHermesEmail, restartHermesForEmail, wantsInbound } from "@/lib/hermes-email";
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

    // Prove the credentials before persisting them.
    try {
      await verifySmtp(toSmtpConfig(settings));
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
      ...(wantsInbound(settings)
        ? { warning: "Sending works. Receiving replies is only available on the Hermes edition." }
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
    if ((await getActiveHarness()) === "hermes") {
      try {
        await clearHermesEmail();
        await restartHermesForEmail(request.signal).catch(() => false);
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
