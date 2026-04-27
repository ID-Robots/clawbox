import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { DATA_DIR } from "./config-store";

const execFileAsync = promisify(execFile);

export const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || "/usr/local/bin/cloudflared";
export const CLOUDFLARED_DIR = path.join(DATA_DIR, "cloudflared");
export const TUNNEL_URL_FILE = path.join(CLOUDFLARED_DIR, "tunnel.url");
export const TUNNEL_SERVICE = "clawbox-tunnel.service";

export async function isInstalled(): Promise<boolean> {
  try {
    await fs.access(CLOUDFLARED_BIN, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read the currently-published *.trycloudflare.com URL, if any. */
export async function readTunnelUrl(): Promise<string | null> {
  try {
    const raw = (await fs.readFile(TUNNEL_URL_FILE, "utf-8")).trim();
    if (!raw) return null;
    // Sanity-check the shape so we never return garbage.
    if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/i.test(raw)) return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function startTunnelService(): Promise<void> {
  await execFileAsync("sudo", ["-n", "/usr/bin/systemctl", "restart", TUNNEL_SERVICE]);
  // Persist the user's intent across reboots — without `enable`, the next
  // power cycle would leave the box unreachable until they SSH in again,
  // which defeats the whole point of Remote Access. Best-effort: a failure
  // here is non-fatal because the tunnel itself just got started above.
  await execFileAsync("sudo", ["-n", "/usr/bin/systemctl", "enable", TUNNEL_SERVICE]).catch((err) => {
    console.warn("[cloudflared] enable failed (non-fatal):", err instanceof Error ? err.message : err);
  });
}

export async function stopTunnelService(): Promise<void> {
  await execFileAsync("sudo", ["-n", "/usr/bin/systemctl", "stop", TUNNEL_SERVICE]);
  // Mirror image of startTunnelService — without `disable` the unit comes
  // back on the next reboot, silently overriding the user's stop intent.
  await execFileAsync("sudo", ["-n", "/usr/bin/systemctl", "disable", TUNNEL_SERVICE]).catch((err) => {
    console.warn("[cloudflared] disable failed (non-fatal):", err instanceof Error ? err.message : err);
  });
}

export type TunnelUnitState = "active" | "inactive" | "failed" | "activating" | "unknown";

export async function getTunnelServiceState(): Promise<TunnelUnitState> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", TUNNEL_SERVICE]);
    const state = stdout.trim();
    if (state === "active" || state === "inactive" || state === "failed" || state === "activating") {
      return state;
    }
    return "unknown";
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout?.trim();
    if (stdout === "inactive" || stdout === "failed" || stdout === "activating") {
      return stdout;
    }
    return "unknown";
  }
}
