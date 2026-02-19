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

// Cache scan results so retry requests after AP restore don't trigger another teardown
let cachedScan: { networks: WifiNetwork[]; timestamp: number } | null = null;
const SCAN_CACHE_TTL = 30_000; // 30 seconds

// Background scan state
let scanInProgress = false;

export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  freq: string;
}

async function isAPMode(): Promise<boolean> {
  try {
    const { stdout } = await exec("iw", ["dev", IFACE, "info"], { timeout: NETWORK_TIMEOUT });
    return stdout.includes("type AP");
  } catch {
    return false;
  }
}

async function bringAPUp(): Promise<void> {
  for (let attempt = 1; attempt <= AP_RETRY_COUNT; attempt++) {
    try {
      await exec("bash", [AP_START_SCRIPT], { timeout: NETWORK_TIMEOUT });
      const apUp = await isAPMode();
      if (apUp) {
        console.log(`[WiFi] AP restored (attempt ${attempt})`);
        return;
      }
      console.warn(`[WiFi] AP start returned success but AP not detected (attempt ${attempt})`);
    } catch (err) {
      console.error(
        `[WiFi] Failed to restore AP (attempt ${attempt}/${AP_RETRY_COUNT}):`,
        err instanceof Error ? err.message : err
      );
    }
    if (attempt < AP_RETRY_COUNT) {
      await new Promise((resolve) => setTimeout(resolve, AP_RETRY_DELAY));
    }
  }
  throw new Error("[WiFi] All AP restore attempts failed");
}

export async function scanWifi(): Promise<WifiNetwork[]> {
  // Return cached results if fresh (avoids tearing down AP again on retry)
  if (cachedScan && (Date.now() - cachedScan.timestamp) < SCAN_CACHE_TTL) {
    return cachedScan.networks;
  }

  // Serialize concurrent scan requests
  let resolve: () => void;
  const prev = scanLock;
  scanLock = new Promise<void>((r) => { resolve = r; });
  await prev;

  // Check cache again after acquiring lock (another request may have just scanned)
  if (cachedScan && (Date.now() - cachedScan.timestamp) < SCAN_CACHE_TTL) {
    resolve!();
    return cachedScan.networks;
  }

  try {
    const networks = await doScan();
    cachedScan = { networks, timestamp: Date.now() };
    return networks;
  } finally {
    resolve!();
  }
}

/** Fire-and-forget: kicks off a scan in the background. Returns immediately. */
export function triggerBackgroundScan(): void {
  if (scanInProgress) return;
  if (cachedScan && (Date.now() - cachedScan.timestamp) < SCAN_CACHE_TTL) return;

  scanInProgress = true;
  scanWifi()
    .catch((err) => console.error("[WiFi] Background scan failed:", err instanceof Error ? err.message : err))
    .finally(() => { scanInProgress = false; });
}

/** Returns current scan state for polling. */
export function getScanStatus(): { scanning: boolean; networks: WifiNetwork[] | null } {
  if (scanInProgress) {
    return { scanning: true, networks: null };
  }
  if (cachedScan) {
    return { scanning: false, networks: cachedScan.networks };
  }
  return { scanning: false, networks: null };
}

async function doScan(): Promise<WifiNetwork[]> {
  const wasAP = await isAPMode();

  if (wasAP) {
    // Disconnect AP so the interface can scan in station mode
    await exec("nmcli", ["connection", "down", "ClawBox-Setup"], { timeout: NETWORK_TIMEOUT }).catch(
      () => {}
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  try {
    // Trigger a fresh scan
    await exec("nmcli", ["device", "wifi", "rescan", "ifname", IFACE], { timeout: NETWORK_TIMEOUT }).catch(
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
    ], { timeout: NETWORK_TIMEOUT });

    const networks = stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        // nmcli terse mode uses ':' as delimiter; SSID could contain ':'
        // but SIGNAL, SECURITY, FREQ are at the end - parse from right
        const parts = line.split(":");
        if (parts.length < 4) {
          console.warn("[WiFi] Dropping malformed nmcli line:", line);
          return null;
        }
        const freq = parts.pop()!;
        const security = parts.pop()!;
        const signal = parts.pop()!;
        const ssid = parts.join(":"); // rejoin in case SSID had ':'
        if (!ssid) {
          console.warn("[WiFi] Dropping line with empty SSID:", line);
          return null;
        }
        const signalNum = parseInt(signal, 10);
        if (Number.isNaN(signalNum)) {
          console.warn("[WiFi] Dropping line with non-numeric signal:", line);
          return null;
        }
        return { ssid, signal: signalNum, security, freq };
      })
      .filter(
        (n): n is WifiNetwork => n !== null && n.ssid !== "ClawBox-Setup"
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
  await exec("bash", [AP_STOP_SCRIPT], { timeout: NETWORK_TIMEOUT });

  // Build args conditionally instead of splicing
  const args = password
    ? ["device", "wifi", "connect", ssid, "password", password, "ifname", IFACE]
    : ["device", "wifi", "connect", ssid, "ifname", IFACE];

  try {
    const { stdout } = await exec("nmcli", args, { timeout: NETWORK_TIMEOUT });
    console.log(`[WiFi] Connected: ${stdout.trim()}`);
    return { message: stdout.trim() };
  } catch (err) {
    console.error("[WiFi] Connection failed, restoring AP:", err instanceof Error ? err.message : err);

    const AP_RESTORE_RETRIES = 3;
    const AP_RESTORE_BACKOFF = 3000;
    let apRestored = false;

    for (let attempt = 1; attempt <= AP_RESTORE_RETRIES; attempt++) {
      try {
        await exec("bash", [AP_START_SCRIPT], { timeout: NETWORK_TIMEOUT });
        // Verify AP is actually up
        const apUp = await isAPMode();
        if (apUp) {
          console.log(`[WiFi] AP restored after connect failure (attempt ${attempt})`);
          apRestored = true;
          break;
        }
        console.warn(`[WiFi] AP start returned success but AP not detected (attempt ${attempt})`);
      } catch (apErr) {
        console.error(
          `[WiFi] Failed to restore AP (attempt ${attempt}/${AP_RESTORE_RETRIES}):`,
          apErr instanceof Error ? apErr.message : apErr
        );
      }
      if (attempt < AP_RESTORE_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, AP_RESTORE_BACKOFF * attempt));
      }
    }

    if (!apRestored) {
      console.error("[WiFi] All AP restore attempts failed after connect failure. Device may be unreachable.");
      // Last resort: try nmcli directly
      try {
        await exec("nmcli", ["connection", "up", "ClawBox-Setup"], { timeout: NETWORK_TIMEOUT });
        console.log("[WiFi] AP restored via direct nmcli fallback");
      } catch (fallbackErr) {
        console.error("[WiFi] Direct nmcli fallback also failed:", fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
      }
    }

    throw err;
  }
}

export async function restartAP(): Promise<void> {
  console.log("[WiFi] Restarting access point...");
  await exec("bash", [AP_START_SCRIPT], { timeout: NETWORK_TIMEOUT });
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
    ], { timeout: NETWORK_TIMEOUT });

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
