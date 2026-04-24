import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const exec = promisify(execFile);
const IFACE = process.env.NETWORK_INTERFACE || "wlP1p1s0";
const NETWORK_TIMEOUT = Number(process.env.NETWORK_COMMAND_TIMEOUT) || 60000;
const TEST_MODE = process.env.CLAWBOX_TEST_MODE === "1";
const AP_RETRY_COUNT = 3;
const AP_RETRY_DELAY = 2000;
const AP_START_SCRIPT =
  process.env.AP_START_SCRIPT || "/home/clawbox/clawbox/scripts/start-ap.sh";
const AP_STOP_SCRIPT =
  process.env.AP_STOP_SCRIPT || "/home/clawbox/clawbox/scripts/stop-ap.sh";

/** Parse one line of nmcli -t output, splitting on unescaped colons and
 *  unescaping `\:` and `\\` per nmcli's terse-output escaping rules. */
export function parseNmcliTerseLine(line: string): string[] {
  const fields: string[] = [];
  let buf = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) { buf += line[++i]; continue; }
    if (c === ":") { fields.push(buf); buf = ""; continue; }
    buf += c;
  }
  fields.push(buf);
  return fields;
}

// Mutex to serialize concurrent scanWifi calls
let scanLock: Promise<void> = Promise.resolve();

// Cache scan results so retry requests after AP restore don't trigger another teardown
let cachedScan: { networks: WifiNetwork[]; timestamp: number } | null = null;
const SCAN_CACHE_TTL = 30_000; // 30 seconds

// Background scan state
let scanInProgress = false;

export type { WifiNetwork } from "./wifi-utils";
import type { WifiNetwork } from "./wifi-utils";

const TEST_NETWORKS: readonly WifiNetwork[] = Object.freeze([
  Object.freeze<WifiNetwork>({ ssid: "TestNet-Home", signal: -42, security: "WPA2", freq: "5180" }),
  Object.freeze<WifiNetwork>({ ssid: "TestNet-Guest", signal: -58, security: "WPA2", freq: "2437" }),
  Object.freeze<WifiNetwork>({ ssid: "TestNet-Open", signal: -70, security: "--", freq: "2412" }),
]);

/** Return a fresh array of fresh objects so callers can't mutate shared state. */
function cloneTestNetworks(): WifiNetwork[] {
  return TEST_NETWORKS.map((n) => ({ ...n }));
}

