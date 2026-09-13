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
      "GENERAL.STATE": "100 (connected)",
      "GENERAL.CONNECTION": "HomeNetwork",
      "IP4.ADDRESS[1]": "192.168.1.100/24",
      "IP4.GATEWAY": "",
    } as unknown as Awaited<ReturnType<typeof getWifiStatus>>);

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connected).toBe(true);
    expect(body.ssid).toBe("HomeNetwork");
    expect(body.ip).toBe("192.168.1.100");
  });

  it("returns disconnected status", async () => {
    mockGetWifiStatus.mockResolvedValue({
      "GENERAL.STATE": "30 (disconnected)",
    } as unknown as Awaited<ReturnType<typeof getWifiStatus>>);

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connected).toBe(false);
  });

  it("returns 500 when getWifiStatus returns error", async () => {
    mockGetWifiStatus.mockResolvedValue({
      error: "Network interface not found",
      errorCode: "unavailable",
    });

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Network interface not found");
    // The classification travels with the failure too, or a caller is back to
    // reading the English to tell a broken nmcli from absent hardware.
    expect(body.reason).toBe("unavailable");
  });

  // Found by the device feature sweep: this route answered 500 "WiFi interface
  // not available" on a machine with no WiFi NIC, which is not a failure of the
  // route but an answer about the hardware. `wifi_status` (mcp/tools/system.ts)
  // does NOT catch this call the way it catches the ethernet one, so the whole
  // tool threw and the agent could not say whether the box was online even with
  // a working cable.
  it("answers absent WiFi hardware as a structured 200, not a 500", async () => {
    mockGetWifiStatus.mockResolvedValue({
      error: "This machine has no WiFi hardware",
      errorCode: "no_wifi_device",
    });

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.reason).toBe("no_wifi_device");
    expect(body.connected).toBe(false);
    // Every field a caller reads is present and null rather than missing.
    expect(body.ssid).toBeNull();
    expect(body.ip).toBeNull();
    expect(body.signalDbm).toBeNull();
    expect(body.pingMs).toBeNull();
    // No `error` key on a 200 — the absence is reported as a fact, not as a
    // failure a caller might re-raise.
    expect(body.error).toBeUndefined();
  });

  // A configured interface that is not on this board is NOT absent hardware —
  // `NETWORK_INTERFACE` defaults to the Jetson's name and can be carried onto a
  // machine whose NIC is called something else. Answering 200 "no WiFi here"
  // would hide a misconfiguration behind a hardware fact nobody can act on.
  it("keeps a misconfigured interface a 500, and names the devices that are there", async () => {
    mockGetWifiStatus.mockResolvedValue({
      error: "No WiFi interface named wlP1p1s0 — this machine has wlan0, wlan1",
      errorCode: "interface_mismatch",
      wifiDevices: "wlan0,wlan1",
    });

    const res = await wifiStatusGet();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.reason).toBe("interface_mismatch");
    expect(body.wifiDevices).toEqual(["wlan0", "wlan1"]);
    // Never the shape that says the box answered about its radio.
    expect(body.available).toBeUndefined();
  });

  it("says the hardware IS there on the ordinary answer", async () => {
    mockGetWifiStatus.mockResolvedValue({
      "GENERAL.STATE": "30 (disconnected)",
    } as unknown as Awaited<ReturnType<typeof getWifiStatus>>);

    const body = await (await wifiStatusGet()).json();
    // Otherwise "this machine has no WiFi" and "a server that predates the
    // distinction" are the same answer.
    expect(body.available).toBe(true);
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
