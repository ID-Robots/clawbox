import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

describe("middleware", () => {
  let middleware: typeof import("@/middleware").middleware;
  let tmpRoot: string;

  /**
   * Mark the wizard as finished by writing data/config.json under the
   * temp CLAWBOX_ROOT — the auth gate skips /setup-api/* until this flag
   * flips, so most authenticated tests need to call this first.
   */
  function markSetupComplete() {
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ setup_complete: true }),
    );
  }

  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mw-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    delete process.env.PORTAL_URL;
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    const mod = await import("@/middleware");
    middleware = mod.middleware;
  });

  afterEach(() => {
    delete process.env.PORTAL_URL;
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    delete process.env.CLAWBOX_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function createRequest(pathname: string): NextRequest {
    return new NextRequest(new URL(`http://localhost${pathname}`));
  }

  async function createSignedSessionCookie(exp: number): Promise<string> {
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
    const signatureHex = Array.from(signature)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
    return `${payload}.${signatureHex}`;
  }

  describe("Android captive portal", () => {
    it("redirects /generate_204 to portal", async () => {
      const request = createRequest("/generate_204");
      const response = await middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });

    it("redirects /gen_204 to portal", async () => {
      const request = createRequest("/gen_204");
      const response = await middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });
  });

  describe("Windows NCSI", () => {
    it("redirects /connecttest.txt to portal", async () => {
      const request = createRequest("/connecttest.txt");
      const response = await middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });

    it("redirects /redirect to portal", async () => {
      const request = createRequest("/redirect");
      const response = await middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });

    it("redirects /ncsi.txt to portal", async () => {
      const request = createRequest("/ncsi.txt");
      const response = await middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });
  });

  describe("Firefox captive portal", () => {
    it("redirects /canonical.html to portal", async () => {
      const request = createRequest("/canonical.html");
      const response = await middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });

    it("redirects /success.txt to portal", async () => {
      const request = createRequest("/success.txt");
      const response = await middleware(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
    });
  });

  describe("Apple captive portal", () => {
    it("returns HTML response for /hotspot-detect.html", async () => {
      const request = createRequest("/hotspot-detect.html");
      const response = await middleware(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");

      const body = await response.text();
      expect(body).toContain("ClawBox Setup");
      expect(body).toContain("<!DOCTYPE html>");
    });

    it("returns HTML response for /library/test/success.html", async () => {
      const request = createRequest("/library/test/success.html");
      const response = await middleware(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");
    });
  });

  describe("non-captive portal paths", () => {
    it("passes through other paths", async () => {
      const request = createRequest("/setup");
      const response = await middleware(request);

      // NextResponse.next() returns a response that continues to the route
      expect(response.status).toBe(200);
    });

    it("passes through API paths when auth is not yet active", async () => {
      // No SESSION_SECRET = pre-setup state. /setup-api/* must work for the
      // wizard to bootstrap.
      const request = createRequest("/setup-api/wifi/scan");
      const response = await middleware(request);

      expect(response.status).toBe(200);
    });
  });

  describe("case insensitivity", () => {
    it("handles uppercase paths", async () => {
      const request = createRequest("/GENERATE_204");
      const response = await middleware(request);

      expect(response.status).toBe(302);
    });

    it("handles mixed case paths", async () => {
      const request = createRequest("/Hotspot-Detect.html");
      const response = await middleware(request);

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
      const response = await mod.middleware(request);

      expect(response.headers.get("Location")).toBe("http://192.168.1.1/setup");
    });

    it("falls back to default for invalid PORTAL_URL", async () => {
      vi.resetModules();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.PORTAL_URL = "not-a-valid-url";
      const mod = await import("@/middleware");

      const request = createRequest("/generate_204");
      const response = await mod.middleware(request);

      expect(response.headers.get("Location")).toBe("http://10.42.0.1/");
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("authentication", () => {
    it("allows public paths without auth", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest("/login");
      const response = await mod.middleware(req);
      expect(response.status).toBe(200);
    });

    it("allows requests when no session secret configured", async () => {
      delete process.env.SESSION_SECRET;
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest("/some-page");
      const response = await mod.middleware(req);
      expect(response.status).toBe(200);
    });

    it("redirects unauthenticated page requests to login", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest("/dashboard");
      const response = await mod.middleware(req);
      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("/login");
    });

    it("returns 401 for unauthenticated API requests", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/api/data"), {
        headers: { accept: "application/json" },
      });
      const response = await mod.middleware(req);
      expect(response.status).toBe(401);
    });

    it.each(["/login", "/setup", "/setup-api/setup/status", "/_next/chunk.js", "/fonts/test.woff", "/images/logo.png", "/manifest.json", "/favicon.ico", "/portal/subscribe"])("allows public path %s", async (p) => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest(p);
      const response = await mod.middleware(req);
      expect(response.status).toBe(200);
    });

    it.each(["/setup-api/wifi/scan", "/setup-api/system/power", "/setup-api/setup/reset", "/setup-api/clawkeep/backup"])("shields %s once setup is complete and auth is active", async (p) => {
      process.env.SESSION_SECRET = "test-secret";
      markSetupComplete();
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest(p);
      const response = await mod.middleware(req);
      // No session cookie -> page-style requests redirect to /login (307).
      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("/login");
    });

    it.each(["/setup-api/wifi/scan", "/setup-api/update/status", "/setup-api/update/run", "/setup-api/system/credentials", "/setup-api/ai-models/configure", "/setup-api/telegram/configure"])("allows %s during setup wizard bootstrap", async (p) => {
      // production-server.js auto-creates SESSION_SECRET so the env-var
      // short-circuit never fires; the wizard must still reach its API
      // surface before setup_complete is written. Regression for the
      // "Failed to check update status" wizard breakage.
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest(p);
      const response = await mod.middleware(req);
      expect(response.status).toBe(200);
    });

    it("re-locks /setup-api/* after config.json flips setup_complete", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const open = await mod.middleware(createRequest("/setup-api/wifi/scan"));
      expect(open.status).toBe(200);

      markSetupComplete();
      const locked = await mod.middleware(createRequest("/setup-api/wifi/scan"));
      expect(locked.status).toBe(307);
      expect(locked.headers.get("Location")).toContain("/login");
    });

    it("skips auth on /setup-api/* when CLAWBOX_TEST_MODE=1 (e2e-install harness)", async () => {
      process.env.SESSION_SECRET = "test-secret";
      process.env.CLAWBOX_TEST_MODE = "1";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest("/setup-api/wifi/scan");
      const response = await mod.middleware(req);
      // Pass-through, not a 307 redirect — the trusted test environment
      // exercises every /setup-api endpoint directly via fetch().
      expect(response.status).toBe(200);
    });

    it("does NOT bypass auth when CLAWBOX_TEST_MODE is a non-'1' truthy value", async () => {
      // Strict equality on "1" — `true`, "true", "yes" et al. must not
      // open the API surface in production environments where the env
      // var was set casually by something else.
      process.env.SESSION_SECRET = "test-secret";
      process.env.CLAWBOX_TEST_MODE = "true";
      markSetupComplete();
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest("/setup-api/wifi/scan");
      const response = await mod.middleware(req);
      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("/login");
    });

    it("still redirects page requests to /login under CLAWBOX_TEST_MODE", async () => {
      // The login-round-trip e2e spec depends on this — clearing cookies
      // and visiting `/` must still bounce to /login even in test mode.
      process.env.SESSION_SECRET = "test-secret";
      process.env.CLAWBOX_TEST_MODE = "1";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest("/");
      const response = await mod.middleware(req);
      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("/login");
    });

    it("rejects invalid session cookie", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/dashboard"), {
        headers: { cookie: "clawbox_session=invalid.cookie" },
      });
      const response = await mod.middleware(req);
      expect(response.status).toBe(307);
    });

    it("allows requests with a valid signed session cookie", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/dashboard"), {
        headers: {
          cookie: `clawbox_session=${await createSignedSessionCookie(Math.floor(Date.now() / 1000) + 60)}`,
        },
      });
      const response = await mod.middleware(req);

      expect(response.status).toBe(200);
    });

    it("rejects expired signed session cookies", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/dashboard"), {
        headers: {
          cookie: `clawbox_session=${await createSignedSessionCookie(Math.floor(Date.now() / 1000) - 60)}`,
        },
      });
      const response = await mod.middleware(req);

      expect(response.status).toBe(307);
    });
  });

  describe("config export", () => {
    it("exports matcher config", async () => {
      const mod = await import("@/middleware");

      expect(mod.config).toBeDefined();
      expect(mod.config.matcher).toBeDefined();
      expect(mod.config.matcher.length).toBeGreaterThan(0);
    });
  });
});
