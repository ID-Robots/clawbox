import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";
import { NextRequest } from "next/server";

// serveGatewayHTML injects the gateway token ONLY for a caller with an owner
// session — the page is the one place a gateway credential leaves the device,
// and several unauthenticated paths used to reach it. Mocked here so each test
// states which caller it is.
const ownerSession = vi.fn<() => Promise<boolean>>();
vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: () => ownerSession(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

const mockFs = vi.mocked(fsp);

describe("gateway-proxy", () => {
  let gatewayProxy: typeof import("@/lib/gateway-proxy");

  function createRequest(url: string, headers?: Record<string, string>): NextRequest {
    return new NextRequest(new URL(url), {
      headers: new Headers(headers),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    ownerSession.mockResolvedValue(true);
    mockFs.readFile.mockResolvedValue(JSON.stringify({
      gateway: { auth: { token: "test-token" } },
    }));

    vi.stubGlobal("fetch", vi.fn());

    gatewayProxy = await import("@/lib/gateway-proxy");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("redirectToSetup", () => {
    it("redirects to setup with allowed host", () => {
      const request = createRequest("http://clawbox.local/", {
        host: "clawbox.local",
      });

      const response = gatewayProxy.redirectToSetup(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/setup");
      expect(response.headers.get("location")).toContain("clawbox.local");
    });

    it("uses canonical origin for unknown hosts", () => {
      const request = createRequest("http://unknown.example.com/", {
        host: "unknown.example.com",
      });

      const response = gatewayProxy.redirectToSetup(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("clawbox.local");
    });

    it("preserves https when forwarded", () => {
      const request = createRequest("http://clawbox.local/", {
        host: "clawbox.local",
        "x-forwarded-proto": "https",
      });

      const response = gatewayProxy.redirectToSetup(request);

      expect(response.headers.get("location")).toContain("https://");
    });

    it("handles multiple x-forwarded-proto values", () => {
      const request = createRequest("http://clawbox.local/", {
        host: "clawbox.local",
        "x-forwarded-proto": "https, http",
      });

      const response = gatewayProxy.redirectToSetup(request);

      expect(response.headers.get("location")).toContain("https://");
    });

    it("strips port from host header", () => {
      const request = createRequest("http://localhost:3000/", {
        host: "localhost:3000",
      });

      const response = gatewayProxy.redirectToSetup(request);

      expect(response.status).toBe(302);
    });
  });

  describe("getOrGenerateGatewayToken", () => {
    const HEX_64 = /^[0-9a-f]{64}$/;

    it("returns the existing on-disk token when it is a valid random value", async () => {
      const stored = "a".repeat(64);
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: stored } },
      }));

      const token = await gatewayProxy.getOrGenerateGatewayToken();

      expect(token).toBe(stored);
    });

    it("rotates the legacy literal 'clawbox' to a fresh random token", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: "clawbox" } },
      }));

      const token = await gatewayProxy.getOrGenerateGatewayToken();

      expect(token).not.toBe("clawbox");
      expect(token).toMatch(HEX_64);
    });

    it("generates a token when openclaw.json is missing", async () => {
      mockFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const token = await gatewayProxy.getOrGenerateGatewayToken();

      expect(token).toMatch(HEX_64);
    });

    it("generates a token when the on-disk value is shorter than 32 chars", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: "short" } },
      }));

      const token = await gatewayProxy.getOrGenerateGatewayToken();

      expect(token).not.toBe("short");
      expect(token).toMatch(HEX_64);
    });

    it("returns distinct values across successive generation calls", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: "clawbox" } },
      }));

      const a = await gatewayProxy.getOrGenerateGatewayToken();
      const b = await gatewayProxy.getOrGenerateGatewayToken();

      expect(a).not.toBe(b);
    });

    it("preserves a canonical SecretRef without resolving it", async () => {
      const token = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" };
      mockFs.readFile.mockResolvedValue(JSON.stringify({ gateway: { auth: { token } } }));
      await expect(gatewayProxy.getOrGenerateGatewayToken()).resolves.toBeNull();
    });

    it("rotates malformed SecretRef objects", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: { source: "exec", provider: "vault" } } },
      }));
      await expect(gatewayProxy.getOrGenerateGatewayToken()).resolves.toMatch(HEX_64);
    });
  });

  describe("serveGatewayHTML", () => {
    it("does not serialize a SecretRef into the browser", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: { source: "exec", provider: "vault", id: "gateway-token" } } },
      }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html><body>Gateway Content</body></html>"),
      }));

      const response = await gatewayProxy.serveGatewayHTML(
        createRequest("http://clawbox.local/", { host: "clawbox.local" }),
      );
      const html = await response.text();

      expect(html).not.toContain("gateway-token");
      expect(html).not.toContain("[object Object]");
      expect(html).not.toContain('h.set("token"');
    });
    it("fetches and injects ClawBox bar", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html><body>Gateway Content</body></html>"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/", {
        host: "clawbox.local",
      });

      const response = await gatewayProxy.serveGatewayHTML(request);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("clawbox-bar");
      expect(html).toContain("Gateway Content");
    });

    it("injects auth token when available", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: "my-secret-token" } },
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html><body></body></html>"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/");

      const response = await gatewayProxy.serveGatewayHTML(request);
      const html = await response.text();

      expect(html).toContain("my-secret-token");
    });

    it("withholds the token from a caller with no owner session", async () => {
      // The security property, not a style choice. `/fonts/zzz`, `/Login`,
      // `/Manifest.json` and `/SW.JS` all reached this function without a
      // session — `/fonts/` is an unconditional public prefix and middleware
      // matched a lower-cased path while the router used the raw one — and each
      // handed a full gateway credential to the open internet through the
      // tunnel. The shell is still served; it just carries no token.
      ownerSession.mockResolvedValue(false);
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: "my-secret-token" } },
      }));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html><body></body></html>"),
      }));

      const response = await gatewayProxy.serveGatewayHTML(createRequest("http://clawbox.local/fonts/zzz"));
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).not.toContain("my-secret-token");
      // Still the app shell, so first boot and the login redirect keep working.
      expect(html).toContain("clawbox-bar");
    });

    it("redirects to setup when gateway returns error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/", {
        host: "clawbox.local",
      });

      const response = await gatewayProxy.serveGatewayHTML(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/setup");
    });

    it("redirects to setup when fetch throws", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/", {
        host: "clawbox.local",
      });

      const response = await gatewayProxy.serveGatewayHTML(request);

      expect(response.status).toBe(302);
    });

    it("handles missing token gracefully", async () => {
      mockFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html><body></body></html>"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/");

      const response = await gatewayProxy.serveGatewayHTML(request);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("clawbox-bar");
      // Should not have token script when no token
      expect(html).not.toContain("clawbox-token");
    });

    it("escapes token for safe injection", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { auth: { token: "<script>alert('xss')</script>" } },
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html><body></body></html>"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/");

      const response = await gatewayProxy.serveGatewayHTML(request);
      const html = await response.text();

      // Should not contain raw < or >
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("\\u003c");
    });

    it("sets proper content-type header", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html><body></body></html>"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/");

      const response = await gatewayProxy.serveGatewayHTML(request);

      expect(response.headers.get("content-type")).toContain("text/html");
    });
  });
});
