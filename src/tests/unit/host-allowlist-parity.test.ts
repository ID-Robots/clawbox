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
  configuredOriginHosts: () => Set<string>;
};

/**
 * Control UI origin files, and the hostnames both copies must take from each.
 *
 * The CommonJS mirror once read these with a regex of its own, which diverged
 * from `normalizeOrigin()` the moment a port ran past 65535: `\d{1,5}` matches
 * `99999`, `new URL` throws on it. The middleware therefore dropped the entry
 * and refused the name while the upgrade path admitted it — the one direction
 * these two copies exist to rule out. Both now run the same parser, and this
 * table is what says so.
 */
const ORIGIN_FILES: Array<[string, unknown[], string[]]> = [
  ["a plain origin", ["https://claw.example.org"], ["claw.example.org"]],
  ["a non-default port", ["https://claw.example.org:8443"], ["claw.example.org"]],
  ["a port past 65535", ["https://bad-port.example.org:99999"], []],
  ["a port of zero-padded nonsense", ["https://bad-port.example.org:0x50"], []],
  ["a bare IPv6 literal", ["http://[2001:db8::1]"], ["2001:db8::1"]],
  ["an invalid IPv6 literal", ["http://[2001:db8:::1]"], []],
  ["IPv4 shorthand WHATWG would rewrite", ["http://127.1"], []],
  ["an octal IPv4 WHATWG would rewrite", ["http://010.0.0.1"], []],
  ["a canonical dotted quad", ["http://192.168.1.50"], ["192.168.1.50"]],
  ["credentials in the authority", ["https://user@claw.example.org"], []],
  ["empty userinfo", ["https://@claw.example.org"], []],
  ["a path", ["https://claw.example.org/admin"], []],
  ["a query string", ["https://claw.example.org/?a=1"], []],
  ["a fragment", ["https://claw.example.org/#x"], []],
  ["a wildcard", ["https://*.example.org"], []],
  ["a non-http scheme", ["ftp://claw.example.org"], []],
  ["a backslash", ["https://claw.example.org\\@evil.test"], []],
  ["entries that are not strings", [42, null, { origin: "https://x.test" }], []],
  ["a trailing dot", ["https://claw.example.org."], []],
  ["mixed valid and invalid", ["https://ok.example.org", "https://bad.example.org:99999"], ["ok.example.org"]],
];

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

  describe("the box's own named-tunnel hostname", () => {
    const HOST = "amber-otter-k7m2p9qx4w3n.clawbox.tech";
    const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
    const credFile = () => path.join(tmp, "named-tunnel");

    beforeEach(() => {
      process.env.CLAWBOX_NAMED_TUNNEL_FILE = credFile();
    });
    afterEach(() => {
      delete process.env.CLAWBOX_NAMED_TUNNEL_FILE;
    });

    async function fresh() {
      vi.resetModules();
      const tsMod = await import("@/lib/host-allowlist");
      delete require_.cache[CJS];
      return { tsMod, cjsMod: require_(CJS) as CjsModule };
    }

    it.each([
      ["a valid credential", `hostname=${HOST}\ntoken=${TOKEN}\n`, true],
      ["no token line", `hostname=${HOST}\n`, false],
      ["a malformed token", `hostname=${HOST}\ntoken=short\n`, false],
      ["a hostname two labels deep", `hostname=x.${HOST}\ntoken=${TOKEN}\n`, false],
      ["a hostname in another zone", `hostname=box.evil.example\ntoken=${TOKEN}\n`, false],
      ["no file at all", null, false],
    ])("both read %s the same way", async (_label, contents, admitted) => {
      if (contents === null) fs.rmSync(credFile(), { force: true });
      else fs.writeFileSync(credFile(), contents);
      const { tsMod, cjsMod } = await fresh();
      expect(tsMod.isAllowedHostHeader(HOST)).toBe(admitted);
      expect(cjsMod.isAllowedHostHeader(HOST)).toBe(admitted);
      expect(cjsMod.isAllowedHostHeader(`${HOST}:443`)).toBe(admitted);
    });

    it("both refuse every other name in the zone", async () => {
      fs.writeFileSync(credFile(), `hostname=${HOST}\ntoken=${TOKEN}\n`);
      const { tsMod, cjsMod } = await fresh();
      for (const host of ["clawbox.tech", "other-box-abcdefghjkmn.clawbox.tech", `x.${HOST}`, `${HOST}.evil.example`]) {
        expect(tsMod.isAllowedHostHeader(host), host).toBe(false);
        expect(cjsMod.isAllowedHostHeader(host), host).toBe(false);
      }
    });

    it("a LAN upgrade on the named hostname is admitted like any own name", async () => {
      fs.writeFileSync(credFile(), `hostname=${HOST}\ntoken=${TOKEN}\n`);
      const { cjsMod } = await fresh();
      expect(cjsMod.isAllowedUpgrade({ headers: { host: HOST }, socket: { remoteAddress: "192.168.1.20" } })).toBe(true);
      expect(
        cjsMod.isAllowedUpgrade({ headers: { host: "other-box-abcdefghjkmn.clawbox.tech" }, socket: { remoteAddress: "192.168.1.20" } }),
      ).toBe(false);
    });
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

  describe("the configured control UI origins are read the same way by both", () => {
    const originsFile = () => process.env.CLAWBOX_CONTROL_UI_ORIGINS_FILE!;

    it.each(ORIGIN_FILES)("%s", async (_label, entries, expected) => {
      fs.writeFileSync(originsFile(), JSON.stringify(entries));
      // Both copies cache on the file's signature, so re-import for each case.
      vi.resetModules();
      const tsMod = await import("@/lib/host-allowlist");
      delete require_.cache[CJS];
      const cjsMod = require_(CJS) as CjsModule;

      expect([...tsMod.configuredOriginHosts()].sort()).toEqual([...expected].sort());
      expect([...cjsMod.configuredOriginHosts()].sort()).toEqual([...expected].sort());

      // …and the hostname decision itself agrees, which is what ships.
      for (const host of [...expected, "bad-port.example.org", "127.1", "claw.example.org"]) {
        expect(cjsMod.isAllowedHostHeader(host)).toBe(tsMod.isAllowedHostHeader(host));
      }
    });

    it.each([
      ["a missing file", null],
      ["invalid JSON", "{["],
      ["a JSON object rather than an array", '{"origins":["https://x.test"]}'],
    ])("both read %s as no configured origins", async (_label, contents) => {
      if (contents === null) fs.rmSync(originsFile(), { force: true });
      else fs.writeFileSync(originsFile(), contents);
      vi.resetModules();
      const tsMod = await import("@/lib/host-allowlist");
      delete require_.cache[CJS];
      const cjsMod = require_(CJS) as CjsModule;

      expect([...tsMod.configuredOriginHosts()]).toEqual([]);
      expect([...cjsMod.configuredOriginHosts()]).toEqual([]);
    });
  });

  it("production-server.js checks the Host before routing, on the HTTP and the HTTPS upgrade", () => {
    const src = readFileSync(path.resolve(process.cwd(), "production-server.js"), "utf-8");
    expect(src).toContain('require("./scripts/host-allowlist.js")');
    const guards = src.match(/if \(!isAllowedUpgrade\(req\)\) \{\s*return rejectForeignHostUpgrade\(socket\);\s*\}\s*const (?:\{ targetPort, url, requireAuth, sanitizeClose \}|gate) = resolveUpgradeTarget/g);
    expect(guards?.length).toBe(2);
  });
});
