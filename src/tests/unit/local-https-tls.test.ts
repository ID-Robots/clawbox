import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import { createRequire } from "module";
import net from "net";
import os from "os";
import path from "path";
import tls from "tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { createCa, generatePrivateKeyPem } from "@/lib/local-https-x509";
import { DAY, HOST, OTHER_HOST, leafFor, testCa, writeStateFile, writeStubCa, writeTlsFile } from "@/tests/helpers/local-https";

/**
 * scripts/local-https.js — what production-server.js and the Hermes dashboard
 * proxy serve over TLS. Pinned: a Local HTTPS pair is served only while it is
 * the box's own name, inside its dates, matching its key and chaining to a
 * trusted root (the stub CA only in stub mode); the listener follows the files
 * and the clock; an owner's data/certs/ pair is served as before; one port can
 * carry HTTP and HTTPS side by side.
 */

const require_ = createRequire(import.meta.url);
type Lib = {
  LOCAL_HTTPS_ZONE: string;
  isLocalHttpsHostname: (v: unknown) => boolean;
  localHttpsHostname: (root?: string) => string | null;
  validateMaterial: (m: unknown, o: { now: number; roots: crypto.X509Certificate[] }) => { ok: boolean; reason?: string; notAfter?: number };
  loadLocalHttpsMaterial: (o: { root: string; now?: number }) => { ok: boolean; reason?: string; hostname?: string; key?: string };
  createLocalHttpsTls: (o: { root: string; legacyCertDir?: string; now?: () => number; log?: { warn: () => void } }) => {
    refresh: () => boolean;
    defaultOptions: () => { key: unknown; cert: unknown } | null;
    sniCallback: (name: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void;
    status: () => { hostname: string; notAfter: number; fingerprint256: string } | null;
  };
  createDualProtocolServer: (plain: http.Server, secure: () => https.Server | null) => net.Server;
  publishListener: (l: unknown) => void;
};
const lib = require_(path.resolve(process.cwd(), "scripts/local-https.js")) as Lib;
const quiet = { warn: () => {} };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "local-https-tls-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the hostname", () => {
  it("is exactly one label under lan.clawbox.com", () => {
    expect(lib.LOCAL_HTTPS_ZONE).toBe("lan.clawbox.com");
    expect(lib.isLocalHttpsHostname(HOST)).toBe(true);
    for (const bad of ["lan.clawbox.com", `a.b.lan.clawbox.com`, "x.clawbox.com", "UPPER.lan.clawbox.com", "-x.lan.clawbox.com", "x.lan.clawbox.com.evil.test", 42, null]) {
      expect(lib.isLocalHttpsHostname(bad)).toBe(false);
    }
  });

  it("is the box's own only while the owner has the feature on", () => {
    expect(lib.localHttpsHostname(root)).toBeNull();
    writeStateFile(root, { enabled: false, hostname: HOST });
    expect(lib.localHttpsHostname(root)).toBeNull();
    writeStateFile(root, { enabled: true, hostname: HOST });
    expect(lib.localHttpsHostname(root)).toBe(HOST);
    writeStateFile(root, { enabled: true, hostname: "evil.example.com" });
    expect(lib.localHttpsHostname(root)).toBeNull();
    fs.writeFileSync(path.join(root, "data", "local-https", "state.json"), "{not json");
    expect(lib.localHttpsHostname(root)).toBeNull();
  });
});

