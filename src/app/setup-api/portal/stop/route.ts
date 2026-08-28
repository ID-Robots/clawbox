import { NextResponse } from "next/server";
import { getTunnelServiceState, stopTunnelService } from "@/lib/cloudflared";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    // Both halves of "off": the unit down now, and the unit still down after a
    // reboot. A `disable` that failed leaves a box that starts publishing a
    // public *.trycloudflare.com address again on the next power cycle, so it
    // cannot be answered with the same `{ success: true }` as a clean stop.
    const { bootPersisted, bootPersistWarning } = await stopTunnelService();
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
    return NextResponse.json({
      success: true,
      bootPersisted,
      ...(bootPersistWarning ? { warning: bootPersistWarning } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to stop tunnel" },
      { status: 500 }
    );
  }
}
