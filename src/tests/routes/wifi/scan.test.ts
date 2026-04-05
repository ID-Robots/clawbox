import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/network", () => ({
  triggerBackgroundScan: vi.fn(),
  getScanStatus: vi.fn().mockReturnValue({ scanning: false, networks: null }),
  getCachedScan: vi.fn().mockReturnValue([]),
  scanWifiLive: vi.fn().mockResolvedValue([]),
}));

import { triggerBackgroundScan, getScanStatus, getCachedScan } from "@/lib/network";

const mockTriggerBackgroundScan = vi.mocked(triggerBackgroundScan);
const mockGetScanStatus = vi.mocked(getScanStatus);
const mockGetCachedScan = vi.mocked(getCachedScan);

describe("/setup-api/wifi/scan", () => {
  let wifiScanGet: () => Promise<Response>;
  let wifiScanPost: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetCachedScan.mockReturnValue([]);
    mockGetScanStatus.mockReturnValue({ scanning: false, networks: null });
    const mod = await import("@/app/setup-api/wifi/scan/route");
    wifiScanGet = mod.GET;
    wifiScanPost = mod.POST;
  });

  describe("POST /setup-api/wifi/scan", () => {
    it("triggers a background scan", async () => {
      const req = new NextRequest(new URL("http://localhost/setup-api/wifi/scan"), { method: "POST" });
      const res = await wifiScanPost(req);
      const body = await res.json();

      expect(mockTriggerBackgroundScan).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(body.status).toBe("scanning");
    });
  });

  describe("GET /setup-api/wifi/scan", () => {
    it("returns scanning status", async () => {
      mockGetScanStatus.mockReturnValue({
        scanning: true,
        networks: null,
      });

      const res = await wifiScanGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scanning).toBe(true);
    });

    it("returns completed with networks", async () => {
      mockGetScanStatus.mockReturnValue({
        scanning: false,
        networks: [
          { ssid: "Network1", signal: 80, security: "WPA2" },
          { ssid: "Network2", signal: 60, security: "WPA3" },
        ],
      });

      const res = await wifiScanGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.networks).toHaveLength(2);
      expect(body.networks[0].ssid).toBe("Network1");
    });

    it("returns idle status when no scan in progress", async () => {
      mockGetScanStatus.mockReturnValue({
        scanning: false,
        networks: null,
      });
      mockGetCachedScan.mockReturnValue([]);

      const res = await wifiScanGet();
      const body = await res.json();

      expect(body.scanning).toBe(false);
      expect(body.networks).toBeNull();
    });

    it("returns cached scan when no live data", async () => {
      mockGetScanStatus.mockReturnValue({
        scanning: false,
        networks: null,
      });
      mockGetCachedScan.mockReturnValue([
        { ssid: "CachedNet", signal: 70, security: "WPA2" },
      ]);

      const res = await wifiScanGet();
      const body = await res.json();

      expect(body.scanning).toBe(false);
      expect(body.networks).toHaveLength(1);
      expect(body.cached).toBe(true);
    });
  });
});
