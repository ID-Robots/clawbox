import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
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

    // A different bot means a fresh allowlist — previously-approved senders
    // belong to the old bot. Detect a real token change (re-saving the same
    // token keeps approvals) so we can reset the harness's allowlist/pending
    // stores and our name map.
    const previousToken = await get("telegram_bot_token");
    const tokenChanged =
      typeof previousToken === "string" && previousToken.length > 0 && previousToken !== botToken;

    // Hand the token to whichever harness this device actually runs. A Hermes
    // device has no OpenClaw gateway at all (the unit is masked, the port is
    // closed), so the OpenClaw path there stored a token nothing ever read and
    // the bot never answered.
    const harness = await getActiveHarness();

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
