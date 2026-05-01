import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { CLOUDFLARED_DIR } from "./cloudflared";
import { get as getConfigValue } from "./config-store";

const DEVICE_ID_FILE = path.join(CLOUDFLARED_DIR, "device-id");
const PORTAL_HEARTBEAT_URL =
  process.env.PORTAL_HEARTBEAT_URL?.trim() ||
  "https://openclawhardware.dev/api/portal/devices/heartbeat";
const CLAWBOX_AI_TOKEN_CONFIG_KEY = "clawai_token";
const MACHINE_ID_FILE = "/etc/machine-id";

// In-memory cache of the last URL we successfully pushed. Survives the lifetime
// of the Next.js server process — long enough that a polling status endpoint
// won't re-push the same URL on every poll, but short enough that any restart
// (which is when cloudflared also restarts and the URL changes anyway) clears
// it cleanly.
let lastPushedUrl: string | null = null;
let inFlight: Promise<void> | null = null;

async function getOrCreateDeviceId(): Promise<string> {
  // Three-tier resolution, picked so the *same physical Pi* always
  // surfaces under the same portal entry even when state gets wiped:
  //
  // 1. The per-install file we wrote previously — highest priority so a
  //    rare base-image rebuild that regenerates /etc/machine-id doesn't
  //    invalidate an already-paired device.
  // 2. /etc/machine-id — stable across data-dir wipes (SD re-image,
  //    factory reset, fresh container) on the same physical device.
  //    Hex-encoded by systemd; we take the first 16 hex chars to match
  //    the existing dev_[a-f0-9]{16} shape so the server doesn't have
  //    to special-case the format.
  // 3. Fresh random — fallback for non-Linux dev hosts and for the rare
  //    case where /etc/machine-id is empty/unreadable.
  try {
    const raw = (await fs.readFile(DEVICE_ID_FILE, "utf-8")).trim();
    if (/^dev_[a-f0-9]{16}$/.test(raw)) return raw;
  } catch {
    // Missing or unreadable — fall through.
  }

  if (process.platform === "linux") {
    try {
      const machineId = (await fs.readFile(MACHINE_ID_FILE, "utf-8")).trim();
      if (/^[a-f0-9]{32}$/.test(machineId)) {
        const id = `dev_${machineId.slice(0, 16)}`;
        await fs.mkdir(CLOUDFLARED_DIR, { recursive: true });
        await fs.writeFile(DEVICE_ID_FILE, id, { mode: 0o600 });
        return id;
      }
    } catch {
      // /etc/machine-id missing (rare, but possible inside minimal
      // containers) — fall through to random.
    }
  }

  const id = `dev_${crypto.randomBytes(8).toString("hex")}`;
  await fs.mkdir(CLOUDFLARED_DIR, { recursive: true });
  await fs.writeFile(DEVICE_ID_FILE, id, { mode: 0o600 });
  return id;
}

// Derive the default device name from the deviceId so a given physical
// device always advertises the same suggested name across heartbeats.
// (The server preserves the user's chosen name once a record exists, but
// we still send a name on every push to cover the very-first-push and
// post-deletion-recreate cases — without this, those paths would burn
// through new random suffixes on every poll until a record stuck.)
function deriveDeviceName(deviceId: string): string {
  const suffix = crypto
    .createHash("sha256")
    .update(deviceId)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
  return `ClawBox-${suffix}`;
}

async function readClawAiToken(): Promise<string | null> {
  try {
    const raw = await getConfigValue(CLAWBOX_AI_TOKEN_CONFIG_KEY);
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed.startsWith("claw_") ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Internal: actually do the POST. Caller must hold the inFlight slot
 * (the two public entry points below check `if (inFlight) return` and
 * assign to it). Always clears `inFlight` on settle so a stuck
 * promise can't permanently lock the helper.
 */
async function pushNow(tunnelUrl: string): Promise<void> {
  try {
    const token = await readClawAiToken();
    if (!token) return;

    const deviceId = await getOrCreateDeviceId();
    const name = deriveDeviceName(deviceId);

    const res = await fetch(PORTAL_HEARTBEAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ deviceId, tunnelUrl, name }),
    });

    if (res.ok) {
      lastPushedUrl = tunnelUrl;
    } else if (res.status === 401 || res.status === 403) {
      // Token revoked or unpaired — stop trying until a config change clears
      // the in-memory state via process restart.
      console.warn(`[portal-heartbeat] auth rejected (${res.status}); will not retry until restart`);
      lastPushedUrl = tunnelUrl;
    } else {
      const detail = await res.text().catch(() => "");
      console.warn(`[portal-heartbeat] push failed ${res.status}: ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn("[portal-heartbeat] push error:", err instanceof Error ? err.message : err);
  } finally {
    inFlight = null;
  }
}

/**
 * Push the current tunnel URL to the portal so the user's Devices list stays
 * in sync without manual re-paste on every cloudflared restart. Fire-and-forget:
 * never throws, never blocks the caller, no-ops if anything is missing
 * (no token paired yet, no URL captured yet, network down).
 *
 * Skips when the URL hasn't changed since the last successful push —
 * that's the "URL drift" path, fired from the cloudflared status route.
 * For periodic liveness pings (lastSeenAt freshness), use
 * {@link pushHeartbeatTick} instead.
 */
export function pushHeartbeatIfChanged(tunnelUrl: string | null): void {
  if (!tunnelUrl) return;
  if (tunnelUrl === lastPushedUrl) return;
  if (inFlight) return;
  inFlight = pushNow(tunnelUrl);
}

/**
 * Periodic liveness ping. Pushes the current URL even when it hasn't
 * changed so the portal's `lastSeenAt < 10 min ago` check keeps the
 * device flagged as Online while it's actually alive.
 *
 * Triggered from the systemd timer (clawbox-heartbeat.timer) every
 * ~5 minutes via the GET /setup-api/portal/heartbeat-tick route, so
 * the cadence is well below the server's 10-minute staleness window
 * even with a missed beat or two during a network blip.
 *
 * Same fire-and-forget contract as `pushHeartbeatIfChanged`. Honours
 * the in-flight guard so a slow previous push doesn't pile a second
 * request on top.
 */
export function pushHeartbeatTick(tunnelUrl: string | null): void {
  if (!tunnelUrl) return;
  if (inFlight) return;
  inFlight = pushNow(tunnelUrl);
}
