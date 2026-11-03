import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  SESSION_EXPIRED_CLOSE_CODE,
  SESSION_EXPIRED_HEADER,
  SESSION_EXPIRED_HEADER_VALUE,
  SESSION_PROBE_TIMEOUT_MS,
  sessionExpiredHeaders,
} from "@/lib/session-expiry";
import { CONTROL_UI_CLOSE_PROBE_GAP_MS, injectAtHeadStart as controlUiInjectAtHeadStart } from "@/lib/control-ui-session-guard";

// The Hermes dashboard on a lapsed session (TASK-2131).
//
// Found on a board: with the session over, the :8090 proxy cut the dashboard's
// sockets and refused every request after — and the tab stayed on the chat,
// saying "Lost connection to the Hermes dashboard server … click Reconnect
// now" while the SPA asked for a socket ticket every few seconds, refused each
// time. No ClawBox code ran on that origin to send it to /login. The proxy now
// puts a session guard at the start of every dashboard page and answers the
// guard's question itself; this file runs both: the program exactly as it
// ships, and the proxy against a stand-in dashboard.

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const require_ = createRequire(import.meta.url);
const GUARD_SCRIPT = path.resolve(process.cwd(), "scripts/hermes-dashboard-session-guard.js");
const PROXY_SCRIPT = path.resolve(process.cwd(), "scripts/hermes-dashboard-proxy.js");

interface GuardModule {
  CLOSE_PROBE_GAP_MS: number;
  SESSION_EXPIRED_CLOSE_CODE: number;
  SESSION_EXPIRED_HEADER: string;
  SESSION_EXPIRED_HEADER_VALUE: string;
  SESSION_PROBE_PATH: string;
  SESSION_PROBE_TIMEOUT_MS: number;
  injectAtHeadStart: (html: string, snippet: string) => string;
  sessionGuardScript: (opts: { loginUrl: string; closeProbeGapMs?: number }) => string;
  sessionGuardScriptBody: (opts: { loginUrl: string; closeProbeGapMs?: number }) => string;
}
const guard = require_(GUARD_SCRIPT) as GuardModule;

const LOGIN = "http://clawbox.local/login";
const GAP_MS = 50;

describe("the dashboard guard's constants", () => {
  it("are the session gate's own, so the proxy's marked 401 and the box's are read alike", () => {
    expect(guard.SESSION_EXPIRED_HEADER).toBe(SESSION_EXPIRED_HEADER);
    expect(guard.SESSION_EXPIRED_HEADER_VALUE).toBe(SESSION_EXPIRED_HEADER_VALUE);
    expect(guard.SESSION_EXPIRED_CLOSE_CODE).toBe(SESSION_EXPIRED_CLOSE_CODE);
    expect(guard.SESSION_PROBE_TIMEOUT_MS).toBe(SESSION_PROBE_TIMEOUT_MS);
    expect(guard.CLOSE_PROBE_GAP_MS).toBe(CONTROL_UI_CLOSE_PROBE_GAP_MS);
  });

  it("places the guard where the Control UI's copy does", () => {
    for (const html of [
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
      "<html lang=en><body></body></html>",
      "<!DOCTYPE html><body></body>",
      "<p>bare</p>",
    ]) {
      expect(guard.injectAtHeadStart(html, "<script>G</script>")).toBe(controlUiInjectAtHeadStart(html, "<script>G</script>"));
    }
  });
});

// ── The program, run exactly as it ships ─────────────────────────────────────

