// @vitest-environment node
import { createRequire } from "module";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * TASK-1478 — the serving half of public app links, attacked for real: the
 * actual listener (scripts/public-app-links.js) in front of an actual HTTP
 * "app", with a second server standing in for the rest of the box. Nothing
 * here is mocked below the socket.
 */
const require_ = createRequire(import.meta.url);
const links = require_("../../../scripts/public-app-links.js") as {
  COOKIE_NAME: string;
  BAD_TOKEN_PER_VISITOR: number;
  linkPaths: (root: string) => { dir: string; links: string; runtime: string; audit: string };
  validLink: (raw: unknown) => unknown;
  canonicalTarget: (url: string) => { path: string; search: string } | null;
  methodAllowed: (link: { apiAllow: string[]; apiReadOnly?: boolean }, method: string, rest: string) => boolean;
  appCookies: (header: string | undefined) => string | null;
  rewriteLocation: (location: string, port: number) => string;
  createLinkServer: (id: string, opts: Record<string, unknown>) => http.Server;
  startPublicAppLinks: (opts: Record<string, unknown>) => { reconcile: () => void; stop: () => void; entries: Map<string, { port: number | null; url: string | null; state: string }> };
};

const TOKEN = "A".repeat(43);
const OTHER_TOKEN = "B".repeat(43);
const LINK_ID = "0123456789abcdef";
const APP = "notes";

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

let root: string;
let appServer: http.Server;
let appPort: number;
let seen: Seen[];
let linkServer: http.Server;
let linkPort: number;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

function writeLinks(list: unknown[]) {
  const p = links.linkPaths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  // A fresh inode every time, as the owner's atomic rename produces.
  fs.writeFileSync(`${p.links}.tmp`, JSON.stringify({ version: 1, links: list }));
  fs.renameSync(`${p.links}.tmp`, p.links);
}

function link(over: Record<string, unknown> = {}) {
  return { id: LINK_ID, appId: APP, mode: "permanent", token: TOKEN, createdAt: 1, expiresAt: null, apiAllow: [], ...over };
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function ask(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string; cookie?: boolean; https?: boolean; port?: number } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.https !== false) headers["x-forwarded-proto"] = "https";
    if (opts.cookie !== false && !("cookie" in headers)) headers.cookie = `${links.COOKIE_NAME}=${TOKEN}`;
    const req = http.request({ host: "127.0.0.1", port: opts.port ?? linkPort, method: opts.method ?? "GET", path: pathname, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

beforeAll(async () => {
  seen = [];
  appServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf-8") });
      if (req.url === `/apps/${APP}/redirect`) {
        res.writeHead(302, { location: `http://127.0.0.1:${appPort}/apps/${APP}/landed?x=1` });
        return res.end();
      }
      if (req.url === `/apps/${APP}/cookies`) {
        res.writeHead(200, { "set-cookie": ["app_pref=1; Path=/", `${links.COOKIE_NAME}=stolen; Path=/`, "clawbox_session=forged; Path=/"], "content-type": "text/plain" });
        return res.end("ok");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`app:${req.method}:${req.url}`);
    });
  });
  appPort = await listen(appServer);
});

afterAll(async () => {
  await new Promise((r) => appServer.close(r));
});

beforeEach(async () => {
  seen.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "public-links-"));
  fs.mkdirSync(path.join(root, "data", "webapps", APP), { recursive: true });
  writeLinks([link()]);
  linkServer = links.createLinkServer(LINK_ID, {
    root,
    resolveApp: (_root: string, id: string) => (id === APP ? { id, port: appPort, strip: false } : null),
  });
  linkPort = await listen(linkServer);
});

