import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "node:module";

/**
 * TASK-809 (HL-8) — the web app on port 80 used to answer to ANY Host header.
 *
 * That is the DNS-rebinding shape: a page on `intranet` (or any name an
 * attacker publishes with a one-second TTL and then re-points at the box's LAN
 * address) becomes same-origin with the device, and the owner's session cookie
 * then answers for it. `src/lib/same-origin.ts` cannot catch it — it measures
 * "same origin" against the very Host header the attacker chose.
 *
 * The RED case is the card's own: a request with `Host: intranet` and a valid
 * session must be refused on :80. On unmodified beta it is served (200).
 */

// src/lib/host-guard.ts reads the box's own name from os.hostname(); this handle
// is the same module object its `import os from "os"` holds, so assigning here
// is what a rename looks like from inside the process. Restored in afterEach.
const osModule = createRequire(import.meta.url)("node:os") as { hostname: () => string };
const realHostname = osModule.hostname;

const ORIGINS_ENV = "CLAWBOX_CONTROL_UI_ORIGINS_FILE";

describe("middleware Host allow-list", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-host-guard-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    delete process.env.HOST_GUARD;
    delete process.env[ORIGINS_ENV];
    delete process.env.CLAWBOX_DATA_DIR;
    delete process.env.CANONICAL_ORIGIN;
  });

  afterEach(() => {
    osModule.hostname = realHostname;
    delete process.env.CLAWBOX_ROOT;
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    delete process.env.HOST_GUARD;
    delete process.env[ORIGINS_ENV];
    delete process.env.CLAWBOX_DATA_DIR;
    delete process.env.CANONICAL_ORIGIN;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function loadMiddleware() {
    vi.resetModules();
    return (await import("@/middleware")).middleware;
  }

  function writeConfig(fields: Record<string, unknown>) {
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(fields));
  }

  function writeTunnelUrl(url: string) {
    const dir = path.join(tmpRoot, "data", "cloudflared");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tunnel.url"), `${url}\n`);
  }

  function writeOrigins(entries: string[]) {
    const file = path.join(tmpRoot, "origins.json");
    fs.writeFileSync(file, JSON.stringify(entries));
    process.env[ORIGINS_ENV] = file;
  }

  async function signedSessionCookie(): Promise<string> {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString("base64url");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    );
    const hex = Array.from(signature)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `${payload}.${hex}`;
  }

  /** A request addressed to `host`, carrying a valid owner session. */
  async function ownerRequest(host: string, pathname = "/", extra: Record<string, string> = {}) {
    process.env.SESSION_SECRET = "test-secret";
    return new NextRequest(new URL(`http://${host}${pathname}`), {
      headers: {
        host,
        cookie: `clawbox_session=${await signedSessionCookie()}`,
        ...extra,
      },
    });
  }

  describe("the rebind case", () => {
    it("refuses Host: intranet with a valid session, with 421", async () => {
      writeConfig({ setup_complete: true, password_configured: true });
      const middleware = await loadMiddleware();

      const response = await middleware(await ownerRequest("intranet"));

      expect(response.status).toBe(421);
    });

    it("refuses a rebinding name on the API surface too, not just on a page", async () => {
      writeConfig({ setup_complete: true, password_configured: true });
      const middleware = await loadMiddleware();

      const response = await middleware(
        await ownerRequest("evil.example", "/setup-api/system/info"),
      );

      expect(response.status).toBe(421);
    });

    it("refuses a rebinding name BEFORE the session is even considered", async () => {
      // No cookie at all: the answer is still 421, never a login redirect that
      // would tell an attacker's page the box is there and listening.
      writeConfig({ setup_complete: true, password_configured: true });
      process.env.SESSION_SECRET = "test-secret";
      const middleware = await loadMiddleware();

      const response = await middleware(
        new NextRequest(new URL("http://evil.example/"), { headers: { host: "evil.example" } }),
      );

      expect(response.status).toBe(421);
    });

    it("names the addresses that do work, in plain text", async () => {
      writeConfig({ setup_complete: true, password_configured: true });
      const middleware = await loadMiddleware();

      const response = await middleware(await ownerRequest("intranet"));
      const body = await response.text();

      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toContain("intranet");
      expect(body).toContain("clawbox.local");
      expect(body).toContain("10.42.0.1");
    });

    it("does not echo control characters or markup from the Host header", async () => {
      writeConfig({ setup_complete: true, password_configured: true });
      const middleware = await loadMiddleware();

      const request = await ownerRequest("intranet");
      request.headers.set("host", "<script>x</script>");
      const body = await (await middleware(request)).text();

      expect(body).not.toContain("<script>");
    });
  });

  describe("the forms that must keep working", () => {
    beforeEach(() => writeConfig({ setup_complete: true, password_configured: true }));

    it.each([
      ["a LAN IPv4", "192.168.1.45"],
      ["the SoftAP address", "10.42.0.1"],
      ["the second AP address", "10.43.0.1"],
      ["loopback by IP", "127.0.0.1"],
      ["loopback by name", "localhost"],
      ["the mDNS name", "clawbox.local"],
      ["a LAN IPv4 with a port", "192.168.1.45:80"],
    ])("admits %s", async (_label, host) => {
      const middleware = await loadMiddleware();

      const response = await middleware(await ownerRequest(host));

      expect(response.status).toBe(200);
    });

    it("admits an IPv6 literal — an address cannot be DNS-rebound", async () => {
      const middleware = await loadMiddleware();

      const request = await ownerRequest("localhost");
      request.headers.set("host", "[::1]");
      const response = await middleware(request);

      expect(response.status).toBe(200);
    });

    it("admits the box's own bare hostname and its .local form after a rename", async () => {
      osModule.hostname = () => "seaside";
      const middleware = await loadMiddleware();

      expect((await middleware(await ownerRequest("seaside"))).status).toBe(200);
      expect((await middleware(await ownerRequest("seaside.local"))).status).toBe(200);
    });

    it("follows a rename without a restart — the old name stops, the new one starts", async () => {
      osModule.hostname = () => "seaside";
      const middleware = await loadMiddleware();
      expect((await middleware(await ownerRequest("seaside"))).status).toBe(200);

      osModule.hostname = () => "harbour";

      expect((await middleware(await ownerRequest("harbour"))).status).toBe(200);
      expect((await middleware(await ownerRequest("seaside"))).status).toBe(421);
    });

    it("does NOT admit some other box's .local name", async () => {
      // The Hermes dashboard proxy admits any `<label>.local` because nothing
      // restarts it on a rename; this guard reads the nodename per request, so
      // it can afford the narrower policy.
      osModule.hostname = () => "seaside";
      const middleware = await loadMiddleware();

      expect((await middleware(await ownerRequest("router.local"))).status).toBe(421);
    });

    it("admits a Tailscale MagicDNS name", async () => {
      // README, control-ui-origins.ts and scripts/gateway_origins.py all promise
      // a `.ts.net` name reaches the box with no configuration, and the firewall
      // keeps 100.64/10 open for it. Before this guard that was true because the
      // middleware answered to everything; it has to stay true on purpose.
      const middleware = await loadMiddleware();

      const response = await middleware(await ownerRequest("seaside.tail1a2b3c.ts.net"));

      expect(response.status).toBe(200);
    });

    it.each([
      ["a bare suffix", "ts.net"],
      ["one label before the suffix", "tailnet.ts.net"],
      ["an empty label", "evil..ts.net"],
      ["a lookalike suffix", "evil.ts.net.example.com"],
    ])("does not admit %s", async (_label, host) => {
      const middleware = await loadMiddleware();

      expect((await middleware(await ownerRequest(host))).status).toBe(421);
    });

    it("admits the host CANONICAL_ORIGIN redirects to", async () => {
      // Otherwise the gateway-busy fallback redirect lands on a 421 dead end.
      process.env.CANONICAL_ORIGIN = "http://box.example.net";
      const middleware = await loadMiddleware();

      expect((await middleware(await ownerRequest("box.example.net"))).status).toBe(200);
    });

    it("admits the hostname the tunnel published", async () => {
      writeTunnelUrl("https://calm-river-1234.trycloudflare.com");
      const middleware = await loadMiddleware();

      const response = await middleware(
        await ownerRequest("calm-river-1234.trycloudflare.com", "/", {
          "x-forwarded-proto": "https",
        }),
      );

      expect(response.status).toBe(200);
    });

    it("stops admitting the tunnel hostname once the tunnel stops", async () => {
      writeTunnelUrl("https://calm-river-1234.trycloudflare.com");
      const middleware = await loadMiddleware();
      expect(
        (await middleware(await ownerRequest("calm-river-1234.trycloudflare.com"))).status,
      ).toBe(200);

      // scripts/run-tunnel.sh removes the file on the way out.
      fs.rmSync(path.join(tmpRoot, "data", "cloudflared", "tunnel.url"));

      expect(
        (await middleware(await ownerRequest("calm-river-1234.trycloudflare.com"))).status,
      ).toBe(421);
    });

    it("admits a configured control-UI origin on an exact scheme+host+port match", async () => {
      writeOrigins(["http://box.example.com:8080"]);
      const middleware = await loadMiddleware();

      const response = await middleware(await ownerRequest("box.example.com:8080"));

      expect(response.status).toBe(200);
    });

    it("does not admit a configured hostname on a scheme that was not configured", async () => {
      writeOrigins(["https://box.example.com"]);
      const middleware = await loadMiddleware();

      const response = await middleware(await ownerRequest("box.example.com"));

      expect(response.status).toBe(421);
    });

    it("lets the captive-portal probes through on their foreign Host", async () => {
      // On the SoftAP dnsmasq answers every name with the box, so the phone's
      // connectivity check arrives addressed to Google's hostname. It must
      // still be redirected to the portal, which is why the guard sits after
      // that block.
      const middleware = await loadMiddleware();

      const response = await middleware(
        new NextRequest(new URL("http://connectivitycheck.gstatic.com/generate_204"), {
          headers: { host: "connectivitycheck.gstatic.com" },
        }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("http://10.42.0.1/");
    });
  });

  describe("the recovery escape", () => {
    it("admits everything while HOST_GUARD is off", async () => {
      writeConfig({ setup_complete: true, password_configured: true });
      process.env.HOST_GUARD = "off";
      const middleware = await loadMiddleware();

      const response = await middleware(await ownerRequest("intranet"));

      expect(response.status).toBe(200);
    });

    it("says so in the log, once per hour rather than once per request", async () => {
      writeConfig({ setup_complete: true, password_configured: true });
      process.env.HOST_GUARD = "off";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const middleware = await loadMiddleware();

      await middleware(await ownerRequest("intranet"));
      await middleware(await ownerRequest("intranet"));

      // Not once per PROCESS either: a box left with the guard off would then
      // say so only in a boot message nobody reads again.
      const lines = warn.mock.calls.filter((call) => String(call[0]).includes("HOST_GUARD"));
      expect(lines).toHaveLength(1);
    });

    it("stays on for any other value", async () => {
      writeConfig({ setup_complete: true, password_configured: true });
      process.env.HOST_GUARD = "on";
      const middleware = await loadMiddleware();

      expect((await middleware(await ownerRequest("intranet"))).status).toBe(421);
    });
  });
});
