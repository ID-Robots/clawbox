import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/network", () => ({
  getWifiStatus: vi.fn(),
}));

import { getWifiStatus } from "@/lib/network";

const mockGetWifiStatus = vi.mocked(getWifiStatus);

describe("GET /setup-api/wifi/status", () => {
  let wifiStatusGet: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/wifi/status/route");
    wifiStatusGet = mod.GET;
  });

  it("returns wifi status when connected", async () => {
    mockGetWifiStatus.mockResolvedValue({
      connected: true,
      ssid: "HomeNetwork",
      signal: 80,
      ip: "192.168.1.100",
    } as unknown as Awaited<ReturnType<typeof getWifiStatus>>);

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connected).toBe(true);
    expect(body.ssid).toBe("HomeNetwork");
    expect(body.signal).toBe(80);
    expect(body.ip).toBe("192.168.1.100");
  });

  it("returns disconnected status", async () => {
    mockGetWifiStatus.mockResolvedValue({
      connected: false,
    } as unknown as Awaited<ReturnType<typeof getWifiStatus>>);

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connected).toBe(false);
  });

  it("returns 500 when getWifiStatus returns error", async () => {
    mockGetWifiStatus.mockResolvedValue({
      error: "Network interface not found",
    });

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Network interface not found");
  });

  it("returns 500 when getWifiStatus throws", async () => {
    mockGetWifiStatus.mockRejectedValue(new Error("nmcli failed"));

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("nmcli failed");
  });

  it("returns generic error for non-Error throws", async () => {
    mockGetWifiStatus.mockRejectedValue("unknown error");

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Status check failed");
  });
});
