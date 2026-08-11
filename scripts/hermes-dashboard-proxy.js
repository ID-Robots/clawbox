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
const os = require("os");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.HERMES_DASH_PROXY_PORT || "8090", 10);
// Port the main ClawBox web server (and therefore /login) listens on. The proxy
// serves EVERY path on its own port, so a relative `Location: /login` would
// bounce back into the proxy — an infinite redirect loop. We always redirect to
// the ClawBox origin explicitly.
const CLAWBOX_WEB_PORT = parseInt(process.env.CLAWBOX_WEB_PORT || "80", 10);
// Host-local, non-loopback: puts the dashboard in gated cookie-auth mode
// (see file header) while staying off the LAN.
const UPSTREAM_HOST = process.env.HERMES_DASH_HOST || "127.0.0.2";
const UPSTREAM_PORT = parseInt(process.env.HERMES_PORT || "9119", 10);
const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const UPSTREAM_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
// The dashboard's WS Host/Origin guard (_ws_host_origin_is_allowed) rejects any
// upgrade whose Origin doesn't target the bound host, and its HTTP layer checks
// Host the same way. Since we bind 127.0.0.2, forward Host AND Origin/Referer as
// that authority — otherwise a browser's real Origin (the LAN proxy URL) trips
// the guard and every dashboard WebSocket closes before accept (code 1006).
const UPSTREAM_ORIGIN = `http://${UPSTREAM_AUTHORITY}`;
const DASH_USERNAME = process.env.HERMES_DASH_USERNAME || "clawbox";

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------
//
// Without these, an upstream that accepts the connection and then goes quiet
// (the dashboard mid-restart, a wedged worker) held the browser's request open
// forever. On a Jetson serving a handful of connections that is how the tab
// ends up spinning with nothing to click and no error to report.
//
// Each timeout is armed only for the phase where silence means "stuck":
//
//   HEADERS — from send to COMPLETE response headers. Cleared as soon as the
//     response starts, because the dashboard legitimately streams (long-lived
//     event streams would be cut mid-flight by an idle timer).
//   LOGIN   — the SSO broker's own POST /auth/password-login. Short: it is on
//     the critical path of a user's first request.
//   WS      — TCP connect plus the 101 handshake, stood down once the upstream
//     has sent a complete header block. A live WebSocket is idle most of the
//     time, so an idle timeout past the handshake would drop working links.
//
// The first two are ABSOLUTE deadlines rather than socket timeouts. A socket
// timer measures inactivity, so an upstream that trickles a byte at a time
// resets it forever and the request hangs anyway. The WS one is a socket timer
// on purpose: it must stop applying entirely once the connection is live.
//
// A timed-out request must still PRODUCE A RESPONSE. Tearing the upstream
// socket down and trusting the existing error handler to notice is not enough:
// `destroy()` is specified to emit 'close', an 'error' only follows in some
// shapes, and on the WebSocket path the client just sees the TCP connection
// vanish (a bare 1006, no status). Silence is the very symptom these timeouts
// exist to remove, so every timeout path below writes its own status FIRST and
// tears the socket down after.
//
// Note the LOGIN timer is an absolute deadline rather than a socket timeout —
// `setTimeout` on a socket measures inactivity, which an upstream that dribbles
// bytes can reset forever. See hermesLogin().
function envMs(name, fallback) {
  const raw = Number.parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
const UPSTREAM_HEADERS_TIMEOUT_MS = envMs("HERMES_DASH_UPSTREAM_TIMEOUT_MS", 30_000);
const LOGIN_TIMEOUT_MS = envMs("HERMES_DASH_LOGIN_TIMEOUT_MS", 10_000);
const WS_HANDSHAKE_TIMEOUT_MS = envMs("HERMES_DASH_WS_TIMEOUT_MS", 15_000);
// End of an HTTP header block — what the WS path waits for before it will call
// the upgrade handshake complete and stand its timeout down.
const HEADER_TERMINATOR = "\r\n\r\n";

// Rewrite the origin part of a Referer to the upstream authority, keeping path.
function rewriteReferer(value) {
  return typeof value === "string" ? value.replace(/^https?:\/\/[^/]+/i, UPSTREAM_ORIGIN) : value;
}
const MAX_RETRY_BODY = 5 * 1024 * 1024; // cap buffered request body for a retry

// ---------------------------------------------------------------------------
// Host / Origin guard (must run BEFORE the upstream rewrites above)
// ---------------------------------------------------------------------------
//
// Forwarding Host/Origin/Referer as the upstream authority deletes the
// dashboard's own DNS-rebind + CSRF guard — from its point of view every
// request looks same-origin. `clawbox_session` is HttpOnly+SameSite=Lax, which
// blocks cross-site fetch/XHR/WS, but Lax still attaches the cookie to
// top-level GET navigations (window.open / a link), so a state-changing GET
// would remain CSRF-able. We therefore re-implement both checks here, at the
// proxy edge, before any header is rewritten.

const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || "clawbox.local,10.42.0.1,10.43.0.1,localhost")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

