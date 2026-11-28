import { NextResponse } from "next/server";
import { isInstalled, startTunnelService } from "@/lib/cloudflared";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "This can only be done from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
  }
  try {
    if (!(await isInstalled())) {
      return NextResponse.json(
        { error: "cloudflared is not installed. Run `sudo bash install.sh --step cloudflared_install`." },
        { status: 400 }
      );
    }
    // `success` is about the unit being up, which it is — a failed `enable` is
    // not a failed start and must not read as one. But it IS a second fact the
    // owner acts on, so it travels with the answer instead of dying in a log.
    const { bootPersisted, bootPersistWarning } = await startTunnelService();
    return NextResponse.json({
      success: true,
      bootPersisted,
      ...(bootPersistWarning ? { warning: bootPersistWarning } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start tunnel" },
      { status: 500 }
    );
  }
}
