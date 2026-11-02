import { execFile } from "child_process";
import net from "net";
import { promisify } from "util";

/**
 * Whether this machine can reach the internet right now: one ping to 1.1.1.1
 * (a TCP connection to it where ICMP is dropped), shared by
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

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function check(): Promise<{ online: boolean; latencyMs: number | null }> {
  try {
    const t0 = Date.now();
    await execFileAsync("ping", ["-c", "1", "-W", "2", "-n", "1.1.1.1"], { timeout: 3000 });
    return { online: true, latencyMs: Date.now() - t0 };
  } catch {
    // Many office networks drop outbound ICMP: ask with a fresh TCP connection
    // to the same host instead. Fresh on every probe, never a cached verdict —
    // the tray's online dot reads this and must go offline when the internet
    // does. A box broadcasting its setup hotspot has no route out at all.
    const t0 = Date.now();
    return (await tcpReachable("1.1.1.1", 443, 2000))
      ? { online: true, latencyMs: Date.now() - t0 }
      : { online: false, latencyMs: null };
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