describe("validateMaterial", () => {
  const ca = testCa();
  const roots = [new crypto.X509Certificate(ca.certPem)];
  const now = Date.now();
  const verdict = (m: Record<string, unknown>, at = now) => lib.validateMaterial(m, { now: at, roots });

  it("accepts the box's own valid pair", () => {
    const leaf = leafFor(ca);
    const v = verdict({ hostname: HOST, key: leaf.keyPem, cert: leaf.chainPem });
    expect(v.ok).toBe(true);
    expect(v.notAfter).toBeGreaterThan(now);
  });

  it.each([
    ["another name", () => ({ hostname: HOST, ...pair(leafFor(ca, { hostname: OTHER_HOST })) }), "wrong_hostname"],
    ["a key that is not the leaf's", () => ({ hostname: HOST, key: generatePrivateKeyPem(), cert: leafFor(ca).chainPem }), "key_mismatch"],
    ["an expired leaf", () => ({ hostname: HOST, ...pair(leafFor(ca, { notBefore: now - 100 * DAY, notAfter: now - DAY })) }), "expired"],
    ["a leaf not valid yet", () => ({ hostname: HOST, ...pair(leafFor(ca, { notBefore: now + DAY, notAfter: now + 90 * DAY })) }), "not_yet_valid"],
    ["a chain from an unknown CA", () => ({ hostname: HOST, ...pair(leafFor(testCa("stranger"))) }), "untrusted"],
    ["a hostname outside the zone", () => ({ hostname: "x.example.com", ...pair(leafFor(ca)) }), "bad_hostname"],
    ["no key", () => ({ hostname: HOST, cert: leafFor(ca).chainPem }), "no_certificate"],
    ["garbage", () => ({ hostname: HOST, key: "nope", cert: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" }), "unreadable"],
  ])("refuses %s", (_label, make, reason) => {
    expect(verdict(make())).toEqual({ ok: false, reason });
  });

  it("refuses a CA certificate as the leaf", () => {
    const self = createCa(HOST, new Date(now - DAY), new Date(now + DAY));
    expect(verdict({ hostname: HOST, key: self.keyPem, cert: self.certPem }).reason).toBe("not_a_server_certificate");
  });

  it("refuses a chain whose links do not sign each other", () => {
    const leaf = leafFor(ca);
    const stranger = testCa("stranger");
    expect(verdict({ hostname: HOST, key: leaf.keyPem, cert: leaf.certPem + stranger.certPem }).reason).toBe("untrusted");
  });

  function pair(l: { keyPem: string; chainPem: string }) {
    return { key: l.keyPem, cert: l.chainPem };
  }
});

describe("loadLocalHttpsMaterial", () => {
  it("is off without the switch, and serves nothing for a pair left behind", () => {
    const ca = testCa();
    const leaf = leafFor(ca);
    writeTlsFile(root, { hostname: HOST, key: leaf.keyPem, cert: leaf.chainPem });
    expect(lib.loadLocalHttpsMaterial({ root })).toEqual({ ok: false, reason: "off" });
  });

  it("trusts the stub CA only while the state says the certificate came from the stub", () => {
    const ca = testCa();
    const leaf = leafFor(ca);
    writeStubCa(root, ca);
    writeTlsFile(root, { hostname: HOST, key: leaf.keyPem, cert: leaf.chainPem });
    writeStateFile(root, { enabled: true, hostname: HOST });
    expect(lib.loadLocalHttpsMaterial({ root }).reason).toBe("untrusted");
    writeStateFile(root, { enabled: true, hostname: HOST, stubPortal: true });
    const ok = lib.loadLocalHttpsMaterial({ root });
    expect(ok.ok).toBe(true);
    expect(ok.hostname).toBe(HOST);
    expect(ok.key).toBe(leaf.keyPem);
  });

  it("refuses a pair stored for another hostname than the state names", () => {
    const ca = testCa();
    const leaf = leafFor(ca, { hostname: OTHER_HOST });
    writeStubCa(root, ca);
    writeStateFile(root, { enabled: true, hostname: HOST, stubPortal: true });
    writeTlsFile(root, { hostname: OTHER_HOST, key: leaf.keyPem, cert: leaf.chainPem });
    expect(lib.loadLocalHttpsMaterial({ root }).reason).toBe("wrong_hostname");
    fs.rmSync(path.join(root, "data", "local-https", "tls.json"));
    expect(lib.loadLocalHttpsMaterial({ root }).reason).toBe("no_certificate");
  });
});

describe("createLocalHttpsTls", () => {
  function install(opts: { notAfter?: number } = {}) {
    const ca = testCa();
    const leaf = leafFor(ca, opts);
    writeStubCa(root, ca);
    writeStateFile(root, { enabled: true, hostname: HOST, stubPortal: true });
    writeTlsFile(root, { hostname: HOST, key: leaf.keyPem, cert: leaf.chainPem });
    return leaf;
  }

  it("has nothing to serve on a box without certificates", () => {
    const t = lib.createLocalHttpsTls({ root, legacyCertDir: path.join(root, "data", "certs"), log: quiet });
    expect(t.refresh()).toBe(false);
    expect(t.defaultOptions()).toBeNull();
    expect(t.status()).toBeNull();
    let error: Error | null = null;
    t.sniCallback(HOST, (err) => (error = err));
    expect(error).toBeInstanceOf(Error);
  });

  it("picks up a certificate that lands later, and drops it at its expiry without a file change", () => {
    let clock = Date.now();
    const t = lib.createLocalHttpsTls({ root, now: () => clock, log: quiet });
    t.refresh();
    expect(t.status()).toBeNull();
    const leaf = install({ notAfter: clock + 10 * 60_000 });
    expect(t.refresh()).toBe(true);
    expect(t.status()?.hostname).toBe(HOST);
    expect(t.defaultOptions()?.key).toBe(leaf.keyPem);
    expect(t.refresh()).toBe(false);
    clock += 11 * 60_000;
    expect(t.refresh()).toBe(true);
    expect(t.status()).toBeNull();
    expect(t.defaultOptions()).toBeNull();
  });

  it("stops serving the moment the owner switches the feature off", () => {
    install();
    const t = lib.createLocalHttpsTls({ root, log: quiet });
    t.refresh();
    expect(t.status()).not.toBeNull();
    writeStateFile(root, { enabled: false, hostname: null });
    expect(t.refresh()).toBe(true);
    expect(t.status()).toBeNull();
  });

  it("serves an owner's data/certs pair for other names, and the Local HTTPS one for its own", () => {
    install();
    const legacyDir = path.join(root, "data", "certs");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = createCa("clawbox.local", new Date(Date.now() - DAY), new Date(Date.now() + DAY));
    fs.writeFileSync(path.join(legacyDir, "cert.pem"), legacy.certPem);
    fs.writeFileSync(path.join(legacyDir, "key.pem"), legacy.keyPem);
    const t = lib.createLocalHttpsTls({ root, legacyCertDir: legacyDir, log: quiet });
    t.refresh();
    const contexts: (tls.SecureContext | undefined)[] = [];
    t.sniCallback(HOST, (_e, ctx) => contexts.push(ctx));
    t.sniCallback("clawbox.local", (_e, ctx) => contexts.push(ctx));
    expect(contexts[0]).toBeDefined();
    expect(contexts[1]).toBeDefined();
    expect(contexts[0]).not.toBe(contexts[1]);
    // The Local HTTPS pair is the default for a client that sends no SNI.
    expect(String(t.defaultOptions()?.cert)).toContain("BEGIN CERTIFICATE");
    expect(t.status()?.hostname).toBe(HOST);
  });
});

describe("createDualProtocolServer", () => {
  const servers: { close: () => void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function listen(withTls: boolean) {
    const ca = testCa();
    const leaf = leafFor(ca);
    const handler: http.RequestListener = (req, res) => {
      let n = 0;
      req.on("data", (c: Buffer) => (n += c.length));
      req.on("end", () => res.end(JSON.stringify({ bytes: n, tls: Boolean((req.socket as tls.TLSSocket).encrypted) })));
    };
    const plain = http.createServer(handler);
    const secure = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, handler);
    const wss = new WebSocketServer({ noServer: true });
    for (const s of [plain, secure]) {
      s.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (m) => ws.send(`echo:${m}`))));
    }
    const front = lib.createDualProtocolServer(plain, () => (withTls ? secure : null));
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    servers.push(front, { close: () => wss.close() });
    return { port: (front.address() as net.AddressInfo).port, ca: ca.certPem };
  }

  function request(mod: typeof http | typeof https, opts: https.RequestOptions, body?: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = mod.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it("answers plain HTTP and TLS on the same port, bodies and keep-alive included", async () => {
    const { port, ca } = await listen(true);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const sagent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect(JSON.parse(await request(http, { host: "127.0.0.1", port, path: "/", agent }))).toEqual({ bytes: 0, tls: false });
      expect(JSON.parse(await request(http, { host: "127.0.0.1", port, path: "/", method: "POST", agent }, Buffer.alloc(2_000_000, 1)))).toEqual({ bytes: 2_000_000, tls: false });
      const tlsOpts = { host: "127.0.0.1", port, path: "/", servername: HOST, ca, agent: sagent };
      expect(JSON.parse(await request(https, tlsOpts))).toEqual({ bytes: 0, tls: true });
      expect(JSON.parse(await request(https, { ...tlsOpts, method: "POST" }, Buffer.alloc(2_000_000, 2)))).toEqual({ bytes: 2_000_000, tls: true });
    } finally {
      agent.destroy();
      sagent.destroy();
    }
  });

  it("carries WebSocket upgrades on both", async () => {
    const { port, ca } = await listen(true);
    for (const [url, extra] of [[`ws://127.0.0.1:${port}/x`, {}], [`wss://127.0.0.1:${port}/x`, { ca, servername: HOST }]] as const) {
      const ws = new WebSocket(url, extra);
      const got = await new Promise<string>((resolve, reject) => {
        ws.on("open", () => ws.send("hi"));
        ws.on("message", (m) => resolve(String(m)));
        ws.on("error", reject);
      });
      ws.close();
      expect(got).toBe("echo:hi");
    }
  });

  it("closes a TLS handshake when there is no certificate, and still answers HTTP", async () => {
    const { port, ca } = await listen(false);
    await expect(request(https, { host: "127.0.0.1", port, path: "/", servername: HOST, ca })).rejects.toThrow();
    expect(JSON.parse(await request(http, { host: "127.0.0.1", port, path: "/" }))).toEqual({ bytes: 0, tls: false });
  });
});

