import { NextResponse } from "next/server";
import { stopTunnelService } from "@/lib/cloudflared";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await stopTunnelService();
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to stop tunnel" },
      { status: 500 }
    );
  }
}
