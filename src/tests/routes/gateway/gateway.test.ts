import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/lib/gateway-proxy", () => ({
  getGatewayToken: vi.fn().mockResolvedValue("test-token"),
}));

import { getGatewayToken } from "@/lib/gateway-proxy";

describe("/setup-api/gateway", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(getGatewayToken).mockResolvedValue("test-token");
    const mod = await import("@/app/setup-api/gateway/route");
    GET = mod.GET;
  });

  it("proxies gateway HTML with injected script", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("<html><head></head><body>Gateway</body></html>"),
    });
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("__OPENCLAW_WS_URL__");
    expect(html).toContain("clawbox.local");
  });

  it("returns offline HTML when gateway is down", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Gateway Offline");
  });

  it("returns offline HTML when gateway responds with error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    const html = await res.text();
    expect(html).toContain("Gateway Offline");
  });
});
