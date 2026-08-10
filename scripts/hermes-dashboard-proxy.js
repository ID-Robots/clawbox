#!/usr/bin/env node
// Auth-gated reverse proxy for the Hermes dashboard (Hermes edition only).
//
// The Hermes dashboard (`hermes dashboard`) is a full SPA served on LOOPBACK
// 127.0.0.1:9119 and has no base-path option, so — unlike the OpenClaw gateway,
// which shares ClawBox's URL space via next.config rewrites — it can't be
// mounted under a path on :80 without its absolute /assets, /api, WS paths
// colliding with ClawBox's own. Instead we expose it on a dedicated LAN port,
// gated by the SAME `clawbox_session` cookie the rest of the device uses, and
// forward HTTP + WebSocket to the loopback dashboard. The dashboard itself
// never leaves loopback, and there's no second login.
//
// Isolated in its own process (its own systemd unit) so a bug here can never
// take down the main ClawBox web server.

const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.HERMES_DASH_PROXY_PORT || "8090", 10);
const UPSTREAM_HOST = process.env.HERMES_DASH_HOST || "127.0.0.1";
const UPSTREAM_PORT = parseInt(process.env.HERMES_PORT || "9119", 10);
const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";

// Signing secret: the SESSION_SECRET env (what production-server uses) or the
// on-disk secret file middleware/auth fall back to. Either way it must match
// the key that signed the cookie.
function sessionSecret() {
  const env = (process.env.SESSION_SECRET || "").trim();
  if (env) return env;
  try {
    return fs.readFileSync(path.join(CLAWBOX_ROOT, "data", ".session-secret"), "utf8").trim();
  } catch {
    return "";
  }
}

// session_generation for revocation — mtime-cached read of data/config.json.
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

// Same HMAC-SHA256 scheme as src/middleware.ts / production-server.js.
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

const server = http.createServer((req, res) => {
  if (!hasValidSession(req)) {
    // Send them to the ClawBox login on the main origin, then back here.
    res.writeHead(302, { Location: "/login", "Content-Type": "text/plain" });
    res.end("Unauthorized — sign in to ClawBox first.");
    return;
  }
  // Present a loopback Host to the dashboard: it binds 127.0.0.1 and treats
  // loopback as trusted (no separate auth), so forwarding the public Host could
  // trip its host/origin checks. We are the auth boundary here.
  const upstreamHeaders = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers: upstreamHeaders },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Hermes dashboard is not reachable.");
  });
  req.pipe(upstream);
});

// WebSocket upgrades — same auth gate, then a raw socket splice to the upstream.
server.on("upgrade", (req, clientSocket, head) => {
  if (!hasValidSession(req)) {
    try { clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch {}
    try { clientSocket.destroy(); } catch {}
    return;
  }
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      // Rewrite Host to loopback so the dashboard's trusted-origin check passes.
      const value = name.toLowerCase() === "host" ? `${UPSTREAM_HOST}:${UPSTREAM_PORT}` : req.rawHeaders[i + 1];
      headerLines.push(`${name}: ${value}`);
    }
    upstream.write(headerLines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  const kill = () => { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
  upstream.on("error", kill);
  clientSocket.on("error", kill);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[hermes-dashboard-proxy] :${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} (clawbox_session gated)`);
});
