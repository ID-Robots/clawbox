import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/lib/gateway-proxy", () => ({
  getGatewayToken: vi.fn().mockResolvedValue("test-token"),
}));

vi.mock("@/lib/gateway-health", () => ({
  getGatewayServiceHealth: vi.fn().mockResolvedValue({
    active: false,
    breakerActive: false,
    activeState: "failed",
    subState: "failed",
    result: "exit-code",
    restartCount: 2,
    finalStartupError: "Config validation failed",
  }),
}));

import { getGatewayToken } from "@/lib/gateway-proxy";
import { getGatewayServiceHealth } from "@/lib/gateway-health";

describe("/setup-api/gateway", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(getGatewayToken).mockResolvedValue("test-token");
    vi.mocked(getGatewayServiceHealth).mockResolvedValue({
      active: false,
      breakerActive: false,
      activeState: "failed",
      subState: "failed",
      result: "exit-code",
      restartCount: 2,
      finalStartupError: "Config validation failed",
    });
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
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain("Gateway Offline");
    expect(html).toContain("Config validation failed");
  });

  it("returns offline HTML when gateway responds with error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    const html = await res.text();
    expect(html).toContain("Gateway Offline");
  });

  it("reports an activated breaker with safe actionable recovery", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));
    vi.mocked(getGatewayServiceHealth).mockResolvedValue({
      active: false,
      breakerActive: true,
      activeState: "failed",
      subState: "failed",
      result: "start-limit-hit",
      restartCount: 3,
      finalStartupError: "bad config <script>alert(1)</script>",
    });

    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    const html = await res.text();

    expect(html).toContain("Automatic restart breaker activated");
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain("systemctl reset-failed clawbox-gateway");
    expect(html).toContain("bad config &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
