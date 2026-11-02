import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * src/lib/internet-reachable.ts: one probe shared by every poller, and an
 * answer that does not depend on ICMP alone.
 *
 * Review findings on the network-step fix: the cache was written only after a
 * probe finished, so requests arriving meanwhile each spawned a ping (the route
 * is open before sign-in); and "online" meant ICMP to 1.1.1.1, which office
 * networks drop, leaving an online PC stuck at the first step of setup.
 */
type Outcome = { error?: Error; stdout?: string };
const calls: string[] = [];
let outcomes: Record<string, () => Promise<Outcome>> = {};

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = (typeof _opts === "function" ? (_opts as typeof cb) : cb)!;
    calls.push(`${cmd} ${args.join(" ")}`);
    const run = outcomes[cmd] ?? (async () => ({ error: new Error(`no ${cmd}`) }));
    void run().then((r) => callback(r.error ?? null, { stdout: r.stdout ?? "", stderr: "" }));
  },
}));

// A TCP connect to 1.1.1.1:443 — the fallback where ICMP is dropped. Each test
// says how the connect ends.
let tcp: "connect" | "error" | "timeout" = "error";
vi.mock("net", () => {
  const connect = (opts: { host: string; port: number }) => {
    calls.push(`tcp ${opts.host}:${opts.port}`);
    const handlers: Record<string, () => void> = {};
    let onTimeout: (() => void) | null = null;
    const socket = {
      once: (event: string, fn: () => void) => { handlers[event] = fn; return socket; },
      setTimeout: (_ms: number, fn: () => void) => { onTimeout = fn; return socket; },
      destroy: () => socket,
    };
    queueMicrotask(() => {
      if (tcp === "timeout") onTimeout?.();
      else handlers[tcp]?.();
    });
    return socket;
  };
  return { default: { connect }, connect };
});

beforeEach(() => {
  calls.length = 0;
  outcomes = {};
  tcp = "error";
  vi.resetModules();
});
afterEach(() => vi.useRealTimers());

describe("internetReachable", () => {
  it("shares one probe between callers that arrive while it runs", async () => {
    let release!: () => void;
    outcomes.ping = () => new Promise((resolve) => { release = () => resolve({ stdout: "1 received" }); });
    const { internetReachable } = await import("@/lib/internet-reachable");
    const answers = Promise.all([internetReachable(), internetReachable(), internetReachable()]);
    await Promise.resolve();
    release();
    expect(await answers).toEqual([true, true, true]);
    expect(calls.filter((c) => c.startsWith("ping"))).toHaveLength(1);
  });

  it("asks with a fresh TCP connection when ping is blocked", async () => {
    // Many office networks drop outbound ICMP. A fresh connect, not a cached
    // verdict: the tray's online dot reads this too and must go offline when
    // the internet does.
    outcomes.ping = async () => ({ error: new Error("100% packet loss") });
    tcp = "connect";
    const { internetReachable } = await import("@/lib/internet-reachable");
    expect(await internetReachable()).toBe(true);
    expect(calls).toContain("tcp 1.1.1.1:443");
  });

  it("stays offline when neither gets through, as on a box broadcasting its setup hotspot", async () => {
    for (const outcome of ["error", "timeout"] as const) {
      vi.resetModules();
      outcomes.ping = async () => ({ error: new Error("unreachable") });
      tcp = outcome;
      const { internetReachable } = await import("@/lib/internet-reachable");
      expect(await internetReachable()).toBe(false);
    }
  });
});
