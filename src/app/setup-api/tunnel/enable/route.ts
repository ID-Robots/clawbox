/**
 * ClawBox — Enable Tunnel API
 *
 * POST /setup-api/tunnel/enable - Start the Cloudflare Tunnel
 */

import { NextResponse } from "next/server";
import { startTunnel, isCloudflaredInstalled } from "@/lib/tunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  // Check if cloudflared is installed first
  if (!(await isCloudflaredInstalled())) {
    return NextResponse.json(
      {
        success: false,
        error:
          "cloudflared is not installed. Please install it with: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared",
      },
      { status: 400 }
    );
  }

  const result = await startTunnel();

  if (result.success) {
    return NextResponse.json({
      success: true,
      tunnelUrl: result.tunnelUrl,
    });
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
