/**
 * The box must not advertise a hostname that no longer exists.
 *
 * Cloudflare reaps quick tunnels server-side. With cloudflared still running,
 * tunnel.url keeps the dead hostname and the heartbeat reported it every five
 * minutes, so the portal showed Online next to a link that gave
 * DNS_PROBE_FINISHED_NXDOMAIN. On the live fleet: 5 of 30 devices on
 * 2026-08-07, 4 of 30 on 2026-08-09, and the only one that recovered in
 * between was fixed by hand after its owner complained.
 *
 * The distinction these tests exist to protect is "dead" versus "cannot tell".
 * A box with no network sees every hostname as unresolvable, and treating that
 * as dead would restart the tunnel on every tick — a worse fault than the one
 * being fixed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolve4 = vi.fn();

vi.mock("dns", () => ({
  promises: { resolve4: (...args: unknown[]) => resolve4(...args) },
}));

let mod: typeof import("@/lib/tunnel-liveness");

beforeEach(async () => {
  vi.resetModules();
  resolve4.mockReset();
  mod = await import("@/lib/tunnel-liveness");
  mod.resetRestartCooldown();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkTunnelLiveness", () => {
  it("calls a resolving hostname alive", async () => {
    resolve4.mockResolvedValue(["104.16.0.1"]);
    expect(await mod.checkTunnelLiveness("https://example-tunnel-host.trycloudflare.com")).toBe("alive");
  });

  it("calls it dead when it does not resolve but our DNS does", async () => {
    resolve4.mockImplementation((host: string) =>
      host === "cloudflare.com" ? Promise.resolve(["104.16.0.1"]) : Promise.reject(new Error("ENOTFOUND")),
    );
    expect(await mod.checkTunnelLiveness("https://dead-tunnel-example.trycloudflare.com")).toBe("dead");
  });

  it("says unknown when nothing resolves, because then the fault is ours", async () => {
    // A box on a dropped uplink. Restarting the tunnel here would churn it
    // every five minutes and fix nothing.
    resolve4.mockRejectedValue(new Error("EAI_AGAIN"));
    expect(await mod.checkTunnelLiveness("https://dead-tunnel-example.trycloudflare.com")).toBe("unknown");
  });

  it("checks the control host only after the tunnel fails, not on every tick", async () => {
    resolve4.mockResolvedValue(["104.16.0.1"]);
    await mod.checkTunnelLiveness("https://alive.trycloudflare.com");
    expect(resolve4).toHaveBeenCalledTimes(1);
    expect(resolve4).toHaveBeenCalledWith("alive.trycloudflare.com");
  });

  it("treats an empty resolve as unresolved", async () => {
    // Some resolvers answer NOERROR with no A records.
    resolve4.mockImplementation((host: string) =>
      host === "cloudflare.com" ? Promise.resolve(["104.16.0.1"]) : Promise.resolve([]),
    );
    expect(await mod.checkTunnelLiveness("https://empty.trycloudflare.com")).toBe("dead");
  });

  it("says unknown for a missing or unparseable url rather than restarting", async () => {
    for (const url of [null, "", "not-a-url", "   "]) {
      expect(await mod.checkTunnelLiveness(url as string | null)).toBe("unknown");
    }
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("does not hang the tick when DNS never answers", async () => {
    // The timer fires every five minutes; a lookup that never settles would
    // hold the route open indefinitely.
    resolve4.mockImplementation(() => new Promise(() => {}));
    const verdict = await mod.checkTunnelLiveness("https://slow.trycloudflare.com");
    expect(verdict).toBe("unknown");
  }, 20_000);
});

describe("the restart cooldown", () => {
  it("allows the first restart", () => {
    expect(mod.mayRestart()).toBe(true);
  });

  it("blocks a second restart inside the window", () => {
    const t0 = 1_000_000;
    mod.markRestarted(t0);
    expect(mod.mayRestart(t0 + 60_000)).toBe(false);
  });

  it("allows one again after the window", () => {
    // A restart mints a new hostname that only reaches the portal on the next
    // tick. The window has to outlast that round trip.
    const t0 = 1_000_000;
    mod.markRestarted(t0);
    expect(mod.mayRestart(t0 + mod.RESTART_COOLDOWN_MS)).toBe(true);
  });

  it("is longer than the five-minute tick, or restarts would stack", () => {
    expect(mod.RESTART_COOLDOWN_MS).toBeGreaterThan(5 * 60 * 1000);
  });
});

describe("hostnameOf", () => {
  it("pulls the host out of a tunnel url", () => {
    expect(mod.hostnameOf("https://sample-tunnel-host.trycloudflare.com")).toBe(
      "sample-tunnel-host.trycloudflare.com",
    );
  });

  it("returns null rather than throwing on junk", () => {
    expect(mod.hostnameOf("nonsense")).toBeNull();
  });
});
