import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";

// A signed-in browser's sockets through production-server.js, end to end: the
// REAL entry point, booted from a scratch copy with a stand-in Next server, a
// stand-in gateway and a stand-in PTY server behind it.
//
// The chat socket used to be the one thing a lapsed session could still use.
// The gateway route was not gated at all (the gateway checks its own token,
// which the browser already holds), and no gated socket was ever looked at
// again after its upgrade — so a chat, a terminal or a remote desktop opened
// before the session ran out kept working for as long as the tab stayed open,
// while every HTTP request from the same desktop was answered 401.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const REPO = process.cwd();
const SECRET = "a".repeat(64);
const OWNER = "clawbox";
const USER = "carol";
const USER_SV = "0123456789abcdef";
const RECHECK_MS = 200;
const GREETING = "upstream ready";

let root: string;
let server: ChildProcess | null = null;
let serverLog = "";
let port = 0;
/** The HTTPS listener's port, or 0 where no certificate could be made for it. */
let tlsPort = 0;
let gateway: WebSocketServer;
let terminal: WebSocketServer;
/** Upstream sockets the stand-ins accepted, to see the proxy tear them down too. */
const upstreams: WebSocket[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: p } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(p));
    });
  });
}

function echoServer(): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => resolve(wss));
    wss.on("connection", (ws: WebSocket) => {
      upstreams.push(ws);
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      // The upstream speaks first, as the gateway does with its challenge: a
      // client that waits for it knows the whole path is open.
      ws.send(GREETING);
    });
  });
}

/** A `clawbox_session` value the way src/lib/auth.ts mints one. */
function mint(exp: number, extra: Record<string, unknown> = {}, gen = 0): string {
  const payload = Buffer.from(JSON.stringify({ exp, gen, ...extra })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

const nowS = () => Math.floor(Date.now() / 1000);

function writeConfig(gen: number, openclawShared = false) {
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({
      session_generation: gen,
      clawbox_users: [{ username: USER, sv: USER_SV }],
      ...(openclawShared ? { openclaw_shared_with_users: true } : {}),
    }),
  );
  // The proxy caches config.json on its mtime, which the kernel stamps at a
  // jiffy's grain: two writes a few milliseconds apart must still read as two.
  configWrites += 1;
  const stamp = new Date(Date.now() + configWrites * 1_000);
  fs.utimesSync(path.join(root, "data", "config.json"), stamp, stamp);
}
let configWrites = 0;

type Dialled = { ws: WebSocket; first: Promise<string>; status?: undefined } | { ws?: undefined; status: number };

function dial(pathname: string, cookie?: string, scheme: "ws" | "wss" = "ws"): Promise<Dialled> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${scheme}://127.0.0.1:${scheme === "wss" ? tlsPort : port}${pathname}`, {
      headers: cookie ? { cookie: `clawbox_session=${cookie}` } : {},
      rejectUnauthorized: false,
    });
    // Listened for from the start: the first frame can arrive in the same
    // chunk as the 101, before an awaiting caller could attach a listener.
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

/**
 * An admitted socket, once the upstream's greeting has come through — unless
 * `greeted` is false: the user relay drops a greeting that is not a gateway
 * frame.
 */
async function open(pathname: string, cookie: string, scheme: "ws" | "wss" = "ws", greeted = true): Promise<WebSocket> {
  const result = await dial(pathname, cookie, scheme);
  if (!result.ws) throw new Error(`upgrade of ${pathname} was refused with ${result.status}`);
  if (greeted) {
    const greeting = await Promise.race([
      result.first,
      new Promise<string>((r) => setTimeout(() => r("(nothing within 5 s)"), 5_000)),
    ]);
    if (greeting !== GREETING) throw new Error(`no greeting through ${scheme}://${pathname}: ${greeting}`);
  }
  return result.ws;
}

/** The close code once the socket closes, or null if it is still open after `ms`. */
function closedWithin(ws: WebSocket, ms: number): Promise<number | null> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(-1);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
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

async function waitForServer(scheme: "ws" | "wss"): Promise<void> {
  const deadline = Date.now() + 30_000;
  const cookie = mint(nowS() + 600);
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`production-server.js exited:\n${serverLog}`);
    try {
      const result = await dial("/terminal-ws", cookie, scheme);
      if (result.ws) {
        result.ws.close();
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`production-server.js never proxied a ${scheme} upgrade:\n${serverLog}`);
}