const gate401 = () => new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: sessionExpiredHeaders() });
const ok = () => new Response(null, { status: 204 });
type Answer = () => Response | Promise<Response>;

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  constructor(public url: string) {
    super();
  }
  closeWith(code: number) {
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

function page(opts: { probe?: Answer; request?: Answer } = {}) {
  const probe = opts.probe ?? ok;
  const request = opts.request ?? (() => new Response("{}", { status: 200 }));
  const nativeFetch = vi.fn(async (input: RequestInfo | URL) => (String(input) === guard.SESSION_PROBE_PATH ? probe() : request()));
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = Object.assign(new EventTarget(), {
    location: { replace: vi.fn() },
    fetch: nativeFetch as unknown as typeof fetch,
    WebSocket: FakeSocket,
  });
  const install = () => new Function("window", "document", guard.sessionGuardScriptBody({ loginUrl: LOGIN, closeProbeGapMs: GAP_MS }))(win, doc);
  install();
  const probes = () => nativeFetch.mock.calls.filter(([input]) => String(input) === guard.SESSION_PROBE_PATH).length;
  return { win, doc, probes, install };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("the Hermes dashboard's lapsed-session guard", () => {
  it("takes the dashboard to ClawBox's /login when the proxy refuses a request and then the session itself", async () => {
    const { win, probes } = page({ request: gate401, probe: gate401 });
    const res = await win.fetch("/api/auth/ws-ticket");
    // The SPA still gets its answer.
    expect(res.status).toBe(401);
    await vi.waitFor(() => expect(win.location.replace).toHaveBeenCalledWith(LOGIN));
    expect(probes()).toBe(1);
  });

  it("stays on the dashboard when the session still holds (a refusal another tab's sign-in has overtaken)", async () => {
    const { win, probes } = page({ request: gate401, probe: ok });
    await win.fetch("/api/status");
    await flush();
    expect(probes()).toBe(1);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("never asks about the dashboard's own 401 — only the proxy's marked one", async () => {
    const { win, probes } = page({ request: () => new Response("{}", { status: 401 }) });
    await win.fetch("/api/auth/ws-ticket");
    await flush();
    expect(probes()).toBe(0);
  });

  it("asks when a dashboard socket is cut — the proxy ends a lapsed one with no close frame — and leaves on the refusal", async () => {
    const { win, probes } = page({ probe: gate401 });
    for (let i = 0; i < 3; i++) new win.WebSocket("ws://clawbox.local:8090/api/pty").closeWith(1006);
    await vi.waitFor(() => expect(win.location.replace).toHaveBeenCalledWith(LOGIN));
    expect(probes()).toBe(1);
  });

  it("never asks about a socket the page closed itself", async () => {
    const { win, probes } = page({ probe: gate401 });
    new win.WebSocket("ws://clawbox.local:8090/api/ws").closeWith(1000);
    new win.WebSocket("ws://clawbox.local:8090/api/ws").closeWith(1001);
    await flush();
    expect(probes()).toBe(0);
  });

  it("asks when the tab is shown again, when the network returns, and when the page comes back from the back/forward cache", async () => {
    for (const fire of [
      (w: EventTarget, d: EventTarget) => d.dispatchEvent(new Event("visibilitychange")),
      (w: EventTarget) => w.dispatchEvent(new Event("online")),
      (w: EventTarget) => w.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })),
    ]) {
      const { win, doc } = page({ probe: gate401 });
      fire(win, doc);
      await vi.waitFor(() => expect(win.location.replace).toHaveBeenCalledWith(LOGIN));
    }
  });

  it("a box that cannot be reached is not a sign-out", async () => {
    const { win, probes } = page({ request: gate401, probe: () => Promise.reject(new TypeError("Failed to fetch")) });
    await win.fetch("/api/status");
    await flush();
    expect(probes()).toBe(1);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("installs once", async () => {
    const { win, install, probes } = page({ request: gate401, probe: ok });
    install();
    await win.fetch("/api/status");
    await flush();
    expect(probes()).toBe(1);
  });

  it("cannot be ended early by the login address it carries", () => {
    const body = guard.sessionGuardScript({ loginUrl: "http://x/</script><script>alert(1)</script>" });
    expect(body.match(/<\/script>/g)).toHaveLength(1);
  });
});

// ── The proxy: the guard in every page, the question answered at the door ─────

const SECRET = "test-session-secret-for-dashboard-guard";
const PAGE = "<!doctype html><html><head><meta charset=utf-8><title>Hermes</title></head><body><div id=root></div></body></html>";

let root: string;
let upstream: http.Server;
let proxy: http.Server;
let port = 0;
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
const ENV_KEYS = ["SESSION_SECRET", "ALLOWED_HOSTS", "CLAWBOX_ROOT", "HERMES_DASH_HOST", "HERMES_PORT", "CLAWBOX_USER"] as const;
const envBefore = new Map<string, string | undefined>();

const nowS = () => Math.floor(Date.now() / 1000);
function mint(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp, gen: 0 })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

function get(pathname: string, opts: { session?: string; accept?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "GET",
      headers: {
        Host: `localhost:${port}`,
        Referer: `http://localhost:${port}/chat`,
        ...(opts.accept ? { Accept: opts.accept } : {}),
        // The browser already holds a Hermes session, so nothing is brokered.
        ...(opts.session ? { Cookie: `clawbox_session=${opts.session}; hermes_session_at=stub` } : {}),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(5_000, () => { req.destroy(); reject(new Error("proxy never responded")); });
    req.on("error", reject);
    req.end();
  });
}

const NAVIGATION = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

beforeAll(async () => {
  for (const key of ENV_KEYS) envBefore.set(key, process.env[key]);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-dashboard-guard-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ session_generation: 0 }));

  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const p = (req.url ?? "").split("?")[0];
    if (p === "/chat" || p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ETag: "\"v1\"", "Content-Length": Buffer.byteLength(PAGE) });
      res.end(PAGE);
    } else if (p === "/gz") {
      const gz = zlib.gzipSync(PAGE);
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip", "Content-Length": gz.length });
      res.end(gz);
    } else if (p === "/assets/app.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end("console.log('<head>')");
    } else if (p === "/big") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head></head><body>${"x".repeat(3 * 1024 * 1024)}</body></html>`);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
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
  });
  delete require_.cache[require_.resolve(PROXY_SCRIPT)];
  proxy = (require_(PROXY_SCRIPT) as { createProxyServer: () => http.Server }).createProxyServer();
  port = await new Promise<number>((resolve) => {
    proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as net.AddressInfo).port));
  });
});

afterAll(async () => {
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

describe("hermes-dashboard-proxy — the session guard in the dashboard's pages", () => {
  it("puts the guard first in the page's <head>, pointed at ClawBox's /login, and keeps no copy that could outlive it", async () => {
    const res = await get("/chat", { session: mint(nowS() + 600), accept: NAVIGATION, headers: { "If-None-Match": "\"v1\"", "Accept-Encoding": "gzip, br" } });
    expect(res.status).toBe(200);
    const html = res.body.toString();
    expect(html).toBe(guard.injectAtHeadStart(PAGE, guard.sessionGuardScript({ loginUrl: "http://localhost/login" })));
    expect(html.indexOf("__clawboxSessionGuard")).toBeLessThan(html.indexOf("<title>"));
    expect(Number(res.headers["content-length"])).toBe(res.body.length);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.etag).toBeUndefined();
    // Asked for whole and readable: never compressed, never a 304.
    const asked = seen.filter((r) => r.url === "/chat").at(-1)!;
    expect(asked.headers["accept-encoding"]).toBe("identity");
    expect(asked.headers["if-none-match"]).toBeUndefined();
  });

  it("relays a compressed page, an oversized page, a script and an API answer as they came", async () => {
    const session = mint(nowS() + 600);
    const gz = await get("/gz", { session, accept: NAVIGATION });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(zlib.gunzipSync(gz.body).toString()).toBe(PAGE);

    const big = await get("/big", { session, accept: NAVIGATION });
    expect(big.status).toBe(200);
    expect(big.body.length).toBe(3 * 1024 * 1024 + "<html><head></head><body></body></html>".length);
    expect(big.body.toString().includes("__clawboxSessionGuard")).toBe(false);

    const js = await get("/assets/app.js", { session, accept: "*/*" });
    expect(js.body.toString()).toBe("console.log('<head>')");

    const api = await get("/api/status", { session, accept: "application/json" });
    expect(JSON.parse(api.body.toString())).toEqual({ ok: true });
  });

  it("still sends a navigation with no session to ClawBox's /login, guard or not", async () => {
    const res = await get("/chat", { accept: NAVIGATION });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://localhost/login");
  });
});

describe("hermes-dashboard-proxy — the guard's question", () => {
  it("answers 204 for the owner's live session, and never asks the dashboard", async () => {
    const before = seen.length;
    const res = await get(guard.SESSION_PROBE_PATH, { session: mint(nowS() + 600), accept: "*/*" });
    expect(res.status).toBe(204);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(seen.length).toBe(before);
  });

  it("answers the marked 401 for an expired session and for none", async () => {
    const before = seen.length;
    for (const session of [mint(nowS() - 5), undefined]) {
      const res = await get(guard.SESSION_PROBE_PATH, { session, accept: "*/*" });
      expect(res.status).toBe(401);
      expect(res.headers[SESSION_EXPIRED_HEADER]).toBe(SESSION_EXPIRED_HEADER_VALUE);
    }
    expect(seen.length).toBe(before);
  });
});
