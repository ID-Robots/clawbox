import { execFile } from "child_process";
import { promisify } from "util";

/**
 * Whether this machine can reach the internet right now: one ping to 1.1.1.1
 * (NetworkManager's own connectivity check where ICMP is dropped), shared by
 * every caller while it runs and remembered for five seconds, so the screens
 * that poll it (the tray's online dot, the setup wizard's network step) share
 * one probe instead of each spawning their own.
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
// The probe in flight, so callers that arrive while it runs wait for it rather
// than each spawning their own (the route that reads it is open before sign-in).
let inflight: Promise<InternetStatus> | null = null;

async function check(): Promise<{ online: boolean; latencyMs: number | null }> {
  try {
    const t0 = Date.now();
    await execFileAsync("ping", ["-c", "1", "-W", "2", "-n", "1.1.1.1"], { timeout: 3000 });
    return { online: true, latencyMs: Date.now() - t0 };
  } catch {
    // Many office networks drop outbound ICMP. NetworkManager runs its own
    // connectivity check; `full` is its word for "reaches the internet". A box
    // broadcasting its setup hotspot answers none or limited. Its last result,
    // not a re-check: re-checking needs a polkit grant a service user lacks.
    try {
      const { stdout } = await execFileAsync("nmcli", ["-t", "networking", "connectivity"], { timeout: 5000 });
      return { online: stdout.trim() === "full", latencyMs: null };
    } catch {
      return { online: false, latencyMs: null };
    }
  }
}

export async function internetStatus(): Promise<InternetStatus> {
  if (cache && Date.now() - cache.checkedAt <= TTL_MS) return cache;
  inflight ??= check()
    .then((result) => {
      cache = { ...result, checkedAt: Date.now() };
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function internetReachable(): Promise<boolean> {
  return (await internetStatus()).online;
}
