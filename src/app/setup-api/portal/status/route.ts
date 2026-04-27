import { NextResponse } from "next/server";
import {
  getTunnelServiceState,
  isInstalled,
  readTunnelUrl,
} from "@/lib/cloudflared";

export const dynamic = "force-dynamic";

const PORTAL_BASE = process.env.PORTAL_WEB || "https://openclawhardware.dev";

/**
 * Status of the remote-access Cloudflare Quick Tunnel.
 *
 *   tunnel.installed  — cloudflared binary is on PATH
 *   tunnel.service    — systemd state for clawbox-tunnel.service
 *   tunnel.url        — the *.trycloudflare.com URL the tunnel published
 *   portalAddDeviceUrl — link to the portal's "Add Device" page
 */
export async function GET() {
  try {
    const [installed, service, url] = await Promise.all([
      isInstalled(),
      getTunnelServiceState(),
      readTunnelUrl(),
    ]);

    return NextResponse.json({
      tunnel: {
        installed,
        service,
        url,
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
