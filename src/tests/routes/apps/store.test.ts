import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("/setup-api/apps/store", () => {
  let GET: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/apps/store/route");
    GET = mod.GET;
  });

  it("proxies store API with default limit", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ apps: [{ id: "test" }] }),
    });
    const req = new Request("http://localhost/setup-api/apps/store");
    const res = await GET(req);
    const body = await res.json();
    expect(body.apps).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("limit=50"),
      expect.anything()
    );
  });

  it("passes category and search params", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ apps: [] }),
    });
    const req = new Request("http://localhost/setup-api/apps/store?category=tools&q=test");
    await GET(req);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/category=tools.*q=test|q=test.*category=tools/),
      expect.anything()
    );
  });

  it("returns error on store API failure", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const req = new Request("http://localhost/setup-api/apps/store");
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it("returns 502 on network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const req = new Request("http://localhost/setup-api/apps/store");
    const res = await GET(req);
    expect(res.status).toBe(502);
  });
});
