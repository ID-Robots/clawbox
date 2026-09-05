import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  clearTelegramPairingState,
  GatewayNotReadyError,
  restartGateway,
  setTelegramToken,
} from "@/lib/openclaw-config";
import {
  clearHermesTelegramPairingState,
  ensureHermesGateway,
  setHermesTelegramToken,
} from "@/lib/hermes-telegram";
import { readApprovalBotToken } from "@/lib/email-approval";
import { readActiveTelegramBot, telegramBotId } from "@/lib/telegram-bot-identity";

export const dynamic = "force-dynamic";

/**
 * Saved, but nobody is serving it yet — the one answer both editions give.
 *
 * The token IS stored, so this is not a failed save and the body keeps
 * `success: true`; what differs is whether anything is coming back, and that
 * decides both halves of the answer.
 *
 * `pending` — the restart exited 0 and the gateway has not finished binding.
 * 200, and a sentence that says so. Before TASK-608 this branch could only mean
 * the restart itself failed, so it borrowed that branch's wording: "will apply
 * on next gateway restart", over a restart that had already been taken. The
 * readiness wait widened the branch and left the sentence, which is the same
 * false failure this task removed from /local-ai/exclusive, /stt and
 * /telegram/streaming.
 *
 * Refused — nothing is coming back on its own. 502, exactly as
 * /telegram/streaming answers for the same condition; `SettingsApp` and
 * `TelegramStep` both read a 502 carrying `success` as "saved, not live yet"
 * rather than a failed save, and the configuring overlay adjudicates either way
 * by polling gateway health on its own deadline.
 *
 * Shared by both editions on purpose. OpenClaw reaches `pending` when the
 * readiness wait times out; Hermes never does — `ensureHermesGateway()` reports
 * systemd's service verdict, read right after the restart command, not a socket
 * probe, so a Hermes answer here is always the refused one. That gap is the
 * harness's: this repo carries no listen port for Hermes' messaging gateway to
 * probe.
 */
function notServingYet(reset: boolean, pending = false): NextResponse {
  return NextResponse.json(
    {
      success: true,
      reset,
      restarted: false,
      warning: pending
        ? "Saved, but the gateway has not finished restarting — the bot answers once it is serving again."
        : "Saved — will apply on next gateway restart",
    },
    { status: pending ? 200 : 502 },
  );
}

