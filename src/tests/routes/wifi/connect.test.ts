import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

class FakeWifiAuthError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "WifiAuthError";
  }
}

vi.mock("@/lib/network", () => ({
  switchToClient: vi.fn(),
  setConnectStatus: vi.fn(),
  WifiAuthError: FakeWifiAuthError,
}));

vi.mock("@/lib/config-store", () => ({
  set: vi.fn(),
  setMany: vi.fn(),
  get: vi.fn(async () => "clawbox"),
}));

import { switchToClient, setConnectStatus, WifiAuthError } from "@/lib/network";
import { set, setMany } from "@/lib/config-store";

const mockSwitchToClient = vi.mocked(switchToClient);
const mockSetConnectStatus = vi.mocked(setConnectStatus);
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
    vi.useRealTimers();
  });

  // The single-radio handoff tears down the setup hotspot mid-connect, so the
  // route is fire-and-forget: it records a "connecting" status, returns
  // immediately, and a background task reports the real outcome via
  // setConnectStatus (which the wizard polls through /wifi/connect-status).

  it("returns connecting and records a connecting status", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: "MyNetwork", password: "secret123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("connecting");
    expect(mockSet).toHaveBeenCalledWith("wifi_ssid", "MyNetwork");
    expect(mockSetConnectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "connecting", ssid: "MyNetwork", reason: null }),
    );
  });

  it("returns connecting for an open network (no password)", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: "OpenNetwork" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("connecting");
  });

  it("records connected and marks configured after a successful background switch", async () => {
    vi.useFakeTimers();
    mockSwitchToClient.mockResolvedValue({ message: "ok" });

    await wifiConnectPost(jsonRequest({ ssid: "MyNetwork", password: "secret123" }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(mockSwitchToClient).toHaveBeenCalledWith("MyNetwork", "secret123");
    expect(mockSetMany).toHaveBeenCalledWith({ wifi_configured: true, hotspot_enabled: false });
    expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "connected", ssid: "MyNetwork" }),
    );
  });

  it("records reason=wrong-password when the background switch throws a WifiAuthError", async () => {
    vi.useFakeTimers();
    mockSwitchToClient.mockRejectedValue(new WifiAuthError("bad key"));

    await wifiConnectPost(jsonRequest({ ssid: "Network", password: "wrong" }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(mockSet).toHaveBeenCalledWith("wifi_configured", false);
    expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed", reason: "wrong-password" }),
    );
  });

  it("records reason=other when the background switch fails otherwise", async () => {
    vi.useFakeTimers();
    mockSwitchToClient.mockRejectedValue(new Error("Connection refused"));

    await wifiConnectPost(jsonRequest({ ssid: "Network", password: "pass" }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed", reason: "other", message: "Connection refused" }),
    );
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
});
