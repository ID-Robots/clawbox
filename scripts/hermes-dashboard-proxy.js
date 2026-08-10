#!/usr/bin/env node
// Auth-gated reverse proxy for the Hermes dashboard (Hermes edition only).
//
// The Hermes dashboard (`hermes dashboard`) is a full SPA with no base-path
// option, so — unlike the OpenClaw gateway, which shares ClawBox's URL space
// via next.config rewrites — it can't be mounted under a path on :80 without
// its absolute /assets, /api, WS paths colliding with ClawBox's own. Instead
// we expose it on a dedicated LAN port, gated by the SAME `clawbox_session`
// cookie the rest of the device uses, and forward HTTP + WebSocket upstream.
//
// The dashboard binds a NON-loopback host-local address (127.0.0.2). Hermes
// only engages its cookie-session auth gate ("gated mode") on a non-loopback
// bind — on plain 127.0.0.1 it falls back to a legacy shared-token mode that
// ignores session cookies, so a reverse proxy can never authenticate to it.
// 127.0.0.2 is still inside 127.0.0.0/8 (host-local, never LAN-reachable), so
// we get gated cookie auth without exposing the dashboard off the box.
//
// Single sign-on: the ClawBox user already authenticated at this proxy (their
// `clawbox_session`). Rather than prompt them a SECOND time for the Hermes
// dashboard password, the proxy logs in on their behalf with the server-side
// password (data/.hermes-dashboard-pw) and injects/relays the resulting Hermes
// session cookies. The dashboard mints and verifies those cookies itself, so
// its WS-ticket handshake and everything downstream work natively.
//
// Isolated in its own process (its own systemd unit) so a bug here can never
// take down the main ClawBox web server.

const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.HERMES_DASH_PROXY_PORT || "8090", 10);
// Host-local, non-loopback: puts the dashboard in gated cookie-auth mode
// (see file header) while staying off the LAN.
const UPSTREAM_HOST = process.env.HERMES_DASH_HOST || "127.0.0.2";
const UPSTREAM_PORT = parseInt(process.env.HERMES_PORT || "9119", 10);
const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const UPSTREAM_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
const DASH_USERNAME = process.env.HERMES_DASH_USERNAME || "clawbox";
const MAX_RETRY_BODY = 5 * 1024 * 1024; // cap buffered request body for a retry

// ---------------------------------------------------------------------------
// ClawBox session gate (same HMAC-SHA256 scheme as middleware / production-server)
// ---------------------------------------------------------------------------

function sessionSecret() {
  const env = (process.env.SESSION_SECRET || "").trim();
  if (env) return env;
  try {
    return fs.readFileSync(path.join(CLAWBOX_ROOT, "data", ".session-secret"), "utf8").trim();
  } catch {
    return "";
  }
}

let genCache = { mtimeMs: -1, gen: 0 };
function readSessionGeneration() {
  try {
    const p = path.join(CLAWBOX_ROOT, "data", "config.json");
    const st = fs.statSync(p);
    if (genCache.mtimeMs === st.mtimeMs) return genCache.gen;
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const gen = typeof cfg.session_generation === "number" && Number.isFinite(cfg.session_generation)
      ? cfg.session_generation : 0;
    genCache = { mtimeMs: st.mtimeMs, gen };
    return gen;
  } catch {
    return 0;
  }
}

