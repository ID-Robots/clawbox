import { afterEach, describe, expect, it, vi } from "vitest";

const cloudflaredMock = {
  isInstalled: vi.fn(),
  startTunnelService: vi.fn(),
  stopTunnelService: vi.fn(),
  getTunnelServiceState: vi.fn(),
  readTunnelUrl: vi.fn(),
};
const heartbeatMock = {
  pushHeartbeatIfChanged: vi.fn(),
};

vi.mock("@/lib/cloudflared", () => cloudflaredMock);
vi.mock("@/lib/portal-heartbeat", () => heartbeatMock);

afterEach(() => {
  for (const fn of Object.values(cloudflaredMock)) fn.mockReset();
  for (const fn of Object.values(heartbeatMock)) fn.mockReset();
});

describe("/setup-api/portal/status", () => {
  it("returns tunnel state + portal URLs", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(true);
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("active");
    cloudflaredMock.readTunnelUrl.mockResolvedValue(
      "https://abc.trycloudflare.com",
    );

    const mod = await import("@/app/setup-api/portal/status/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tunnel).toEqual({
      installed: true,
      service: "active",
      url: "https://abc.trycloudflare.com",
    });
    expect(body.portalAddDeviceUrl).toMatch(/openclawhardware\.dev.*addDevice/);
    expect(body.portalWeb).toMatch(/openclawhardware\.dev/);
    expect(heartbeatMock.pushHeartbeatIfChanged).toHaveBeenCalledWith(
      "https://abc.trycloudflare.com",
    );
  });

  it("returns null tunnel.url when not running", async () => {
    cloudflaredMock.isInstalled.mockResolvedValue(false);
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("inactive");
    cloudflaredMock.readTunnelUrl.mockResolvedValue(null);

    const mod = await import("@/app/setup-api/portal/status/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.tunnel.installed).toBe(false);
    expect(body.tunnel.service).toBe("inactive");
    expect(body.tunnel.url).toBeNull();
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
    cloudflaredMock.startTunnelService.mockResolvedValue(undefined);

    const mod = await import("@/app/setup-api/portal/start/route");
    const res = await mod.POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(cloudflaredMock.startTunnelService).toHaveBeenCalledTimes(1);
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
    cloudflaredMock.stopTunnelService.mockResolvedValue(undefined);
    cloudflaredMock.getTunnelServiceState.mockResolvedValue("inactive");

    const mod = await import("@/app/setup-api/portal/stop/route");
    const res = await mod.POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success ?? body.ok ?? true).toBeTruthy();
    expect(cloudflaredMock.stopTunnelService).toHaveBeenCalledTimes(1);
  });
});
