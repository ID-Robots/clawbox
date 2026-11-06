import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

// The Hermes edition's dashboard (chat stream, terminal) behind its :8090
// proxy, and a session that runs out while it is open.
//
// The proxy gated every WebSocket upgrade on the owner's ClawBox session and
// never looked at the socket again, so a dashboard opened before the session
// ran out kept working for as long as the tab stayed open, while every
// request to the ClawBox web server was already answered 401 — the gap
// production-server.js closed for its own sockets with
// scripts/upgrade-session-watch.js. The proxy now keeps the same watch.

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const require_ = createRequire(import.meta.url);
const SCRIPT = path.resolve(process.cwd(), "scripts/hermes-dashboard-proxy.js");
const SECRET = "test-session-secret-for-proxy-session-expiry";
const RECHECK_MS = 200;
const GREETING = "dashboard ready";

let root: string;
let upstream: http.Server;
let upstreamWss: WebSocketServer;
/** Upstream sockets the stand-in dashboard accepted, to see the proxy cut them too. */
const upstreams: WebSocket[] = [];
let proxy: http.Server;
let port = 0;
const ENV_KEYS = [
  "SESSION_SECRET", "ALLOWED_HOSTS", "CLAWBOX_ROOT", "HERMES_DASH_HOST", "HERMES_PORT",
  "CLAWBOX_USER", "CLAWBOX_WS_SESSION_RECHECK_MS",
] as const;
const envBefore = new Map<string, string | undefined>();

const nowS = () => Math.floor(Date.now() / 1000);

/** A `clawbox_session` value the way src/lib/auth.ts mints one. */
function mint(exp: number, gen = 0): string {
  const payload = Buffer.from(JSON.stringify({ exp, gen })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function writeConfig(gen: number) {
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ session_generation: gen }));
}

/**
 * The browser's cookies for the dashboard: its ClawBox session, and a Hermes
 * session it already holds, so the proxy passes the socket straight through
 * rather than brokering one.
 */
function cookies(session: string): string {
  return `clawbox_session=${session}; hermes_session_at=stub`;
}

type Dialled = { ws: WebSocket; first: Promise<string>; status?: undefined } | { ws?: undefined; status: number };

function dial(session?: string): Promise<Dialled> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: {
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
        ...(session ? { cookie: cookies(session) } : {}),
      },
    });
    // Listened for from the start: the greeting can arrive in the same chunk
    // as the 101, before an awaiting caller could attach a listener.
    const first = new Promise<string>((r) => ws.once("message", (data) => r(String(data))));
    ws.once("open", () => resolve({ ws, first }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
      ws.terminate();
    });
    ws.once("error", reject);
  });
}

/** An admitted socket, once the stand-in dashboard's greeting has come through. */
async function open(session: string): Promise<WebSocket> {
  const result = await dial(session);
  if (!result.ws) throw new Error(`the dashboard upgrade was refused with ${result.status}`);
  const greeting = await Promise.race([
    result.first,
    new Promise<string>((r) => setTimeout(() => r("(nothing within 5 s)"), 5_000)),
  ]);
  if (greeting !== GREETING) throw new Error(`no greeting through the proxy: ${greeting}`);
  return result.ws;
}

/** True once the socket has closed, false if it is still open after `ms`. */
function closedWithin(ws: WebSocket, ms: number): Promise<boolean> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function echoes(ws: WebSocket, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3_000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(String(data) === text);
    });
    ws.send(text);
  });
}

function get(pathname: string, session: string): Promise<{ status: number; marker: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers: { Host: `localhost:${port}`, Referer: `http://localhost:${port}/`, Cookie: cookies(session) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          marker: res.headers["x-clawbox-session"] as string | undefined,
          body: Buffer.concat(chunks).toString(),
        }));
      },
    );
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error("proxy never responded"));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  for (const key of ENV_KEYS) envBefore.set(key, process.env[key]);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-proxy-session-expiry-"));
  fs.mkdirSync(path.join(root, "data"));
  writeConfig(0);

  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on("connection", (ws) => {
    upstreams.push(ws);
    ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    ws.send(GREETING);
  });
  const upstreamPort = await new Promise<number>((resolve) => {
    upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as net.AddressInfo).port));
  });

  Object.assign(process.env, {
    SESSION_SECRET: SECRET,
    ALLOWED_HOSTS: "localhost",
    CLAWBOX_ROOT: root,
    HERMES_DASH_HOST: "127.0.0.1",
    HERMES_PORT: String(upstreamPort),
    CLAWBOX_USER: "clawbox",
    CLAWBOX_WS_SESSION_RECHECK_MS: String(RECHECK_MS),
  });
  delete require_.cache[require_.resolve(SCRIPT)];
  const mod = require_(SCRIPT) as { createProxyServer: () => http.Server };
  proxy = mod.createProxyServer();
  port = await new Promise<number>((resolve) => {
    proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as net.AddressInfo).port));
  });
});

afterAll(async () => {
  for (const ws of upstreams) ws.terminate();
  await new Promise<void>((r) => upstreamWss.close(() => r()));
  for (const server of [proxy, upstream]) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of envBefore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("hermes-dashboard-proxy — a dashboard socket and a lapsed session", () => {
  it("refuses a dashboard upgrade whose session has expired", async () => {
    expect(await dial(mint(nowS() - 5))).toEqual({ status: 401 });
  });

  it("still proxies a signed-in owner's dashboard socket, and keeps it while the session is live", async () => {
    const ws = await open(mint(nowS() + 600));
    expect(await echoes(ws, "hello dashboard")).toBe(true);
    // Several re-checks later the socket is still there and still answers.
    expect(await closedWithin(ws, RECHECK_MS * 4)).toBe(false);
    expect(await echoes(ws, "still here")).toBe(true);
    ws.close();
  });

  it("cuts an open dashboard socket — and the dashboard's side of it — once its session expires", async () => {
    const before = upstreams.length;
    const session = mint(nowS() + 2);
    const ws = await open(session);
    expect(await echoes(ws, "still signed in")).toBe(true);
    const dashboardSide = upstreams[before];
    expect(dashboardSide).toBeDefined();
    const dashboardGone = closedWithin(dashboardSide, 6_000);

    expect(await closedWithin(ws, 6_000)).toBe(true);
    expect(await dashboardGone).toBe(true);
    // The reconnect meets the gate.
    expect(await dial(session)).toEqual({ status: 401 });
  });

  it("cuts an open dashboard socket when a password change revokes its session", async () => {
    const ws = await open(mint(nowS() + 600));
    expect(await echoes(ws, "before the change")).toBe(true);
    writeConfig(1);
    try {
      expect(await closedWithin(ws, RECHECK_MS * 20)).toBe(true);
    } finally {
      writeConfig(0);
    }
  });
});

describe("hermes-dashboard-proxy — an API request on a lapsed session", () => {
  it("answers the session gate's marked 401, which the ClawBox pages read as signed out", async () => {
    const res = await get("/api/status", mint(nowS() - 5));
    expect(res.status).toBe(401);
    expect(res.marker).toBe("expired");
  });

  it("passes the same request through while the session is live", async () => {
    const res = await get("/api/status", mint(nowS() + 600));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