function hasValidSession(req) {
  try {
    const secret = sessionSecret();
    if (!secret) return false;
    const m = /(?:^|;\s*)clawbox_session=([^;]+)/.exec(req.headers.cookie || "");
    if (!m) return false;
    const cookie = decodeURIComponent(m[1]);
    const dot = cookie.indexOf(".");
    if (dot < 0) return false;
    const payload = cookie.slice(0, dot);
    const sig = cookie.slice(dot + 1);
    if (!payload || !sig) return false;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const data = JSON.parse(decoded);
    if (typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return false;
    if ((typeof data.gen === "number" ? data.gen : 0) !== readSessionGeneration()) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hermes dashboard SSO broker
// ---------------------------------------------------------------------------

function dashPassword() {
  try {
    return fs.readFileSync(path.join(CLAWBOX_ROOT, "data", ".hermes-dashboard-pw"), "utf8").trim();
  } catch {
    return "";
  }
}

// Cached Hermes session: { cookieHeader, setCookies } or null. cookieHeader is
// "name=value; name=value" for injecting upstream; setCookies is the raw
// Set-Cookie array to relay to the browser so it adopts the same session.
let hermesState = null;
let loginInFlight = null;

function hermesLogin() {
  const pw = dashPassword();
  if (!pw) return Promise.resolve(null);
  const body = JSON.stringify({ provider: "basic", username: DASH_USERNAME, password: pw, next: "/" });
  return new Promise((resolve) => {
    const reqUp = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method: "POST",
        path: "/auth/password-login",
        headers: {
          host: UPSTREAM_AUTHORITY,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (up) => {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const setCookies = up.headers["set-cookie"];
          if (up.statusCode !== 200 || !Array.isArray(setCookies) || setCookies.length === 0) {
            console.error(`[hermes-dashboard-proxy] login failed: HTTP ${up.statusCode} ${Buffer.concat(chunks).toString().slice(0, 120)}`);
            resolve(null);
            return;
          }
          // Build a Cookie header from each Set-Cookie's leading name=value.
          const cookieHeader = setCookies
            .map((sc) => String(sc).split(";", 1)[0])
            .filter(Boolean)
            .join("; ");
          resolve({ cookieHeader, setCookies });
        });
      },
    );
    reqUp.on("error", (e) => {
      console.error(`[hermes-dashboard-proxy] login error: ${e.message}`);
      resolve(null);
    });
    reqUp.end(body);
  });
}

// Return cached Hermes cookies, logging in (once, de-duped) if needed.
async function ensureHermesCookies(forceRefresh) {
  if (hermesState && !forceRefresh) return hermesState;
  if (!loginInFlight) {
    loginInFlight = hermesLogin().then((state) => {
      hermesState = state;
      loginInFlight = null;
      return state;
    });
  }
  return loginInFlight;
}

function browserHasHermesSession(req) {
  return /(?:^|;\s*)hermes_session_at=/.test(req.headers.cookie || "");
}

function mergeCookie(existing, injected) {
  const base = (existing || "").trim();
  if (!base) return injected;
  return `${base}; ${injected}`;
}

// ---------------------------------------------------------------------------
// HTTP proxy
// ---------------------------------------------------------------------------

// Forward one request upstream. `injected` (or null) is the Hermes cookie
// state to splice in for SSO. On a 401 while injecting, re-login once and
// retry (bodyBuf must be buffered for the retry to resend it).
function forward(req, res, injected, bodyBuf, allowRelogin) {
  const headers = { ...req.headers, host: UPSTREAM_AUTHORITY };
  if (injected) {
    headers.cookie = mergeCookie(req.headers.cookie, injected.cookieHeader);
  }
  if (bodyBuf) headers["content-length"] = Buffer.byteLength(bodyBuf);

  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (up) => {
      // Injected session was rejected (expired/rotated) — re-login once.
      if (up.statusCode === 401 && injected && allowRelogin && bodyBuf !== null) {
        up.resume(); // drain
        ensureHermesCookies(true).then((fresh) => {
          if (!fresh) { pipeResponse(res, up, injected); return; }
          forward(req, res, fresh, bodyBuf, false);
        });
        return;
      }
      pipeResponse(res, up, injected);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Hermes dashboard is not reachable.");
  });

  if (bodyBuf !== null && bodyBuf !== undefined) {
    upstream.end(bodyBuf);
  } else {
    req.pipe(upstream);
  }
}

function pipeResponse(res, up, injected) {
  const headers = { ...up.headers };
  if (injected) {
    // Relay Hermes's own Set-Cookie so the browser adopts the session and
    // sends it directly next time (no re-inject). Preserve any upstream
    // Set-Cookie already present.
    const existing = headers["set-cookie"];
    const relay = injected.setCookies.slice();
    headers["set-cookie"] = Array.isArray(existing) ? relay.concat(existing) : relay;
  }
  res.writeHead(up.statusCode || 502, headers);
  up.pipe(res);
}

const server = http.createServer((req, res) => {
  if (!hasValidSession(req)) {
    res.writeHead(302, { Location: "/login", "Content-Type": "text/plain" });
    res.end("Unauthorized — sign in to ClawBox first.");
    return;
  }

  // Browser already holds a Hermes session — pass through untouched.
  if (browserHasHermesSession(req)) {
    forward(req, res, null, null, false);
    return;
  }

  // No Hermes session yet: broker one (SSO). Buffer a small body so a 401
  // re-login can resend it; fall back to streaming for large uploads.
  ensureHermesCookies(false).then((injected) => {
    if (!injected) {
      // Login unavailable (no password / dashboard down): forward as-is and
      // let the dashboard render its own login page rather than hard-fail.
      forward(req, res, null, null, false);
      return;
    }
    const method = (req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      forward(req, res, injected, null, true);
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_RETRY_BODY) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on("end", () => {
      // tooBig: we already dropped chunks, so we can't resend — stream instead
      // (no retry). Rare for a config dashboard.
      forward(req, res, injected, tooBig ? null : Buffer.concat(chunks), !tooBig);
    });
    req.on("error", () => { try { res.destroy(); } catch {} });
  });
});

// ---------------------------------------------------------------------------
// WebSocket upgrades — same gate, inject SSO cookies, raw splice upstream.
// ---------------------------------------------------------------------------

server.on("upgrade", (req, clientSocket, head) => {
  if (!hasValidSession(req)) {
    try { clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch {}
    try { clientSocket.destroy(); } catch {}
    return;
  }
  const proceed = (injected) => {
    const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
      const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
      let cookieWritten = false;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lower = name.toLowerCase();
        if (lower === "host") {
          headerLines.push(`${name}: ${UPSTREAM_AUTHORITY}`);
        } else if (lower === "cookie") {
          const value = injected ? mergeCookie(req.rawHeaders[i + 1], injected.cookieHeader) : req.rawHeaders[i + 1];
          headerLines.push(`Cookie: ${value}`);
          cookieWritten = true;
        } else {
          headerLines.push(`${name}: ${req.rawHeaders[i + 1]}`);
        }
      }
      if (injected && !cookieWritten) headerLines.push(`Cookie: ${injected.cookieHeader}`);
      upstream.write(headerLines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    const kill = () => { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
    upstream.on("error", kill);
    clientSocket.on("error", kill);
  };

  if (browserHasHermesSession(req)) {
    proceed(null);
  } else {
    ensureHermesCookies(false).then((injected) => proceed(injected));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[hermes-dashboard-proxy] :${PORT} -> ${UPSTREAM_AUTHORITY} (clawbox_session gated, Hermes SSO)`);
});