// Single mDNS label — letters/digits/hyphens, no dots. Mirrors the same regex in
// src/lib/gateway-proxy.ts so the two host checks can't drift apart.
const MDNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

let cachedMdnsHost; // undefined = not computed yet, null = unusable hostname
function systemMdnsHost() {
  if (cachedMdnsHost !== undefined) return cachedMdnsHost;
  try {
    const label = os.hostname().trim().toLowerCase();
    cachedMdnsHost = MDNS_LABEL_RE.test(label) ? `${label}.local` : null;
  } catch {
    cachedMdnsHost = null;
  }
  return cachedMdnsHost;
}

// Split a Host header into { hostname, port, authority }. Handles `[::1]:8090`.
function splitHost(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(value);
  if (v6) return { hostname: v6[1], port: v6[2] || "80", authority: value };
  const parts = value.split(":");
  if (parts.length > 2) return null; // bare IPv6 without brackets — not valid in Host
  const hostname = parts[0];
  if (!hostname) return null;
  if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return null;
  return { hostname, port: parts[1] || "80", authority: value };
}

// A Host we're willing to be addressed as. Anything else is a DNS-rebind
// attempt: an attacker-controlled name that resolves to this box.
function isAllowedHostname(hostname) {
  if (!hostname) return false;
  if (ALLOWED_HOSTS.has(hostname)) return true;
  if (hostname === systemMdnsHost()) return true;
  // The box can be renamed after install (mDNS label changes without this
  // service restarting), so accept any well-formed `<label>.local` — .local is
  // mDNS-only and cannot be registered by a remote attacker.
  if (hostname.endsWith(".local") && MDNS_LABEL_RE.test(hostname.slice(0, -".local".length))) return true;
  if (net.isIP(hostname)) return true; // raw LAN address
  return false;
}

// Authorities we accept as the referring page: this proxy itself, and the
// ClawBox web server on the SAME host. The second one is required — the
// dashboard is opened from the ClawBox desktop on :80 (link or iframe), and a
// GET navigation carries no Origin, only `Referer: http://<host>/…`, so a
// strict same-authority rule would 403 the only intended entry point.
// Anything on a different hostname, or on some other port, is refused.
//
// RESIDUAL RISK, documented rather than hidden: accepting :80 means accepting
// EVERYTHING ClawBox serves same-origin there, not just the desktop shell —
// installed webapps (/setup-api/webapps, data/webapps/*) and built code
// projects are agent- or user-authored HTML on that same origin. Under
// `Referrer-Policy: strict-origin-when-cross-origin` both the desktop and a
// malicious webapp send exactly `Referer: http://<host>/`, so the check cannot
// tell them apart, and a prompt-injected webapp can drive the dashboard through
// this proxy. Tightening the Referer comparison does not help; closing it needs
// a proxy-issued nonce on the desktop's dashboard link.
function isTrustedPeer(parsed, host) {
  if (parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "") !== host.hostname) return false;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return port === host.port || port === String(PORT) || port === String(CLAWBOX_WEB_PORT);
}

