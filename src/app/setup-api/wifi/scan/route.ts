import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { triggerBackgroundScan, getScanStatus, getCachedScan, scanWifiLive } from "@/lib/network";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/** POST: Trigger a scan.
 *  ?live=1 — uses `iw scan` (non-disruptive, works in AP mode, returns results directly)
 *  default — background scan via nmcli (tears down AP)
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "This can only be done from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
  }
  const live = request.nextUrl.searchParams.get("live");
  if (live) {
    const networks = await scanWifiLive();
    return NextResponse.json({ scanning: false, networks });
  }
  triggerBackgroundScan();
  return NextResponse.json({ status: "scanning" });
}

/** GET: Poll for scan results. Falls back to pre-AP cached scan. */
export async function GET() {
  const result = getScanStatus();
  // If no live scan data, serve the pre-AP cached scan from boot
  if (!result.scanning && !result.networks) {
    const cached = getCachedScan();
    if (cached.length > 0) {
      return NextResponse.json({ scanning: false, networks: cached, cached: true });
    }
  }
  return NextResponse.json(result);
}
