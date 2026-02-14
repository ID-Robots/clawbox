import { NextResponse } from "next/server";
import { switchToClient, restartAP } from "@/lib/network";
import { set } from "@/lib/config-store";

export async function POST(request: Request) {
  let body: { ssid?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { ssid, password } = body;
  if (!ssid || typeof ssid !== "string" || !ssid.trim()) {
    return NextResponse.json({ error: "SSID is required" }, { status: 400 });
  }
  if (password !== undefined && typeof password !== "string") {
    return NextResponse.json({ error: "Password must be a string" }, { status: 400 });
  }

  try {
    await set("wifi_ssid", ssid);

    // Schedule network switch after response is sent
    setTimeout(async () => {
      try {
        await switchToClient(ssid, password as string | undefined);
        await set("wifi_configured", true);
      } catch (err) {
        console.error(
          "[WiFi] Failed to connect, restarting AP:",
          err instanceof Error ? err.message : err
        );
        await set("wifi_configured", false);
        try {
          await restartAP();
        } catch (apErr) {
          console.error(
            "[WiFi] Failed to restart AP:",
            apErr instanceof Error ? apErr.message : apErr
          );
        }
      }
    }, 5000);

    return NextResponse.json({
      success: true,
      message: "WiFi credentials saved. Switching networks in 5 seconds...",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connection failed" },
      { status: 500 }
    );
  }
}
