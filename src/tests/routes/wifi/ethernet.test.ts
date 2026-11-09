import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/network", () => ({
  getEthernetStatus: vi.fn(),
}));
vi.mock("@/lib/internet-reachable", () => ({
  internetReachable: vi.fn(),
}));

import { getEthernetStatus } from "@/lib/network";
import { internetReachable } from "@/lib/internet-reachable";
const mockGetEthernetStatus = vi.mocked(getEthernetStatus);
const mockInternetReachable = vi.mocked(internetReachable);

describe("/setup-api/wifi/ethernet", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/wifi/ethernet/route");
    GET = mod.GET;
  });

  it("returns ethernet status", async () => {
    mockGetEthernetStatus.mockResolvedValue({ connected: true, cable: true, iface: "eth0" });
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ connected: true, cable: true, iface: "eth0", online: true });
    // A connected cable is the answer already; no probe is spent on it.
    expect(mockInternetReachable).not.toHaveBeenCalled();
  });

  it("says the computer is online over another uplink when no cable is connected", async () => {
    // A PC on its own Wi-Fi (install-x64.sh): the network step must be passable.
    mockGetEthernetStatus.mockResolvedValue({ connected: false, cable: false, iface: "enP7s7" });
    mockInternetReachable.mockResolvedValue(true);
    const body = await (await GET()).json();
    expect(body).toEqual({ connected: false, cable: false, iface: "enP7s7", online: true });
  });

  it("says offline when there is no cable and no route out, as on a box broadcasting its setup hotspot", async () => {
    mockGetEthernetStatus.mockResolvedValue({ connected: false, cable: false, iface: "eth0" });
    mockInternetReachable.mockResolvedValue(false);
    const body = await (await GET()).json();
    expect(body.online).toBe(false);
  });

  it("returns disconnected on error", async () => {
    mockGetEthernetStatus.mockRejectedValue(new Error("fail"));
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ connected: false, cable: false, iface: null, online: false });
  });
});
