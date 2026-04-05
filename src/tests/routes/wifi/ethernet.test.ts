import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/network", () => ({
  getEthernetStatus: vi.fn(),
}));

import { getEthernetStatus } from "@/lib/network";
const mockGetEthernetStatus = vi.mocked(getEthernetStatus);

describe("/setup-api/wifi/ethernet", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/wifi/ethernet/route");
    GET = mod.GET;
  });

  it("returns ethernet status", async () => {
    mockGetEthernetStatus.mockResolvedValue({ connected: true, iface: "eth0" });
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ connected: true, iface: "eth0" });
  });

  it("returns disconnected on error", async () => {
    mockGetEthernetStatus.mockRejectedValue(new Error("fail"));
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ connected: false, iface: null });
  });
});
