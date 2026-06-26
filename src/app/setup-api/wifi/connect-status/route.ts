import { NextResponse } from "next/server";
import { getConnectStatus } from "@/lib/network";

export const dynamic = "force-dynamic";

/**
 * Poll target for the WiFi connect handoff. The wizard loses the setup hotspot
 * the moment the box switches to client mode, so it can't get a synchronous
 * connect result — it polls this once it reconnects (to the restored AP on
 * failure, or to us on the home network on success).
 */
export async function GET() {
  return NextResponse.json(getConnectStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
