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
//
// BOTH VERBS also tell Hermes to rebuild its MCP tool list when — and only when
// — this change flips whether the agent may read the mailbox. The MCP server
// probes that gate once at startup, so without this a mailbox connected under a
// running server stays invisible to the agent. See email-mcp-refresh.ts for the
// whole story, including why the reload is not fired on an ordinary save.

import { NextResponse } from "next/server";
import {
  clearEmailSettings,
  modeAllowsReading,
  parseEmailConfigure,
  publicEmailStatus,
  saveEmailSettings,
  toImapConfig,
  toSmtpConfig,
} from "@/lib/email-config";
import { refreshEmailToolsIfReadabilityChanged } from "@/lib/email-mcp-refresh";
import { clearPending } from "@/lib/email-pending";
import { clearPrompts } from "@/lib/email-approval-prompts";
import { retireAllChatPrompts } from "@/lib/email-approval";
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

    // Whether the agent may open the mailbox, asked BEFORE the write and again
    // after it. Read through publicEmailStatus rather than re-derived here:
    // email-config.ts answers `canRead` in one place on purpose (its comment
    // says so), and a second copy of "which modes allow reading" is a copy that
    // can drift when a fourth mode arrives.
    const couldReadBefore = (await publicEmailStatus()).canRead;

    await saveEmailSettings(settings);

    // The "after" side needs no second read of the store. An account is provably
    // connected at this point — the address, the password and the SMTP host were
    // just accepted by the real server — so the mode is the whole of the answer,
    // through the same helper `canRead` is built from.
    //
    // AWAITED, deliberately, rather than left to run after the response. Three
    // reasons, in order of weight. It only ever does anything on a readability
    // FLIP, which happens about once in the life of a mailbox, so the latency is
    // not paid by ordinary saves. This route already awaits `restartHermesForEmail`
    // below — a full gateway restart — on the inbound path, so seconds are
    // already inside its budget and a tool-list reload is the smaller of the two.
    // And a floating promise here would outlive the response with nothing
    // watching it, on a request whose own later branches can restart the very
    // gateway it is talking to; awaiting keeps the call ordered, bounded by the
    // helper's own deadline, and observable by a test.
    //
    // It cannot fail the save: the helper swallows everything and returns void,
    // so the worst case is a logged line and a tool list that catches up at the
    // next restart.
    //
    // On a send → answer change the gateway restart below ALSO respawns the MCP
    // servers, making this reload redundant for that one transition. Skipping it
    // there would mean guessing that the restart is going to happen and going to
    // succeed — and the case where it does not is precisely the case that needs
    // the refresh, so the redundant reload is the cheaper mistake.
    await refreshEmailToolsIfReadabilityChanged(couldReadBefore, modeAllowsReading(settings.mode));

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
            const stop = await stopHermesEmailPolling(request.signal);
            return NextResponse.json({
              success: true,
              inbound: false,
              restarted: stop === "stopped",
              // A gateway nobody installed cannot be restarted from here, so
              // it is still receiving on the credentials it loaded at
              // startup. Saying nothing would read as "receiving stopped".
              // "unmanaged" and "restart-failed" both mean the same thing to
              // the owner: nothing restarted, so it is still receiving on the
              // credentials it loaded at startup. Saying nothing would read as
              // "receiving stopped".
              ...(stop === "unmanaged" || stop === "restart-failed"
                ? { warning: "Saved — receiving stops on the next gateway restart" }
                : {}),
            });
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
    // Asked before the account is dropped, for the same reason POST asks: this
    // is the other direction of the same flip. An agent whose box no longer has
    // a mailbox must stop being offered email_list/email_read, or every call it
    // makes to them answers 409 — which is the failure the registration gate
    // exists to avoid in the first place.
    const couldReadBefore = (await publicEmailStatus()).canRead;
    await clearEmailSettings();
    // Drafts waiting on an account that no longer exists can never be approved,
    // and they hold agent-composed text. Disconnecting drops them.
    // Order matters: the buttons can only be found while the store still holds
    // the chat and message ids, so the chat is tidied BEFORE the records go.
    // Clearing first would leave live controls in the owner's Telegram whose
    // only possible answer is an error.
    await retireAllChatPrompts();
    clearPending();
    clearPrompts();
    if ((await getActiveHarness()) === "hermes") {
      try {
        await clearHermesEmail();
        // Same reasoning as the inbound-off branch of POST: restart a gateway
        // that is running so it drops the adapter, but do not install one on a
        // device whose owner has just disconnected email.
        await stopHermesEmailPolling(request.signal).catch(() => "none-running" as const);
      } catch (err) {
        console.error("[email/configure] Hermes email teardown failed:", err);
      }
    }
    // There is no account left, so "after" is false by construction — no read of
    // the store can say anything else. Same await-and-swallow contract as POST.
    await refreshEmailToolsIfReadabilityChanged(couldReadBefore, false);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to disconnect" },
      { status: 500 },
    );
  }
}