// A request we are willing to accept with NO Origin and NO Referer at all.
// Only a plain top-level document navigation qualifies: typing the dashboard
// URL in the address bar, or a bookmark, legitimately arrives bare.
function isBareDocumentNavigation(req) {
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  // wantsJsonError() covers /api/*, /auth/*, XHR hints and JSON-only Accept —
  // i.e. everything the SPA calls programmatically and everything
  // state-changing. Those must produce a peer header or they don't proceed.
  return !wantsJsonError(req);
}

// Returns null when the request may proceed, or a short reason string.
function checkRequestOrigin(req) {
  const host = splitHost(req.headers.host);
  if (!host || !isAllowedHostname(host.hostname)) return "bad Host header";
  let sawPeer = false;
  for (const name of ["origin", "referer"]) {
    const raw = req.headers[name];
    if (raw === undefined || raw === "") continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    // `Origin: null` = opaque origin (sandboxed iframe, some redirects). The
    // dashboard SPA never sends it; treat it as cross-origin.
    if (value === "null") return `opaque ${name}`;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return `malformed ${name}`;
    }
    if (!isTrustedPeer(parsed, host)) return `cross-origin ${name}`;
    sawPeer = true;
  }
  // ABSENT is not the same as SAFE. The attacker chooses whether a Referer is
  // emitted (`<meta name="referrer" content="no-referrer">`, or
  // `rel="noreferrer" target="_blank"`), and a top-level GET navigation never
  // carries an Origin — so "reject only what is present and cross-origin"
  // leaves the exact vector this guard exists to close wide open:
  // clawbox_session is SameSite=Lax, so it IS attached to that navigation, and
  // the rewrites below then present the request to the dashboard as
  // same-origin. Sec-Fetch-* can't rescue us either: those headers are only
  // sent to potentially-trustworthy origins, and this device is plain http on
  // a .local/LAN address.
  if (!sawPeer && !isBareDocumentNavigation(req)) {
    return "missing Origin and Referer";
  }
  return null;
}

// Where the ClawBox login page actually lives. The proxy owns every path on its
// own port, so we must send the browser to the ClawBox origin on :80 — derived
// from the request's own Host (already validated) so a renamed/re-addressed box
// keeps working.
function clawboxLoginUrl(req) {
  const host = splitHost(req.headers.host);
  const hostname = host && net.isIPv6(host.hostname) ? `[${host.hostname}]` : host && host.hostname;
  const suffix = CLAWBOX_WEB_PORT === 80 ? "" : `:${CLAWBOX_WEB_PORT}`;
  // No `redirect=` parameter: /login only honours a SAME-ORIGIN redirect target
  // (src/app/login/page.tsx), and the proxy is a different origin (:8090), so
  // any value we passed would be discarded. The user lands on the desktop and
  // re-opens the dashboard.
  return `http://${hostname}${suffix}/login`;
}

// True for requests the SPA makes programmatically, where a 302 to an HTML
// login page is useless (it either gets CORS-blocked or JSON.parse'd).
function wantsJsonError(req) {
  const p = String(req.url || "").split("?")[0].toLowerCase();
  if (p.startsWith("/api/") || p.startsWith("/auth/")) return true;
  const mode = String(req.headers["sec-fetch-mode"] || "").toLowerCase();
  if (mode === "cors" || mode === "websocket" || mode === "same-origin") return true;
  if (req.headers["x-requested-with"]) return true;
  const accept = String(req.headers.accept || "");
  return accept.includes("application/json") && !accept.includes("text/html");
}

// ---------------------------------------------------------------------------
// ClawBox session gate (same HMAC-SHA256 scheme as middleware / production-server)
// ---------------------------------------------------------------------------

