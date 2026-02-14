import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await getAll();
    return NextResponse.json({
      setup_complete: !!config.setup_complete,
      update_completed: !!config.update_completed,
      wifi_configured: !!config.wifi_configured,
      telegram_configured: !!config.telegram_bot_token,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
