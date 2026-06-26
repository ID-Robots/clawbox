import { NextResponse } from "next/server";
import {
  switchToClient,
  setConnectStatus,
  WifiAuthError,
  type ConnectFailReason,
} from "@/lib/network";
import { set, setMany } from "@/lib/config-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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
      const { message } = await switchToClient(ssid, password as string | undefined);
      await setMany({ wifi_configured: true, hotspot_enabled: false }).catch(() => {});
      setConnectStatus({ phase: "connected", ssid, reason: null, message, at: Date.now() });
    } catch (err) {
      await set("wifi_configured", false).catch(() => {});
      const reason: ConnectFailReason = err instanceof WifiAuthError ? "wrong-password" : "other";
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
