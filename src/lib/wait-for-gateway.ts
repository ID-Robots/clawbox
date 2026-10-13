/**
 * Browser side of a save that restarted the gateway (TASK-1535).
 *
 * `/setup-api/ai-models/configure` answers a save that needs a gateway restart
 * as soon as systemd has taken it (`gatewayRestarting: true`), instead of
 * holding the request through the stop, the pre-start and the core start-up —
 * the two minutes that ran it past what the browser and the tunnel would hold
 * open. The page waits for the gateway itself, here, against
 * `/setup-api/gateway/health`, which reports a restart still in flight as not
 * available (so the old process, still listening while it is stopped, cannot
 * be mistaken for the gateway being back).
 *
 * Client-safe: no server imports.
 */

/** A restart is 50-60 s on a board; three times that before the page stops waiting. */
export const GATEWAY_BACK_WAIT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 5_000;

export interface WaitForGatewayOptions {
  signal?: AbortSignal;
  budgetMs?: number;
  intervalMs?: number;
  /** For tests; the page's own `fetch` otherwise. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Resolves true once the gateway is reachable again, false when the budget ran
 * out or the wait was aborted. Never rejects.
 */
export async function waitForGatewayAfterRestart(options: WaitForGatewayOptions = {}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const deadline = Date.now() + (options.budgetMs ?? GATEWAY_BACK_WAIT_MS);
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  while (!options.signal?.aborted && Date.now() < deadline) {
    try {
      const res = await fetchImpl("/setup-api/gateway/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { available?: unknown } | null;
        if (data?.available === true) return true;
      }
    } catch {
      // The web server answers this from the box itself; a failed probe is
      // a moment, not a verdict.
    }
    await pause(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
  }
  return false;
}
