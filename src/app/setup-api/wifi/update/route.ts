import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { logSafe } from "@/lib/log-safe";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const AP_PROFILE = "ClawBox-Setup";

// 802.11 defines the SSID element as at most 32 octets, so a longer value
// cannot name a network nmcli could act on.
const SSID_MAX_OCTETS = 32;

export async function POST(request: Request) {
  let body: { ssid?: string; password?: string; action?: "update" | "forget" };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const action = body.action ?? "update";
  if (action !== "update" && action !== "forget") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  const normalizedSsid = (body.ssid ?? "").trim();
  if (!normalizedSsid) return NextResponse.json({ error: "Network name is required" }, { status: 400 });
  if (Buffer.byteLength(normalizedSsid, "utf8") > SSID_MAX_OCTETS) {
    return NextResponse.json({ error: `Network name must be at most ${SSID_MAX_OCTETS} bytes` }, { status: 400 });
  }
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
      console.warn(`[wifi/update] reactivate ${logSafe(normalizedSsid)} failed: ${logSafe(reactivateError)}`);
    }
    return NextResponse.json({ success: true, action: "update", connected, reactivateError });
  } catch (err) {
    // The `connection modify` argv includes `wifi-sec.psk <password>`, which
    // execFile embeds into its error message — scrub the PSK before logging so
    // it doesn't land in the journal in cleartext. The scrubbed text still
    // carries the SSID nmcli echoed back, so it goes through logSafe too.
    const raw = err instanceof Error ? err.message : String(err);
    // replaceAll rather than split/join: the message is bounded by execFile's
    // 1 MB maxBuffer, and split would allocate an array of every fragment of it.
    const safe = body.password ? raw.replaceAll(String(body.password), "***") : raw;
    console.warn(`[wifi/update] ${action} ${logSafe(normalizedSsid)} failed: ${logSafe(safe)}`);
    return NextResponse.json({ error: "Failed to update WiFi network" }, { status: 500 });
  }
}
