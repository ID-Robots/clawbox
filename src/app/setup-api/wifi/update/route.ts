import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const AP_PROFILE = "ClawBox-Setup";

export async function POST(request: Request) {
  let body: { ssid?: string; password?: string; action?: "update" | "forget" };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const action = body.action ?? "update";
  if (action !== "update" && action !== "forget") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  const normalizedSsid = (body.ssid ?? "").trim();
  if (!normalizedSsid) return NextResponse.json({ error: "Network name is required" }, { status: 400 });
  if (normalizedSsid === AP_PROFILE) return NextResponse.json({ error: "Cannot modify the hotspot profile here" }, { status: 400 });

  try {
    if (action === "forget") {
      await execFileAsync("nmcli", ["connection", "delete", normalizedSsid], { timeout: 5_000 });
      return NextResponse.json({ success: true, action: "forget" });
    }

    const password = body.password ?? "";
    if (password.length < 8 || password.length > 63) {
      return NextResponse.json({ error: "Password must be 8–63 characters" }, { status: 400 });
    }
    await execFileAsync("nmcli", [
      "connection", "modify", normalizedSsid,
      "wifi-sec.key-mgmt", "wpa-psk",
      "wifi-sec.psk", password,
    ], { timeout: 5_000 });
    let connected = true;
    let reactivateError: string | null = null;
    try {
      await execFileAsync("nmcli", ["connection", "up", normalizedSsid], { timeout: 15_000 });
    } catch (err) {
      connected = false;
      reactivateError = err instanceof Error ? err.message : "Failed to reconnect";
      console.warn(`[wifi/update] reactivate ${normalizedSsid} failed:`, err);
    }
    return NextResponse.json({ success: true, action: "update", connected, reactivateError });
  } catch (err) {
    console.warn(`[wifi/update] ${action} ${normalizedSsid} failed:`, err);
    return NextResponse.json({ error: "Failed to update WiFi network" }, { status: 500 });
  }
}
