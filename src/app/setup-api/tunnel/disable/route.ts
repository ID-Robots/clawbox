/**
 * ClawBox — Disable Tunnel API
 *
 * POST /setup-api/tunnel/disable - Stop the Cloudflare Tunnel
 */

import { NextResponse } from "next/server";
import { stopTunnel } from "@/lib/tunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const result = await stopTunnel();

  if (result.success) {
    return NextResponse.json({ success: true });
  } else {
    return NextResponse.json(
      {
        success: false,
        error: result.error,
      },
      { status: 500 }
    );
  }
}
