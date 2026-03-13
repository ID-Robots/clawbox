import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/network", () => ({
  triggerBackgroundScan: vi.fn(),
  getScanStatus: vi.fn(),
}));

import { triggerBackgroundScan, getScanStatus } from "@/lib/network";

const mockTriggerBackgroundScan = vi.mocked(triggerBackgroundScan);
const mockGetScanStatus = vi.mocked(getScanStatus);

describe("/setup-api/wifi/scan", () => {
  let wifiScanGet: () => Promise<Response>;
  let wifiScanPost: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/wifi/scan/route");
    wifiScanGet = mod.GET;
    wifiScanPost = mod.POST;
  });

  describe("POST /setup-api/wifi/scan", () => {
    it("triggers a background scan", async () => {
      const res = await wifiScanPost();
      const body = await res.json();

      expect(mockTriggerBackgroundScan).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(body.status).toBe("scanning");
    });
  });

  describe("GET /setup-api/wifi/scan", () => {
    it("returns scanning status", async () => {
      mockGetScanStatus.mockReturnValue({
        status: "scanning",
        networks: null,
      });

      const res = await wifiScanGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("scanning");
    });

    it("returns completed with networks", async () => {
      mockGetScanStatus.mockReturnValue({
        status: "complete",
        networks: [
          { ssid: "Network1", signal: 80, security: "WPA2" },
          { ssid: "Network2", signal: 60, security: "WPA3" },
        ],
      });

      const res = await wifiScanGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("complete");
      expect(body.networks).toHaveLength(2);
      expect(body.networks[0].ssid).toBe("Network1");
    });

    it("returns idle status when no scan in progress", async () => {
      mockGetScanStatus.mockReturnValue({
        status: "idle",
        networks: null,
      });

      const res = await wifiScanGet();
      const body = await res.json();

      expect(body.status).toBe("idle");
    });

    it("returns error status on scan failure", async () => {
      mockGetScanStatus.mockReturnValue({
        status: "error",
        error: "Scan failed",
        networks: null,
      });

      const res = await wifiScanGet();
      const body = await res.json();

      expect(body.status).toBe("error");
      expect(body.error).toBe("Scan failed");
    });
  });
});
