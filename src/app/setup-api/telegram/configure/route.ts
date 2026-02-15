import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";
import { setTelegramToken, restartGateway } from "@/lib/openclaw-config";

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

    // Save to ClawBox config
    await set("telegram_bot_token", botToken);

    // Register Telegram channel with OpenClaw gateway
    await setTelegramToken(botToken);
    // Restart gateway so it picks up the new channel
    restartGateway();

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 }
    );
  }
}
