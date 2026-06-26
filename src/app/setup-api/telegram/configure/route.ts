import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
import { setTelegramToken, restartGateway, clearTelegramPairingState } from "@/lib/openclaw-config";

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
    // token keeps approvals) so we can reset OpenClaw's allowlist/pending stores
    // and our name map below.
    const previousToken = await get("telegram_bot_token");
    const tokenChanged =
      typeof previousToken === "string" && previousToken.length > 0 && previousToken !== botToken;

    // Save to ClawBox config
    await set("telegram_bot_token", botToken);

    // Register Telegram channel with OpenClaw gateway
    await setTelegramToken(botToken);

    if (tokenChanged) {
      await clearTelegramPairingState();
      await set("telegram_approved_names", undefined);
    }

    // Restart gateway so it picks up the new channel (and the reset allowlist)
    await restartGateway();

    return NextResponse.json({ success: true, reset: tokenChanged });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 }
    );
  }
}
