import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

describe("middleware", () => {
  let middleware: typeof import("@/middleware").middleware;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.PORTAL_URL;
    const mod = await import("@/middleware");
    middleware = mod.middleware;
  });

  afterEach(() => {
    delete process.env.PORTAL_URL;
  });

  function createRequest(pathname: string): NextRequest {
    return new NextRequest(new URL(`http://localhost${pathname}`));
  }

  describe("Android captive portal", () => {
    it("redirects /generate_204 to portal", () => {
      const request = createRequest("/generate_204");
      const response = middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });

    it("redirects /gen_204 to portal", () => {
      const request = createRequest("/gen_204");
      const response = middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });
  });

  describe("Windows NCSI", () => {
    it("redirects /connecttest.txt to portal", () => {
      const request = createRequest("/connecttest.txt");
      const response = middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });

    it("redirects /redirect to portal", () => {
      const request = createRequest("/redirect");
      const response = middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });

    it("redirects /ncsi.txt to portal", () => {
      const request = createRequest("/ncsi.txt");
      const response = middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });
  });

  describe("Firefox captive portal", () => {
    it("redirects /canonical.html to portal", () => {
      const request = createRequest("/canonical.html");
      const response = middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });

    it("redirects /success.txt to portal", () => {
      const request = createRequest("/success.txt");
      const response = middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });
  });

  describe("Apple captive portal", () => {
    it("returns HTML response for /hotspot-detect.html", async () => {
      const request = createRequest("/hotspot-detect.html");
      const response = middleware(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");

      const body = await response.text();
      expect(body).toContain("ClawBox Setup");
      expect(body).toContain("<!DOCTYPE html>");
    });

    it("returns HTML response for /library/test/success.html", async () => {
      const request = createRequest("/library/test/success.html");
      const response = middleware(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");
    });
  });

  describe("non-captive portal paths", () => {
    it("passes through other paths", () => {
      const request = createRequest("/setup");
      const response = middleware(request);

      // NextResponse.next() returns a response that continues to the route
      expect(response.status).toBe(200);
    });

    it("passes through API paths", () => {
      const request = createRequest("/setup-api/wifi/scan");
      const response = middleware(request);

      expect(response.status).toBe(200);
    });
  });

  describe("case insensitivity", () => {
    it("handles uppercase paths", () => {
      const request = createRequest("/GENERATE_204");
      const response = middleware(request);

      expect(response.status).toBe(302);
    });

    it("handles mixed case paths", () => {
      const request = createRequest("/Hotspot-Detect.html");
      const response = middleware(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");
    });
  });

  describe("custom PORTAL_URL", () => {
    it("uses custom PORTAL_URL when set", async () => {
      vi.resetModules();
      process.env.PORTAL_URL = "http://192.168.1.1/setup";
      const mod = await import("@/middleware");

      const request = createRequest("/generate_204");
      const response = mod.middleware(request);

      expect(response.headers.get("Location")).toBe("http://192.168.1.1/setup");
    });

    it("falls back to default for invalid PORTAL_URL", async () => {
      vi.resetModules();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.PORTAL_URL = "not-a-valid-url";
      const mod = await import("@/middleware");

      const request = createRequest("/generate_204");
      const response = mod.middleware(request);

      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("config export", () => {
    it("exports matcher config", async () => {
      const mod = await import("@/middleware");

      expect(mod.config).toBeDefined();
      expect(mod.config.matcher).toContain("/generate_204");
      expect(mod.config.matcher).toContain("/hotspot-detect.html");
      expect(mod.config.matcher.length).toBe(9);
    });
  });
});