afterEach(async () => {
  linkServer.closeAllConnections?.();
  await new Promise((r) => linkServer.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the link's secret", () => {
  it("answers 404 to a visitor with no token, and nothing reaches the app", async () => {
    const res = await ask(`/apps/${APP}/`, { cookie: false });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("answers 404 to a wrong token and to a wrong cookie", async () => {
    expect((await ask(`/apps/${APP}/?k=${OTHER_TOKEN}`, { cookie: false })).status).toBe(404);
    expect((await ask(`/apps/${APP}/`, { headers: { cookie: `${links.COOKIE_NAME}=${OTHER_TOKEN}` } })).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("answers 404, and keeps running, for a token of the right length with a multibyte character", async () => {
    const odd = `${TOKEN.slice(0, 42)}é`;
    expect((await ask(`/apps/${APP}/?k=${encodeURIComponent(odd)}`, { cookie: false })).status).toBe(404);
    expect((await ask(`/apps/${APP}/`, { headers: { cookie: `${links.COOKIE_NAME}=${odd}` } })).status).toBe(404);
    expect((await ask(`/apps/${APP}/`)).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("exchanges ?k= for a host-only Secure HttpOnly cookie and redirects the token out of the URL", async () => {
    const res = await ask(`/apps/${APP}/?k=${TOKEN}&tab=2`, { cookie: false });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/apps/${APP}/?tab=2`);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain(`${links.COOKIE_NAME}=${TOKEN}`);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(seen).toHaveLength(0);
  });

  it("locks a visitor out after repeated wrong tokens — even with the right one", async () => {
    for (let i = 0; i < links.BAD_TOKEN_PER_VISITOR; i += 1) {
      expect((await ask(`/apps/${APP}/?k=${OTHER_TOKEN}`, { cookie: false })).status).toBe(404);
    }
    const res = await ask(`/apps/${APP}/`);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
  });

  it("refuses plain HTTP", async () => {
    const res = await ask(`/apps/${APP}/`, { https: false });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe("what a visitor with the link can reach", () => {
  it("the app's own pages, with neither the link cookie nor any ClawBox session forwarded", async () => {
    const res = await ask(`/apps/${APP}/page?x=1`, { headers: { cookie: `${links.COOKIE_NAME}=${TOKEN}; clawbox_session=abc.def; theme=dark` } });
    expect(res.status).toBe(200);
    expect(res.body).toBe(`app:GET:/apps/${APP}/page?x=1`);
    expect(seen[0].headers.cookie).toBe("theme=dark");
    expect(seen[0].headers.host).toBe(`127.0.0.1:${appPort}`);
    expect(seen[0].headers["x-clawbox-public-link"]).toBe("1");
    expect(JSON.stringify(seen[0].headers)).not.toContain(TOKEN);
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it.each([
    "/",
    "/login",
    "/setup-api/preferences?all=1",
    "/setup-api/files/list",
    "/setup-api/apps/public-link",
    "/setup-api/webapps?app=other",
    "/api/status",
    "/apps/other/",
    "/apps/other/index.html",
    `/apps/${APP}x/`,
    "/terminal-ws",
    "/_next/static/chunks/main.js",
    "/assets/index.js",
  ])("nothing of the box: %s", async (target) => {
    const res = await ask(target);
    // "/" is sent to the app's own base path; everything else is refused.
    if (target === "/") {
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/apps/${APP}/`);
    } else {
      expect(res.status).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it.each([
    `/apps/${APP}/../other/`,
    `/apps/${APP}/..%2fother/`,
    `/apps/${APP}/%2e%2e/other/`,
    `/apps/${APP}/%2E%2E%2Fother`,
    `/apps/${APP}//api/x`,
    `/apps/${APP}/a\\..\\b`,
    `/apps/${APP}/api;x/secret`,
    `/apps/${APP}/%00`,
    `/apps/${APP}/./api/x`,
    `//evil.example/apps/${APP}/`,
  ])("no traversal or ambiguous path: %s", async (target) => {
    // Raw socket: http.request would normalise some of these away.
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(linkPort, "127.0.0.1", () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nX-Forwarded-Proto: https\r\nCookie: ${links.COOKIE_NAME}=${TOKEN}\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (c) => { data += String(c); });
      socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
      socket.on("error", reject);
    });
    expect([400, 404]).toContain(status);
    expect(seen).toHaveLength(0);
  });

  it("refuses the app's /api tree and every write by default", async () => {
    expect((await ask(`/apps/${APP}/api/notes`)).status).toBe(403);
    expect((await ask(`/apps/${APP}/API/notes`)).status).toBe(403);
    expect((await ask(`/apps/${APP}/api`)).status).toBe(403);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await ask(`/apps/${APP}/page`, { method, body: method === "OPTIONS" ? undefined : "x" })).status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("opens exactly the API prefixes the owner allow-listed", async () => {
    writeLinks([link({ apiAllow: ["/api/scores"] })]);
    const post = await ask(`/apps/${APP}/api/scores`, { method: "POST", body: "{\"n\":1}", headers: { "content-type": "application/json" } });
    expect(post.status).toBe(200);
    expect(seen[0].body).toBe("{\"n\":1}");
    expect((await ask(`/apps/${APP}/api/scores/top`)).status).toBe(200);
    expect((await ask(`/apps/${APP}/api/scoresx`)).status).toBe(403);
    expect((await ask(`/apps/${APP}/api/notes`)).status).toBe(403);
    expect((await ask(`/apps/${APP}/page`, { method: "POST", body: "x" })).status).toBe(403);
  });

  it("refuses an oversized body", async () => {
    writeLinks([link({ apiAllow: ["/api/up"] })]);
    const res = await ask(`/apps/${APP}/api/up`, { method: "POST", headers: { "content-length": String(11 * 1024 * 1024) } }).catch(() => ({ status: 413 }));
    expect(res.status).toBe(413);
  });

  it("refuses WebSocket upgrades", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(linkPort, "127.0.0.1", () => {
        socket.write(`GET /apps/${APP}/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-Proto: https\r\nCookie: ${links.COOKIE_NAME}=${TOKEN}\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (c) => { data += String(c); });
      socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
      socket.on("error", reject);
    });
    expect(status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("keeps the app's own cookies, drops a forged link or session cookie, and hides the loopback address in redirects", async () => {
    const cookies = await ask(`/apps/${APP}/cookies`);
    expect(cookies.headers["set-cookie"]).toEqual(["app_pref=1; Path=/"]);
    const redirect = await ask(`/apps/${APP}/redirect`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(`/apps/${APP}/landed?x=1`);
  });
});

describe("revocation and expiry are the server's", () => {
  it("a disabled link is gone on the very next request", async () => {
    expect((await ask(`/apps/${APP}/`)).status).toBe(200);
    writeLinks([]);
    const res = await ask(`/apps/${APP}/`);
    expect(res.status).toBe(410);
    expect((await ask(`/apps/${APP}/?k=${TOKEN}`, { cookie: false })).status).toBe(410);
  });

  it("an app whose folder is gone is not served", async () => {
    fs.rmSync(path.join(root, "data", "webapps", APP), { recursive: true, force: true });
    expect((await ask(`/apps/${APP}/`)).status).toBe(410);
    expect(seen).toHaveLength(0);
  });

  it("a re-created link for the same app does not revive the old token", async () => {
    writeLinks([link({ id: "fedcba9876543210", token: OTHER_TOKEN })]);
    expect((await ask(`/apps/${APP}/`)).status).toBe(410);
  });

  it("a temporary link stops at its expiry, with no timer involved", async () => {
    let now = 1_000_000;
    const server = links.createLinkServer(LINK_ID, { root, now: () => now, resolveApp: () => ({ id: APP, port: appPort, strip: false }) });
    const port = await listen(server);
    try {
      writeLinks([link({ mode: "temporary", expiresAt: 1_060_000 })]);
      expect((await ask(`/apps/${APP}/`, { port })).status).toBe(200);
      const exchange = await ask(`/apps/${APP}/?k=${TOKEN}`, { port, cookie: false });
      expect(String(exchange.headers["set-cookie"])).toMatch(/Max-Age=60\b/);
      now = 1_060_000;
      expect((await ask(`/apps/${APP}/`, { port })).status).toBe(410);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("an unreadable or malformed list serves nothing", async () => {
    fs.writeFileSync(links.linkPaths(root).links, "{not json");
    expect((await ask(`/apps/${APP}/`)).status).toBe(410);
    writeLinks([link({ token: "short" })]);
    expect((await ask(`/apps/${APP}/`)).status).toBe(410);
  });
});

describe("a one-file webapp", () => {
  let staticServer: http.Server;
  let port: number;
  beforeEach(async () => {
    const dir = path.join(root, "data", "webapps", APP);
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>static</h1>");
    fs.writeFileSync(path.join(dir, "app.js"), "1");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: "Notes" }));
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(root, "data", "config.json"), "{\"secret\":true}");
    fs.symlinkSync(path.join(root, "data", "config.json"), path.join(dir, "leak.json"));
    fs.mkdirSync(path.join(root, "data", "webapps", "other"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "webapps", "other", "index.html"), "other");
    staticServer = links.createLinkServer(LINK_ID, { root, resolveApp: () => null });
    port = await listen(staticServer);
  });
  afterEach(async () => { await new Promise((r) => staticServer.close(r)); });

  it("serves its own files and nothing else", async () => {
    const index = await ask("/", { port });
    expect(index.status).toBe(200);
    expect(index.body).toBe("<h1>static</h1>");
    expect((await ask("/app.js", { port })).status).toBe(200);
    for (const target of ["/meta.json", "/.env", "/leak.json", "/nope.html", "/apps/other/", "/setup-api/webapps?app=other", "/index.html/"]) {
      expect((await ask(target, { port })).status, target).toBe(404);
    }
    expect((await ask("/", { port, method: "POST", body: "x" })).status).toBe(405);
  });

  it("does not serve a server app's stub while its server is down", async () => {
    fs.writeFileSync(path.join(root, "data", "webapps", APP, "meta.json"), JSON.stringify({ name: "Notes", port: 4321 }));
    expect((await ask("/", { port })).status).toBe(502);
  });
});

describe("the policy functions", () => {
  it("canonicalTarget", () => {
    expect(links.canonicalTarget("/apps/a/x?y=1")).toEqual({ path: "/apps/a/x", search: "?y=1" });
    expect(links.canonicalTarget("/apps/a/")).toEqual({ path: "/apps/a/", search: "" });
    for (const bad of ["apps/a", "/a/../b", "/a//b", "/a/%2e%2e/b", "/a/%2Fb", "/a\\b", "/a;b", "/a/%zz", `/apps/${APP}/%61pi/notes`, "/a/%7e", `/${"a".repeat(5000)}`]) {
      expect(links.canonicalTarget(bad), bad).toBeNull();
    }
  });

  it("methodAllowed", () => {
    const closed = { apiAllow: [] };
    expect(links.methodAllowed(closed, "GET", "/")).toBe(true);
    expect(links.methodAllowed(closed, "HEAD", "/assets/a.js")).toBe(true);
    expect(links.methodAllowed(closed, "GET", "/api/x")).toBe(false);
    expect(links.methodAllowed(closed, "POST", "/")).toBe(false);
    expect(links.methodAllowed(closed, "TRACE", "/")).toBe(false);
    const open = { apiAllow: ["/api/a/"] };
    expect(links.methodAllowed(open, "DELETE", "/api/a/1")).toBe(true);
    expect(links.methodAllowed(open, "GET", "/api/a")).toBe(true);
    expect(links.methodAllowed(open, "GET", "/api/ab")).toBe(false);
    // Read-only: the listed prefixes answer GET/HEAD and nothing else.
    const readOnly = { apiAllow: ["/api"], apiReadOnly: true };
    expect(links.methodAllowed(readOnly, "GET", "/api/a")).toBe(true);
    expect(links.methodAllowed(readOnly, "HEAD", "/api/a")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(links.methodAllowed(readOnly, method, "/api/a"), method).toBe(false);
    expect(links.methodAllowed(readOnly, "POST", "/page")).toBe(false);
  });

  it("validLink refuses anything malformed", () => {
    expect(links.validLink(link())).not.toBeNull();
    expect(links.validLink(link({ mode: "temporary", expiresAt: 5 }))).not.toBeNull();
    expect((links.validLink(link()) as { apiReadOnly: boolean }).apiReadOnly).toBe(false);
    expect((links.validLink(link({ apiReadOnly: true })) as { apiReadOnly: boolean }).apiReadOnly).toBe(true);
    for (const bad of [null, link({ id: "x" }), link({ appId: "../x" }), link({ mode: "forever" }), link({ mode: "temporary" }), link({ expiresAt: 5 }), link({ token: "abc" }), link({ apiAllow: ["api"] }), link({ apiAllow: ["/a/../b"] }), link({ apiAllow: "x" }), link({ apiReadOnly: "yes" })]) {
      expect(links.validLink(bad)).toBeNull();
    }
  });

  it("appCookies and rewriteLocation", () => {
    expect(links.appCookies(`${links.COOKIE_NAME}=x`)).toBeNull();
    expect(links.appCookies(`a=1; ${links.COOKIE_NAME}=x; b=2`)).toBe("a=1; b=2");
    expect(links.rewriteLocation("http://127.0.0.1:4000/apps/a/x", 4000)).toBe("/apps/a/x");
    expect(links.rewriteLocation("http://127.0.0.1:5000/x", 4000)).toBe("http://127.0.0.1:5000/x");
    expect(links.rewriteLocation("/apps/a/x", 4000)).toBe("/apps/a/x");
  });
});

describe("the supervisor", () => {
  class FakeTunnel extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    exitCode: number | null = null;
    killed: string[] = [];
    kill(signal: string) {
      this.killed.push(signal);
      this.exitCode = 0;
      this.emit("exit", 0);
      return true;
    }
  }

  async function until(check: () => boolean) {
    for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  }

  it("runs one loopback listener and one tunnel per live link; on disable answers 410, then tears both down", async () => {
    const tunnels: { tunnel: FakeTunnel; port: number; config: string }[] = [];
    const sup = links.startPublicAppLinks({
      root,
      pollMs: 20,
      goneGraceMs: 400,
      resolveApp: () => ({ id: APP, port: appPort, strip: false }),
      spawnTunnel: (port: number, config: string) => {
        const tunnel = new FakeTunnel();
        tunnels.push({ tunnel, port, config });
        return tunnel;
      },
    });
    try {
      await until(() => tunnels.length === 1);
      expect(fs.readFileSync(tunnels[0].config, "utf-8")).toBe("{}\n");
      tunnels[0].tunnel.stderr.emit("data", Buffer.from("INF |  https://calm-river-test-words.trycloudflare.com  |"));
      const runtimeFile = links.linkPaths(root).runtime;
      await until(() => JSON.parse(fs.readFileSync(runtimeFile, "utf-8"))[LINK_ID]?.state === "live");
      expect(JSON.parse(fs.readFileSync(runtimeFile, "utf-8"))[LINK_ID].url).toBe("https://calm-river-test-words.trycloudflare.com");
      expect((fs.statSync(runtimeFile).mode & 0o777)).toBe(0o600);
      // The tunnel's listener is loopback, and serves the link.
      expect((await ask(`/apps/${APP}/`, { port: tunnels[0].port })).status).toBe(200);

      writeLinks([]);
      // During the grace the address stays and says the link is gone.
      expect((await ask(`/apps/${APP}/`, { port: tunnels[0].port })).status).toBe(410);
      await until(() => !(LINK_ID in JSON.parse(fs.readFileSync(runtimeFile, "utf-8"))));
      expect(tunnels[0].tunnel.killed).toHaveLength(0);
      expect((await ask(`/apps/${APP}/`, { port: tunnels[0].port })).status).toBe(410);
      await until(() => tunnels[0].tunnel.killed.includes("SIGTERM"));
      await expect(ask(`/apps/${APP}/`, { port: tunnels[0].port })).rejects.toThrow();
      const auditLog = fs.readFileSync(links.linkPaths(root).audit, "utf-8");
      expect(auditLog).toContain("\"published\"");
      expect(auditLog).toContain("\"tunnel_stopped\"");
      expect(auditLog).not.toContain(TOKEN);
    } finally {
      sup.stop();
    }
  });

  it("stops the tunnel of a temporary link when it expires and never starts an expired one", async () => {
    const tunnels: FakeTunnel[] = [];
    writeLinks([link({ mode: "temporary", expiresAt: Date.now() + 150 }), link({ id: "aaaaaaaaaaaaaaaa", appId: "old", mode: "temporary", expiresAt: Date.now() - 1 })]);
    const sup = links.startPublicAppLinks({ root, pollMs: 20, goneGraceMs: 0, spawnTunnel: () => { const t = new FakeTunnel(); tunnels.push(t); return t; } });
    try {
      await until(() => tunnels.length === 1);
      await until(() => tunnels[0].killed.includes("SIGTERM"));
      expect(tunnels).toHaveLength(1);
      expect(sup.entries.size).toBe(0);
    } finally {
      sup.stop();
    }
  });
});
