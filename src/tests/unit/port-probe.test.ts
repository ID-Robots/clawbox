import net from "net";
import { afterEach, describe, expect, it } from "vitest";
import { isPortOpen, waitForPortOpen } from "@/lib/port-probe";

/**
 * The polling loop three readiness waits now share: the updater's
 * `waitForGateway`, `restartGateway`'s own wait on :18789, and the Hermes
 * dashboard bounce. Driven against a real socket, because the loop calls the
 * probe inside its own module — a mocked export would not be the thing that
 * runs.
 */
const HOST = "127.0.0.1";
const FAST = { timeoutMs: 400, intervalMs: 20, probeTimeoutMs: 200 };

let server: net.Server | null = null;

function listen(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    server = s;
    s.once("error", reject);
    s.listen(port, HOST, () => resolve((s.address() as net.AddressInfo).port));
  });
}

function close(): Promise<void> {
  const s = server;
  server = null;
  if (!s) return Promise.resolve();
  return new Promise((resolve) => s.close(() => resolve()));
}

/** A port nothing is listening on: bind one, then let it go. */
async function freePort(): Promise<number> {
  const port = await listen();
  await close();
  return port;
}

afterEach(close);

describe("waitForPortOpen", () => {
  it("returns as soon as something is listening", async () => {
    const port = await listen();
    const started = Date.now();
    await expect(waitForPortOpen(port, HOST, { ...FAST, timeoutMs: 5_000 })).resolves.toBe(true);
    // No sleep before the first probe: a service that is already up must not
    // cost the caller a polling interval.
    expect(Date.now() - started).toBeLessThan(FAST.timeoutMs);
  });

  it("gives up on a port that never opens, inside its budget", async () => {
    const port = await freePort();
    const started = Date.now();
    await expect(waitForPortOpen(port, HOST, FAST)).resolves.toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(FAST.timeoutMs - 50);
    // Never sleeps past the deadline: the last gap is clamped to what is left.
    expect(elapsed).toBeLessThan(FAST.timeoutMs + 2_000);
  });

  it("waits for a listener that arrives late", async () => {
    const port = await freePort();
    expect(await isPortOpen(port, HOST, 200)).toBe(false);
    setTimeout(() => void listen(port), 40);
    await expect(waitForPortOpen(port, HOST, { ...FAST, timeoutMs: 5_000 })).resolves.toBe(true);
  });

  it("gives up at once on a malformed budget rather than spinning", async () => {
    // Every caller's timeout comes from `Number(process.env…)`, so a typo makes
    // it NaN. `Date.now() + NaN` makes every deadline comparison false, which
    // without the guard is a 1 ms-interval hot loop that never returns.
    const port = await freePort();
    const started = Date.now();
    await expect(
      waitForPortOpen(port, HOST, { timeoutMs: Number("thirty-seconds"), probeTimeoutMs: 200 }),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
