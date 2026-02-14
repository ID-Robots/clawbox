import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const IFACE = process.env.NETWORK_INTERFACE || "wlP1p1s0";
const NETWORK_TIMEOUT = Number(process.env.NETWORK_COMMAND_TIMEOUT) || 60000;
const AP_RETRY_COUNT = 3;
const AP_RETRY_DELAY = 2000;
const AP_START_SCRIPT =
  process.env.AP_START_SCRIPT || "/home/clawbox/clawbox/scripts/start-ap.sh";
const AP_STOP_SCRIPT =
  process.env.AP_STOP_SCRIPT || "/home/clawbox/clawbox/scripts/stop-ap.sh";

// Mutex to serialize concurrent scanWifi calls
let scanLock: Promise<void> = Promise.resolve();

export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  freq: string;
}

async function isAPMode(): Promise<boolean> {
  try {
    const { stdout } = await exec("iw", ["dev", IFACE, "info"]);
    return stdout.includes("type AP");
  } catch {
    return false;
  }
}

async function bringAPUp(): Promise<void> {
  for (let attempt = 1; attempt <= AP_RETRY_COUNT; attempt++) {
    try {
      await exec("nmcli", ["connection", "up", "ClawBox-Setup"]);
      console.log(`[WiFi] AP restored (attempt ${attempt})`);
      return;
    } catch (err) {
      console.error(
        `[WiFi] Failed to restore AP (attempt ${attempt}/${AP_RETRY_COUNT}):`,
        err instanceof Error ? err.message : err
      );
      if (attempt < AP_RETRY_COUNT) {
        await new Promise((resolve) => setTimeout(resolve, AP_RETRY_DELAY));
      }
    }
  }
  throw new Error("[WiFi] All AP restore attempts failed");
}

export async function scanWifi(): Promise<WifiNetwork[]> {
  // Serialize concurrent scan requests
  let resolve: () => void;
  const prev = scanLock;
  scanLock = new Promise<void>((r) => { resolve = r; });
  await prev;

  try {
    return await doScan();
  } finally {
    resolve!();
  }
}

async function doScan(): Promise<WifiNetwork[]> {
  const wasAP = await isAPMode();

  if (wasAP) {
    // Disconnect AP so the interface can scan in station mode
    await exec("nmcli", ["connection", "down", "ClawBox-Setup"]).catch(
      () => {}
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  try {
    // Trigger a fresh scan
    await exec("nmcli", ["device", "wifi", "rescan", "ifname", IFACE]).catch(
      () => {}
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const { stdout } = await exec("nmcli", [
      "-t",
      "-f",
      "SSID,SIGNAL,SECURITY,FREQ",
      "device",
      "wifi",
      "list",
      "ifname",
      IFACE,
    ]);

    const networks = stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        // nmcli terse mode uses ':' as delimiter; SSID could contain ':'
        // but SIGNAL, SECURITY, FREQ are at the end - parse from right
        const parts = line.split(":");
        if (parts.length < 4) return null;
        const freq = parts.pop()!;
        const security = parts.pop()!;
        const signal = parts.pop()!;
        const ssid = parts.join(":"); // rejoin in case SSID had ':'
        return { ssid, signal: parseInt(signal, 10), security, freq };
      })
      .filter(
        (n): n is WifiNetwork => n !== null && !!n.ssid && n.ssid !== "ClawBox-Setup"
      );

    // Deduplicate by SSID, keep strongest signal
    const deduped = new Map<string, WifiNetwork>();
    for (const n of networks) {
      if (!deduped.has(n.ssid) || deduped.get(n.ssid)!.signal < n.signal) {
        deduped.set(n.ssid, n);
      }
    }

    return Array.from(deduped.values()).sort((a, b) => b.signal - a.signal);
  } finally {
    if (wasAP) {
      try {
        await bringAPUp();
      } catch (err) {
        console.error("[WiFi] Failed to restore AP after scan:", err instanceof Error ? err.message : err);
      }
    }
  }
}

export async function switchToClient(
  ssid: string,
  password?: string
): Promise<{ message: string }> {
  console.log(`[WiFi] Switching to client mode, connecting to: ${ssid}`);

  // Stop the AP
  await exec("bash", [AP_STOP_SCRIPT]);

  // Build args conditionally instead of splicing
  const args = password
    ? ["device", "wifi", "connect", ssid, "password", password, "ifname", IFACE]
    : ["device", "wifi", "connect", ssid, "ifname", IFACE];

  const { stdout } = await exec("nmcli", args, { timeout: NETWORK_TIMEOUT });
  console.log(`[WiFi] Connected: ${stdout.trim()}`);
  return { message: stdout.trim() };
}

export async function restartAP(): Promise<void> {
  console.log("[WiFi] Restarting access point...");
  await exec("bash", [AP_START_SCRIPT]);
}

export async function getWifiStatus(): Promise<Record<string, string>> {
  try {
    const { stdout } = await exec("nmcli", [
      "-t",
      "-f",
      "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY",
      "device",
      "show",
      IFACE,
    ]);

    const info: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > -1) {
        info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return info;
  } catch {
    return { error: "WiFi interface not available" };
  }
}
