import { NextResponse } from "next/server";
import { getTunnelServiceState, stopTunnelService } from "@/lib/cloudflared";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await stopTunnelService();
    const state = await getTunnelServiceState();
    if (state === "active" || state === "activating") {
      return NextResponse.json(
        { error: "Tunnel service is still running after stop was requested." },
        { status: 500 }
      );
    }
    if (state === "unknown") {
      return NextResponse.json(
        { error: "Tunnel service stopped, but its final state could not be verified." },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to stop tunnel" },
      { status: 500 }
    );
  }
}
