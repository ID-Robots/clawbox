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

beforeEach(() => {
  calls.length = 0;
  outcomes = {};
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

  it("asks NetworkManager when ping is blocked, and believes a full connection", async () => {
    outcomes.ping = async () => ({ error: new Error("100% packet loss") });
    outcomes.nmcli = async () => ({ stdout: "full\n" });
    const { internetReachable } = await import("@/lib/internet-reachable");
    expect(await internetReachable()).toBe(true);
    expect(calls).toContain("nmcli -t networking connectivity");
  });

  it("stays offline when NetworkManager reports no full connection, as on a box broadcasting its setup hotspot", async () => {
    for (const state of ["limited", "none", "portal", "unknown"]) {
      vi.resetModules();
      outcomes.ping = async () => ({ error: new Error("unreachable") });
      outcomes.nmcli = async () => ({ stdout: `${state}\n` });
      const { internetReachable } = await import("@/lib/internet-reachable");
      expect(await internetReachable()).toBe(false);
    }
  });
});
