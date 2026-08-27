/**
 * ClawBox — Cloudflare Tunnel Management
 *
 * Uses Cloudflare's `cloudflared` quick tunnel feature (no account required).
 * The tunnel URL is extracted from cloudflared output and persisted.
 */

import { exec, spawn } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import {
  type TunnelUnitState,
  getTunnelServiceState,
  readTunnelUrl,
  readTunnelUrlFromJournal,
} from "@/lib/cloudflared";

const execAsync = promisify(exec);

// Data directory for tunnel state. Aligns with the rest of the app
// (config-store uses CLAWBOX_ROOT/data); falling back to /data — which
// does not exist on real installs — would cause every writeFile call
// here to throw, leaving the /setup-api/tunnel/enable handler hung
// since startTunnel's success path awaits a Promise.all that never
// resolves.
const DATA_DIR =
  process.env.CLAWBOX_DATA_DIR ||
  join(process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data");
const TUNNEL_STATE_FILE = join(DATA_DIR, "tunnel-state.json");
const TUNNEL_PID_FILE = join(DATA_DIR, "tunnel.pid");
const TUNNEL_URL_FILE = join(DATA_DIR, "tunnel-url.txt");

export interface TunnelState {
  enabled: boolean;
  tunnelUrl: string | null;
  startedAt: string | null;
}

export interface TunnelStatus {
  enabled: boolean;
  running: boolean;
  tunnelUrl: string | null;
  error: string | null;
  /** systemd state of clawbox-tunnel.service. */
  service: TunnelUnitState;
  /** Which tunnel this describes — null when nothing is running. */
  managedBy: "systemd" | "spawned" | null;
}

async function ensureDataDir() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Ignore if exists
  }
}

export async function readState(): Promise<TunnelState> {
  try {
    const data = await readFile(TUNNEL_STATE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { enabled: false, tunnelUrl: null, startedAt: null };
  }
}

export async function writeState(state: TunnelState) {
  await ensureDataDir();
  await writeFile(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2));
}

export async function getTunnelPid(): Promise<number | null> {
  try {
    const pid = await readFile(TUNNEL_PID_FILE, "utf-8");
    return parseInt(pid.trim(), 10);
  } catch {
    return null;
  }
}

export async function isTunnelRunning(): Promise<boolean> {
  const pid = await getTunnelPid();
  if (!pid) return false;

  try {
    // Check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    try {
      await unlink(TUNNEL_PID_FILE);
    } catch {}
    return false;
  }
}

export async function getTunnelUrl(): Promise<string | null> {
  try {
    const url = await readFile(TUNNEL_URL_FILE, "utf-8");
    return url.trim() || null;
  } catch {
    return null;
  }
}

export async function isCloudflaredInstalled(): Promise<boolean> {
  try {
    await execAsync("which cloudflared");
    return true;
  } catch {
    return false;
  }
}

/**
 * Full tunnel status — for EITHER tunnel this device can be running.
 *
 * There are two, and this module only ever knew about one of them. This file
 * spawns `cloudflared` itself and records the child's pid in data/tunnel.pid;
 * the shipped device instead runs clawbox-tunnel.service, whose
 * scripts/run-tunnel.sh writes no pid file at all and publishes its URL to
 * data/cloudflared/tunnel.url. So on a real box — the QA device on
 * 2026-08-24 — this answered `{enabled:false, running:false, tunnelUrl:null}`
 * while `systemctl is-active clawbox-tunnel` said `active` and the whole
 * desktop was being served to the public internet behind one password. Telling
 * an owner that remote access is off when it is on is a support-grade lie, and
 * it is the one state in which they most need the URL and the off switch.
 *
 * The unit is consulted first because it is the one an installed device uses.
 */
