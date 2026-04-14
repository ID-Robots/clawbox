import { NextResponse } from "next/server";
import { switchToClient } from "@/lib/network";
import * as configStore from "@/lib/config-store";

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
    await configStore.set("wifi_configured", true);
    return NextResponse.json({ success: true, message: "WiFi skipped (Ethernet only)" });
  }

  const { ssid, password } = body;
  if (!ssid || typeof ssid !== "string" || !ssid.trim()) {
    return NextResponse.json({ error: "SSID is required" }, { status: 400 });
  }
  if (password !== undefined && typeof password !== "string") {
    return NextResponse.json({ error: "Password must be a string" }, { status: 400 });
  }

  try {
    await configStore.set("wifi_ssid", ssid);

    // Actually attempt connection before responding
    await switchToClient(ssid, password as string | undefined);

    await configStore.setMany({ wifi_configured: true, hotspot_enabled: false });

    let hostname = "clawbox";
    try {
      hostname = ((await configStore.get("hostname")) as string | undefined) || hostname;
    } catch {
      // Fall back to the default hostname when config lookup fails.
    }
    return NextResponse.json({
      success: true,
      message: `Connected! Reconnect to your home WiFi and visit http://${hostname}.local to continue.`,
    });
  } catch (err) {
    // switchToClient already restores the AP on failure
    await configStore.set("wifi_configured", false).catch(() => {});

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connection failed" },
      { status: 500 }
    );
  }
}
