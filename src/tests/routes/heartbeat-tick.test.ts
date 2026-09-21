/**
 * What the five-minute tick does with a hostname that has stopped existing.
 *
 * Before this, it pushed whatever was in tunnel.url. Cloudflare reaps quick
 * tunnels, cloudflared keeps running, the file keeps a corpse, and the portal
 * showed a green Online next to a dead link on 5 of 30 live devices.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const routeAuth = { requireSession: vi.fn() };
const internalToken = { isInternalRequest: vi.fn() };

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
const persona = { applyDeferredLanguagePersona: vi.fn() };

vi.mock("@/lib/language-persona", () => persona);
vi.mock("@/lib/cloudflared", () => cloudflared);
vi.mock("@/lib/portal-heartbeat", () => heartbeat);
vi.mock("@/lib/tunnel-liveness", () => liveness);
vi.mock("@/lib/route-auth", () => routeAuth);
vi.mock("@/lib/internal-token", () => internalToken);

function request(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/setup-api/portal/heartbeat-tick", { headers });
}

async function tick(req: Request = request()) {
  const mod = await import("@/app/setup-api/portal/heartbeat-tick/route");
  return mod.GET(req);
}

beforeEach(() => {
  vi.resetModules();
  liveness.mayRestart.mockReturnValue(true);
  cloudflared.startTunnelService.mockResolvedValue({ bootPersisted: true, bootPersistWarning: null });
  persona.applyDeferredLanguagePersona.mockResolvedValue(false);
  // Default for the behavioural tests below: the systemd unit, presenting the
  // install's internal token.
  internalToken.isInternalRequest.mockReturnValue(true);
  routeAuth.requireSession.mockResolvedValue(null);
});

afterEach(() => {
  for (const fn of [
    ...Object.values(cloudflared),
    ...Object.values(heartbeat),
    ...Object.values(liveness),
    ...Object.values(routeAuth),
    ...Object.values(internalToken),
    ...Object.values(persona),
  ]) {
    fn.mockReset();
  }
});

/**
 * The tick is pre-auth in middleware because the timer runs on a device nobody
 * has logged into. That had become "anyone may call it" — and the dead-tunnel
 * branch RESTARTS clawbox-tunnel, so any LAN neighbour, or anyone holding the
 * box's public tunnel URL, could bounce a systemd unit four times an hour
 * (TASK-446).
 */
describe("who may call the tick", () => {
  beforeEach(() => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://dead-tunnel-example.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("dead");
  });

  it("refuses an anonymous caller, and restarts nothing", async () => {
    internalToken.isInternalRequest.mockReturnValue(false);
    routeAuth.requireSession.mockResolvedValue(
      NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    );

    const res = await tick();

    expect(res.status).toBe(401);
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
    expect(heartbeat.pushHeartbeatTick).not.toHaveBeenCalled();
  });

  it("accepts our own unit on its internal token, with no session", async () => {
    internalToken.isInternalRequest.mockReturnValue(true);
    routeAuth.requireSession.mockResolvedValue(
      NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    );

    const res = await tick(request({ "x-clawbox-internal-token": "a".repeat(64) }));

    expect(res.status).toBe(200);
    // The token is checked BEFORE the session, so the timer never depends on
    // anyone being logged in.
    expect(routeAuth.requireSession).not.toHaveBeenCalled();
  });

  it("accepts the owner's browser on its session cookie", async () => {
    internalToken.isInternalRequest.mockReturnValue(false);
    routeAuth.requireSession.mockResolvedValue(null);

    const res = await tick();

    expect(res.status).toBe(200);
  });
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

/**
 * The tick is also what pays back a language pick OpenClaw's
 * first-conversation ritual made ClawBox defer.
 *
 * POST /setup-api/preferences refuses to write USER.md/SOUL.md while the
 * introduction is armed or unstarted — creating those files is what suppressed
 * the ritual on every box that shipped — and records the debt instead. Nothing
 * restarts the gateway when the agent finishes the introduction, so the
 * ExecStartPre that re-applies the pick can sit unrun for as long as the box
 * stays up: the desktop in the owner's language, the agent's persona with no
 * language directive at all. This five-minute tick is the only thing on a
 * running box that fires without anyone touching it, so it is where the debt
 * is drained.
 */
describe("the deferred language pick", () => {
  it("is drained on an ordinary tick", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://alive.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("alive");

    await tick();
    expect(persona.applyDeferredLanguagePersona).toHaveBeenCalledTimes(1);
  });

  it("is drained on the dead-tunnel path too, which returns early", async () => {
    // The tunnel and the persona have nothing to do with each other; a box
    // whose tunnel died must still learn the owner's language.
    cloudflared.readTunnelUrl.mockResolvedValue("https://dead.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("dead");

    const res = await tick();
    expect(res.status).toBe(200);
    expect(persona.applyDeferredLanguagePersona).toHaveBeenCalledTimes(1);
  });

  it("is not drained for a caller the tick refuses", async () => {
    // The drain writes the agent's system prompt from stored state. It belongs
    // behind the same door as the unit restart below it.
    internalToken.isInternalRequest.mockReturnValue(false);
    routeAuth.requireSession.mockResolvedValue(
      NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    );

    const res = await tick();
    expect(res.status).toBe(401);
    expect(persona.applyDeferredLanguagePersona).not.toHaveBeenCalled();
  });
});
