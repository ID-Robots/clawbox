import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/network", () => ({
  switchToClient: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  set: vi.fn(),
  setMany: vi.fn(),
}));

import { switchToClient } from "@/lib/network";
import { set, setMany } from "@/lib/config-store";

const mockSwitchToClient = vi.mocked(switchToClient);
const mockSet = vi.mocked(set);
const mockSetMany = vi.mocked(setMany);

describe("POST /setup-api/wifi/connect", () => {
  let wifiConnectPost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSwitchToClient.mockResolvedValue({ message: "connected" });
    mockSet.mockResolvedValue();
    mockSetMany.mockResolvedValue();

    const mod = await import("@/app/setup-api/wifi/connect/route");
    wifiConnectPost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("connects to a WiFi network successfully", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: "MyNetwork", password: "secret123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSwitchToClient).toHaveBeenCalledWith("MyNetwork", "secret123");
    expect(mockSetMany).toHaveBeenCalledWith({ wifi_configured: true, hotspot_enabled: false });
  });

  it("connects without password (open network)", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: "OpenNetwork" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSwitchToClient).toHaveBeenCalledWith("OpenNetwork", undefined);
  });

  it("skips WiFi setup when skip=true", async () => {
    const res = await wifiConnectPost(jsonRequest({ skip: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.message).toContain("Ethernet only");
    expect(mockSet).toHaveBeenCalledWith("wifi_configured", true);
    expect(mockSwitchToClient).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await wifiConnectPost(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for missing SSID", async () => {
    const res = await wifiConnectPost(jsonRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("SSID is required");
  });

  it("returns 400 for empty SSID", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: "  " }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("SSID is required");
  });

  it("returns 400 for non-string SSID", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: 123 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("SSID is required");
  });

  it("returns 400 for non-string password", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: "Network", password: 123 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Password must be a string");
  });

  it("returns 500 when connection fails", async () => {
    mockSwitchToClient.mockRejectedValue(new Error("Connection refused"));

    const res = await wifiConnectPost(jsonRequest({ ssid: "Network", password: "pass" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Connection refused");
    expect(mockSet).toHaveBeenCalledWith("wifi_configured", false);
  });

  it("returns generic error for non-Error throws", async () => {
    mockSwitchToClient.mockRejectedValue("unknown error");

    const res = await wifiConnectPost(jsonRequest({ ssid: "Network", password: "pass" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Connection failed");
  });
});
