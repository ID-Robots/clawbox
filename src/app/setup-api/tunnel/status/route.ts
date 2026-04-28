/**
 * ClawBox — Tunnel Status API
 *
 * GET /setup-api/tunnel/status - Get current tunnel status
 */

import { NextResponse } from "next/server";
import { getTunnelStatus, isCloudflaredInstalled } from "@/lib/tunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const status = await getTunnelStatus();
  const cloudflaredInstalled = await isCloudflaredInstalled();

  return NextResponse.json({
    ...status,
    cloudflaredInstalled,
  });
}