export async function getTunnelStatus(): Promise<TunnelStatus> {
  const [state, spawnedRunning, service] = await Promise.all([
    readState(),
    isTunnelRunning(),
    getTunnelServiceState(),
  ]);
  // "activating" counts as up: cloudflared is already dialling out, and a
  // status that flickers to "off" mid-start is what makes the panel look broken.
  const serviceRunning = service === "active" || service === "activating";
  const running = serviceRunning || spawnedRunning;

  let tunnelUrl: string | null = null;
  if (serviceRunning) {
    tunnelUrl = (await readTunnelUrl()) ?? (await readTunnelUrlFromJournal());
  }
  if (!tunnelUrl && spawnedRunning) tunnelUrl = await getTunnelUrl();

  return {
    // `state.enabled` is only ever written by startTunnel/stopTunnel in this
    // file, so it cannot speak for the unit. A running unit IS remote access
    // enabled, whoever turned it on.
    enabled: serviceRunning || (state.enabled && spawnedRunning),
    running,
    tunnelUrl,
    error: null,
    service,
    managedBy: serviceRunning ? "systemd" : spawnedRunning ? "spawned" : null,
  };
}

// Start the tunnel using cloudflared quick tunnel
export async function startTunnel(): Promise<{ success: boolean; error?: string; tunnelUrl?: string }> {
  // Check if cloudflared is installed
  if (!(await isCloudflaredInstalled())) {
    return {
      success: false,
      error: "cloudflared is not installed. Please install it first.",
    };
  }

  // Check if already running — EITHER tunnel. Without the unit check this
  // spawned a second cloudflared alongside clawbox-tunnel.service, publishing a
  // second public hostname for the same box that nothing then tracked or
  // stopped.
  const service = await getTunnelServiceState();
  if (service === "active" || service === "activating") {
    const url = (await readTunnelUrl()) ?? (await readTunnelUrlFromJournal());
    return { success: true, tunnelUrl: url || undefined };
  }
  if (await isTunnelRunning()) {
    const url = await getTunnelUrl();
    return { success: true, tunnelUrl: url || undefined };
  }

  await ensureDataDir();

  return new Promise((resolve) => {
    // Start cloudflared with quick tunnel (no account needed)
    // It will expose localhost:80 (the ClawBox web UI)
    const proc = spawn("cloudflared", ["tunnel", "--url", "http://localhost:80"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tunnelUrl: string | null = null;
    let resolved = false;

    const handleOutput = (data: Buffer) => {
      const output = data.toString();
      // Look for the tunnel URL in output
      // cloudflared outputs: "Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): https://xxx.trycloudflare.com"
      const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (urlMatch && !resolved) {
        tunnelUrl = urlMatch[0];
        resolved = true;

        // Save state
        Promise.all([
          writeFile(TUNNEL_PID_FILE, proc.pid!.toString()),
          writeFile(TUNNEL_URL_FILE, tunnelUrl),
          writeState({ enabled: true, tunnelUrl, startedAt: new Date().toISOString() }),
        ]).then(() => {
          resolve({ success: true, tunnelUrl: tunnelUrl! });
        });
      }
    };

    proc.stdout?.on("data", handleOutput);
    proc.stderr?.on("data", handleOutput);

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: err.message });
      }
    });

    proc.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: `cloudflared exited with code ${code}` });
      }
    });

    // Detach so it keeps running after this request
    proc.unref();

    // Timeout after 30 seconds if no URL found
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({ success: false, error: "Timeout waiting for tunnel URL" });
      }
    }, 30000);
  });
}

export async function stopTunnel(): Promise<{ success: boolean; error?: string }> {
  // This function can only kill a child THIS module spawned. On an installed
  // device the tunnel is clawbox-tunnel.service, and reporting success for a
  // unit that is still running would tell the owner the box is off the public
  // internet when it is not — the exact failure getTunnelStatus() had. Say so
  // and name the control that does work.
  const service = await getTunnelServiceState();
  if (service === "active" || service === "activating") {
    return {
      success: false,
      error:
        "Remote access is running as the clawbox-tunnel system service, which this endpoint cannot stop. Turn it off in Settings > Remote Control (POST /setup-api/portal/stop).",
    };
  }

  const pid = await getTunnelPid();

  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      // Wait a moment for graceful shutdown
      await new Promise((r) => setTimeout(r, 1000));
      try {
        process.kill(pid, 0);
        // Still running, force kill
        process.kill(pid, "SIGKILL");
      } catch {
        // Process is dead, good
      }
    } catch {
      // Process already dead
    }
  }

  // Clean up files
  try {
    await unlink(TUNNEL_PID_FILE);
  } catch {}
  try {
    await unlink(TUNNEL_URL_FILE);
  } catch {}

  await writeState({ enabled: false, tunnelUrl: null, startedAt: null });

  return { success: true };
}
