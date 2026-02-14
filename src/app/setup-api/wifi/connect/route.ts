import { NextResponse } from "next/server";
import { switchToClient, restartAP } from "@/lib/network";
import { set } from "@/lib/config-store";

export async function POST(request: Request) {
  try {
    const { ssid, password } = await request.json();
    if (!ssid) {
      return NextResponse.json({ error: "SSID is required" }, { status: 400 });
    }

    await set("wifi_ssid", ssid);
    await set("wifi_configured", true);

    // Schedule network switch after response is sent
    setTimeout(async () => {
      try {
        await switchToClient(ssid, password);
      } catch (err) {
        console.error(
          "[WiFi] Failed to connect, restarting AP:",
          err instanceof Error ? err.message : err
        );
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
