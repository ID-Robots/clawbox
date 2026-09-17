import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * src/lib/host-allowlist.ts (the middleware) and scripts/host-allowlist.js
 * (production-server.js's WebSocket upgrades) are two copies of one rule. An
 * upgrade the middleware would refuse must not be admitted — /terminal-ws is a
 * shell — so the same table runs over both.
 */

const require_ = createRequire(import.meta.url);
const osModule = require_("node:os") as { hostname: () => string };
const realHostname = osModule.hostname;
const CJS = path.resolve(process.cwd(), "scripts/host-allowlist.js");

type CjsModule = {
  isAllowedHostHeader: (raw: unknown) => boolean;
  isAllowedUpgrade: (req: unknown) => boolean;
};

const BOX = "krasi-workshop";

const ADMITTED = [
  "localhost", "LOCALHOST:3000", "clawbox.local", "clawbox.local.", "kitchen.local", `${BOX}.local`,
  BOX, `${BOX}:80`, "10.42.0.1", "10.43.0.1", "192.168.1.50:8080", "[::1]", "[fe80::1]:443",
  `${BOX}.tail1234.ts.net`, "claw.example.org", "claw.example.org:8443",
];

const REFUSED = [
  "", "intranet", "intranet:80", "router", `${BOX}.lan`, `${BOX}.fritz.box`, "evil.example.com",
  "ts.net", "evil.ts.net", "a.b.c.ts.net", "evil..local", "-bad.local", ".local", "::1",
  "clawbox.local:abc", "10.0.0.1:80:80", "other.example.org",
];

describe("host allow-list parity", () => {
  let tmp: string;
  let ts: typeof import("@/lib/host-allowlist");
  let cjs: CjsModule;

  beforeEach(async () => {
    vi.resetModules();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hostp-"));
    const originsFile = path.join(tmp, "origins.json");
    fs.writeFileSync(originsFile, JSON.stringify(["https://claw.example.org", 42, "not a url"]));
    process.env.CLAWBOX_CONTROL_UI_ORIGINS_FILE = originsFile;
    delete process.env.ALLOWED_HOSTS;
    osModule.hostname = () => BOX;
    ts = await import("@/lib/host-allowlist");
    delete require_.cache[CJS];
    cjs = require_(CJS) as CjsModule;
  });

  afterEach(() => {
    osModule.hostname = realHostname;
    delete process.env.CLAWBOX_CONTROL_UI_ORIGINS_FILE;
    delete process.env.ALLOWED_HOSTS;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(ADMITTED)("both admit %s", (host) => {
    expect(ts.isAllowedHostHeader(host)).toBe(true);
    expect(cjs.isAllowedHostHeader(host)).toBe(true);
  });

  it.each(REFUSED)("both refuse %j", (host) => {
    expect(ts.isAllowedHostHeader(host)).toBe(false);
    expect(cjs.isAllowedHostHeader(host)).toBe(false);
  });

  it("both honour ALLOWED_HOSTS, which replaces the default list", () => {
    process.env.ALLOWED_HOSTS = "box.home.arpa";
    for (const mod of [ts, cjs]) {
      expect(mod.isAllowedHostHeader("box.home.arpa")).toBe(true);
      expect(mod.isAllowedHostHeader("localhost")).toBe(false);
      // An IP literal and .local do not depend on the list.
      expect(mod.isAllowedHostHeader("127.0.0.1")).toBe(true);
      expect(mod.isAllowedHostHeader("clawbox.local")).toBe(true);
    }
  });

  describe("upgrades", () => {
    const req = (remoteAddress: string | undefined, host: string | undefined) => ({
      headers: host === undefined ? {} : { host },
      socket: remoteAddress === undefined ? undefined : { remoteAddress },
    });

    it("refuses a LAN peer on a foreign name", () => {
      expect(cjs.isAllowedUpgrade(req("192.168.1.20", "intranet"))).toBe(false);
      expect(cjs.isAllowedUpgrade(req("::ffff:192.168.1.20", "intranet:80"))).toBe(false);
      expect(cjs.isAllowedUpgrade(req(undefined, "intranet"))).toBe(false);
      expect(cjs.isAllowedUpgrade(req("192.168.1.20", undefined))).toBe(false);
    });

    it("admits a LAN peer on the box's own names", () => {
      expect(cjs.isAllowedUpgrade(req("192.168.1.20", `${BOX}.local`))).toBe(true);
      expect(cjs.isAllowedUpgrade(req("192.168.1.20", "192.168.1.5"))).toBe(true);
    });

    it("admits a loopback peer on any name — cloudflared delivers the tunnel's own hostname", () => {
      expect(cjs.isAllowedUpgrade(req("127.0.0.1", "abc-def.trycloudflare.com"))).toBe(true);
      expect(cjs.isAllowedUpgrade(req("::1", "abc-def.trycloudflare.com"))).toBe(true);
    });

    it("never throws on a malformed request", () => {
      expect(cjs.isAllowedUpgrade(null)).toBe(false);
      expect(cjs.isAllowedUpgrade({})).toBe(false);
    });
  });

  it("production-server.js checks the Host before routing, on the HTTP and the HTTPS upgrade", () => {
    const src = readFileSync(path.resolve(process.cwd(), "production-server.js"), "utf-8");
    expect(src).toContain('require("./scripts/host-allowlist.js")');
    const guards = src.match(/if \(!isAllowedUpgrade\(req\)\) \{\s*return rejectForeignHostUpgrade\(socket\);\s*\}\s*const (?:\{ targetPort, url, requireAuth, sanitizeClose \}|gate) = resolveUpgradeTarget/g);
    expect(guards?.length).toBe(2);
  });
});
