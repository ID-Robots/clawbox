import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const token = await get("telegram_bot_token");
    return NextResponse.json({ configured: !!token });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