export async function POST(request: Request) {
  try {
    let body: { botToken?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON" },
        { status: 400 }
      );
    }

    const { botToken } = body;
    if (!botToken) {
      return NextResponse.json(
        { error: "Bot token is required" },
        { status: 400 }
      );
    }
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
      return NextResponse.json(
        { error: "Invalid bot token format" },
        { status: 400 }
      );
    }

    // The same-bot rule, in the direction /setup-api/email/chat-approval does
    // not cover. That route refuses an approvals bot any harness already polls;
    // nothing refused the reverse, so pointing the MAIN bot at the approvals
    // bot's token saved happily and put ClawBox's own approval poller and the
    // harness gateway on one `getUpdates` stream — "Conflict: terminated by
    // other getUpdates request", approvals stop arriving, and every queued email
    // waits on a question nobody is ever asked. By bot id, as next door: a
    // rotated secret is the same stream.
    //
    // Read tri-state, and REFUSED when ClawBox's own store could not be read.
    // The plain reader answers `{}` to an EACCES, an EIO or a config.json
    // caught mid-restore, `approvalId` is then null and the guard is skipped
    // in silence — this PR's own doctrine, applied to both harness stores and
    // missed on the guard it adds. Refusing costs the owner one retry on the
    // main bot; not refusing costs the household its email approvals, because
    // ClawBox's poller and the harness gateway end up on one getUpdates
    // stream. Unlike the unknown BELOW, this one is not a lockout: it does not
    // stand between the owner and a first bot on a box whose store reads fine.
    const approval = await readApprovalBotToken();
    if (!approval.known) {
      return NextResponse.json(
        {
          error:
            "Could not read this device's saved settings, so this token cannot be confirmed as different from the bot that approves your email drafts. See the ClawBox service log.",
          kind: "bot_unknown",
        },
        { status: 503 },
      );
    }
    const approvalId = telegramBotId(approval.token);
    if (approvalId !== null && approvalId === telegramBotId(botToken)) {
      return NextResponse.json(
        {
          error:
            "This is the bot that approves your email drafts. It has to stay a bot of its own, so the approval never travels through the same connection as the conversation.",
          kind: "same_bot",
        },
        { status: 400 },
      );
    }

    // Hand the token to whichever harness this device actually runs. A Hermes
    // device has no OpenClaw gateway at all (the unit is masked, the port is
    // closed), so the OpenClaw path there stored a token nothing ever read and
    // the bot never answered.
    const harness = await getActiveHarness();

    // A different bot means a fresh allowlist — previously-approved senders
    // belong to the old bot. Detect a real token change (re-saving the same
    // token keeps approvals) so we can reset the harness's allowlist/pending
    // stores and our name map.
    //
    // Asked of the store the running edition keeps the credential in. The
    // approvals in the harness's pairing store belong to the bot the HARNESS
    // holds, and ClawBox's copy is a mirror written only by this route — so on
    // a box paired with `hermes config set` there was none, every save looked
    // like the first one, and the previous bot's approved senders carried over
    // to the new bot.
    //
    // A store that could not be READ is neither "no previous bot" nor "the bot
    // changed", and this route may not answer it by refusing the way the
    // approvals guard next door does. That gate protects a SECOND bot the owner
    // has an alternative to; this one is the only path on the device to a
    // Telegram bot at all (TelegramStep, Settings → Channels), so a refusal is
    // a permanent, silent lockout of the feature on a fault the owner cannot
    // reach — including on a box that has never had Telegram configured, where
    // there is nothing for the reset to protect in the first place.
    //
    // So an unknown is decided on the one piece of evidence that survives it:
    // `readActiveTelegramBot` degrades to ClawBox's own mirror, so `token` is
    // then the last value THIS route wrote. Matching it is proof enough that
    // nothing changed (the ordinary "it stopped working, let me re-enter it"
    // save, which must not cost the household its pairings); anything else is
    // treated as a change and resets, which costs a re-pair at worst and never
    // carries the previous bot's approved senders onto a new one.
    //
    // Compared whole, deliberately, and NOT by bot id the way the approvals
    // guard compares: a /revoke-rotated secret for the same bot is exactly the
    // case where the owner has reason to believe the old credential leaked, and
    // clearing the allowlist is the safe reading of that. The guard next door
    // asks a different question — "would these two pollers collide" — where the
    // id is the whole point.
    const previous = await readActiveTelegramBot(harness);
    const tokenChanged = previous.known
      ? previous.token !== null && previous.token !== botToken
      : previous.token !== botToken;

    // The reset runs BEFORE the new token is persisted, on purpose. A reset
    // that fails then fails the save with nothing changed: the old bot keeps
    // its old approvals, and the next attempt still sees a token change and
    // retries the reset. Run after the save, a failed reset left the new bot
    // answering senders approved for the old one — and the retry, seeing the
    // same token, never reset again.
    if (tokenChanged) {
      try {
        if (harness === "hermes") await clearHermesTelegramPairingState();
        else await clearTelegramPairingState();
      } catch (resetErr) {
        console.error("[telegram/configure] Pairing reset failed; the token was not saved:", resetErr);
        return NextResponse.json(
          {
            error:
              "The previous Telegram approvals could not be cleared, so the new bot token was not saved. See the ClawBox service log.",
          },
          { status: 500 }
        );
      }
      await set("telegram_approved_names", undefined);
    }

    // Save to ClawBox config
    await set("telegram_bot_token", botToken);

    if (harness === "hermes") {
      // No `request.signal` past this point. The line above has already written
      // the token to ClawBox's own store and, on a token change, cleared the
      // approvals — so a browser that goes away now (a phone locking during the
      // ~1-3 s the CLI takes) must not be able to cancel the other half. It
      // would leave the token saved here, absent from ~/.hermes/.env, and the
      // previous bot's approvals gone; `runHermesCli` refuses a call whose
      // signal is already aborted, so this would be a reliable split rather
      // than a rare one. Past the first durable write, finish the job.
      await setHermesTelegramToken(botToken);

      // Hermes' messaging gateway is the process that RECEIVES messages, so it
      // has to be installed and up. As with the OpenClaw restart below, the
      // token is already persisted here — a service failure is a warning, not a
      // failed save.
      try {
        const status = await ensureHermesGateway();
        // `applied` and not just `running`: the status probe runs unprivileged
        // and a refused restart leaves the OLD process up, so `running` alone
        // reported the new token as live when it was not.
        if (!status.running || !status.applied) {
          return notServingYet(tokenChanged);
        }
      } catch (gatewayErr) {
        console.error("[telegram/configure] Hermes gateway start failed:", gatewayErr);
        return notServingYet(tokenChanged);
      }

      return NextResponse.json({ success: true, reset: tokenChanged, restarted: true });
    }

    // Register Telegram channel with OpenClaw gateway
    await setTelegramToken(botToken);

    // Restart the gateway so it picks up the new channel (and the reset
    // allowlist), and wait for it to serve again: on THIS edition
    // `restartGateway()` resolves only once :18789 is listening, so
    // `restarted: true` means the bot can answer. (The Hermes branch above
    // cannot say that as strongly — see `notServingYet`.)
    //
    // The token is already persisted at this point, so a restart that does not
    // come back must not fail the whole save. Never surface the raw exec error.
    try {
      await restartGateway();
    } catch (restartErr) {
      console.error("[telegram/configure] Gateway restart failed:", restartErr);
      return notServingYet(tokenChanged, restartErr instanceof GatewayNotReadyError);
    }

    return NextResponse.json({ success: true, reset: tokenChanged, restarted: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 }
    );
  }
}