/** A throwaway self-signed certificate for the HTTPS listener; false where openssl is missing. */
function makeCertificate(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-upgrade-session-"));
  // The entry point and the CommonJS helpers it requires — never the shell
  // scripts, so the MCP registration it fires at boot finds nothing to run.
  fs.copyFileSync(path.join(REPO, "production-server.js"), path.join(root, "production-server.js"));
  fs.mkdirSync(path.join(root, "scripts"));
  for (const name of fs.readdirSync(path.join(REPO, "scripts"))) {
    if (name.endsWith(".js")) fs.copyFileSync(path.join(REPO, "scripts", name), path.join(root, "scripts", name));
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
  // The stand-in Next server: answers HTTP and owns an `upgrade` listener, the
  // way Next's does, which the proxy replaces with its own.
  fs.mkdirSync(path.join(root, ".next", "standalone"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".next", "standalone", "server.js"),
    [
      'const http = require("http");',
      'const s = http.createServer((req, res) => { res.end("next"); });',
      's.on("upgrade", (req, socket) => socket.destroy());',
      's.listen(Number(process.env.PORT), "127.0.0.1");',
    ].join("\n"),
  );
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", ".session-secret"), SECRET);
  writeConfig(0);
  fs.mkdirSync(path.join(root, ".openclaw"));
  fs.writeFileSync(
    path.join(root, ".openclaw", "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token: "gateway-token-for-tests" } } }),
  );

  gateway = await echoServer();
  terminal = await echoServer();
  port = await freePort();
  if (makeCertificate(path.join(root, "data", "certs"))) tlsPort = await freePort();
  server = spawn(process.execPath, [path.join(root, "production-server.js")], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      NODE_ENV: "production",
      PORT: String(port),
      HTTPS_PORT: String(tlsPort),
      GATEWAY_PORT: String((gateway.address() as net.AddressInfo).port),
      TERMINAL_WS_PORT: String((terminal.address() as net.AddressInfo).port),
      CLAWBOX_ROOT: root,
      CLAWBOX_OPENCLAW_HOME: path.join(root, ".openclaw"),
      CLAWBOX_USER: OWNER,
      CLOUDFLARED_BIN: "/nonexistent/cloudflared",
      CLAWBOX_WS_SESSION_RECHECK_MS: String(RECHECK_MS),
      SHUTDOWN_GRACE_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (b) => { serverLog += b; });
  server.stderr?.on("data", (b) => { serverLog += b; });
  await waitForServer("ws");
  if (tlsPort) await waitForServer("wss");
});

afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  }
  await new Promise((r) => gateway?.close(r));
  await new Promise((r) => terminal?.close(r));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("chat socket (the gateway route) and a lapsed session", () => {
  it("refuses a chat upgrade that carries no session at all", async () => {
    expect(await dial("/")).toEqual({ status: 401 });
  });

  it("refuses a chat upgrade whose session has expired", async () => {
    expect(await dial("/", mint(nowS() - 5))).toEqual({ status: 401 });
  });

  it("refuses a chat upgrade whose session a password change revoked", async () => {
    expect(await dial("/", mint(nowS() + 600, {}, 7))).toEqual({ status: 401 });
  });

  it("still proxies a signed-in owner's chat to the gateway", async () => {
    const ws = await open("/", mint(nowS() + 600));
    expect(await echoes(ws, "hello gateway")).toBe(true);
    ws.close();
  });

  it("closes an open chat socket — and the gateway's side of it — once its session expires", async () => {
    const before = upstreams.length;
    const ws = await open("/", mint(nowS() + 2));
    expect(await echoes(ws, "still signed in")).toBe(true);
    const upstream = upstreams[before];
    expect(upstream).toBeDefined();
    const upstreamGone = closedWithin(upstream, 6_000);

    expect(await closedWithin(ws, 6_000)).not.toBeNull();
    expect(await upstreamGone).not.toBeNull();
  });

  it("closes an open chat socket when a password change revokes its session", async () => {
    const ws = await open("/", mint(nowS() + 600));
    expect(await echoes(ws, "before the change")).toBe(true);
    writeConfig(1);
    try {
      expect(await closedWithin(ws, RECHECK_MS * 20)).not.toBeNull();
    } finally {
      writeConfig(0);
    }
  });

  it("closes another ClawBox user's relayed chat with the session-expired code", async () => {
    const ws = await open("/", mint(nowS() + 2, { u: USER, sv: USER_SV }), "ws", false);
    expect(await closedWithin(ws, 6_000)).toBe(4401);
  });
});

