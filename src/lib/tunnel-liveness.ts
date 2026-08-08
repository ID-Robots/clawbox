/**
 * Is the tunnel hostname we are about to advertise still real?
 *
 * Cloudflare quick tunnels are ephemeral and get reaped server-side. When that
 * happens while cloudflared is still running, `tunnel.url` keeps a hostname
 * that no longer resolves and the box reports it to the portal every five
 * minutes, forever. The portal derives Online from the last heartbeat, which
 * describes the BOX, so it shows a green dot next to a link that gives
 * DNS_PROBE_FINISHED_NXDOMAIN.
 *
 * Measured on the live fleet on 2026-08-07: 5 of 30 online devices, 17%.
 * Re-measured on 2026-08-09: 4 of 30, and the only one that recovered was the
 * box whose owner opened a ticket. Nothing self-heals.
 *
 * So: resolve before reporting. A hostname that does not resolve is not
 * reported and the tunnel is restarted instead, which mints a fresh one.
 */

import { promises as dns } from "dns";

/**
 * Resolved when the device's own DNS works at all.
 *
 * Without this check a box with no network would find every hostname dead and
 * restart the tunnel on every tick, which is a worse failure than the one being
 * fixed. Cloudflare's own domain is the control: if that does not resolve
 * either, the problem is on this side of the wire and the right move is to do
 * nothing and try again in five minutes.
 */
const DNS_CONTROL_HOST = "cloudflare.com";

/**
 * Long enough for a slow uplink, short enough not to stall the tick. Kept tight
 * because the tunnel host is now retried once and the control host checked on
 * failure, so the worst case is 3 lookups — 3 × 2.5s = 7.5s, still under the
 * heartbeat unit's budget.
 */
const LOOKUP_TIMEOUT_MS = 2_500;

/**
 * A restart mints a new hostname, and the portal only learns it on the next
 * tick. Restarting faster than that would churn the tunnel without giving the
 * new URL a chance to be captured and pushed.
 */
export const RESTART_COOLDOWN_MS = 15 * 60 * 1000;

export type LivenessVerdict =
  /** The hostname resolves. Report it. */
  | "alive"
  /** The hostname does not resolve, but ours does. Restart the tunnel. */
  | "dead"
  /** Our own DNS is down. Report nothing, change nothing, try later. */
  | "unknown";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  // clear the timer whichever side wins, so the fast path doesn't park a live
  // reject timer for the full timeout on every lookup.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function hostnameOf(tunnelUrl: string): string | null {
  try {
    return new URL(tunnelUrl).hostname || null;
  } catch {
    return null;
  }
}

async function resolves(hostname: string, attempts = 1): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const records = await withTimeout(dns.resolve4(hostname), LOOKUP_TIMEOUT_MS);
      if (records.length > 0) return true;
    } catch {
      // transient failure (SERVFAIL / EAI_AGAIN / timeout) — retry if any left
    }
  }
  return false;
}

/**
 * Three-way on purpose. "Cannot tell" has to be distinguishable from "dead",
 * because the two call for opposite actions.
 */
export async function checkTunnelLiveness(tunnelUrl: string | null): Promise<LivenessVerdict> {
  if (!tunnelUrl) return "unknown";
  const hostname = hostnameOf(tunnelUrl);
  if (!hostname) return "unknown";

  // Retry the tunnel host before condemning it: a single transient failure
  // must not restart a working tunnel and rotate its public URL (every
  // bookmark/QR/shared link would break). Two agreeing failures is the bar.
  if (await resolves(hostname, 2)) return "alive";

  // It failed twice. Before calling it dead, prove that anything resolves.
  if (await resolves(DNS_CONTROL_HOST)) return "dead";
  return "unknown";
}

/** Module-level, so the cooldown survives across ticks within one server process. */
let lastRestartAt = 0;

export function mayRestart(now = Date.now()): boolean {
  return now - lastRestartAt >= RESTART_COOLDOWN_MS;
}

export function markRestarted(now = Date.now()): void {
  lastRestartAt = now;
}

/** Test seam. */
export function resetRestartCooldown(): void {
  lastRestartAt = 0;
}
