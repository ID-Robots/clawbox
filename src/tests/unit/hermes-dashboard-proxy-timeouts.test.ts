import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createSessionCookie } from "@/lib/auth";

/**
 * scripts/hermes-dashboard-proxy.js — upstream timeouts.
 *
 * The proxy is on the serving path for the Hermes dashboard on shipped
 * devices. Before this, an upstream that accepted the connection and then went
 * quiet (dashboard mid-restart, wedged worker) held the browser's request open
 * with no status and no error: the tab just span.
 *
 * The fix is only worth anything if the timeout PRODUCES A RESPONSE. Node's
 * `destroy()` with no argument emits 'close', not 'error', so a timeout that
 * simply tore the socket down would leave the request hanging — the same
 * symptom, now caused by the fix. Every assertion below is therefore "a status
 * came back, within the timeout", never "an attribute is set".
 *
 * These tests exist at all because the script now exports a server factory and
 * keeps `listen()` behind a main-module guard. Previously it bound its port at
 * import time, so nothing could load it without starting a real listener.
 */

const require_ = createRequire(import.meta.url);
const SCRIPT = path.resolve(process.cwd(), "scripts/hermes-dashboard-proxy.js");

const TIMEOUT_MS = 300;
const SESSION_SECRET = "test-session-secret-for-proxy-timeouts";

/**
 * A `clawbox_session` the proxy's HMAC gate accepts.
 *
 * Minted with the PRODUCTION helper, not a copy of its format. The proxy is a
 * standalone script and re-implements the verification side in plain JS, so it
 * cannot import `auth.ts` — this test is the only thing holding the two in
 * step. A hand-rolled cookie here would keep passing against a payload shape
 * `auth.ts` had already moved on from, which is precisely the drift the test
 * exists to catch.
 *
 * `hermes_session_at` puts the request on the pass-through path so the test
 * exercises forwarding, not the SSO broker.
 */
function sessionCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET)}; hermes_session_at=stub`;
}

/** Bind on an ephemeral port and resolve with the one it got. */
function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function close(server?: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    // `close()` only stops NEW connections and waits for existing ones to end.
    // These tests deliberately leave half-finished sockets around (a stalled
    // upgrade, a held-open request), so waiting for them is waiting forever.
    // http.Server can drop them itself; a plain net.Server cannot, which is why
    // those stubs track their sockets and destroy them in afterAll.
    if ("closeAllConnections" in server) server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** GET through the proxy, rejecting loudly if nothing ever comes back. */
function get(port: number, urlPath: string, budgetMs: number) {
  return new Promise<{ status: number; body: string; elapsedMs: number }>((resolve, reject) => {
    const startedAt = Date.now();
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { host: `127.0.0.1:${port}`, cookie: sessionCookie() },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            elapsedMs: Date.now() - startedAt,
          }),
        );
      },
    );
    // The regression this guards: a timeout path that destroys the upstream
    // without answering leaves us here until the budget expires.
    req.setTimeout(budgetMs, () => {
      req.destroy();
      reject(new Error(`proxy never responded — request hung for ${budgetMs}ms`));
    });
    req.on("error", (e) => reject(e));
    req.end();
  });
}

// --- fixtures --------------------------------------------------------------

/** Upstream that answers /fast and deliberately never answers /silent. */
let upstream: http.Server;
let upstreamPort: number;
const heldSockets: net.Socket[] = [];

/** Upstream that accepts TCP and never speaks — for the WS handshake path. */
let muteTcp: net.Server;
let muteTcpPort: number;

/** Stub upstreams a single test spun up; torn down with the rest in afterAll. */
const adHocServers: net.Server[] = [];

let proxy: http.Server;
let proxyPort: number;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === "/silent") {
      // Hold the connection open, headers never sent. This is the wedged
      // dashboard: TCP is healthy, the application is not.
      heldSockets.push(res.socket as net.Socket);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("dashboard ok");
  });
  upstreamPort = await listen(upstream);

  muteTcp = net.createServer((socket) => {
    heldSockets.push(socket);
  });
  muteTcpPort = await listen(muteTcp);
});

afterAll(async () => {
  // Sockets first: these servers are deliberately holding half-finished
  // connections, and `close()` on a net.Server waits for every one of them.
  for (const s of heldSockets) {
    try {
      s.destroy();
    } catch {
      /* already gone */
    }
  }
  await Promise.all([close(upstream), close(muteTcp), ...adHocServers.map(close)]);
});

// Every env key startProxy() may write. Snapshotted so the suite cannot leak
// a proxy-shaped environment into whatever else shares this worker.
const ENV_KEYS = [
  "SESSION_SECRET",
  "ALLOWED_HOSTS",
  "CLAWBOX_ROOT",
  "HERMES_DASH_HOST",
  "HERMES_PORT",
  "HERMES_DASH_UPSTREAM_TIMEOUT_MS",
  "HERMES_DASH_WS_TIMEOUT_MS",
  "HERMES_DASH_LOGIN_TIMEOUT_MS",
] as const;
const envBefore = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) envBefore.set(key, process.env[key]);
});

afterEach(async () => {
  await close(proxy);
  for (const [key, value] of envBefore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Load the proxy with a fresh module registry so its load-time env snapshot
 * (ports, timeouts, secret) reflects this test's setup, then start it on an
 * ephemeral port.
 */
async function startProxy(env: Record<string, string>) {
  Object.assign(process.env, {
    SESSION_SECRET,
    ALLOWED_HOSTS: "localhost",
    CLAWBOX_ROOT: path.join(process.cwd(), "nonexistent-proxy-test-root"),
    HERMES_DASH_HOST: "127.0.0.1",
    HERMES_DASH_UPSTREAM_TIMEOUT_MS: String(TIMEOUT_MS),
    HERMES_DASH_WS_TIMEOUT_MS: String(TIMEOUT_MS),
    HERMES_DASH_LOGIN_TIMEOUT_MS: String(TIMEOUT_MS),
    ...env,
  });
  // The proxy snapshots env at module load, so every start needs a fresh one.
  // This is also what clears the module's Hermes session cache between tests.
  delete require_.cache[require_.resolve(SCRIPT)];
  const mod = require_(SCRIPT);
  proxy = mod.createProxyServer();
  proxyPort = await listen(proxy);
  return mod;
}

// --- tests -----------------------------------------------------------------

describe("hermes dashboard proxy — module shape", () => {
  it("exports a server factory and does not listen on import", async () => {
    const mod = await startProxy({ HERMES_PORT: String(upstreamPort) });

    expect(typeof mod.createProxyServer).toBe("function");
    // The regression this guards: the script used to call listen() at import
    // time, so merely loading it bound :8090. A server built here must be inert
    // until something asks it to listen.
    const spare = mod.createProxyServer();
    expect(spare.listening).toBe(false);
    spare.close();
  });
});

describe("hermes dashboard proxy — upstream timeouts", () => {
  it("answers 504 when the upstream accepts the connection but never responds", async () => {
    await startProxy({ HERMES_PORT: String(upstreamPort) });

    // Budget is many times the timeout: if this rejects, the proxy hung.
    const res = await get(proxyPort, "/silent", TIMEOUT_MS * 20);

    expect(res.status).toBe(504);
    expect(res.body).toContain("did not respond in time");
    expect(res.elapsedMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(res.elapsedMs).toBeLessThan(TIMEOUT_MS * 10);
  });

  it("hangs on that same request when the timeout is disabled — the behaviour being fixed", async () => {
    // 0 disables the timer, reproducing the proxy exactly as it shipped. The
    // point of the test above is that this is what it replaced: not a slower
    // response, but no response at all until the browser gives up.
    await startProxy({
      HERMES_PORT: String(upstreamPort),
      HERMES_DASH_UPSTREAM_TIMEOUT_MS: "0",
    });

    await expect(get(proxyPort, "/silent", TIMEOUT_MS * 4)).rejects.toThrow(
      /never responded/,
    );
  });

  it("still proxies a responsive upstream — the timeout does not fire on healthy traffic", async () => {
    await startProxy({ HERMES_PORT: String(upstreamPort) });

    const res = await get(proxyPort, "/fast", TIMEOUT_MS * 20);

    expect(res.status).toBe(200);
    expect(res.body).toBe("dashboard ok");
  });

  it("answers 502 when the upstream is not listening at all", async () => {
    // Bind and immediately release a port so we know nothing is on it.
    const scratch = net.createServer();
    const deadPort = await listen(scratch);
    await close(scratch);

    await startProxy({ HERMES_PORT: String(deadPort) });

    const res = await get(proxyPort, "/fast", TIMEOUT_MS * 20);

    expect(res.status).toBe(502);
    expect(res.body).toContain("not reachable");
  });

  it("closes a WebSocket upgrade with 504 when the upstream never speaks at all", async () => {
    await startProxy({ HERMES_PORT: String(muteTcpPort) });

    const raw = await attemptUpgrade();

    // The browser must be told; a silent close is a 1006 with no explanation.
    expect(raw.text).toContain("504");
    expect(raw.elapsedMs).toBeLessThan(TIMEOUT_MS * 10);
  });

  it("closes a WebSocket upgrade with 504 when the upstream stalls MID-HEADER", async () => {
    // The subtle case: bytes arrive, so anything that stood the timer down on
    // "first byte seen" would disarm here and hand the client a permanent hang.
    // The upgrade is only complete once the header terminator lands.
    const partial = net.createServer((socket) => {
      heldSockets.push(socket);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websoc");
    });
    adHocServers.push(partial);
    const partialPort = await listen(partial);

    await startProxy({ HERMES_PORT: String(partialPort) });
    const raw = await attemptUpgrade();

    expect(raw.text).toContain("504");
    expect(raw.elapsedMs).toBeLessThan(TIMEOUT_MS * 10);
  });
});

/** Drive a raw WebSocket upgrade through the proxy and collect what comes back. */
function attemptUpgrade() {
  return new Promise<{ text: string; elapsedMs: number }>((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(
        [
          "GET /ws HTTP/1.1",
          `Host: 127.0.0.1:${proxyPort}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Origin: http://127.0.0.1:${proxyPort}`,
          `Cookie: ${sessionCookie()}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    let text = "";
    socket.on("data", (c) => {
      text += c.toString();
    });
    socket.on("close", () => resolve({ text, elapsedMs: Date.now() - startedAt }));
    socket.on("error", reject);
    socket.setTimeout(TIMEOUT_MS * 20, () => {
      socket.destroy();
      reject(new Error("upgrade hung — proxy never answered or closed"));
    });
  });
}
