import { afterEach, describe, expect, it, vi } from "vitest";

const cloudflaredMock = {
  isInstalled: vi.fn(),
  startTunnelService: vi.fn(),
  stopTunnelService: vi.fn(),
  getTunnelServiceState: vi.fn(),
  readTunnelUrl: vi.fn(),
  readTunnelUrlHistory: vi.fn(),
};
const heartbeatMock = {
  pushHeartbeatIfChanged: vi.fn(),
};

const namedTunnelMock = {
  readTunnelMode: vi.fn(async () => null as "named" | "quick" | null),
  readNamedTunnelCredential: vi.fn(async () => null as { hostname: string; token: string } | null),
};

vi.mock("@/lib/cloudflared", () => cloudflaredMock);
vi.mock("@/lib/portal-heartbeat", () => heartbeatMock);
vi.mock("@/lib/named-tunnel", () => namedTunnelMock);

afterEach(() => {
  for (const fn of Object.values(cloudflaredMock)) fn.mockReset();
  for (const fn of Object.values(heartbeatMock)) fn.mockReset();
  namedTunnelMock.readTunnelMode.mockReset().mockResolvedValue(null);
  namedTunnelMock.readNamedTunnelCredential.mockReset().mockResolvedValue(null);
});

describe("/setup-api/portal/status", () => {
  it("returns tunnel state + portal URLs", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(true);
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("active");
    cloudflaredMock.readTunnelUrl.mockResolvedValue(
      "https://abc.trycloudflare.com",
    );
    cloudflaredMock.readTunnelUrlHistory.mockResolvedValue([
      { at: "2026-08-22T09:00:00Z", url: "https://abc.trycloudflare.com" },
      { at: "2026-08-21T09:00:00Z", url: "https://old.trycloudflare.com" },
    ]);

    const mod = await import("@/app/setup-api/portal/status/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tunnel).toEqual({
      installed: true,
      service: "active",
      url: "https://abc.trycloudflare.com",
      history: [
        { at: "2026-08-22T09:00:00Z", url: "https://abc.trycloudflare.com" },
        { at: "2026-08-21T09:00:00Z", url: "https://old.trycloudflare.com" },
      ],
      mode: null,
      hostname: null,
    });
    expect(body.portalAddDeviceUrl).toMatch(/clawbox\.com.*addDevice/);
    expect(body.portalWeb).toMatch(/clawbox\.com/);
    expect(heartbeatMock.pushHeartbeatIfChanged).toHaveBeenCalledWith(
      "https://abc.trycloudflare.com",
    );
  });

  it("returns null tunnel.url when not running", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(false);
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("inactive");
    cloudflaredMock.readTunnelUrl.mockResolvedValue(null);
    // A stopped tunnel still has to say which hostnames it HAS published —
    // that is the question a stray, still-serving quick-tunnel URL raises, and
    // `url` alone can never answer it.
    cloudflaredMock.readTunnelUrlHistory.mockResolvedValue([
      { at: "2026-08-21T09:00:00Z", url: "https://retired.trycloudflare.com" },
    ]);

    const mod = await import("@/app/setup-api/portal/status/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.tunnel.installed).toBe(false);
    expect(body.tunnel.service).toBe("inactive");
    expect(body.tunnel.url).toBeNull();
    expect(body.tunnel.history).toEqual([
      { at: "2026-08-21T09:00:00Z", url: "https://retired.trycloudflare.com" },
    ]);
  });

  it("returns 500 when an underlying call throws", async () => {
    cloudflaredMock.isInstalled.mockRejectedValue(new Error("boom"));
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("inactive");
    cloudflaredMock.readTunnelUrl.mockResolvedValue(null);

    const mod = await import("@/app/setup-api/portal/status/route");
    const res = await mod.GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/boom/);
  });
});

