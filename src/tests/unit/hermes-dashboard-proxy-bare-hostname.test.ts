import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import { createSessionCookie } from "@/lib/auth";

/**
 * TASK-808 — the box reached by its OWN BARE HOSTNAME.
 *
 * The desktop's Hermes tile builds its URL from the page it is on
 * (`${location.protocol}//${location.hostname}:8090/`, src/app/page.tsx and
 * src/app/app/[id]/page.tsx), so the Host the proxy sees is whatever name the
 * owner typed. A router that registers the DHCP hostname — or a LAN with a DNS
 * search domain — hands them `http://clawbox/`, the box's own hostname with no
 * suffix. The desktop serves fine there; the tile answered
 * `403 Forbidden (bad Host header).` because the guard admitted `<label>.local`,
 * a raw IP and four literals in ALLOWED_HOSTS, and a bare label was none of
 * those.
 *
 * What is pinned here:
 *   - the box's own bare hostname is admitted, on HTTP and on the WS upgrade
 *     (separate rejection paths — a dashboard that loads and then sits dead is
 *     the same bug half-fixed);
 *   - it is re-derived per request, so `Settings → System → rename` is followed
 *     without restarting this service. Nothing restarts it on a rename, so a
 *     name cached for the process lifetime would 403 the NEW hostname until the
 *     next reboot — and it is the guard's only source for a bare name;
 *   - the guard is not simply open: a bare label that is NOT this box's
 *     hostname is still refused, because a single label can be pointed at this
 *     box by a search domain or a hosts file nobody here controls.
 *
 * Scaffolding shape (module-cache bust, env snapshot, session cookie, upgrade
 * fixture) follows hermes-dashboard-proxy-renamed-host.test.ts, which owns the
 * `<name>.local` half of the same guard.
 */

const require_ = createRequire(import.meta.url);
const SCRIPT = path.resolve(process.cwd(), "scripts/hermes-dashboard-proxy.js");

/**
 * The proxy reads the box's identity from `os.hostname()`. `require("os")` in
 * the script and this handle are the same module object, so assigning here is
 * what a rename looks like from inside the process. Restored in afterEach.
 *
 * This depends on the script keeping its `const os = require("os")` style: a
 * NAMED import (`import { hostname } from "os"`) is a live binding the stub
 * cannot reach, and these tests would then fail rather than pass wrongly.
 */
const osModule = require_("node:os") as { hostname: () => string };
const realHostname = osModule.hostname;

const SESSION_SECRET = "test-session-secret-for-proxy-bare-host";
/** The box's hostname. `http://clawbox/` in the field; a distinct name here so no pass can come from a default. */
const BOX = "krasi-workshop";
/** The box after a rename, before anything restarts this service. */
const RENAMED_BOX = "kitchen";
/** A single label that is NOT this box — what a search domain could point here. */
const FOREIGN_LABEL = "intranet";

function sessionCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET)}; hermes_session_at=stub`;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

function close(server?: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

interface Reply {
  status: number;
  body: string;
  location?: string;
}

function request(port: number, headers: Record<string, string>, urlPath = "/"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          location: res.headers.location,
        }),
      );
    });
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error("proxy never responded"));
    });
    req.on("error", reject);
    req.end();
  });
}

let upstream: http.Server;
let upstreamPort: number;
let proxy: http.Server | undefined;
let proxyPort: number;
/** Upgrade sockets the fixture answered; destroyed in afterEach. */
const upgraded: Duplex[] = [];

// The last two are not set by startProxy(): the assertions below depend on their
// DEFAULTS (`http://<BOX>/login` needs CLAWBOX_WEB_PORT 80, and the port test
// sets HERMES_DASH_PROXY_PORT itself), so they are snapshotted and restored too.
const ENV_KEYS = [
  "SESSION_SECRET",
  "ALLOWED_HOSTS",
  "CLAWBOX_ROOT",
  "HERMES_DASH_HOST",
  "HERMES_PORT",
  "HERMES_DASH_PROXY_PORT",
  "CLAWBOX_WEB_PORT",
] as const;
const envBefore = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of ENV_KEYS) envBefore.set(key, process.env[key]);
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("dashboard ok");
  });
  upstream.on("upgrade", (_req, socket) => {
    upgraded.push(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  upstreamPort = await listen(upstream);
});

afterAll(async () => {
  await close(upstream);
});

afterEach(async () => {
  // An UPGRADED socket is detached from the server's connection tracking, so
  // closeAllConnections() cannot reach it and close() would wait on it forever.
  while (upgraded.length) upgraded.pop()!.destroy();
  await close(proxy);
  proxy = undefined;
  osModule.hostname = realHostname;
  for (const [key, value] of envBefore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function startProxy(extraEnv: Record<string, string> = {}): Promise<void> {
  delete process.env.HERMES_DASH_PROXY_PORT;
  delete process.env.CLAWBOX_WEB_PORT;
  Object.assign(process.env, {
    SESSION_SECRET,
    // Holds neither name used below: the guard has to derive the box's own
    // hostname, not read it from a list written at install time.
    ALLOWED_HOSTS: "localhost",
    CLAWBOX_ROOT: path.join(process.cwd(), "nonexistent-proxy-bare-host-root"),
    HERMES_DASH_HOST: "127.0.0.1",
    HERMES_PORT: String(upstreamPort),
    ...extraEnv,
  });
  delete require_.cache[require_.resolve(SCRIPT)];
  const mod = require_(SCRIPT) as { createProxyServer: () => http.Server };
  proxy = mod.createProxyServer();
  proxyPort = await listen(proxy);
}

/** Drive a raw WebSocket upgrade through the proxy and collect what comes back. */
function attemptUpgrade(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(
        [
          "GET /ws HTTP/1.1",
          `Host: ${host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          // A browser always sends one on a WS handshake, and without it
          // `checkRequestOrigin` takes its bare-navigation branch — so the
          // upgrade would pass without the peer check ever running.
          `Origin: http://${host}`,
          `Cookie: ${sessionCookie()}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    let text = "";
    socket.on("data", (c) => {
      text += c.toString();
      if (text.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("upgrade hung — proxy never answered or closed"));
    });
  });
}

describe("hermes dashboard proxy — the box's own bare hostname", () => {
  it("serves the dashboard on the bare hostname with a valid session", async () => {
    osModule.hostname = () => BOX;
    await startProxy();
    const res = await request(proxyPort, { host: BOX, cookie: sessionCookie() });
    expect(res.status).toBe(200);
    expect(res.body).toBe("dashboard ok");
  });

  it("sends an unauthenticated visitor to the login page on the bare hostname", async () => {
    osModule.hostname = () => BOX;
    await startProxy();
    const res = await request(proxyPort, { host: BOX });
    // Not 403: the host guard passed, so what the owner meets is the login
    // page — on the name they typed, which is the only one they can resolve.
    expect(res.status).toBe(302);
    expect(res.location).toBe(`http://${BOX}/login`);
  });

  it("accepts a Referer from the desktop on the bare hostname", async () => {
    // How the tile actually arrives: a top-level navigation from the ClawBox
    // desktop on :80, carrying no Origin and `Referer: http://<host>/`.
    osModule.hostname = () => BOX;
    await startProxy();
    const res = await request(proxyPort, {
      host: BOX,
      referer: `http://${BOX}/`,
      cookie: sessionCookie(),
    });
    expect(res.status).toBe(200);
  });

  it("accepts a WebSocket upgrade on the bare hostname", async () => {
    // The leg that matters most in service: the dashboard's live traffic is
    // WebSocket and handleUpgrade() owns its own 403 path.
    osModule.hostname = () => BOX;
    await startProxy();
    expect(await attemptUpgrade(BOX)).toContain("101 Switching Protocols");
  });

  it("follows a rename with no restart, and stops answering for the old name", async () => {
    osModule.hostname = () => BOX;
    await startProxy();
    expect((await request(proxyPort, { host: BOX, cookie: sessionCookie() })).status).toBe(200);

    // Settings → System → rename: data/hostname.env plus the set_hostname root
    // step, which ends in `hostnamectl set-hostname`. Nothing restarts this
    // service, so the guard must re-read the name rather than cache it.
    osModule.hostname = () => RENAMED_BOX;
    const renamed = await request(proxyPort, { host: RENAMED_BOX, cookie: sessionCookie() });
    expect(renamed.status).toBe(200);
    const stale = await request(proxyPort, { host: BOX, cookie: sessionCookie() });
    expect(stale.status).toBe(403);
    expect(stale.body).toContain("bad Host header");
  });

  it("still refuses a bare label that is not this box, on both legs", async () => {
    // A single label is not proof of this box: a DNS search domain or a hosts
    // file can aim one here. Admitting every label would be a rebind hole.
    osModule.hostname = () => BOX;
    await startProxy();
    const res = await request(proxyPort, { host: FOREIGN_LABEL, cookie: sessionCookie() });
    expect(res.status).toBe(403);
    expect(res.body).toContain("bad Host header");
    expect(await attemptUpgrade(FOREIGN_LABEL)).toContain("403 Forbidden");
  });

  it("still refuses a DNS-rebind name, so the guard has not simply been opened", async () => {
    osModule.hostname = () => BOX;
    await startProxy();
    const res = await request(proxyPort, { host: "attacker.example.com", cookie: sessionCookie() });
    expect(res.status).toBe(403);
    expect(res.body).toContain("bad Host header");
  });

  it("admits the tile's own request shape: bare hostname with the proxy port, referred from the desktop", async () => {
    // What the browser really sends for the tile's URL — `Host: clawbox:8090`
    // AND `Referer: http://clawbox/`, the desktop it was clicked on. Asserted
    // together because that combination is the one isTrustedPeer() has to rate
    // on the web-server port rather than on the Host's own.
    osModule.hostname = () => BOX;
    await startProxy();
    const res = await request(proxyPort, {
      host: `${BOX}:8090`,
      referer: `http://${BOX}/`,
      cookie: sessionCookie(),
    });
    expect(res.status).toBe(200);
  });

  it("keeps the port guard usable when HERMES_DASH_PROXY_PORT is junk", async () => {
    // PORT is compared against the Referer's port in isTrustedPeer(), so a bad
    // value costs the guard a comparison as well as the socket: `parseInt`
    // accepted "70000" — a port Node refuses — and then matched no referer.
    // envPort() falls back to 8090, which is what this Referer carries.
    osModule.hostname = () => BOX;
    await startProxy({ HERMES_DASH_PROXY_PORT: "70000" });
    const res = await request(proxyPort, {
      host: BOX,
      referer: `http://${BOX}:8090/`,
      cookie: sessionCookie(),
    });
    expect(res.status).toBe(200);
  });
});
