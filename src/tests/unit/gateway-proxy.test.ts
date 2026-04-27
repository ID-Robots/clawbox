import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";
import { NextRequest } from "next/server";

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

  describe("serveGatewayHTML", () => {
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

    it("returns 503 'starting' page when gateway returns error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/", {
        host: "clawbox.local",
      });

      const response = await gatewayProxy.serveGatewayHTML(request);
      const html = await response.text();

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(html).toContain("OpenClaw is starting");
    });

    it("returns 503 'starting' page when fetch throws", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      vi.stubGlobal("fetch", mockFetch);

      const request = createRequest("http://clawbox.local/", {
        host: "clawbox.local",
      });

      const response = await gatewayProxy.serveGatewayHTML(request);

      expect(response.status).toBe(503);
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
