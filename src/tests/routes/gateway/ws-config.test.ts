import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-proxy", () => ({
  getGatewayToken: vi.fn().mockResolvedValue("test-token"),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(JSON.stringify({
      agents: { defaults: { model: { primary: "claude-3" } } },
    })),
  },
}));

describe("/setup-api/gateway/ws-config", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { getGatewayToken } = await import("@/lib/gateway-proxy");
    vi.mocked(getGatewayToken).mockResolvedValue("test-token");
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.readFile).mockResolvedValue(JSON.stringify({
      agents: { defaults: { model: { primary: "claude-3" } } },
    }));
    const mod = await import("@/app/setup-api/gateway/ws-config/route");
    GET = mod.GET;
  });

  it("returns ws config with host from request", async () => {
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway/ws-config"));
    const res = await GET(req);
    const body = await res.json();
    expect(body.wsUrl).toBe("ws://clawbox.local:18789");
    expect(body.token).toBe("test-token");
    expect(body.model).toBe("claude-3");
  });

  it("falls back to clawbox.local when no host header", async () => {
    const req = new NextRequest(new URL("http://localhost/setup-api/gateway/ws-config"), {
      headers: {},
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.wsUrl).toContain("clawbox.local");
  });
});