describe("/setup-api/portal/status — named tunnel", () => {
  const HOST = "amber-otter-k7m2p9qx4w3n.clawbox.tech";
  const TOKEN = "eyJzZWNyZXQiOiJkby1ub3Qtc2hvdy1tZSJ9eyJzZWNyZXQiOiJ9";

  it("reports mode and the permanent hostname, and never the token", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(true);
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("active");
    cloudflaredMock.readTunnelUrl.mockResolvedValue(`https://${HOST}`);
    cloudflaredMock.readTunnelUrlHistory.mockResolvedValue([]);
    namedTunnelMock.readTunnelMode.mockResolvedValue("named");
    namedTunnelMock.readNamedTunnelCredential.mockResolvedValue({ hostname: HOST, token: TOKEN });

    const mod = await import("@/app/setup-api/portal/status/route");
    const res = await mod.GET();
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text);
    expect(body.tunnel).toMatchObject({ mode: "named", hostname: HOST, url: `https://${HOST}` });
    // The stable URL is still what the heartbeat reports as liveness.
    expect(heartbeatMock.pushHeartbeatIfChanged).toHaveBeenCalledWith(`https://${HOST}`);
  });

  it("reports quick mode without a hostname", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(true);
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("active");
    cloudflaredMock.readTunnelUrl.mockResolvedValue("https://abc.trycloudflare.com");
    cloudflaredMock.readTunnelUrlHistory.mockResolvedValue([]);
    namedTunnelMock.readTunnelMode.mockResolvedValue("quick");
    namedTunnelMock.readNamedTunnelCredential.mockResolvedValue({ hostname: HOST, token: TOKEN });

    const mod = await import("@/app/setup-api/portal/status/route");
    const body = await (await mod.GET()).json();
    expect(body.tunnel).toMatchObject({ mode: "quick", hostname: null });
  });
});

describe("/setup-api/portal/start", () => {
  it("returns 400 when cloudflared is not installed", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(false);

    const mod = await import("@/app/setup-api/portal/start/route");
    const res = await mod.POST();
    expect(res.status).toBe(400);
    expect(cloudflaredMock.startTunnelService).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toMatch(/cloudflared/);
  });

  it("starts the systemd unit and returns success", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(true);
    cloudflaredMock.startTunnelService.mockResolvedValue({
      bootPersisted: true,
      bootPersistWarning: null,
    });

    const mod = await import("@/app/setup-api/portal/start/route");
    const res = await mod.POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, bootPersisted: true });
    expect(cloudflaredMock.startTunnelService).toHaveBeenCalledTimes(1);
  });

  it("says so when the unit started but boot-start was not recorded", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(true);
    cloudflaredMock.startTunnelService.mockResolvedValue({
      bootPersisted: false,
      bootPersistWarning: "Remote access is running, but ... after the next reboot.",
    });

    const mod = await import("@/app/setup-api/portal/start/route");
    const res = await mod.POST();
    // Still 200 — the tunnel IS up, and calling that a failure would be the
    // opposite lie. What changes is that the second fact travels with it.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bootPersisted).toBe(false);
    expect(body.warning).toMatch(/reboot/);
  });

  it("returns 500 when systemctl restart throws", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(true);
    cloudflaredMock.startTunnelService.mockRejectedValue(
      new Error("Unit failed"),
    );

    const mod = await import("@/app/setup-api/portal/start/route");
    const res = await mod.POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Unit failed/);
  });
});

describe("/setup-api/portal/stop", () => {
  it("stops the systemd unit and returns success", async () => {
    cloudflaredMock.stopTunnelService.mockResolvedValue({
      bootPersisted: true,
      bootPersistWarning: null,
    });
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("inactive");

    const mod = await import("@/app/setup-api/portal/stop/route");
    const res = await mod.POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bootPersisted).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(cloudflaredMock.stopTunnelService).toHaveBeenCalledTimes(1);
  });

  it("does not answer a stop that will undo itself with a bare success", async () => {
    // `systemctl stop` worked, `systemctl disable` did not: the tunnel is down
    // now and comes back at the next boot, still publishing this box to the
    // public internet. The old answer to this was byte-identical to the answer
    // for a clean stop.
    cloudflaredMock.stopTunnelService.mockResolvedValue({
      bootPersisted: false,
      bootPersistWarning:
        "Remote access is stopped, but ... after the next reboot.",
    });
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("inactive");

    const mod = await import("@/app/setup-api/portal/stop/route");
    const res = await mod.POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bootPersisted).toBe(false);
    expect(body.warning).toMatch(/reboot/);
  });
});