/** Deduplicate networks by SSID, keeping the strongest signal for each. */
function deduplicateNetworks(networks: WifiNetwork[]): WifiNetwork[] {
  const deduped = new Map<string, WifiNetwork>();
  for (const n of networks) {
    if (!n.ssid) continue;
    if (!deduped.has(n.ssid) || deduped.get(n.ssid)!.signal < n.signal) {
      deduped.set(n.ssid, n);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => b.signal - a.signal);
}

const SCAN_CACHE_PATH = path.join(
  process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox",
  "data",
  "wifi-scan-cache.json"
);

let cachedFileScan: { networks: WifiNetwork[]; mtime: number } | null = null;

/** Read the pre-AP scan cache written by start-ap.sh */
export function getCachedScan(): WifiNetwork[] {
  try {
    const stat = fs.statSync(SCAN_CACHE_PATH);
    const mtime = stat.mtimeMs;
    if (cachedFileScan && cachedFileScan.mtime === mtime) {
      return cachedFileScan.networks;
    }
    const raw = fs.readFileSync(SCAN_CACHE_PATH, "utf-8");
    const networks = deduplicateNetworks(JSON.parse(raw));
    cachedFileScan = { networks, mtime };
    return networks;
  } catch {
    return [];
  }
}

/** Scan using `iw scan` — works even in AP mode without tearing down the hotspot. */
export async function scanWifiLive(): Promise<WifiNetwork[]> {
  if (TEST_MODE) return cloneTestNetworks();
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn("/usr/sbin/iw", ["dev", IFACE, "scan"]);
      let out = "";
      let err = "";
      const timer = setTimeout(() => { proc.kill(); reject(new Error("iw scan timed out")); }, NETWORK_TIMEOUT);
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !out) reject(new Error(`iw scan exited ${code}: ${err}`));
        else resolve(out);
      });
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    });

    const networks: WifiNetwork[] = [];
    let current: Partial<WifiNetwork> = {};

    for (const line of stdout.split("\n")) {
      if (line.startsWith("BSS ")) {
        // New BSS entry — push the previous one if valid
        if (current.ssid) {
          networks.push({
            ssid: current.ssid,
            signal: current.signal ?? 0,
            security: current.security ?? "",
            freq: current.freq ?? "",
          });
        }
        current = { security: "" };
      }
      const trimmed = line.trim();
      if (trimmed.startsWith("SSID: ")) {
        current.ssid = trimmed.slice(6);
      } else if (trimmed.startsWith("signal: ")) {
        // "signal: -45.00 dBm" → convert to 0-100 scale
        const dbm = parseFloat(trimmed.slice(8));
        current.signal = Math.max(0, Math.min(100, 2 * (dbm + 100)));
      } else if (trimmed.startsWith("freq: ")) {
        const f = parseInt(trimmed.slice(6), 10);
        current.freq = f >= 5000 ? "5 GHz" : "2.4 GHz";
      } else if (trimmed.startsWith("RSN:") || trimmed.startsWith("WPA:")) {
        current.security = current.security || "WPA2";
      }
    }
    // Push last entry
    if (current.ssid) {
      networks.push({
        ssid: current.ssid,
        signal: current.signal ?? 0,
        security: current.security ?? "",
        freq: current.freq ?? "",
      });
    }

    return deduplicateNetworks(networks.filter((n) => n.ssid && n.ssid !== "ClawBox-Setup"));
  } catch (err) {
    console.error("[WiFi] iw scan failed:", err instanceof Error ? err.message : err);
    return [];
  }
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
  if (TEST_MODE) return cloneTestNetworks();
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

    return deduplicateNetworks(networks);
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

  if (TEST_MODE) {
    // Container has no wireless. Pretend the connect worked so the setup
    // wizard can advance; tests control whether to simulate failure via a
    // reserved SSID prefix.
    if (ssid.startsWith("__fail__")) {
      throw new Error(`TEST_MODE: simulated connect failure for '${ssid}'`);
    }
    void password;
    return { message: `TEST_MODE: fake connect to '${ssid}'` };
  }

  // Stop the AP
  await exec("bash", [AP_STOP_SCRIPT], { timeout: NETWORK_TIMEOUT });

  // Build args conditionally instead of splicing
  const args = password
    ? ["device", "wifi", "connect", ssid, "password", password, "ifname", IFACE]
    : ["device", "wifi", "connect", ssid, "ifname", IFACE];

  // After leaving AP mode the interface needs time to discover nearby networks.
  // Retry the connect with rescans in between — the first attempt often fails
  // because the SSID hasn't been discovered yet.
  const CONNECT_RETRIES = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
    await exec("nmcli", ["device", "wifi", "rescan", "ifname", IFACE], { timeout: NETWORK_TIMEOUT }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      const { stdout } = await exec("nmcli", args, { timeout: NETWORK_TIMEOUT });
      console.log(`[WiFi] Connected on attempt ${attempt}: ${stdout.trim()}`);
      return { message: stdout.trim() };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[WiFi] Connect attempt ${attempt}/${CONNECT_RETRIES} failed: ${msg}`);
      if (attempt < CONNECT_RETRIES) {
        // Wait a bit longer before next retry
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  console.error("[WiFi] All connect attempts failed, restoring AP:", lastErr instanceof Error ? lastErr.message : lastErr);

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

    throw lastErr;
}

export async function restartAP(): Promise<void> {
  console.log("[WiFi] Restarting access point...");
  if (TEST_MODE) {
    console.log("[WiFi] TEST_MODE: skipping AP restart");
    return;
  }
  await exec("bash", [AP_START_SCRIPT], { timeout: NETWORK_TIMEOUT });
}

/** Check if any Ethernet interface has a physical link (cable plugged in). */
export async function getEthernetStatus(): Promise<{ connected: boolean; iface: string | null }> {
  if (TEST_MODE) return { connected: true, iface: "eth0" };
  try {
    const { stdout } = await exec("nmcli", [
      "-t", "-f", "DEVICE,TYPE,STATE",
      "device", "status",
    ], { timeout: NETWORK_TIMEOUT });
    for (const line of stdout.split("\n")) {
      const [dev, type, state] = line.split(":");
      if (type === "ethernet" && state?.includes("connected")) {
        return { connected: true, iface: dev };
      }
    }
    // Check for physical link even if not connected
    const { stdout: links } = await exec("ip", ["link", "show"], { timeout: NETWORK_TIMEOUT });
    const ethMatch = links.match(/\d+:\s+(eth\w+|enp\w+|eno\w+).*state UP/);
    if (ethMatch) {
      return { connected: true, iface: ethMatch[1] };
    }
    return { connected: false, iface: null };
  } catch {
    return { connected: false, iface: null };
  }
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
