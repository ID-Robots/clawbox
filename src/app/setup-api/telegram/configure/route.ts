import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { setTelegramToken, restartGateway, clearTelegramPairingState } from "@/lib/openclaw-config";
import {
  clearHermesTelegramPairingState,
  ensureHermesGateway,
  setHermesTelegramToken,
} from "@/lib/hermes-telegram";

export const dynamic = "force-dynamic";

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
    // stores and our name map below.
    const previousToken = await get("telegram_bot_token");
    const tokenChanged =
      typeof previousToken === "string" && previousToken.length > 0 && previousToken !== botToken;

    // Save to ClawBox config
    await set("telegram_bot_token", botToken);

    // Hand the token to whichever harness this device actually runs. A Hermes
    // device has no OpenClaw gateway at all (the unit is masked, the port is
    // closed), so the OpenClaw path there stored a token nothing ever read and
    // the bot never answered.
    const harness = await getActiveHarness();

    if (harness === "hermes") {
      await setHermesTelegramToken(botToken, request.signal);

      if (tokenChanged) {
        await clearHermesTelegramPairingState();
        await set("telegram_approved_names", undefined);
      }

      // Hermes' messaging gateway is the process that RECEIVES messages, so it
      // has to be installed and up. As with the OpenClaw restart below, the
      // token is already persisted here — a service failure is a warning, not a
      // failed save.
      try {
        const status = await ensureHermesGateway(request.signal);
        // `applied` and not just `running`: the status probe runs unprivileged
        // and a refused restart leaves the OLD process up, so `running` alone
        // reported the new token as live when it was not.
        if (!status.running || !status.applied) {
          return NextResponse.json({
            success: true,
            reset: tokenChanged,
            restarted: false,
            warning: "Saved — will apply on next gateway restart",
          });
        }
      } catch (gatewayErr) {
        console.error("[telegram/configure] Hermes gateway start failed:", gatewayErr);
        return NextResponse.json({
          success: true,
          reset: tokenChanged,
          restarted: false,
          warning: "Saved — will apply on next gateway restart",
        });
      }

      return NextResponse.json({ success: true, reset: tokenChanged, restarted: true });
    }

    // Register Telegram channel with OpenClaw gateway
    await setTelegramToken(botToken);

    if (tokenChanged) {
      await clearTelegramPairingState();
      await set("telegram_approved_names", undefined);
    }

    // Restart gateway so it picks up the new channel (and the reset allowlist).
    // The token is already persisted at this point, so a restart failure must
    // not fail the whole save — report it as a soft warning that'll apply on
    // the next gateway restart (mirrors /telegram/streaming). Never surface the
    // raw exec error.
    try {
      await restartGateway();
    } catch (restartErr) {
      console.error("[telegram/configure] Gateway restart failed:", restartErr);
      return NextResponse.json({
        success: true,
        reset: tokenChanged,
        restarted: false,
        warning: "Saved — will apply on next gateway restart",
      });
    }

    return NextResponse.json({ success: true, reset: tokenChanged, restarted: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 }
    );
  }
}
