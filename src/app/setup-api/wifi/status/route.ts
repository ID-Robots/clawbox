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
      return NextResponse.json({ error: status.error }, { status: 500 });
    }
    const statusRecord = status as Record<string, unknown>;
    const state = typeof statusRecord["GENERAL.STATE"] === "string" ? statusRecord["GENERAL.STATE"] : "";
    const nmcliSsid = typeof statusRecord["GENERAL.CONNECTION"] === "string" ? statusRecord["GENERAL.CONNECTION"] : null;
    const connectedFromStatus = typeof statusRecord.connected === "boolean" ? statusRecord.connected : null;
    const connected = connectedFromStatus ?? (/\(connected\)/.test(state) && !!nmcliSsid && nmcliSsid !== "--" && nmcliSsid !== "ClawBox-Setup");
    const ssid = connected
      ? (typeof statusRecord.ssid === "string" ? statusRecord.ssid : nmcliSsid)
      : null;
    const ip = typeof statusRecord.ip === "string"
      ? statusRecord.ip
      : ((typeof statusRecord["IP4.ADDRESS[1]"] === "string" ? statusRecord["IP4.ADDRESS[1]"] : "").split("/")[0] || null);
    const gateway = typeof statusRecord.gateway === "string"
      ? statusRecord.gateway
      : (typeof statusRecord["IP4.GATEWAY"] === "string" ? statusRecord["IP4.GATEWAY"] : null);
    const signalDbm = connected
      ? (typeof statusRecord.signalDbm === "number" ? statusRecord.signalDbm : quality.signalDbm)
      : null;
    const bitrateMbps = connected
      ? (typeof statusRecord.bitrateMbps === "number" ? statusRecord.bitrateMbps : quality.bitrateMbps)
      : null;
    const signal = connected && typeof statusRecord.signal === "number" ? statusRecord.signal : undefined;
    const pingMs = connected ? await pingGateway(gateway) : null;
    const body = {
      connected,
      ssid: connected ? ssid : null,
      ip, gateway,
      signal,
      signalDbm,
      bitrateMbps,
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
