import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * src/lib/host-guard.ts — the one Host allow-list, shared by src/middleware.ts
 * (which refuses everything else with 421) and src/lib/gateway-proxy.ts (which
 * decides what to reflect into a redirect).
 *
 * The middleware-level behaviour is covered in
 * src/tests/middleware/host-allowlist.test.ts; this file covers the module's
 * own contracts — above all that the two places the app records the tunnel's
 * public hostname are the two places this reads.
 */
describe("host-guard", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-host-guard-unit-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    delete process.env.HOST_GUARD;
    delete process.env.CLAWBOX_DATA_DIR;
  });

  afterEach(() => {
    delete process.env.CLAWBOX_ROOT;
    delete process.env.HOST_GUARD;
    delete process.env.CLAWBOX_DATA_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function loadGuard() {
    vi.resetModules();
    return import("@/lib/host-guard");
  }

  describe("the tunnel hostname comes from the app's own record of it", () => {
    /**
     * The guard re-derives the two paths rather than importing them, so the
     * middleware bundle does not pull child_process in through
     * src/lib/cloudflared.ts. This is what keeps the copies honest: if either
     * module moves its file, this fails.
     */
    it("reads exactly the files cloudflared.ts and tunnel.ts write", async () => {
      vi.resetModules();
      const cloudflared = await import("@/lib/cloudflared");
      const tunnel = await import("@/lib/tunnel");
      const guard = await import("@/lib/host-guard");

      expect(guard.tunnelUrlFiles()).toEqual([
        cloudflared.TUNNEL_URL_FILE,
        tunnel.TUNNEL_URL_FILE,
      ]);
    });

    it("admits the hostname in data/cloudflared/tunnel.url (the systemd unit)", async () => {
      const dir = path.join(tmpRoot, "data", "cloudflared");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "tunnel.url"), "https://calm-river-1234.trycloudflare.com\n");
      const guard = await loadGuard();

      expect([...guard.tunnelHostnames()]).toEqual(["calm-river-1234.trycloudflare.com"]);
    });

    it("admits the hostname in data/tunnel-url.txt (the in-app spawned tunnel)", async () => {
      fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "data", "tunnel-url.txt"),
        "https://calm-river-5678.trycloudflare.com",
      );
      const guard = await loadGuard();

      expect([...guard.tunnelHostnames()]).toEqual(["calm-river-5678.trycloudflare.com"]);
    });

    it("ignores a file that does not hold a quick-tunnel URL", async () => {
      const dir = path.join(tmpRoot, "data", "cloudflared");
      fs.mkdirSync(dir, { recursive: true });
      // A half-written line, or a hand edit. This file decides who the box
      // answers to; anything but the shape cloudflared publishes widens nothing.
      fs.writeFileSync(path.join(dir, "tunnel.url"), "https://evil.example");
      const guard = await loadGuard();

      expect([...guard.tunnelHostnames()]).toEqual([]);
    });

    it("picks up a NEW hostname without a restart", async () => {
      const dir = path.join(tmpRoot, "data", "cloudflared");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "tunnel.url");
      fs.writeFileSync(file, "https://first-name-0001.trycloudflare.com");
      const guard = await loadGuard();
      expect(guard.tunnelHostnames().has("first-name-0001.trycloudflare.com")).toBe(true);

      // The unit restarts on failure and every restart publishes a new name.
      // Deliberately a DIFFERENT LENGTH: the cache key is
      // dev:ino:size:mtimeNs:ctimeNs, and Linux timestamp granularity is coarser
      // than a nanosecond, so two same-length writes inside one tick would be
      // indistinguishable and this test would flake on a fast runner.
      fs.writeFileSync(file, "https://a-much-longer-second-name-0002.trycloudflare.com");

      expect(guard.tunnelHostnames().has("a-much-longer-second-name-0002.trycloudflare.com")).toBe(true);
      expect(guard.tunnelHostnames().has("first-name-0001.trycloudflare.com")).toBe(false);
    });
  });

  describe("splitHostHeader", () => {
    it.each([
      ["clawbox.local", "clawbox.local", ""],
      ["ClawBox.Local:80", "clawbox.local", "80"],
      ["[::1]", "::1", ""],
      ["[fe80::1]:8090", "fe80::1", "8090"],
    ])("splits %s", async (raw, hostname, port) => {
      const guard = await loadGuard();

      expect(guard.splitHostHeader(raw)).toEqual({ hostname, port });
    });

    it.each(["", "   ", "::1", "host:notaport"])("refuses %s", async (raw) => {
      const guard = await loadGuard();

      expect(guard.splitHostHeader(raw)).toBeNull();
    });
  });

  describe("isReflectableHost stays the gateway proxy's predicate", () => {
    it("admits a listed host, an IPv4 and the box's own names — and nothing else", async () => {
      const guard = await loadGuard();

      expect(guard.isReflectableHost("clawbox.local")).toBe(true);
      expect(guard.isReflectableHost("10.42.0.1")).toBe(true);
      expect(guard.isReflectableHost("192.168.1.45")).toBe(true);
      expect(guard.isReflectableHost("intranet")).toBe(false);
      // IPv6 is NOT reflectable — the proxy never reflected one, and the
      // middleware admits it separately.
      expect(guard.isReflectableHost("::1")).toBe(false);
    });
  });

  describe("the CJS sibling must not drift", () => {
    /**
     * scripts/hermes-dashboard-proxy.js runs in its own process and cannot
     * import this module, so it carries its own copy of the ALLOWED_HOSTS
     * default and of MDNS_LABEL_RE. Both files promise they are "the same"; this
     * is what makes that true. The POLICY around the regex is deliberately
     * different (that proxy admits any `<label>.local`) and is not asserted here.
     */
    it("shares the ALLOWED_HOSTS default and the mDNS label regex with the Hermes dashboard proxy", async () => {
      const proxySource = fs.readFileSync(
        path.join(process.cwd(), "scripts", "hermes-dashboard-proxy.js"),
        "utf-8",
      );
      const guardSource = fs.readFileSync(
        path.join(process.cwd(), "src", "lib", "host-guard.ts"),
        "utf-8",
      );

      const defaultOf = (text: string) =>
        /process\.env\.ALLOWED_HOSTS \|\| "([^"]+)"/.exec(text)?.[1];
      const labelReOf = (text: string) =>
        /const MDNS_LABEL_RE = (\/[^\n;]+\/);/.exec(text)?.[1];

      expect(defaultOf(guardSource)).toBeDefined();
      expect(defaultOf(proxySource)).toBe(defaultOf(guardSource));
      expect(labelReOf(guardSource)).toBeDefined();
      expect(labelReOf(proxySource)).toBe(labelReOf(guardSource));
    });
  });

  describe("advertisedHostNames", () => {
    it("names the box's own names and the defaults, never the tunnel", async () => {
      const dir = path.join(tmpRoot, "data", "cloudflared");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "tunnel.url"), "https://calm-river-1234.trycloudflare.com");
      const guard = await loadGuard();

      const names = guard.advertisedHostNames();

      expect(names).toContain("clawbox.local");
      expect(names.some((name) => name.includes("trycloudflare"))).toBe(false);
      expect(new Set(names).size).toBe(names.length);
      // Whoever reads the 421 reached the box over the network; `localhost`
      // would send them to their own machine.
      expect(names).not.toContain("localhost");
    });
  });
});
