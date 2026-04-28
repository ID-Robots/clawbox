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

// Get full tunnel status
export async function getTunnelStatus(): Promise<TunnelStatus> {
  const state = await readState();
  const running = await isTunnelRunning();
  const tunnelUrl = running ? await getTunnelUrl() : null;

  return {
    enabled: state.enabled && running,
    running,
    tunnelUrl,
    error: null,
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

  // Check if already running
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
