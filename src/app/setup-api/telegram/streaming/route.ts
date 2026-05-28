import { NextResponse } from "next/server";
import {
  getTelegramProgressStreaming,
  setTelegramProgressStreaming,
  restartGateway,
} from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

// Read whether the Telegram bot streams live tool/research progress while it
// works. Defaults to ON (true) when no override is set.
export async function GET() {
  try {
    const enabled = await getTelegramProgressStreaming();
    return NextResponse.json(
      { enabled },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read setting" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    let body: { enabled?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 },
      );
    }

    await setTelegramProgressStreaming(body.enabled);

    // The gateway only reads channel config at startup, so restart to apply.
    try {
      await restartGateway();
    } catch {
      // Setting is persisted; surface the restart failure so the UI can tell
      // the user it'll take effect on the next gateway restart.
      return NextResponse.json(
        {
          success: true,
          restarted: false,
          warning: "Saved, but the gateway restart failed — it'll apply on next restart.",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, restarted: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 },
    );
  }
}
