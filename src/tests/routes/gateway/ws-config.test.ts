import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-proxy", () => ({
  getGatewayToken: vi.fn().mockResolvedValue("test-token"),
}));

const who = vi.hoisted(() => ({ identity: null as { username: string; isOwner: boolean } | null }));
vi.mock("@/lib/route-auth", () => ({ sessionIdentity: vi.fn(async () => who.identity) }));

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

  it("never hands another ClawBox user the gateway's token: their socket goes through the relay", async () => {
    who.identity = { username: "alice", isOwner: false };
    try {
      const body = await (await GET(new NextRequest(new URL("http://clawbox.local/setup-api/gateway/ws-config")))).json();
      expect(body.token).toBe("");
      expect(body.relayed).toBe(true);
      // Their own socket path, which the proxy always relays — the root path
      // is the Control UI's, which the owner may share (non-owner-scope.ts).
      expect(body.wsUrl).toBe("ws://clawbox.local/user-chat-ws");
      const { getGatewayToken } = await import("@/lib/gateway-proxy");
      expect(getGatewayToken).not.toHaveBeenCalled();
    } finally {
      who.identity = null;
    }
  });

  it("gives the owner the token as before", async () => {
    who.identity = { username: "clawbox", isOwner: true };
    try {
      const body = await (await GET(new NextRequest(new URL("http://clawbox.local/setup-api/gateway/ws-config")))).json();
      expect(body.token).toBe("test-token");
      expect(body.relayed).toBeUndefined();
      expect(body.wsUrl).toBe("ws://clawbox.local");
    } finally {
      who.identity = null;
    }
  });

  it("returns same-origin ws URL so the upgrade proxy can forward it", async () => {
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway/ws-config"));
    const res = await GET(req);
    const body = await res.json();
    // No port: browsers connect to the same origin on :80/:443, and the
    // production server's WebSocket upgrade proxy routes it to the gateway.
    expect(body.wsUrl).toBe("ws://clawbox.local");
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

  it("upgrades the scheme to wss when the proxy signals https", async () => {
    const req = new NextRequest(
      new URL("http://clawbox.local/setup-api/gateway/ws-config"),
      { headers: { "x-forwarded-proto": "https" } },
    );
    const res = await GET(req);
    const body = await res.json();
    expect(body.wsUrl).toBe("wss://clawbox.local");
  });

  it("picks wss when Cloudflare cf-visitor header reports https", async () => {
    const req = new NextRequest(
      new URL("http://clawbox.local/setup-api/gateway/ws-config"),
      { headers: { "cf-visitor": '{"scheme":"https"}' } },
    );
    const res = await GET(req);
    const body = await res.json();
    expect(body.wsUrl).toBe("wss://clawbox.local");
  });
});
