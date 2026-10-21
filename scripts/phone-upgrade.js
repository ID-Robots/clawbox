// The phone link: the one WebSocket path a paired phone uses to reach the
// OpenClaw gateway, and the gate production-server.js puts in front of it.
//
// A phone pairs over the box's permanent clawbox.tech link. cloudflared
// connects to production-server.js from 127.0.0.1 and the upgrade proxy pipes
// the socket on to the gateway on 127.0.0.1 too. Every other gateway upgrade
// has its forwarded-client headers DROPPED (see FORWARDED_CLIENT_HEADERS in
// production-server.js), so the gateway sees a clean loopback client — which
// OpenClaw treats as a process on the box itself and silently approves its
// first pairing and its scope upgrades (core 2026.10.3:
// `resolveGatewayIngressAttribution` → `direct-local`,
// `resolvePairingLocality` → `direct_local`, `shouldAllowSilentLocalPairing`).
// For the box's own pages that is the intended behaviour. For a phone on the
// other side of the world it is not: the owner approves each phone in the box
// UI, and a phone must never be mistaken for the box.
//
// So the phone link rebuilds the attribution instead of dropping it: whatever
// forwarded headers the client sent are discarded by the caller, and these are
// added in their place, naming the address the PROXY saw. The gateway honours
// them because `gateway.trustedProxies` lists loopback while phone pairing is
// on (src/lib/phone-pairing.ts writes it through the core's own `config set`),
// and resolves the connection to `trusted-proxy` with the phone's real address
// — remote, never local. Raw loopback requests with no forwarded headers stay
// `direct-local` with that setting: the core checks that case first.
//
// Shared with the Next.js side (src/lib/phone-pairing.ts) so the path, the
// switch's key and the rule for reading it cannot drift apart.

const net = require("net");
const { isLoopback, normalizeIp } = require("./proxy-peer.js");

/** Where every phone pairing code points: `wss://<boxHandle>.clawbox.tech/phone-ws`. */
const PHONE_WS_PATH = "/phone-ws";

/** The owner's switch in data/config.json. Absent means OFF. */
const PHONE_PAIRING_CONFIG_KEY = "phone_pairing_enabled";

/**
 * The one rule, on a parsed data/config.json: only the boolean `true` is on.
 * A string "true", 1 or an absent key all read as off — phones reaching the
 * gateway is a consent, never a default.
 */
function phonePairingEnabledFromConfig(config) {
  return !!config && typeof config === "object" && config[PHONE_PAIRING_CONFIG_KEY] === true;
}

function singleHeader(req, name) {
  const value = req && req.headers ? req.headers[name] : undefined;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * One spelling per address, or null for anything that is not an IP literal.
 * IPv6 is compressed and lower-cased the way WHATWG URL serializes it, and a
 * v4-mapped address becomes dotted IPv4 — so `0:0:0:0:0:0:0:1`, `::0` and
 * `0:0:0:0:0:ffff:127.0.0.1` reach the loopback and unspecified checks as
 * `::1`, `::` and `127.0.0.1` instead of slipping past them. A zone id is kept.
 */
function canonicalIp(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const family = net.isIP(raw);
  if (family === 4) return raw;
  if (family !== 6) return null;
  const zoneAt = raw.indexOf("%");
  const zone = zoneAt === -1 ? "" : raw.slice(zoneAt);
  let host;
  try {
    host = new URL(`http://[${zoneAt === -1 ? raw : raw.slice(0, zoneAt)}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return host + zone;
}

/** An address the gateway can attribute: an IP literal that is not loopback or unspecified, in its canonical spelling. */
function attributableIp(value) {
  const ip = canonicalIp(value);
  if (!ip) return null;
  if (isLoopback(ip) || ip === "0.0.0.0" || ip === "::") return null;
  return ip;
}

/**
 * Who is on the other end of a phone-link upgrade, or null when the proxy
 * cannot say.
 *
 *  - Through the tunnel (socket peer is loopback): Cloudflare's
 *    CF-Connecting-IP. Only cloudflared and processes on the box itself can
 *    connect from loopback, and a local process that claims to be remote only
 *    makes itself LESS trusted.
 *  - From the LAN (any other peer): the socket's own address. A CF header from
 *    a LAN peer is the client's claim, not Cloudflare's, and is ignored —
 *    the same rule scripts/proxy-peer.js applies to HTTP requests.
 *  - A loopback peer with no usable CF-Connecting-IP is unattributable: it
 *    would reach the gateway looking local, which is what this link exists to
 *    prevent, so it is refused.
 */
function phoneClientAddress(req) {
  const peer = normalizeIp(req && req.socket && req.socket.remoteAddress);
  if (!peer) return null;
  if (!isLoopback(peer)) return attributableIp(peer);
  return attributableIp(singleHeader(req, "cf-connecting-ip") || singleHeader(req, "cf-connecting-ipv6"));
}

/**
 * The verdict for one phone-link upgrade, in authorizeUpgrade's shape:
 * `{ ok: true, identity: null, forwarded }` to proxy it with these headers in
 * place of the client's own, or `{ ok: false, status }` to refuse it.
 *
 * 404 while phone pairing is switched off: the link does not exist then.
 * 403 when the client cannot be attributed.
 */
function authorizePhoneUpgrade(req, enabled) {
  if (enabled !== true) return { ok: false, status: 404 };
  const address = phoneClientAddress(req);
  if (!address) return { ok: false, status: 403 };
  const peer = normalizeIp(req.socket && req.socket.remoteAddress);
  const viaTunnel = isLoopback(peer);
  const encrypted = !!(req.socket && req.socket.encrypted);
  return {
    ok: true,
    identity: null,
    forwarded: {
      "X-Forwarded-For": address,
      // The tunnel's edge always terminates TLS for the clawbox.tech name.
      "X-Forwarded-Proto": viaTunnel || encrypted ? "https" : "http",
    },
  };
}

module.exports = {
  PHONE_WS_PATH,
  PHONE_PAIRING_CONFIG_KEY,
  phonePairingEnabledFromConfig,
  phoneClientAddress,
  authorizePhoneUpgrade,
};
