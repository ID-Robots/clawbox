import { NextResponse } from "next/server";
import {
  getTunnelServiceState,
  isInstalled,
  readTunnelUrl,
  readTunnelUrlHistory,
} from "@/lib/cloudflared";
import { pushHeartbeatIfChanged } from "@/lib/portal-heartbeat";

export const dynamic = "force-dynamic";

const PORTAL_BASE = process.env.PORTAL_WEB || "https://clawbox.com";

/**
 * Status of the remote-access Cloudflare Quick Tunnel.
 *
 *   tunnel.installed  — cloudflared binary is on PATH
 *   tunnel.service    — systemd state for clawbox-tunnel.service
 *   tunnel.url        — the *.trycloudflare.com URL the tunnel published
 *   tunnel.history    — the last few URLs this device has published, newest
 *                       first, each with the time it was published. `url` goes
 *                       null the moment the tunnel stops, so without this there
 *                       was no way to find out which hostnames the box had ever
 *                       been reachable on — the question a stray, still-serving
 *                       quick-tunnel URL raises.
 *   portalAddDeviceUrl — link to the portal's "Add Device" page
 */
export async function GET() {
  try {
    const [installed, service, url, history] = await Promise.all([
      isInstalled(),
      getTunnelServiceState(),
      readTunnelUrl(),
      readTunnelUrlHistory(),
    ]);

    // Fire-and-forget: push the new URL to the portal so the user's Devices
    // list stays in sync across cloudflared restarts. No-ops when there's no
    // ClawAI token paired or when the URL hasn't changed since the last push.
    pushHeartbeatIfChanged(url);

    return NextResponse.json({
      tunnel: {
        installed,
        service,
        url,
        history,
      },
      portalAddDeviceUrl: `${PORTAL_BASE}/portal/devices?addDevice=1`,
      portalWeb: PORTAL_BASE,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