describe("the other gated sockets and a lapsed session", () => {
  it("closes an open terminal socket once its session expires", async () => {
    const ws = await open("/terminal-ws", mint(nowS() + 2));
    expect(await echoes(ws, "ls")).toBe(true);
    expect(await closedWithin(ws, 6_000)).not.toBeNull();
  });

  it("keeps a terminal socket whose session is still live", async () => {
    const ws = await open("/terminal-ws", mint(nowS() + 600));
    expect(await closedWithin(ws, RECHECK_MS * 5)).toBeNull();
    expect(await echoes(ws, "pwd")).toBe(true);
    ws.close();
  });
});

// The HTTPS listener relays frames itself (bun cannot pipe a TLS upgrade), so
// it can close the browser's side with the session-expired code.
// Skipped where openssl is missing and no certificate could be made.
describe("the chat socket over HTTPS and a lapsed session", () => {
  const tls = () => tlsPort > 0;

  it("refuses a chat upgrade that carries no session at all", async ({ skip }) => {
    if (!tls()) skip();
    expect(await dial("/", undefined, "wss")).toEqual({ status: 401 });
  });

  it("closes an open chat socket with the session-expired code once its session expires", async ({ skip }) => {
    if (!tls()) skip();
    const before = upstreams.length;
    const ws = await open("/", mint(nowS() + 2), "wss");
    expect(await echoes(ws, "over tls")).toBe(true);
    const upstreamGone = closedWithin(upstreams[before], 6_000);
    expect(await closedWithin(ws, 6_000)).toBe(4401);
    expect(await upstreamGone).not.toBeNull();
  });
});

// The owner's "Share OpenClaw with all users" switch (src/lib/non-owner-scope.ts).
// A raw pipe to the gateway carries the stand-in's greeting through; the user
// relay drops it, because it is no gateway frame — so the greeting is how a
// test tells the two apart.
describe("another ClawBox user's gateway sockets and the OpenClaw sharing switch", () => {
  const carol = () => mint(nowS() + 600, { u: USER, sv: USER_SV });

  /** What the socket hears first within `ms`, or null. */
  async function firstWithin(
    pathname: string,
    cookie: string,
    scheme: "ws" | "wss" = "ws",
    ms = 1_500,
  ): Promise<{ ws: WebSocket; first: string | null }> {
    const result = await dial(pathname, cookie, scheme);
    if (!result.ws) throw new Error(`upgrade of ${pathname} was refused with ${result.status}`);
    const first = await Promise.race([result.first, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    return { ws: result.ws, first };
  }

  afterEach(() => writeConfig(0));

  it("relays the user's Control UI socket and their own chat socket while OpenClaw is not shared", async () => {
    for (const pathname of ["/", "/user-chat-ws"]) {
      const { ws, first } = await firstWithin(pathname, carol());
      expect(first, pathname).toBeNull();
      ws.close();
    }
  });

  it("pipes the user's Control UI socket to the gateway like the owner's once OpenClaw is shared — their own chat stays relayed", async () => {
    writeConfig(0, true);
    const shared = await firstWithin("/", carol());
    expect(shared.first).toBe(GREETING);
    expect(await echoes(shared.ws, "shared control ui")).toBe(true);
    shared.ws.close();
    const chat = await firstWithin("/user-chat-ws", carol());
    expect(chat.first).toBeNull();
    chat.ws.close();
  });

  it("closes a shared Control UI socket when the owner switches sharing off", async () => {
    writeConfig(0, true);
    const { ws, first } = await firstWithin("/", carol());
    expect(first).toBe(GREETING);
    writeConfig(0, false);
    expect(await closedWithin(ws, RECHECK_MS * 20)).not.toBeNull();
  });

  it("does the same over HTTPS, where the proxy relays frames itself", async ({ skip }) => {
    if (tlsPort === 0) skip();
    const chat = await firstWithin("/", carol(), "wss");
    expect(chat.first).toBeNull();
    chat.ws.close();
    writeConfig(0, true);
    const shared = await firstWithin("/", carol(), "wss");
    expect(shared.first).toBe(GREETING);
    expect(await echoes(shared.ws, "shared over tls")).toBe(true);
    const own = await firstWithin("/user-chat-ws", carol(), "wss");
    expect(own.first).toBeNull();
    own.ws.close();
    writeConfig(0, false);
    expect(await closedWithin(shared.ws, RECHECK_MS * 20)).toBe(4401);
  });

  it("pipes the owner on the user-chat path too, with the prefix stripped", async () => {
    const ws = await open("/user-chat-ws", mint(nowS() + 600));
    expect(await echoes(ws, "owner on the user path")).toBe(true);
    ws.close();
  });
});

