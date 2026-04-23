import { NextResponse } from "next/server";
import { isInstalled, startTunnelService } from "@/lib/cloudflared";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    if (!(await isInstalled())) {
      return NextResponse.json(
        { error: "cloudflared is not installed. Run `sudo bash install.sh --step cloudflared_install`." },
        { status: 400 }
      );
    }
    await startTunnelService();
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start tunnel" },
      { status: 500 }
    );
  }
}
