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

  describe("trailing-slash redirect (step 0)", () => {
    /**
     * The redirect has to land on the SLASHLESS path. It did not: `NextURL`
     * captures `trailingSlash` when it parses the URL, its `pathname` setter
     * leaves that flag alone, and `href`/`toString()` — which is what
     * `NextResponse.redirect` serialises — re-adds the slash from it. So every
     * page path typed with a trailing slash 308'd to itself, forever.
     */
    it.each(["/setup/", "/login/", "/portal/", "/updating/", "/app/", "/apps/", "/chat/"])(
      "sends %s to the same path without the slash, not back to itself",
      async (pathname) => {
        const response = await middleware(createRequest(pathname));

        expect(response.status).toBe(308);
        const target = new URL(response.headers.get("location")!, "http://localhost");
        expect(target.pathname).toBe(pathname.replace(/\/+$/, ""));
      },
    );

    it("collapses repeated trailing slashes in one hop", async () => {
      const response = await middleware(createRequest("/setup///"));

      expect(response.status).toBe(308);
      expect(new URL(response.headers.get("location")!, "http://localhost").pathname).toBe("/setup");
    });

    it("is not cacheable, so a browser cannot replay a stale one", async () => {
      // A 308 is cacheable by default (RFC 7538 §3) and browsers treat a
      // permanent redirect as durable. Both shipped boxes served the
      // self-referencing loop AS a permanent redirect, so without this a
      // browser that cached it stays broken after the box is updated.
      const response = await middleware(createRequest("/setup/"));

      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("keeps the query string", async () => {
      const response = await middleware(createRequest("/login/?next=%2Fportal"));

      expect(response.status).toBe(308);
      const target = new URL(response.headers.get("location")!, "http://localhost");
      expect(target.pathname).toBe("/login");
      expect(target.searchParams.get("next")).toBe("/portal");
    });
  });

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

  describe("public webapps (InstalledMeta.public)", () => {
    // The owner marks one webapp public in its meta; that app's files are
    // served read-only without a session. Nothing else opens: another app,
    // POST, or a pre-setup box.
    function writeConfig(extra: Record<string, unknown>) {
      const dataDir = path.join(tmpRoot, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ setup_complete: true, ...extra }));
    }
    const meta = {
      "pref:installed_meta": {
        "shared-game": { name: "Game", color: "#000", iconUrl: "", webappUrl: "/setup-api/webapps?app=shared-game", public: true },
        "private-app": { name: "Private", color: "#000", iconUrl: "", webappUrl: "/setup-api/webapps?app=private-app" },
      },
    };

    async function load() {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      return (await import("@/middleware")).middleware;
    }

    it("serves a public webapp and its files to anyone, GET only", async () => {
      writeConfig(meta);
      const mw = await load();
      expect((await mw(createRequest("/setup-api/webapps?app=shared-game"))).status).toBe(200);
      expect((await mw(createRequest("/setup-api/webapps?app=shared-game&file=app.js"))).status).toBe(200);
      const post = new NextRequest(new URL("http://localhost/setup-api/webapps?app=shared-game"), { method: "POST" });
      expect((await mw(post)).status).toBe(401);
    });

    it("keeps every other webapp, and the path without an app, behind the session", async () => {
      writeConfig(meta);
      const mw = await load();
      expect((await mw(createRequest("/setup-api/webapps?app=private-app"))).status).toBe(401);
      expect((await mw(createRequest("/setup-api/webapps"))).status).toBe(401);
    });

    it("shares nothing when no meta says public, and picks up a flag flipped later", async () => {
      writeConfig({});
      const mw = await load();
      expect((await mw(createRequest("/setup-api/webapps?app=shared-game"))).status).toBe(401);
      // The snapshot is keyed on the file's mtime; force a distinct one.
      await new Promise((r) => setTimeout(r, 15));
      writeConfig(meta);
      expect((await mw(createRequest("/setup-api/webapps?app=shared-game"))).status).toBe(200);
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

    it("answers the /setup-api ROOT as the API namespace, not as a page", async () => {
      // TASK-631. Every gate here tested `startsWith("/setup-api/")`, WITH the
      // slash, so the namespace root itself was treated as an ordinary page:
      // an unauthenticated caller got a redirect to /login, and an
      // authenticated one fell through to the gateway catch-all, which answers
      // a navigation with the Control UI shell and the gateway token in it.
      // The root belongs to the same namespace as everything under it.
      process.env.SESSION_SECRET = "test-secret";
      markSetupComplete();
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest("/setup-api"));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
    });

    it("lets an anonymous /login-api/* path through to the route, which now 404s it", async () => {
      // The one namespace where an ANONYMOUS caller reached the gateway shell:
      // `/login-api` is in PUBLIC_PREFIXES (the login POST needs it), so
      // `GET /login-api/nope` was `NextResponse.next()` → the catch-all →
      // `serveGatewayHTML` → 200 Control UI. No token (`serveGatewayHTML`
      // injects only for an owner session), so not a credential leak — but it
      // is the only one of the five that answered a stranger with a 200 HTML
      // page, and the route's namespace gate is what turns it into a 404.
      // Middleware's own behaviour is deliberately unchanged here: taking
      // /login-api out of PUBLIC_PREFIXES would break signing in.
      process.env.SESSION_SECRET = "test-secret";
      markSetupComplete();
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest("/login-api/nope"));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    });

    it("does not fold /setupsomething into the /setup-api namespace", async () => {
      // The matching is on a segment boundary in both directions: `/setup-api`
      // must not fold into `/setup` (the original auth-bypass) and a path that
      // merely starts with the same letters must not fold into either.
      process.env.SESSION_SECRET = "test-secret";
      markSetupComplete();
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest("/setup-apiary"));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
    });

    it.each(["/login", "/setup", "/setup-api/setup/status", "/_next/chunk.js", "/fonts/test.woff", "/images/logo.png", "/manifest.json", "/sw.js", "/favicon.ico", "/portal/subscribe"])("allows public path %s", async (p) => {
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

    it.each([
      "/setup-api/local-ai/llamacpp/v1/chat/completions",
      "/setup-api/local-ai/ollama/api/chat",
      "/setup-api/local-ai/embed/v1/embeddings",
    ])("passes %s through with no session — the proxy verifies its own bearer", async (p) => {
      // OpenClaw is a separate process with no cookie. A 401 from here would
      // trip its auth-failure cooldown; for the embed prefix it would also
      // fail every memory search, since its embedding client gives a refused
      // request three attempts inside two seconds and then gives up.
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");
      const response = await mod.middleware(createRequest(p));
      expect(response.status).toBe(200);
    });

    it.each([
      "/setup-api/wifi/scan",
      "/setup-api/wifi/connect",
      "/setup-api/update/status",
      "/setup-api/update/run",
      "/setup-api/system/credentials",
      "/setup-api/system/hostname",
      "/setup-api/system/hotspot",
      "/setup-api/gateway/health",
      "/setup-api/harness/active",
    ])("allows %s during setup wizard bootstrap", async (p) => {
      // production-server.js auto-creates SESSION_SECRET so the env-var
      // short-circuit never fires; the wizard must still reach the routes
      // steps 1-3 need before a password can exist. Regression for the
      // "Failed to check update status" wizard breakage.
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = createRequest(p);
      const response = await mod.middleware(req);
      expect(response.status).toBe(200);
    });

    // TASK-443. The gate is an ALLOW-list now, so a route nobody thought about
    // is closed rather than open. These six were all reachable with no
    // credential from radio range of the OPEN `ClawBox-Setup` AP; setup/reset
    // in that state really did wipe the QA box.
    it.each([
      "/setup-api/setup/reset",
      "/setup-api/system/power",
      "/setup-api/install/run-step",
      "/setup-api/ollama/pull",
      // The telemetry family (TASK-446). Every one of these answered 200 with
      // no session while the open AP was up: hostname, kernel, CPU model, RAM,
      // uptime, disk, the LAN address, raw UI state, and which AI provider and
      // Telegram bot the box is wired to.
      "/setup-api/system/info",
      "/setup-api/system/stats",
      "/setup-api/wifi/status",
      "/setup-api/kv",
      "/setup-api/ai-models/status",
      "/setup-api/telegram/status",
    ])("gates %s even during setup wizard bootstrap", async (p) => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest(p));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
    });

    // TASK-443. The window used to be keyed on setup_complete alone, so a box
    // that had a password but an unfinished wizard — including one whose
    // config.json had simply lost the setup_complete key — served the whole
    // bootstrap surface to anyone. A device with a password has an owner.
    it.each([
      "/setup-api/wifi/connect",
      "/setup-api/update/run",
      "/setup-api/system/credentials",
      "/setup-api/harness/active",
    ])("closes the bootstrap window for %s once a password is configured", async (p) => {
      process.env.SESSION_SECRET = "test-secret";
      writeConfig({ password_configured: true }); // setup_complete still absent
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest(p));
      expect(response.status).toBe(401);
    });

    it("fails closed when config.json exists but cannot be parsed", async () => {
      // A missing config.json is a first-boot device and must open the window.
      // A corrupt one is a provisioned box with a damaged (or clobbered) file,
      // and treating that as "pre-setup" hands the window back. TASK-446.
      process.env.SESSION_SECRET = "test-secret";
      const dataDir = path.join(tmpRoot, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), "{ this is not json");
      vi.resetModules();
      const mod = await import("@/middleware");

      expect((await mod.middleware(createRequest("/setup-api/update/run"))).status).toBe(401);
      expect((await mod.middleware(createRequest("/setup-api/wifi/scan"))).status).toBe(401);
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
      // Same prefix, and it reads guild member lists through the bot token.
      "/setup-api/discord/members",
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
      // POST downloads ~2.2 MB from a third-party CDN and rewrites
      // display.pet.*. Cosmetic, desktop-only, and never part of onboarding.
      "/setup-api/pets",
      "/setup-api/pets/select",
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
      "/setup-api/whatsapp/status",    // WhatsApp lives only in Settings
      "/setup-api/whatsapp/configure", // writes who may talk to the agent
      "/setup-api/whatsapp/pair",      // hands back live QR pairing material
      "/setup-api/whatsapp/unpair",    // deletes the linked-device session
    ])("gates %s during the setup window", async (p) => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      expect((await mod.middleware(createRequest(p))).status).toBe(401);
    });

    it("still allows the wizard's /setup-api/harness/active during the setup window", async () => {
      // AIModelsStep reads which agent this SKU runs on the step boundary,
      // before a password can exist, so it is on the bootstrap allow-list.
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      expect((await mod.middleware(createRequest("/setup-api/harness/active"))).status).toBe(200);
    });

    it.each([
      "/setup-api/hermes/models",
      "/setup-api/hermes/clawai",
      "/setup-api/hermes/oauth",
      // The four leaves of the provider sign-in flow, named one by one rather
      // than inferred from the parent path above. They mint, advance and destroy
      // a real provider-OAuth session, and the parent's assertion does not cover
      // them: a single entry in BOOTSTRAP_ALLOWED_EXACT for one leaf opens that
      // leaf while `/setup-api/hermes/oauth` itself keeps answering 401, so the
      // line above would still pass. That exact-vs-prefix distinction is live in
      // the allow-list already — it is what holds `mascot-lines` open while the
      // `/regenerate` leaf beside it stays shut. TASK-527.
      "/setup-api/hermes/oauth/start",
      "/setup-api/hermes/oauth/submit",
      "/setup-api/hermes/oauth/poll",
      "/setup-api/hermes/oauth/cancel",
      "/setup-api/hermes/provider-key",
      "/setup-api/ai-models/configure",
      "/setup-api/telegram/configure",
    ])("requires the wizard's own session for %s", async (p) => {
      // These are steps 4-5, which run AFTER CredentialsStep. The password set
      // hands back a session cookie, so the wizard reaches them authenticated
      // and they need no pre-auth carve-out — which matters because the device
      // is broadcasting an OPEN AP for this whole window. TASK-443/446.
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      expect((await mod.middleware(createRequest(p))).status).toBe(401);

      const authed = new NextRequest(new URL(`http://localhost${p}`), {
        headers: {
          cookie: `clawbox_session=${await createSignedSessionCookie(Math.floor(Date.now() / 1000) + 60)}`,
        },
      });
      expect((await mod.middleware(authed)).status).toBe(200);
    });
  });

  describe("the wizard page follows the same window as its API", () => {
    it("serves /setup unauthenticated while the device has no owner", async () => {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");

      expect((await mod.middleware(createRequest("/setup"))).status).toBe(200);
    });

    it("redirects /setup to /login once a password is configured", async () => {
      // A resumed or half-finished wizard has an owner, so it logs in first —
      // and then steps 4-5 work through the session gate rather than needing a
      // pre-auth carve-out. TASK-443.
      process.env.SESSION_SECRET = "test-secret";
      writeConfig({ password_configured: true });
      vi.resetModules();
      const mod = await import("@/middleware");

      const response = await mod.middleware(createRequest("/setup"));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("Location")!);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("redirect")).toBe("/setup");
    });

    it("serves /setup again to a caller with a valid session", async () => {
      process.env.SESSION_SECRET = "test-secret";
      writeConfig({ password_configured: true });
      vi.resetModules();
      const mod = await import("@/middleware");

      const req = new NextRequest(new URL("http://localhost/setup"), {
        headers: {
          cookie: `clawbox_session=${await createSignedSessionCookie(Math.floor(Date.now() / 1000) + 60)}`,
        },
      });
      expect((await mod.middleware(req)).status).toBe(200);
    });

    it("does not let the /setup prefix leak /setup-api past the gate", async () => {
      // `startsWith("/setup")` also matches `/setup-api/...`; that was the
      // original auth bypass, and the wizard-page carve-out must not reopen it.
      process.env.SESSION_SECRET = "test-secret";
      writeConfig({ setup_complete: true, password_configured: true });
      vi.resetModules();
      const mod = await import("@/middleware");

      expect((await mod.middleware(createRequest("/setup-api/system/info"))).status).toBe(401);
      expect((await mod.middleware(createRequest("/setupmagic"))).status).toBe(307);
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

  /**
   * The update lock. `updateClawBoxAndReboot` runs `git reset --hard` and
   * `git clean -fd` over the project while the desktop is still on screen, and
   * every app on it can write through /setup-api — so a window left open can
   * save into a tree being rewritten underneath it. While an update owns the
   * box, page navigations go to the updating screen instead.
   */
  describe("update lock", () => {
    async function authed(pathname: string) {
      process.env.SESSION_SECRET = "test-secret";
      vi.resetModules();
      const mod = await import("@/middleware");
      const req = new NextRequest(new URL(`http://localhost${pathname}`), {
        headers: {
          cookie: `clawbox_session=${await createSignedSessionCookie(Math.floor(Date.now() / 1000) + 60)}`,
        },
      });
      return mod.middleware(req);
    }

    it("sends the desktop to the updating page while an update runs", async () => {
      writeConfig({ setup_complete: true, update_in_progress: true });
      const res = await authed("/");
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/updating");
    });

    it("sends a standalone app page there too", async () => {
      // /app/<id> is a real surface an owner can be sitting on, and it can
      // write through the same routes as the desktop.
      writeConfig({ setup_complete: true, update_in_progress: true });
      const res = await authed("/app/notes");
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/updating");
    });

    it("does not redirect the updating page to itself", async () => {
      writeConfig({ setup_complete: true, update_in_progress: true });
      expect((await authed("/updating")).status).toBe(200);
    });

    it("leaves /setup-api alone, because the updating page polls it", async () => {
      // And because an API answering a navigation redirect with HTML is the
      // defect #304 fixed — every caller parses the body as JSON.
      writeConfig({ setup_complete: true, update_in_progress: true });
      expect((await authed("/setup-api/update/status")).status).toBe(200);
    });

    it("does nothing when no update is running", async () => {
      writeConfig({ setup_complete: true });
      expect((await authed("/")).status).toBe(200);
    });

    it("fails OPEN on an unreadable config", async () => {
      // The auth fields fail CLOSED on a corrupt config; this one must not. A
      // config.json that will not parse is no evidence of an update, and
      // locking the desktop on it would take away the surfaces the owner needs
      // to fix the box.
      const dataDir = path.join(tmpRoot, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), "{ not json");
      expect((await authed("/")).status).toBe(200);
    });
  });

});
