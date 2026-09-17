import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createRequire } from "node:module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The Host allow-list on port 80.
 *
 * The app on :80 answered whatever name it was addressed as. The session cookie
 * is host-only and SameSite=Lax, so a LAN attacker who can point a name at the
 * box — a DHCP search domain turning `intranet` into this box's address — gets
 * the owner's browser to make top-level, same-origin requests to that name with
 * the cookie attached: the desktop and every /setup-api route, readable by the
 * attacker's own page on that same name. The Hermes dashboard proxy on :8090
 * already refused such names; the app did not.
 *
 * Pinned here:
 *   - a foreign name with a VALID session is refused (the RED case);
 *   - every documented way to reach the box still works: localhost, an IP
 *     literal, `<label>.local`, the box's own bare hostname, a Tailscale
 *     `.ts.net` name, an owner-configured control UI origin, and the Cloudflare
 *     tunnel (whose Host is the tunnel's own hostname);
 *   - a fresh box on its hotspot is not locked out: a page navigation to any
 *     name during the bootstrap window is sent to the portal, and the captive
 *     portal probes still answer.
 */

const require_ = createRequire(import.meta.url);
const osModule = require_("node:os") as { hostname: () => string };
const realHostname = osModule.hostname;
const BOX = "krasi-workshop";

describe("middleware Host allow-list", () => {
  let tmpRoot: string;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-host-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    process.env.CLAWBOX_CONTROL_UI_ORIGINS_FILE = path.join(tmpRoot, "control-ui-origins.json");
    process.env.SESSION_SECRET = "test-secret";
    delete process.env.ALLOWED_HOSTS;
    delete process.env.PORTAL_URL;
    delete process.env.CLAWBOX_TEST_MODE;
    osModule.hostname = () => BOX;
  });

  afterEach(() => {
    osModule.hostname = realHostname;
    delete process.env.ALLOWED_HOSTS;
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_ROOT;
    delete process.env.CLAWBOX_CONTROL_UI_ORIGINS_FILE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeConfig(fields: Record<string, unknown>) {
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(fields));
  }

  async function sessionCookie(): Promise<string> {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
    return `${payload}.${Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  async function run(host: string, pathname: string, headers: Record<string, string> = {}, method = "GET") {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest(new URL(`http://${host}${pathname}`), {
      method,
      headers: { host, ...headers },
    });
    return middleware(req);
  }

  async function asOwner(host: string, pathname: string, extra: Record<string, string> = {}, method = "GET") {
    return run(host, pathname, { cookie: `clawbox_session=${await sessionCookie()}`, ...extra }, method);
  }

  describe("a foreign name is refused, even with the owner's session", () => {
    beforeEach(() => writeConfig({ setup_complete: true, password_configured: true }));

    it("refuses the desktop on Host: intranet", async () => {
      const res = await asOwner("intranet", "/");
      expect(res.status).toBe(403);
      expect(res.headers.get("x-middleware-next")).toBeNull();
      // Names a way in that works, and nothing of the desktop.
      expect(await res.text()).toContain(`http://${BOX}.local/`);
    });

    it("refuses /setup-api on Host: intranet with a JSON code", async () => {
      const res = await asOwner("intranet", "/setup-api/system/info");
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "host_not_allowed" });
    });

    it("refuses a state-changing POST on a foreign name with a port", async () => {
      const res = await asOwner("intranet:80", "/setup-api/system/power", {}, "POST");
      expect(res.status).toBe(403);
    });

    it("refuses the LAN-domain form and a bare label that is not this box", async () => {
      expect((await asOwner(`${BOX}.lan`, "/")).status).toBe(403);
      expect((await asOwner("router", "/")).status).toBe(403);
      expect((await asOwner("evil.example.com", "/login")).status).toBe(403);
    });

    it("refuses public paths too, so a foreign name reaches nothing at all", async () => {
      expect((await run("intranet", "/login")).status).toBe(403);
      expect((await run("intranet", "/setup-api/setup/status")).status).toBe(403);
    });

    it("does not trust a Host-like header that is not the Host", async () => {
      const res = await asOwner("intranet", "/", { "x-forwarded-host": "clawbox.local" });
      expect(res.status).toBe(403);
    });

    it("refuses an empty cf-connecting-ip as the tunnel marker", async () => {
      const res = await asOwner("intranet", "/", { "cf-connecting-ip": "" });
      expect(res.status).toBe(403);
    });

    it("refuses a .ts.net name that is not a machine on a tailnet", async () => {
      expect((await asOwner("ts.net", "/")).status).toBe(403);
      expect((await asOwner("evil.ts.net", "/")).status).toBe(403);
    });
  });

  describe("every documented address still works", () => {
    beforeEach(() => writeConfig({ setup_complete: true, password_configured: true }));

    it.each([
      "localhost",
      "localhost:3000",
      "clawbox.local",
      `${BOX}.local`,
      "kitchen.local",
      BOX,
      `${BOX.toUpperCase()}`,
      "10.42.0.1",
      "192.168.1.50",
      "192.168.1.50:80",
      "[::1]",
      "[fe80::1]:80",
      `${BOX}.tail1234.ts.net`,
    ])("serves the owner on Host: %s", async (host) => {
      const res = await asOwner(host, "/");
      expect(res.status).toBe(200);
    });

    it("follows a rename without a restart", async () => {
      expect((await asOwner("kitchen", "/")).status).toBe(403);
      osModule.hostname = () => "kitchen";
      expect((await asOwner("kitchen", "/")).status).toBe(200);
    });

    it("admits names listed in ALLOWED_HOSTS", async () => {
      process.env.ALLOWED_HOSTS = "box.home.arpa";
      expect((await asOwner("box.home.arpa", "/")).status).toBe(200);
    });

    it("admits the host of an owner-configured control UI origin", async () => {
      fs.writeFileSync(
        process.env.CLAWBOX_CONTROL_UI_ORIGINS_FILE!,
        JSON.stringify(["https://claw.example.org"]),
      );
      expect((await asOwner("claw.example.org", "/")).status).toBe(200);
    });

    it("admits the Cloudflare tunnel, whose Host is the tunnel's own hostname", async () => {
      // cf-connecting-ip only survives scripts/proxy-peer.js from a loopback peer.
      const res = await asOwner("abc-def.trycloudflare.com", "/", { "cf-connecting-ip": "203.0.113.9" });
      expect(res.status).toBe(200);
    });

    it("answers the captive-portal probes on any name", async () => {
      const res = await run("connectivitycheck.gstatic.com", "/generate_204");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://10.42.0.1/");
      const apple = await run("captive.apple.com", "/hotspot-detect.html");
      expect(apple.status).toBe(200);
    });
  });

  describe("a fresh box is not locked out", () => {
    it("sends a page navigation on any name to the portal while there is no owner", async () => {
      writeConfig({});
      const res = await run("example.com", "/");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://10.42.0.1/");
    });

    it("still runs the wizard on the portal address and on .local", async () => {
      writeConfig({});
      expect((await run("10.42.0.1", "/setup")).status).toBe(200);
      expect((await run("clawbox.local", "/setup-api/setup/status")).status).toBe(200);
    });

    it("refuses the wizard's API on a foreign name even then", async () => {
      writeConfig({});
      expect((await run("example.com", "/setup-api/setup/status")).status).toBe(403);
    });

    it("refuses a foreign-name navigation once there is an owner", async () => {
      writeConfig({ setup_complete: true, password_configured: true });
      const res = await run("intranet", "/");
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });
});
