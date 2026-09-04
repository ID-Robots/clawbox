import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import { createSessionCookie } from "@/lib/auth";

/**
 * TASK-553 — does the Hermes dashboard proxy need its own allowed-origins
 * update after a hostname rename? No. This suite is the answer, written down
 * as a test so it stays true.
 *
 * On OpenClaw a rename rewrites `gateway.controlUi.allowedOrigins` and
 * restarts the gateway (src/app/setup-api/system/hostname/route.ts). Nothing
 * equivalent runs on Hermes, and nothing needs to:
 *
 *   - Hermes 0.20.5 has no allowed-origins list to update. Its dashboard guard
 *     (`_ws_host_origin_reason` in hermes_cli/web_server.py, read on a v0.20.5
 *     device 2026-09-04) compares Host and Origin against
 *     `app.state.bound_host` — the address the dashboard was bound to — and
 *     takes no configuration. ClawBox binds it to 127.0.0.2 and the proxy
 *     rewrites Host/Origin/Referer to that authority, so the box's LAN name
 *     never reaches Hermes at all.
 *   - The proxy's own guard (scripts/hermes-dashboard-proxy.js,
 *     `isAllowedHostname`) accepts ANY well-formed `<label>.local` and any raw
 *     IP literal, so it needs no list either — a renamed box is accepted the
 *     moment it is renamed, with no restart and no config write. That generic
 *     rule also SUBSUMES the cached `systemMdnsHost()` branch above it: every
 *     non-null value that branch can return is a `<label>.local` the generic
 *     rule accepts anyway, so the process-lifetime cache decides no request and
 *     cannot go stale into a lockout. The cache is not a fast path worth
 *     keeping — deleting the generic rule and keeping it would break every
 *     renamed box.
 *
 * What is pinned here is that second property, which nothing tested before:
 * `ALLOWED_HOSTS` below deliberately holds neither name used in the requests.
 * Both legs are covered — HTTP and the WS upgrade share `checkRequestOrigin`
 * but own separate rejection paths, and the dashboard's live traffic is mostly
 * WebSocket, so a renamed box could otherwise load and then sit dead.
 *
 * The scaffolding below (module-cache bust, env snapshot, session cookie) is
 * the same shape as hermes-dashboard-proxy-timeouts.test.ts. Kept separate
 * rather than folded in: that file is about upstream deadlines, this one about
 * the host guard, and neither wants the other's fixtures.
 */

const require_ = createRequire(import.meta.url);
const SCRIPT = path.resolve(process.cwd(), "scripts/hermes-dashboard-proxy.js");

const SESSION_SECRET = "test-session-secret-for-proxy-host-guard";
/** The box after `Settings → System → rename`. Not in ALLOWED_HOSTS. */
const RENAMED = "krasi-workshop.local";
/** TEST-NET-1 (RFC 5737) — safe to write down in a public repo. */
const LAN_IP = "192.0.2.10";

/** A `clawbox_session` the proxy's HMAC gate accepts, on the pass-through path. */
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

function request(
  port: number,
  headers: Record<string, string>,
  urlPath = "/",
): Promise<Reply> {
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
/** Upgrade sockets the fixture answered; destroyed in afterAll. */
const upgraded: Duplex[] = [];

const ENV_KEYS = ["SESSION_SECRET", "ALLOWED_HOSTS", "CLAWBOX_ROOT", "HERMES_DASH_HOST", "HERMES_PORT"] as const;
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
  for (const [key, value] of envBefore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function startProxy(): Promise<void> {
  Object.assign(process.env, {
    SESSION_SECRET,
    // Neither RENAMED nor LAN_IP is listed: the point is that the guard does
    // not need them listed. `clawbox.local` is left out too, so a pass cannot
    // come from the shipped default.
    ALLOWED_HOSTS: "localhost",
    CLAWBOX_ROOT: path.join(process.cwd(), "nonexistent-proxy-host-guard-root"),
    HERMES_DASH_HOST: "127.0.0.1",
    HERMES_PORT: String(upstreamPort),
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
      // The proxy answers the handshake before any frame; that status line is
      // all this asserts on, so stop as soon as the headers are complete.
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

describe("hermes dashboard proxy — a renamed box needs no allowed-origins update", () => {
  it("serves the dashboard under the new <name>.local with a valid session", async () => {
    await startProxy();
    const res = await request(proxyPort, { host: RENAMED, cookie: sessionCookie() });
    expect(res.status).toBe(200);
    expect(res.body).toBe("dashboard ok");
  });

  it("sends an unauthenticated visitor to the login page on the NEW name", async () => {
    await startProxy();
    const res = await request(proxyPort, { host: RENAMED });
    // Not 403: the host guard passed. The login URL is derived from the
    // request's own Host, so the redirect follows the rename too.
    expect(res.status).toBe(302);
    expect(res.location).toBe(`http://${RENAMED}/login`);
  });

  it("accepts an Origin on the new name, and refuses one on any other host", async () => {
    await startProxy();
    const same = await request(proxyPort, {
      host: RENAMED,
      origin: `http://${RENAMED}`,
      cookie: sessionCookie(),
    });
    expect(same.status).toBe(200);

    const other = await request(proxyPort, {
      host: RENAMED,
      origin: "http://someone-elses-box.local",
      cookie: sessionCookie(),
    });
    expect(other.status).toBe(403);
    expect(other.body).toContain("cross-origin origin");
  });

  it("accepts a raw LAN address, for a box reached before mDNS resolves", async () => {
    await startProxy();
    const res = await request(proxyPort, { host: LAN_IP, cookie: sessionCookie() });
    expect(res.status).toBe(200);
  });

  it("accepts a WebSocket upgrade on the new name, and refuses a rebind name", async () => {
    // The leg that matters most in service: the dashboard's live traffic is
    // WebSocket, and handleUpgrade() owns its own 403 path, so an HTTP-only
    // assertion would let a renamed box load and then sit dead.
    await startProxy();
    expect(await attemptUpgrade(RENAMED)).toContain("101 Switching Protocols");
    expect(await attemptUpgrade("attacker.example.com")).toContain("403 Forbidden");
  });

  it("still refuses a DNS-rebind name, so the guard has not simply been opened", async () => {
    await startProxy();
    const res = await request(proxyPort, { host: "attacker.example.com", cookie: sessionCookie() });
    expect(res.status).toBe(403);
    expect(res.body).toContain("bad Host header");
  });
});
