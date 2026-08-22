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

  function writeConfig(fields: Record<string, unknown>) {
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(fields));
  }

  async function createSignedSessionCookie(exp: number, gen?: number): Promise<string> {
    const body: Record<string, number> = { exp };
    if (gen !== undefined) body.gen = gen;
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
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

    it("returns a parseable JSON 401 for /setup-api/* with no Accept header (#304)", async () => {
      // The bug: a raw fetch("/setup-api/...") sends Accept: */*, hit the login
      // *redirect*, and the caller's `.json()` threw on the login page's HTML.
      // Guard that an expired session now yields a JSON 401 the caller can parse.
      process.env.SESSION_SECRET = "test-secret";
      markSetupComplete();
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest("/setup-api/system/info"));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
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

      // createRequest() sends no Accept header — exactly like a raw fetch()
      // (Accept: */*). Every /setup-api/* consumer parses JSON, so an expired
      // session must return a JSON 401, not an HTML login redirect that makes
      // the caller's .json() throw (#304).
      const req = createRequest(p);
      const response = await mod.middleware(req);
      expect(response.status).toBe(401);
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
      // Re-locked API surface returns a JSON 401 (not a login redirect) so
      // fetch() callers can detect the expired session — see #304.
      expect(locked.status).toBe(401);
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
      // Auth still enforced -> /setup-api/* yields a JSON 401 (not a bypass).
      expect(response.status).toBe(401);
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

  describe("session generation revocation", () => {
    const future = () => Math.floor(Date.now() / 1000) + 60;

    it("accepts a matching-generation cookie", async () => {
      process.env.SESSION_SECRET = "test-secret";
      writeConfig({ setup_complete: true, session_generation: 3 });
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/dashboard"), {
        headers: { cookie: `clawbox_session=${await createSignedSessionCookie(future(), 3)}` },
      });
      expect((await mod.middleware(req)).status).toBe(200);
    });

    it("rejects a cookie from before the last password change", async () => {
      process.env.SESSION_SECRET = "test-secret";
      // Generation bumped to 4; a cookie stamped gen 3 is now revoked.
      writeConfig({ setup_complete: true, session_generation: 4 });
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/dashboard"), {
        headers: { cookie: `clawbox_session=${await createSignedSessionCookie(future(), 3)}` },
      });
      expect((await mod.middleware(req)).status).toBe(307);
    });

    it("treats a legacy cookie with no generation as generation 0", async () => {
      process.env.SESSION_SECRET = "test-secret";
      writeConfig({ setup_complete: true }); // session_generation defaults to 0
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/dashboard"), {
        headers: { cookie: `clawbox_session=${await createSignedSessionCookie(future())}` },
      });
      expect((await mod.middleware(req)).status).toBe(200);
    });
  });

  describe("pre-auth sensitive-surface gate (setup window)", () => {
    // SESSION_SECRET is provisioned but setup_complete is NOT yet written — the
    // pre-setup wizard window. Sensitive desktop/agent backends must stay gated
    // here (they play no part in onboarding), even though the wizard's own
    // routes pass. Regression guard for the pre-auth reachability multiplier.
    it.each([
      "/setup-api/files/clawbox/data/.session-secret",
      "/setup-api/files",
      "/setup-api/browser/navigate",
      "/setup-api/code/project/init",
      "/setup-api/code-server/start",
      "/setup-api/webapps",
      "/setup-api/vnc/status",
      "/setup-api/terminal",
      "/setup-api/clawkeep/restore",
      // Writes a bot credential; configured from Settings, never the wizard.
      "/setup-api/discord/configure",
      "/setup-api/discord/status",
      "/setup-api/tunnel/enable",
      "/setup-api/portal/start", // same privileged tunnel control as /tunnel
      "/setup-api/portal/stop",
      "/setup-api/apps/settings",
      "/setup-api/apps/install",
      "/setup-api/apps/uninstall",
      "/setup-api/gateway/ws-config",
      // Reads generated images straight off the harness media tree.
      "/setup-api/chat/media",
      // POST turns real systemd units on and off through sudo, and has no part
      // in onboarding — during the setup window the device is broadcasting an
      // OPEN AP, so anyone in radio range would otherwise reach it.
      "/setup-api/local-models",
      // POST rewrites messages.tts.provider and spawns the openclaw CLI. Same
      // radio-range reasoning as local-models: onboarding never calls it.
      "/setup-api/tts",
      "/setup-api/gateway",
      "/setup-api/gateway/", // trailing slash must not dodge the exact match
      // Each call cold-loads a ~3.8 GB model on a Jetson for up to three
      // minutes, and its only caller is a desktop Settings button — so during
      // the open-AP setup window it was a free way for anyone in radio range
      // to pin the box's memory and CPU.
      "/setup-api/mascot-lines/regenerate",
    ])("gates sensitive %s during the setup window", async (p) => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest(p));
      // Falls through to the session gate → JSON 401 (no valid cookie).
      expect(response.status).toBe(401);
    });

    it("still allows /setup-api/gateway/health during the setup window", async () => {
      // The wizard polls gateway readiness before setup_complete is written, so
      // health must stay open even though the sibling ws-config / SPA proxy are
      // gated.
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest("/setup-api/gateway/health"));
      expect(response.status).toBe(200);
    });

    it("still allows the mascot GET during the setup window", async () => {
      // Only the /regenerate leaf is gated, not the subtree: the crab reads
      // its phrases from the bare path and it renders on the wizard, so
      // gating the subtree would leave the mascot mute during setup.
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest("/setup-api/mascot-lines"));
      expect(response.status).toBe(200);
    });

    it("still allows /setup-api/portal/heartbeat-tick during the setup window", async () => {
      // The heartbeat timer hits this on a freshly-booted device before login;
      // gating the /setup-api/portal prefix must not catch this whitelisted
      // sibling (it does no privileged work).
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest("/setup-api/portal/heartbeat-tick"));
      expect(response.status).toBe(200);
    });

    it("allows a sensitive route once a valid session is presented", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/setup-api/files"), {
        headers: {
          cookie: `clawbox_session=${await createSignedSessionCookie(Math.floor(Date.now() / 1000) + 60)}`,
        },
      });
      const response = await mod.middleware(req);
      expect(response.status).toBe(200);
    });
  });

  describe("Hermes surfaces during the setup window", () => {
    // The device broadcasts an OPEN AP while the wizard runs, so anything left
    // pre-auth is reachable by anyone in radio range.
    it.each([
      "/setup-api/hermes/chat",        // agent turn with shell/tool access
      "/setup-api/hermes/skills",
      "/setup-api/hermes/skills/install",
      "/setup-api/hermes/skills/uninstall",
      "/setup-api/harness/select",     // rewrites which agent the device runs
      "/setup-api/harness/status",     // desktop picker only, never the wizard
    ])("gates %s during the setup window", async (p) => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      expect((await mod.middleware(createRequest(p))).status).toBe(401);
    });

    it.each([
      "/setup-api/harness/active",
      "/setup-api/hermes/models",
      "/setup-api/hermes/clawai",
      "/setup-api/hermes/oauth",
      "/setup-api/hermes/provider-key",
    ])("still allows the wizard's %s during the setup window", async (p) => {
      // AIModelsStep → HermesProviderConfig calls all five before setup
      // completes; gating them would make the Hermes SKU unprovisionable.
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      expect((await mod.middleware(createRequest(p))).status).toBe(200);
    });
  });

  describe("gateway paths are edition-aware", () => {
    function writeEditionFile(edition: string): string {
      const file = path.join(tmpRoot, "edition.env");
      fs.writeFileSync(file, `CLAWBOX_EDITION=${edition}\n`);
      return file;
    }

    afterEach(() => {
      delete process.env.CLAWBOX_EDITION_FILE;
      delete process.env.CLAWBOX_EDITION;
    });

    it.each(["/api/state", "/assets/app.js", "/favicon.svg", "/favicon-32.png"])(
      "404s the gateway-only path %s on the hermes edition",
      async (p) => {
        process.env.CLAWBOX_EDITION_FILE = writeEditionFile("hermes");
        vi.resetModules();
        const mod = await import("@/middleware");

        // The OpenClaw gateway is disabled+masked on this SKU, so the
        // next.config rewrite would 502 instead of serving ClawBox's own 404.
        expect((await mod.middleware(createRequest(p))).status).toBe(404);
      },
    );

    it.each(["/api/state", "/assets/app.js", "/favicon.svg"])(
      "leaves %s alone on the openclaw edition",
      async (p) => {
        process.env.CLAWBOX_EDITION_FILE = writeEditionFile("openclaw");
        vi.resetModules();
        const mod = await import("@/middleware");

        expect((await mod.middleware(createRequest(p))).status).toBe(200);
      },
    );

    it("does not 404 ClawBox's own paths on hermes", async () => {
      process.env.CLAWBOX_EDITION_FILE = writeEditionFile("hermes");
      vi.resetModules();
      const mod = await import("@/middleware");

      for (const p of ["/", "/login", "/setup-api/setup/status", "/apiary", "/assetstore"]) {
        expect((await mod.middleware(createRequest(p))).status).not.toBe(404);
      }
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
