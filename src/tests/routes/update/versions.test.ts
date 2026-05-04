import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/updater", () => ({
  getVersionInfo: vi.fn(),
  invalidateVersionCache: vi.fn(),
}));

import { getVersionInfo, invalidateVersionCache } from "@/lib/updater";

const mockGetVersionInfo = vi.mocked(getVersionInfo);
const mockInvalidateVersionCache = vi.mocked(invalidateVersionCache);

const makeRequest = (url = "http://localhost/setup-api/update/versions") =>
  new Request(url) as unknown as Request;

describe("GET /setup-api/update/versions", () => {
  let getVersions: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetVersionInfo.mockResolvedValue({
      clawbox: { current: "v2.2.2", target: "v2.2.3" },
      openclaw: { current: "2026.4.5", target: "2026.4.6" },
    });

    const mod = await import("@/app/setup-api/update/versions/route");
    getVersions = mod.GET;
  });

  it("returns version info", async () => {
    const response = await getVersions(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      clawbox: { current: "v2.2.2", target: "v2.2.3" },
      openclaw: { current: "2026.4.5", target: "2026.4.6" },
    });
    expect(mockInvalidateVersionCache).not.toHaveBeenCalled();
  });

  it("force=1 invalidates the cache before reading versions", async () => {
    const response = await getVersions(makeRequest("http://localhost/setup-api/update/versions?force=1"));

    expect(response.status).toBe(200);
    expect(mockInvalidateVersionCache).toHaveBeenCalledTimes(1);
  });

  it("returns a 500 when reading versions fails", async () => {
    mockGetVersionInfo.mockRejectedValueOnce(new Error("Registry unavailable"));

    const response = await getVersions(makeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Registry unavailable" });
  });

  it("returns the generic 500 message for non-Error failures", async () => {
    mockGetVersionInfo.mockRejectedValueOnce("bad failure");

    const response = await getVersions(makeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to read versions" });
  });
});
