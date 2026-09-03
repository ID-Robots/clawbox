import net from "net";

/**
 * Resolves true if a TCP connection to `host:port` completes within
 * `timeoutMs`. The kernel handles the 3-way handshake without involving
 * the target process's event loop, so this answers "is the listener
 * bound?" cleanly even when the target is blocked on long synchronous
 * work (e.g. OpenClaw gateway during agent prep).
 */
export function isPortOpen(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.connect(port, host);
  });
}

/** How {@link waitForPortOpen} polls. Defaults are the updater's long-standing values. */
export interface PortWaitOptions {
  /** Whole-wait budget in ms. */
  timeoutMs: number;
  /** Gap between probes. */
  intervalMs?: number;
  /** Per-probe connect timeout. */
  probeTimeoutMs?: number;
}

const DEFAULT_WAIT_INTERVAL_MS = 1_500;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/**
 * Poll until something is listening on `host:port`, or the budget runs out.
 *
 * THE ONE PLACE that answers "is this service serving yet?". `systemctl restart`
 * on a `Type=simple` unit returns when the main process is FORKED, so every
 * caller that read it as "the service is back" was reporting a success it had
 * not observed. A TCP connect is the probe because the kernel completes the
 * handshake without the target's event loop, so it answers correctly even while
 * the process is blocked on long synchronous work — and because it is the probe
 * OpenClaw itself uses for this question (`waitForGatewayPortReady`).
 *
 * Deliberately only the open direction. "Nothing is listening" cannot be proven
 * this way: `isPortOpen` reports a connect TIMEOUT and a refusal alike, so a
 * wedged process whose backlog is full would read as gone.
 */
export async function waitForPortOpen(
  port: number,
  host = "127.0.0.1",
  { timeoutMs, intervalMs = DEFAULT_WAIT_INTERVAL_MS, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS }: PortWaitOptions,
): Promise<boolean> {
  // A malformed budget must not become an unbounded hot spin: every caller's
  // timeout comes from `Number(process.env…)`, and `Date.now() + NaN` makes
  // every later comparison false. Zero means "one probe, then give up".
  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    // ONE probe may not outlive the WHOLE wait: a connect timeout fired just
    // before the deadline would spend the caller's budget a second time, which
    // matters most where the budget is what is left of a shared deadline. A
    // zero or exhausted budget still asks once, at full length — "give up at
    // once" must not become "never ask". (A positive budget shorter than one
    // probe caps that first probe too, which is the point.)
    const leftBeforeProbe = deadline - Date.now();
    const probeMs = leftBeforeProbe > 0 ? Math.min(probeTimeoutMs, leftBeforeProbe) : probeTimeoutMs;
    if (await isPortOpen(port, host, probeMs)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

