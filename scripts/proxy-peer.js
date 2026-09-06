// scripts/proxy-peer.js
//
// Who may tell this box where a request came from.
//
// /login-api throttles failed passwords in TWO buckets: `global` (always, capped
// at five minutes so nobody can drive it to the 24 h tier) and `cf:<ip>` from
// CF-Connecting-IP, which gets the full escalating schedule because behind the
// Cloudflare tunnel the edge rewrites that header and it is a real per-client
// identity. On the LAN there is no edge: the box serves plain HTTP with no
// reverse proxy, and CF-Connecting-IP is whatever the client typed. A direct
// client could therefore pick its own `cf:` bucket — escaping the 30 min / 24 h
// escalation by minting a fresh value per request (the global cap still bounds
// it) — or, worse, write `cf:<the owner's public IP>` twenty times and lock the
// owner out of the tunnel for a day.
//
// A Next route handler never sees the socket, so the ONE process that does —
// production-server.js, which owns the http.Server — settles it here: when the
// peer is NOT loopback, the client-supplied proxy-identity headers are deleted
// from `req.headers` before Next's own listener builds the route's Request. A
// LAN client then lands on `global` exactly as a header-less client does today.
// On this box the only legitimate source of those headers is cloudflared,
// which connects from loopback (`scripts/run-tunnel.sh` targets
// http://localhost:80), so a request from anywhere else carrying them is lying.
//
// Trusting loopback trusts every LOCAL process along with cloudflared: both
// harnesses, a coding-agent run, the box's own Chromium, a Terminal `curl`.
// Each of those already acts as the owner (they hold the owner's shell or the
// device bearer), so choosing a lockout bucket is no new capability for them —
// but it is the boundary this file draws, and it is said here on purpose.
//
// Deliberately NOT touched: the x-forwarded-* family. The login route never
// consults X-Forwarded-For (TASK-444c), Next synthesises x-forwarded-proto
// itself, and OpenClaw's gateway treats the family as forwarded-client evidence
// that production-server.js already strips on the hop to it.
//
// CommonJS for the same reason scripts/access-log.js is: production-server.js
// is CJS and has to be — it monkey-patches http.Server.prototype.listen before
// Next's standalone bundle is required.

/**
 * The headers a client may use to name itself to the lockout. The same three
 * are in production-server.js's FORWARDED_CLIENT_HEADERS (the upgrade proxy's
 * strip set); this list is the subset that picks a bucket.
 */
const PROXY_IDENTITY_HEADERS = ["cf-connecting-ip", "cf-connecting-ipv6", "true-client-ip"];

/** ::ffff:192.168.1.5 is how a v4 client shows up on a dual-stack listener. */
function normalizeIp(value) {
  if (!value) return null;
  return String(value).replace(/^::ffff:/i, "");
}

/**
 * The whole of 127.0.0.0/8 and ::1, in their v4-mapped form too. A later `::`
 * bind would deliver the tunnel on ::1 or ::ffff:127.0.0.1, and a check that
 * only knew "127.0.0.1" would silently strip the edge's real header and drop
 * every tunnel user to `global` alone — safe, and invisible.
 */
function isLoopback(address) {
  const ip = normalizeIp(address);
  if (!ip) return false;
  if (ip === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/**
 * Delete the proxy-identity headers from a request whose socket peer is not
 * loopback. Mutates `req.headers` in place — Node builds that object from
 * rawHeaders once and caches it, and Next's NodeNextRequest reads exactly that
 * object — and returns whether anything was removed.
 *
 * A request whose peer cannot be read at all (no socket) is treated as
 * untrusted: an unattributable client must not get to choose its bucket. Never
 * throws — this runs in front of every request the box answers.
 */
function stripUntrustedProxyHeaders(req) {
  try {
    const headers = req && req.headers;
    if (!headers || typeof headers !== "object") return false;
    const peer = req.socket && req.socket.remoteAddress;
    if (isLoopback(peer)) return false;
    let stripped = false;
    for (const name of PROXY_IDENTITY_HEADERS) {
      if (Object.prototype.hasOwnProperty.call(headers, name)) {
        delete headers[name];
        stripped = true;
      }
    }
    return stripped;
  } catch {
    return false;
  }
}

/**
 * Attach the guard to an http.Server. `prependListener`, not `on`: Next's
 * handler is registered at createServer time and the headers have to be gone
 * before it runs. Attach it before the access log too, so the access line
 * records the honest client address rather than a forged cf value.
 *
 * HTTPS needs no second attachment — production-server.js re-emits every TLS
 * request onto this same server, with the TLS socket as `req.socket`.
 */
function attachProxyPeerGuard(server) {
  server.prependListener("request", (req) => {
    stripUntrustedProxyHeaders(req);
  });
  return true;
}

module.exports = {
  PROXY_IDENTITY_HEADERS,
  attachProxyPeerGuard,
  isLoopback,
  normalizeIp,
  stripUntrustedProxyHeaders,
};