// mtime-cached like readSessionGeneration below: this runs on EVERY request
// (including every WS upgrade), and the secret only changes on a re-provision.
let secretCache = { mtimeMs: -1, secret: "" };
function sessionSecret() {
  const env = (process.env.SESSION_SECRET || "").trim();
  if (env) return env;
  try {
    const p = path.join(CLAWBOX_ROOT, "data", ".session-secret");
    const st = fs.statSync(p);
    if (secretCache.mtimeMs === st.mtimeMs) return secretCache.secret;
    const secret = fs.readFileSync(p, "utf8").trim();
    secretCache = { mtimeMs: st.mtimeMs, secret };
    return secret;
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
// When the dashboard is down (or the password file is out of sync) a login
// attempt per request would hammer it and stall every response on a connect
// timeout. Remember the last failure and skip re-login until the cooldown.
let loginFailedAt = 0;
const LOGIN_RETRY_COOLDOWN_MS = 10_000;

function hermesLogin() {
  const pw = dashPassword();
  if (!pw) return Promise.resolve(null);
  const body = JSON.stringify({ provider: "basic", username: DASH_USERNAME, password: pw, next: "/" });
  return new Promise((resolve) => {
    // EVERY request needing SSO awaits this one promise (see ensureHermesCookies),
    // so it must settle exactly once and it must always settle. `settle` gives
    // both: later callers are ignored, and the deadline below guarantees one.
    let settled = false;
    let deadline = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(value);
    };

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
            settle(null);
            return;
          }
          // Build a Cookie header from each Set-Cookie's leading name=value.
          const cookieHeader = setCookies
            .map((sc) => String(sc).split(";", 1)[0])
            .filter(Boolean)
            .join("; ");
          settle({ cookieHeader, setCookies });
        });
      },
    );
    // An ABSOLUTE deadline, not a socket timeout. `setTimeout` on a request
    // measures INACTIVITY, so a dashboard that dribbles a byte just often
    // enough — a half-written response, a stuck chunked body — resets it
    // forever and never fires. The promise would then stay pending, and with
    // it every SSO request in the process. This bounds total login duration
    // regardless of how the upstream misbehaves; resolving null feeds the
    // existing failure path (cooldown, then retry).
    if (LOGIN_TIMEOUT_MS > 0) {
      deadline = setTimeout(() => {
        console.error(`[hermes-dashboard-proxy] login timed out after ${LOGIN_TIMEOUT_MS}ms`);
        reqUp.destroy();
        settle(null);
      }, LOGIN_TIMEOUT_MS);
      // Never hold the process open for a login that is only a retry away.
      deadline.unref?.();
    }
    reqUp.on("error", (e) => {
      console.error(`[hermes-dashboard-proxy] login error: ${e.message}`);
      settle(null);
    });
    reqUp.end(body);
  });
}

// Return cached Hermes cookies, logging in (once, de-duped) if needed.
// `forceRefresh` drops the cached session first — used when the upstream
// rejected it (expired TTL, or the dashboard restarted and rotated its signing
// secret), which is the only way the process ever picks up a new session.
async function ensureHermesCookies(forceRefresh) {
  if (hermesState && !forceRefresh) return hermesState;
  if (forceRefresh) hermesState = null;
  if (loginInFlight) return loginInFlight;
  if (Date.now() - loginFailedAt < LOGIN_RETRY_COOLDOWN_MS) return null;
  loginInFlight = hermesLogin().then((state) => {
    hermesState = state;
    loginFailedAt = state ? 0 : Date.now();
    loginInFlight = null;
    return state;
  });
  return loginInFlight;
}

function browserHasHermesSession(req) {
  return /(?:^|;\s*)hermes_session_at=/.test(req.headers.cookie || "");
}

// Cookie names the browser may be holding that our injected session replaces.
const HERMES_COOKIE_NAMES = ["hermes_session_at"];

