import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("/setup-api/gateway/health", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/gateway/health/route");
    GET = mod.GET;
  });

  it("returns available when gateway responds ok", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    const res = await GET();
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.port).toBe(18789);
  });

  it("returns unavailable when gateway returns error", async () => {
    mockFetch.mockResolvedValue({ ok: false, text: () => Promise.resolve("") });
    const res = await GET();
    const body = await res.json();
    expect(body.available).toBe(false);
  });

  it("returns unavailable when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));
    const res = await GET();
    const body = await res.json();
    expect(body.available).toBe(false);
  });
});
