import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("/setup-api/code-server", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/code-server/route");
    GET = mod.GET;
  });

  it("returns available when healthz responds", async () => {
    mockFetch.mockResolvedValue({ ok: true, body: { cancel: vi.fn() } });
    const res = await GET();
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.port).toBe(8080);
  });

  it("falls back to root path on healthz failure", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ ok: true, status: 200, body: { cancel: vi.fn() } });
    const res = await GET();
    const body = await res.json();
    expect(body.available).toBe(true);
  });

  it("detects 302 redirect as available", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ ok: false, status: 302, body: { cancel: vi.fn() } });
    const res = await GET();
    const body = await res.json();
    expect(body.available).toBe(true);
  });

  it("returns unavailable when both checks fail", async () => {
    mockFetch.mockRejectedValue(new Error("fail"));
    const res = await GET();
    const body = await res.json();
    expect(body.available).toBe(false);
  });
});
