import net from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envPort, isPortOpen, waitForPortOpen } from "@/lib/port-probe";

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

  it("never lets one probe outlive the whole wait", async () => {
    // A connect timeout fired just before the deadline would spend the budget a
    // second time — which matters most for the Hermes bounce, where the budget
    // handed here is what is LEFT of a shared deadline. Read off the socket
    // rather than the clock: a refused loopback connect never reaches its own
    // timeout, so the cap is only observable as the value the probe was given.
    //
    // Every probe with budget still on the clock is capped. The LAST one is
    // not, and deliberately: it is taken with the budget already spent, which
    // is the "give up at once must not become never ask" carve-out the next
    // case pins. So the overrun this loop can add is bounded by one probe, not
    // by one probe per poll.
    const port = await freePort();
    const given: number[] = [];
    const spy = vi
      .spyOn(net.Socket.prototype, "setTimeout")
      .mockImplementation(function (this: net.Socket, ms: number) {
        given.push(ms);
        return this;
      } as never);
    try {
      await expect(
        waitForPortOpen(port, HOST, { timeoutMs: 60, intervalMs: 20, probeTimeoutMs: 5_000 }),
      ).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }

    expect(given.length).toBeGreaterThan(1);
    for (const ms of given.slice(0, -1)) expect(ms).toBeLessThanOrEqual(60);
  });

  it("still asks once, at full length, on an exhausted budget", async () => {
    // "Give up at once" must not become "never ask": a zero or already-spent
    // budget still gets one probe, and that one is not clamped to nothing.
    const port = await freePort();
    const given: number[] = [];
    const spy = vi
      .spyOn(net.Socket.prototype, "setTimeout")
      .mockImplementation(function (this: net.Socket, ms: number) {
        given.push(ms);
        return this;
      } as never);
    try {
      await expect(
        waitForPortOpen(port, HOST, { timeoutMs: 0, probeTimeoutMs: 200 }),
      ).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }

    expect(given).toEqual([200]);
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

/**
 * The ports every readiness wait and every local baseUrl is built from come out
 * of the environment, and `Number(x) || default` was not enough: `-1`, `1.5` and
 * `70000` are truthy, so they survived the fallback, and Node then throws
 * ERR_SOCKET_BAD_PORT synchronously — outside `isPortOpen`'s error handler, so
 * the probe REJECTS instead of answering false, and `restartGateway` reports a
 * restart that worked as a failed one.
 */
describe("envPort", () => {
  it("takes a valid port", () => {
    expect(envPort("9119", 1)).toBe(9119);
    expect(envPort("1", 9119)).toBe(1);
    expect(envPort("65535", 9119)).toBe(65535);
  });

  it("falls back on anything Node would refuse at the socket", () => {
    for (const bad of [undefined, "", "  ", "oops", "9119abc", "0", "-1", "1.5", "65536", "70000", "NaN", "Infinity"]) {
      expect(envPort(bad, 9119)).toBe(9119);
    }
  });

  it("agrees with the socket about which ports are usable", async () => {
    // Not a restatement of the rule: the values the guard rejects are exactly
    // the ones `net.Socket.connect` throws on, and a throw here does not become
    // `false` — it escapes isPortOpen's error handler and rejects.
    for (const bad of [-1, 1.5, 70000]) {
      await expect(isPortOpen(bad, HOST, 50)).rejects.toThrow();
      expect(envPort(String(bad), 9119)).toBe(9119);
    }
  });
});