// Splice a brokered Hermes session into the client's Cookie header, DROPPING
// any same-named cookie the browser already sent. Plain concatenation would
// produce `hermes_session_at=stale; hermes_session_at=fresh` and leave the
// dashboard picking whichever it parses first — usually the stale one, which
// silently defeats the whole re-login retry.
function mergeCookie(existing, injected) {
  const replaced = new Set(HERMES_COOKIE_NAMES);
  for (const pair of String(injected || "").split(/;\s*/)) {
    const name = pair.split("=")[0].trim().toLowerCase();
    if (name) replaced.add(name);
  }
  const kept = String(existing || "")
    .split(/;\s*/)
    .filter((pair) => pair && !replaced.has(pair.split("=")[0].trim().toLowerCase()));
  return kept.length ? `${kept.join("; ")}; ${injected}` : injected;
}

// Tell the browser to drop the Hermes session it is holding. Used when the
// dashboard rejected it and we could not broker a replacement — without this
// the stale cookie keeps steering every later request down the pass-through
// path, and the customer is stuck on the Hermes password form until they
// manually clear cookies or someone restarts the service.
function expireHermesCookies() {
  return HERMES_COOKIE_NAMES.map((n) => `${n}=; Path=/; Max-Age=0; HttpOnly`);
}

// ---------------------------------------------------------------------------
// HTTP proxy
// ---------------------------------------------------------------------------

// Forward one request upstream. `injected` (or null) is the Hermes cookie
// state to splice in for SSO. On a 401 while injecting, re-login once and
// retry — which is only possible when the request is replayable.
//
// `bodyBuf` has THREE states, and the difference matters:
//   Buffer     — body fully buffered here; replayable.
//   null       — request has no body at all (GET/HEAD); replayable (just end()).
//   undefined  — body is being streamed straight from `req`; NOT replayable,
//                and `req` may already be consumed, so it must never be piped
//                a second time (that hangs the upstream request forever).
function forward(req, res, injected, bodyBuf, allowRelogin) {
  const headers = { ...req.headers, host: UPSTREAM_AUTHORITY };
  // Present the upstream authority as Origin/Referer so the dashboard's
  // Host/Origin guard (which compares against its bound host) accepts us.
  // Safe only because checkRequestOrigin() already validated the real ones.
  if (headers.origin) headers.origin = UPSTREAM_ORIGIN;
  if (headers.referer) headers.referer = rewriteReferer(headers.referer);
  if (injected) {
    headers.cookie = mergeCookie(req.headers.cookie, injected.cookieHeader);
  }
  if (bodyBuf !== undefined) {
    // We control the framing now: exactly one of Content-Length /
    // Transfer-Encoding may describe what we send, and the client's original
    // values describe a body we are no longer relaying verbatim.
    delete headers["transfer-encoding"];
    if (bodyBuf === null) delete headers["content-length"];
    else headers["content-length"] = Buffer.byteLength(bodyBuf);
  }

  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (up) => {
      // Headers are in — the upstream is alive. The deadline is cleared by the
      // 'response' listener below; from here a slow body is legitimate (event
      // stream, slow download) and nothing may cut it.
      // The Hermes session was rejected (TTL elapsed, or the dashboard restarted
      // and rotated its signing secret) — re-broker once and replay.
      //
      // This fires for BOTH shapes, which is the point: `injected` means we
      // supplied the session, and `injected === null` here means the BROWSER
      // supplied one and it turned out to be stale. Handling only the first
      // shape left the second permanently broken — once a browser held any
      // hermes_session_at cookie the proxy never re-brokered again, so after
      // the 7-day session_ttl (or any dashboard restart) the customer got the
      // Hermes password form forever, with no recovery short of clearing
      // cookies.
      if (up.statusCode === 401 && allowRelogin && bodyBuf !== undefined) {
        up.resume(); // drain
        ensureHermesCookies(true).then((fresh) => {
          if (!fresh) {
            // Couldn't get a new session (dashboard down, or password desynced
            // — see scripts/setup-hermes-dashboard-auth.sh). Pass the 401 back
            // WITHOUT planting a session, and expire whatever the browser holds
            // so the next request retries the SSO path instead of this one.
            pipeResponse(res, up, null, expireHermesCookies());
            return;
          }
          forward(req, res, fresh, bodyBuf, false);
        });
        return;
      }
      pipeResponse(res, up, injected);
    },
  );
  // Answer the client with `status` unless the response is already under way.
  //
  // The socket can also error AFTER the response was fully piped and ended
  // (aborted keep-alive, dashboard restart mid-stream). Writing then is a
  // write-after-end, which Node raises as an 'error' event on the
  // ServerResponse — unhandled, that is an uncaught exception, and this
  // proxy is a single process, so it would take the whole service down.
  //
  // Also why the timeout and the error path can both fire for one request
  // without doubling up: whichever lands first writes, the other returns here.
  const failRequest = (status, message) => {
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(message);
  };

  // An ABSOLUTE deadline for "response headers complete", not a socket timeout.
  // A socket timer measures INACTIVITY, so an upstream trickling one header
  // byte at a time — or a stuck chunked header block — resets it forever: the
  // response callback never runs, the timer never fires, and the browser waits
  // with nothing to show. Same trap as the login path; bounded the same way.
  // Cleared once headers land, so a legitimately slow BODY is never cut.
  let headerDeadline = null;
  const clearHeaderDeadline = () => {
    if (headerDeadline) {
      clearTimeout(headerDeadline);
      headerDeadline = null;
    }
  };
  if (UPSTREAM_HEADERS_TIMEOUT_MS > 0) {
    headerDeadline = setTimeout(() => {
      // Respond FIRST, then tear down — see the Timeouts section at the top of
      // this file. 504 also says "the dashboard went quiet" rather than the 502
      // an incidental socket error would report.
      failRequest(504, "Hermes dashboard did not respond in time.");
      upstream.destroy();
    }, UPSTREAM_HEADERS_TIMEOUT_MS);
    headerDeadline.unref?.();
  }
  upstream.on("response", clearHeaderDeadline);
  upstream.on("error", () => {
    clearHeaderDeadline();
    failRequest(502, "Hermes dashboard is not reachable.");
  });
  upstream.on("close", clearHeaderDeadline);
  // Sink for any late stream error on the client connection, same reasoning.
  res.on("error", () => {});

  if (bodyBuf === undefined) {
    req.pipe(upstream);
  } else if (bodyBuf === null) {
    upstream.end();
  } else {
    upstream.end(bodyBuf);
  }
}

