/**
 * What the five-minute tick does with a hostname that has stopped existing.
 *
 * Before this, it pushed whatever was in tunnel.url. Cloudflare reaps quick
 * tunnels, cloudflared keeps running, the file keeps a corpse, and the portal
 * showed a green Online next to a dead link on 5 of 30 live devices.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudflared = {
  readTunnelUrl: vi.fn(),
  startTunnelService: vi.fn(),
};
const heartbeat = { pushHeartbeatTick: vi.fn() };
const liveness = {
  checkTunnelLiveness: vi.fn(),
  mayRestart: vi.fn(),
  markRestarted: vi.fn(),
};

vi.mock("@/lib/cloudflared", () => cloudflared);
vi.mock("@/lib/portal-heartbeat", () => heartbeat);
vi.mock("@/lib/tunnel-liveness", () => liveness);

async function tick() {
  const mod = await import("@/app/setup-api/portal/heartbeat-tick/route");
  return mod.GET();
}

beforeEach(() => {
  vi.resetModules();
  liveness.mayRestart.mockReturnValue(true);
  cloudflared.startTunnelService.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const fn of [...Object.values(cloudflared), ...Object.values(heartbeat), ...Object.values(liveness)]) {
    fn.mockReset();
  }
});

describe("a live tunnel", () => {
  it("is reported, as before", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://alive.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("alive");

    const res = await tick();
    expect(res.status).toBe(200);
    expect(heartbeat.pushHeartbeatTick).toHaveBeenCalledWith("https://alive.trycloudflare.com");
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
  });
});

describe("a dead tunnel", () => {
  beforeEach(() => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://dead-tunnel-example.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("dead");
  });

  it("is never reported", async () => {
    // The whole bug in one assertion.
    await tick();
    expect(heartbeat.pushHeartbeatTick).not.toHaveBeenCalled();
  });

  it("restarts the tunnel so a fresh hostname is minted", async () => {
    await tick();
    expect(cloudflared.startTunnelService).toHaveBeenCalledTimes(1);
    expect(liveness.markRestarted).toHaveBeenCalled();
  });

  it("says what it did, so the timer's log is diagnosable", async () => {
    const res = await tick();
    expect(await res.json()).toEqual({ ok: true, tunnel: "dead", restarted: true });
  });

  it("respects the cooldown rather than restarting every five minutes", async () => {
    liveness.mayRestart.mockReturnValue(false);
    const res = await tick();
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, tunnel: "dead", restarted: false });
  });

  it("still answers 200 when the restart itself fails", async () => {
    // A 500 here would make the systemd unit flap.
    cloudflared.startTunnelService.mockRejectedValue(new Error("sudo: no tty"));
    const res = await tick();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tunnel: "dead", restarted: false });
  });
});

describe("when the box cannot tell", () => {
  it("keeps reporting, because the fault is probably our own network", async () => {
    // Dropped uplink. Going quiet here would mark a healthy box Offline, and
    // restarting its tunnel would fix nothing.
    cloudflared.readTunnelUrl.mockResolvedValue("https://maybe.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("unknown");

    await tick();
    expect(heartbeat.pushHeartbeatTick).toHaveBeenCalledWith("https://maybe.trycloudflare.com");
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
  });

  it("passes a missing url straight through, as it always did", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue(null);
    liveness.checkTunnelLiveness.mockResolvedValue("unknown");

    const res = await tick();
    expect(res.status).toBe(200);
    expect(heartbeat.pushHeartbeatTick).toHaveBeenCalledWith(null);
  });
});
