import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/network", () => ({
  switchToClient: vi.fn(),
  setConnectStatus: vi.fn(),
  // Real subclass so the route's `err instanceof WifiAuthError` check works.
  WifiAuthError: class WifiAuthError extends Error {
    constructor(message = "Incorrect WiFi password") {
      super(message);
      this.name = "WifiAuthError";
    }
  },
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
  });

  // The route is fire-and-forget: it returns { status: "connecting" }
  // immediately (the single-radio handoff means a synchronous result can never
  // reach the wizard) and runs switchToClient in the background after a short
  // grace delay, recording the outcome via setConnectStatus. These tests drive
  // the deferred timer to assert the background side effects.
  it("returns connecting and runs the switch in the background", async () => {
    vi.useFakeTimers();
    try {
      const res = await wifiConnectPost(jsonRequest({ ssid: "MyNetwork", password: "secret123" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("connecting");
      expect(mockSetConnectStatus).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "connecting", ssid: "MyNetwork" })
      );

      // Background switch is gated behind a grace delay — advance past it.
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockSwitchToClient).toHaveBeenCalledWith("MyNetwork", "secret123");
      expect(mockSetMany).toHaveBeenCalledWith({ wifi_configured: true, hotspot_enabled: false });
      expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "connected", ssid: "MyNetwork" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects without password (open network)", async () => {
    vi.useFakeTimers();
    try {
      const res = await wifiConnectPost(jsonRequest({ ssid: "OpenNetwork" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("connecting");

      await vi.advanceTimersByTimeAsync(2000);
      expect(mockSwitchToClient).toHaveBeenCalledWith("OpenNetwork", undefined);
    } finally {
      vi.useRealTimers();
    }
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

  it("records a failed status (reason: other) when the switch throws", async () => {
    vi.useFakeTimers();
    try {
      mockSwitchToClient.mockRejectedValue(new Error("Connection refused"));

      const res = await wifiConnectPost(jsonRequest({ ssid: "Network", password: "pass" }));
      const body = await res.json();

      // Still a 200 "connecting" — the failure is reported via connect-status.
      expect(res.status).toBe(200);
      expect(body.status).toBe("connecting");

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockSet).toHaveBeenCalledWith("wifi_configured", false);
      expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "failed", reason: "other", message: "Connection refused" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags a wrong-password failure when the switch throws WifiAuthError", async () => {
    vi.useFakeTimers();
    try {
      mockSwitchToClient.mockRejectedValue(new WifiAuthError('Incorrect password for "Network"'));

      const res = await wifiConnectPost(jsonRequest({ ssid: "Network", password: "pass" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("connecting");

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "failed", reason: "wrong-password" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a generic failure for non-Error throws", async () => {
    vi.useFakeTimers();
    try {
      mockSwitchToClient.mockRejectedValue("unknown error");

      const res = await wifiConnectPost(jsonRequest({ ssid: "Network", password: "pass" }));
      await res.json();

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "failed", reason: "other", message: "Connection failed" })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