describe("publishListener", () => {
  it("puts the listener where src/lib/local-https-listener.ts reads it", async () => {
    const key = Symbol.for("clawbox.local-https.listener");
    const before = (globalThis as Record<symbol, unknown>)[key];
    try {
      const status = { hostname: HOST, notBefore: 1, notAfter: Date.now() + DAY, fingerprint256: "AA" };
      let refreshed = 0;
      lib.publishListener({ status: () => status, port: 8443, refresh: () => (refreshed += 1) });
      const listener = await import("@/lib/local-https-listener");
      expect(listener.localHttpsServing()).toEqual(status);
      expect(listener.localHttpsPort()).toBe(8443);
      expect(listener.localHttpsUrl(HOST)).toBe(`https://${HOST}:8443`);
      listener.refreshLocalHttpsListener();
      expect(refreshed).toBe(1);
    } finally {
      (globalThis as Record<symbol, unknown>)[key] = before;
    }
  });

  it("reads as not serving when nothing was published", async () => {
    const key = Symbol.for("clawbox.local-https.listener");
    const before = (globalThis as Record<symbol, unknown>)[key];
    try {
      delete (globalThis as Record<symbol, unknown>)[key];
      const listener = await import("@/lib/local-https-listener");
      expect(listener.localHttpsServing()).toBeNull();
      expect(listener.localHttpsPort()).toBe(443);
      expect(listener.localHttpsUrl(HOST)).toBe(`https://${HOST}`);
      expect(() => listener.refreshLocalHttpsListener()).not.toThrow();
    } finally {
      (globalThis as Record<symbol, unknown>)[key] = before;
    }
  });
});

