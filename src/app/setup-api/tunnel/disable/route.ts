/**
 * ClawBox — Disable Tunnel API
 *
 * POST /setup-api/tunnel/disable - Stop the Cloudflare Tunnel
 */

import { NextResponse } from "next/server";
import { stopTunnel } from "@/lib/tunnel";
import { isSameOriginRequest } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "This can only be done from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
  }
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