function pipeResponse(res, up, injected, extraSetCookies) {
  const headers = { ...up.headers };
  const relay = [];
  // NEVER hand the browser a session the dashboard just REJECTED. Relaying the
  // injected Set-Cookie on a 401/403 planted a cookie the upstream had already
  // refused, which then made browserHasHermesSession() true forever and locked
  // the customer out permanently — the realistic outcome whenever hermesLogin()
  // fails (e.g. a desynced password_hash).
  const rejected = up.statusCode === 401 || up.statusCode === 403;
  if (injected && !rejected) {
    // Relay Hermes's own Set-Cookie so the browser adopts the session and
    // sends it directly next time (no re-inject).
    relay.push(...injected.setCookies);
  }
  if (extraSetCookies && extraSetCookies.length) relay.push(...extraSetCookies);
  if (relay.length) {
    // Preserve any upstream Set-Cookie already present.
    const existing = headers["set-cookie"];
    headers["set-cookie"] = Array.isArray(existing) ? relay.concat(existing) : relay;
  }
  res.writeHead(up.statusCode || 502, headers);
  up.pipe(res);
}

function handleRequest(req, res) {
  // Cross-origin / rebind check FIRST: everything below rewrites Host and
  // Origin to the upstream authority, which would otherwise disarm the
  // dashboard's own guard.
  const rejection = checkRequestOrigin(req);
  if (rejection) {
    res.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(`Forbidden (${rejection}).`);
    return;
  }

  if (!hasValidSession(req)) {
    // XHR/API callers get a structured 401 they can act on; only real
    // navigations are redirected — and to the ClawBox origin on :80, since a
    // relative /login is served by THIS proxy (redirect loop).
    if (wantsJsonError(req)) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Authentication required", login: clawboxLoginUrl(req) }));
      return;
    }
    res.writeHead(302, {
      Location: clawboxLoginUrl(req),
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    res.end("Unauthorized — sign in to ClawBox first.");
    return;
  }

  // Browser already holds a Hermes session — pass through untouched. Bodyless
  // requests are still marked replayable (bodyBuf null, allowRelogin true) so
  // that a 401 from a stale/rotated session re-brokers SSO instead of dropping
  // the customer on the Hermes password form permanently. Requests WITH a body
  // stream straight through and cannot be retried.
  if (browserHasHermesSession(req)) {
    const method = (req.method || "GET").toUpperCase();
    const replayable = method === "GET" || method === "HEAD";
    forward(req, res, null, replayable ? null : undefined, replayable);
    return;
  }

  // No Hermes session yet: broker one (SSO). Buffer a small body so a 401
  // re-login can resend it; fall back to streaming for large uploads.
  ensureHermesCookies(false).then((injected) => {
    if (!injected) {
      // Login unavailable (no password / dashboard down): forward as-is and
      // let the dashboard render its own login page rather than hard-fail.
      forward(req, res, null, undefined, false);
      return;
    }
    const method = (req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      // Bodyless: replayable, so a 401 re-login CAN retry it. (Passing a
      // stream marker here is what previously made the retry unreachable for
      // every GET, pinning the Hermes session for the process lifetime.)
      forward(req, res, injected, null, true);
      return;
    }
    // A declared oversize body is streamed from the start — never buffered,
    // never retried. Anything else is buffered so a 401 can replay it.
    const declared = Number.parseInt(req.headers["content-length"] || "", 10);
    if (Number.isFinite(declared) && declared > MAX_RETRY_BODY) {
      forward(req, res, injected, undefined, false);
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      size += c.length;
      if (size > MAX_RETRY_BODY) {
        // Undeclared (chunked) body that outgrew the buffer: we already hold a
        // partial copy and cannot stream from the start, so fail cleanly rather
        // than forwarding a truncated body or piping an ended request.
        rejected = true;
        chunks.length = 0;
        res.writeHead(413, { "Content-Type": "text/plain", Connection: "close" });
        res.on("finish", () => { try { req.destroy(); } catch {} });
        res.end(`Request body exceeds the ${Math.round(MAX_RETRY_BODY / (1024 * 1024))} MB dashboard proxy limit.`);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      forward(req, res, injected, Buffer.concat(chunks), true);
    });
    req.on("error", () => { try { res.destroy(); } catch {} });
  });
}

// ---------------------------------------------------------------------------
// WebSocket upgrades — same gate, inject SSO cookies, raw splice upstream.
// ---------------------------------------------------------------------------

function handleUpgrade(req, clientSocket, head) {
  // Same guard as the HTTP path — the upgrade handler below rewrites Host and
  // Origin to the upstream authority, so the dashboard's WS Origin check can't
  // protect us. A same-origin SPA upgrade sends Origin == this proxy's
  // authority and passes.
  const rejection = checkRequestOrigin(req);
  if (rejection) {
    try { clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); } catch {}
    try { clientSocket.destroy(); } catch {}
    return;
  }
  if (!hasValidSession(req)) {
    try { clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch {}
    try { clientSocket.destroy(); } catch {}
    return;
  }
  const proceed = (injected) => {
    // Armed for TCP connect + the 101 handshake only. A dashboard that accepts
    // the socket and never completes the upgrade would otherwise leave the
    // browser's WebSocket pending indefinitely with no close frame; the client
    // gets an explicit 504 instead. Disarmed once the upstream's response
    // HEADERS are complete, because an established WebSocket is idle by design
    // and an idle timer past that point would drop healthy connections.
    //
    // Completion means the full header block, terminator included — NOT merely
    // "some byte arrived". A partial status line followed by silence is exactly
    // the wedged-upstream case this timeout exists for, and disarming on the
    // first byte would hand that case straight back to the hang.
    let handshakeComplete = false;
    const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
      const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
      let cookieWritten = false;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lower = name.toLowerCase();
        if (lower === "host") {
          headerLines.push(`${name}: ${UPSTREAM_AUTHORITY}`);
        } else if (lower === "origin") {
          // Must target the bound host or the dashboard's WS Origin guard
          // rejects the upgrade (closes before accept → browser code 1006).
          headerLines.push(`Origin: ${UPSTREAM_ORIGIN}`);
        } else if (lower === "referer") {
          headerLines.push(`Referer: ${rewriteReferer(req.rawHeaders[i + 1])}`);
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
      // Watch the upstream's bytes only until its response headers end, then
      // DETACH. This listener merely observes — pipe() above still delivers
      // every chunk to the client — but pipe has already registered a 'data'
      // handler, so leaving a second one attached would keep `_events.data` an
      // array for the life of the socket, and emit() clones that array on
      // every inbound chunk. Removing it restores the single-listener fast
      // path for the long-lived WebSocket that follows.
      //
      // Attached AFTER pipe() so the pipe is already consuming; both listeners
      // are registered in this same synchronous block, so no byte is lost.
      let sniffed = "";
      const onUpstreamData = (chunk) => {
        // latin1 keeps one byte per char, so the CRLF scan and the carry-over
        // slice below cannot be broken by a multi-byte sequence.
        const text = sniffed + chunk.toString("latin1");
        if (text.includes(HEADER_TERMINATOR)) {
          handshakeComplete = true;
          sniffed = "";
          upstream.setTimeout(0);
          upstream.off("data", onUpstreamData);
          return;
        }
        // Carry the tail so a terminator split across two chunks still matches.
        sniffed = text.slice(-(HEADER_TERMINATOR.length - 1));
      };
      upstream.on("data", onUpstreamData);
    });
    const kill = () => { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
    if (WS_HANDSHAKE_TIMEOUT_MS > 0) {
      upstream.setTimeout(WS_HANDSHAKE_TIMEOUT_MS, () => {
        if (handshakeComplete) return; // established WebSocket: idle is normal
        // `kill` on its own drops the connection with nothing written, so the
        // browser reports a bare 1006 and cannot tell a wedged dashboard from a
        // network blip. Write the status before tearing down.
        try { clientSocket.write(`HTTP/1.1 504 Gateway Timeout\r\nConnection: close${HEADER_TERMINATOR}`); } catch {}
        kill();
      });
    }
    upstream.on("error", kill);
    clientSocket.on("error", kill);
  };

  if (browserHasHermesSession(req)) {
    proceed(null);
  } else {
    ensureHermesCookies(false).then((injected) => proceed(injected));
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
//
// The server is BUILT here but only LISTENS under the main-module guard below.
// Calling listen() at import time meant nothing could load this file to check
// its behaviour without also binding :8090 — so the gate, the SSO broker and
// the timeouts above shipped to devices with no test covering any of them.

// ONE server per process. The Hermes session cache, the login cooldown and the
// upstream address are all module-scope, so two servers built here would share
// them — build a second only to assert something about a server that never
// listens, never to run two side by side.
function createProxyServer() {
  const srv = http.createServer(handleRequest);
  srv.on("upgrade", handleUpgrade);
  return srv;
}

if (require.main === module) {
  createProxyServer().listen(PORT, "0.0.0.0", () => {
    console.log(`[hermes-dashboard-proxy] :${PORT} -> ${UPSTREAM_AUTHORITY} (clawbox_session gated, Hermes SSO)`);
  });
}

module.exports = { createProxyServer, handleRequest, handleUpgrade };
