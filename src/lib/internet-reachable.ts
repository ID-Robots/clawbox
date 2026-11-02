import { execFile } from "child_process";
import { promisify } from "util";

/**
 * Whether this machine can reach the internet right now: one ping to 1.1.1.1,
 * remembered for five seconds so the screens that poll it (the tray's online
 * dot, the setup wizard's network step) share one probe instead of each
 * spawning their own.
 *
 * A bare connectivity reading on purpose. It is read by every signed-in user
 * (/setup-api/network/internet, see src/lib/non-owner-scope.ts) and, through
 * /setup-api/wifi/ethernet, before any owner exists — nothing of the network's
 * configuration belongs in it.
 */
const execFileAsync = promisify(execFile);
const TTL_MS = 5_000;

export interface InternetStatus {
  online: boolean;
  latencyMs: number | null;
  checkedAt: number;
}

let cache: InternetStatus | null = null;

async function check(): Promise<{ online: boolean; latencyMs: number | null }> {
  try {
    const t0 = Date.now();
    await execFileAsync("ping", ["-c", "1", "-W", "2", "-n", "1.1.1.1"], { timeout: 3000 });
    return { online: true, latencyMs: Date.now() - t0 };
  } catch {
    return { online: false, latencyMs: null };
  }
}

export async function internetStatus(): Promise<InternetStatus> {
  const now = Date.now();
  if (!cache || now - cache.checkedAt > TTL_MS) {
    cache = { ...(await check()), checkedAt: now };
  }
  return cache;
}

export async function internetReachable(): Promise<boolean> {
  return (await internetStatus()).online;
}
