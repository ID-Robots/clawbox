import { NextResponse } from "next/server";
import { getWifiStatus } from "@/lib/network";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const IFACE = process.env.NETWORK_INTERFACE || "wlP1p1s0";

export const dynamic = "force-dynamic";

let cache: { body: unknown; at: number } | null = null;
const TTL_MS = 3_000;

async function readLinkQuality(): Promise<{ signalDbm: number | null; bitrateMbps: number | null }> {
  try {
    const { stdout } = await execFileAsync("iw", ["dev", IFACE, "link"], { timeout: 2000 });
    const sigMatch = stdout.match(/signal:\s*(-?\d+)\s*dBm/);
    const rateMatch = stdout.match(/tx bitrate:\s*([\d.]+)\s*MBit\/s/);
    return {
      signalDbm: sigMatch ? Number(sigMatch[1]) : null,
      bitrateMbps: rateMatch ? Number(rateMatch[1]) : null,
    };
  } catch {
    return { signalDbm: null, bitrateMbps: null };
  }
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

async function pingGateway(gateway: string | null): Promise<number | null> {
  if (!gateway || !IPV4_RE.test(gateway)) return null;
  try {
    const t0 = Date.now();
    await execFileAsync("ping", ["-c", "1", "-W", "1", "-n", gateway], { timeout: 2000 });
    return Date.now() - t0;
  } catch {
    return null;
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.body);
  }
  try {
    // Run nmcli (status) and iw (quality) in parallel; gateway ping must wait
    // for nmcli to know the gateway IP.
    const [status, quality] = await Promise.all([
      getWifiStatus(),
      readLinkQuality(),
    ]);
    if (status.error) {
      // A machine with no WiFi NIC is not a failure of this route — it is an
      // answer, and one every caller has to be able to read: `wifi_status`
      // (mcp/tools/system.ts) does NOT catch this call the way it catches the
      // ethernet one, so a 500 here threw the whole tool and the agent could not
      // say whether the box was online even with a working cable. Only a real
      // nmcli failure — not installed, not answering, timed out — is a 500.
      if (status.errorCode === "no_interface") {
        const body = {
          connected: false,
          available: false,
          reason: "no_interface",
          interface: IFACE,
          ssid: null,
          ip: null,
          gateway: null,
          signalDbm: null,
          bitrateMbps: null,
          pingMs: null,
        };
        cache = { body, at: Date.now() };
        return NextResponse.json(body);
      }
      return NextResponse.json({ error: status.error }, { status: 500 });
    }
    const state = status["GENERAL.STATE"] || "";
    const ssid = status["GENERAL.CONNECTION"] || null;
    const connected = /\(connected\)/.test(state) && !!ssid && ssid !== "--" && ssid !== "ClawBox-Setup";
    const ip = (status["IP4.ADDRESS[1]"] || "").split("/")[0] || null;
    const gateway = status["IP4.GATEWAY"] || null;
    const pingMs = connected ? await pingGateway(gateway) : null;
    const body = {
      connected,
      // Says the hardware IS there, so "no WiFi on this machine" and a server
      // that predates the distinction are not the same answer.
      available: true,
      ssid: connected ? ssid : null,
      ip, gateway,
      signalDbm: connected ? quality.signalDbm : null,
      bitrateMbps: connected ? quality.bitrateMbps : null,
      pingMs,
      raw: status,
    };
    cache = { body, at: Date.now() };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
