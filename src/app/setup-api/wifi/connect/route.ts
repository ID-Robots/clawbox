import { NextResponse } from "next/server";
import {
  switchToClient,
  setConnectStatus,
  WifiAuthError,
  WifiRadioOffError,
  type ConnectFailReason,
} from "@/lib/network";
import { set } from "@/lib/config-store";
import { switchHotspotOffAfterWifiJoin } from "@/lib/hotspot-env";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "This can only be done from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
  }
  // WifiStep is step 1, before any password can exist, so this takes the
  // bootstrap carve-out. Post-password it needs a session: joining the box to
  // an attacker-chosen SSID takes it off the owner's LAN, and a WPA password
  // typed into `nmcli` is a credential the caller shouldn't be able to plant
  // anonymously. TASK-443.
  const unauthorized = await requireSession(request, { allowBootstrap: true });
  if (unauthorized) return unauthorized;

  let body: { ssid?: unknown; password?: unknown; skip?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Skip WiFi setup (Ethernet only) — just mark as configured
  if (body.skip) {
    await set("wifi_configured", true);
    return NextResponse.json({ success: true, message: "WiFi skipped (Ethernet only)" });
  }

  const { ssid, password } = body;
  if (!ssid || typeof ssid !== "string" || !ssid.trim()) {
    return NextResponse.json({ error: "SSID is required" }, { status: 400 });
  }
  if (password !== undefined && typeof password !== "string") {
    return NextResponse.json({ error: "Password must be a string" }, { status: 400 });
  }

  await set("wifi_ssid", ssid);

  // Single-radio handoff: switchToClient tears down the setup hotspot to join
  // the home network, so the browser loses us mid-connect and a synchronous
  // response can never arrive. Run it in the background, record a pollable
  // status, and return immediately — the wizard polls /wifi/connect-status
  // once the AP comes back (failure) or it reaches us on the home network.
  setConnectStatus({ phase: "connecting", ssid, reason: null, message: "", at: Date.now() });
  void (async () => {
    // Grace period so this response is flushed before the AP drops underneath us.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      // Each step lands in the status, so a page that can still reach the box
      // (Ethernet, Settings) shows what is happening rather than a spinner.
      const { message, ip } = await switchToClient(ssid, password as string | undefined, (step) =>
        setConnectStatus({ phase: "connecting", ssid, reason: null, message: "", step, at: Date.now() }),
      );
      await set("wifi_configured", true).catch(() => {});
      // One radio: joining took the AP down, and the hotspot switch goes off
      // with it. The switch lives in data/hotspot.env as well as config, and the
      // AP scripts read only the env file (#1517). Before setup this only
      // proposes "off" to the wizard's hotspot step (src/lib/hotspot-env.ts).
      await switchHotspotOffAfterWifiJoin().catch((err) => {
        console.warn("[wifi/connect] could not record the hotspot as switched off:", err);
      });
      setConnectStatus({ phase: "connected", ssid, reason: null, message, ip, at: Date.now() });
    } catch (err) {
      await set("wifi_configured", false).catch(() => {});
      const reason: ConnectFailReason = err instanceof WifiAuthError
        ? "wrong-password"
        : err instanceof WifiRadioOffError ? "radio-off" : "other";
      setConnectStatus({
        phase: "failed",
        ssid,
        reason,
        message: err instanceof Error ? err.message : "Connection failed",
        at: Date.now(),
      });
    }
  })();

  return NextResponse.json({ status: "connecting" });
}
