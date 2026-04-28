import { afterEach, describe, expect, it, vi } from "vitest";

const tunnelMock = {
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
  getTunnelStatus: vi.fn(),
  isCloudflaredInstalled: vi.fn(),
};

vi.mock("@/lib/tunnel", () => tunnelMock);

afterEach(() => {
  for (const fn of Object.values(tunnelMock)) fn.mockReset();
});

describe("/setup-api/tunnel/status", () => {
  it("returns status payload + cloudflaredInstalled flag", async () => {
    tunnelMock.getTunnelStatus.mockResolvedValue({
      enabled: true,
      running: true,
      tunnelUrl: "https://abc.trycloudflare.com",
      error: null,
    });
    tunnelMock.isCloudflaredInstalled.mockResolvedValue(true);

    const mod = await import("@/app/setup-api/tunnel/status/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      running: true,
      tunnelUrl: "https://abc.trycloudflare.com",
      error: null,
      cloudflaredInstalled: true,
    });
  });

  it("reports not-running with cloudflaredInstalled=false", async () => {
    tunnelMock.getTunnelStatus.mockResolvedValue({
      enabled: false,
      running: false,
      tunnelUrl: null,
      error: null,
    });
    tunnelMock.isCloudflaredInstalled.mockResolvedValue(false);

    const mod = await import("@/app/setup-api/tunnel/status/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.running).toBe(false);
    expect(body.cloudflaredInstalled).toBe(false);
  });
});

describe("/setup-api/tunnel/enable", () => {
  it("returns 400 when cloudflared is not installed", async () => {
    tunnelMock.isCloudflaredInstalled.mockResolvedValue(false);

    const mod = await import("@/app/setup-api/tunnel/enable/route");
    const res = await mod.POST();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/cloudflared/);
    // Should never have tried to start
    expect(tunnelMock.startTunnel).not.toHaveBeenCalled();
  });

  it("starts tunnel and returns URL on success", async () => {
    tunnelMock.isCloudflaredInstalled.mockResolvedValue(true);
    tunnelMock.startTunnel.mockResolvedValue({
      success: true,
      tunnelUrl: "https://fresh.trycloudflare.com",
    });

    const mod = await import("@/app/setup-api/tunnel/enable/route");
    const res = await mod.POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      tunnelUrl: "https://fresh.trycloudflare.com",
    });
  });

  it("returns 500 with error message when startTunnel fails", async () => {
    tunnelMock.isCloudflaredInstalled.mockResolvedValue(true);
    tunnelMock.startTunnel.mockResolvedValue({
      success: false,
      error: "Timeout waiting for tunnel URL",
    });

    const mod = await import("@/app/setup-api/tunnel/enable/route");
    const res = await mod.POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: "Timeout waiting for tunnel URL",
    });
  });
});

describe("/setup-api/tunnel/disable", () => {
  it("returns success when stopTunnel succeeds", async () => {
    tunnelMock.stopTunnel.mockResolvedValue({ success: true });

    const mod = await import("@/app/setup-api/tunnel/disable/route");
    const res = await mod.POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
  });

  it("returns 500 when stopTunnel reports an error", async () => {
    tunnelMock.stopTunnel.mockResolvedValue({
      success: false,
      error: "boom",
    });

    const mod = await import("@/app/setup-api/tunnel/disable/route");
    const res = await mod.POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("boom");
  });
});
