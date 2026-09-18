// scripts/host-allowlist.js
//
// The names the web server on :80/:443 answers to — the CommonJS mirror of
// src/lib/host-allowlist.ts, which carries the reasoning. production-server.js
// needs its own copy because WebSocket upgrades never pass through Next's
// middleware: without this, a page on a foreign name that resolves to the box
// (`intranet` from a hostile DHCP search domain) could open /terminal-ws with
// the owner's SameSite=Lax cookie and drive a shell, whatever the middleware
// refuses over HTTP. src/tests/unit/host-allowlist-parity.test.ts runs one
// table over both copies, so a rule added to one and not the other fails.
//
// The tunnel differs by construction: middleware cannot see the socket and
// admits cloudflared by CF-Connecting-IP (which scripts/proxy-peer.js strips
// from non-loopback peers); here the socket IS visible, so a loopback peer is
// admitted directly — cloudflared, and every local process that already acts
// as the owner.
//
// CommonJS for the same reason scripts/proxy-peer.js is.

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { isLoopback } = require("./proxy-peer.js");

const DEFAULT_ALLOWED_HOSTS = "clawbox.local,10.42.0.1,10.43.0.1,localhost";
const DEFAULT_ORIGINS_PATH = "/home/clawbox/clawbox/data/control-ui-origins.json";
const BOX_TUNNEL_SUFFIX = ".clawbox.tech";
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Both copied from src/lib/control-ui-origins.ts, which originHostname() below
// mirrors rule for rule.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const FORBIDDEN_RAW_ORIGIN_RE = /[\\%]|[^\x20-\x7e]/;

function parseHostHeader(raw) {
  const value = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!value) return null;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(value);
  if (v6) return { hostname: v6[1], port: v6[2] || null };
  const parts = value.split(":");
  if (parts.length > 2) return null;
  const hostname = parts[0].replace(/\.$/, "");
  if (!hostname) return null;
  if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return null;
  return { hostname, port: parts[1] || null };
}

function allowedHostsFromEnv() {
  return new Set(
    (process.env.ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS)
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Per call: a rename runs `hostnamectl set-hostname` and restarts nothing.
function systemHostLabel() {
  let label;
  try {
    label = os.hostname().trim().toLowerCase().split(".")[0];
  } catch {
    return null;
  }
  return LABEL_RE.test(label) ? label : null;
}

function isLabels(value, count) {
  const labels = value.split(".");
  return labels.length === count && labels.every((l) => LABEL_RE.test(l));
}

/**
 * The hostname of ONE configured origin, in the form a Host header carries it
 * (an IPv6 literal bare, without its brackets), or null for an entry this box
 * will not trust.
 *
 * A rule-for-rule mirror of `normalizeOrigin()` in src/lib/control-ui-origins.ts
 * — the SAME parser (`new URL`, the WHATWG one) in the same order, not a regex
 * of its own. A regex was the first attempt and diverged immediately: `\d{1,5}`
 * accepts `:99999`, which `new URL` throws on, so an entry the middleware
 * dropped entirely would have had its hostname admitted here — and an upgrade
 * this admits and the middleware refuses is exactly what the two copies exist
 * to prevent (/terminal-ws is a shell). The remaining rules below are the same
 * class of trap: `127.1` and `010.0.0.1` are hostnames to a regex and canonical
 * dotted quads to WHATWG.
 *
 * Kept honest by src/tests/unit/host-allowlist-parity.test.ts, which feeds one
 * table of origin files through both copies and compares the admitted set.
 */
function originHostname(raw) {
  if (typeof raw !== "string") return null;
  if (FORBIDDEN_RAW_ORIGIN_RE.test(raw)) return null;
  const value = raw.trim();
  if (!value || value.includes("*")) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;

  // `@` in the authority is userinfo even when empty (`http://@host`), which
  // url.username cannot see once WHATWG has stripped it.
  const rawAuthority = value.slice(value.indexOf("://") + 3).split(/[/?#]/)[0];
  if (rawAuthority.includes("@")) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.search || url.hash) return null;

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return null;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const bare = hostname.slice(1, -1);
    return net.isIPv6(bare) ? bare : null;
  }
  if (!HOSTNAME_RE.test(hostname)) return null;
  if (/^[0-9.]+$/.test(hostname) && !net.isIPv4(hostname)) return null;
  // WHATWG rewrites IPv4 shorthand ("127.1", "010.0.0.1", "2130706433") to a
  // canonical dotted quad. Only trust one that was already written that way.
  if (net.isIPv4(hostname) && rawAuthority.replace(/:\d+$/, "").toLowerCase() !== hostname) return null;
  return hostname;
}

// Hostnames of the owner-configured control UI origins. A missing, unreadable,
// non-JSON or non-array file is no origins at all — never a throw, since this
// runs in front of every upgrade.
function configuredOriginHosts() {
  const file = process.env.CLAWBOX_CONTROL_UI_ORIGINS_FILE || DEFAULT_ORIGINS_PATH;
  const hosts = new Set();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return hosts;
  }
  if (!Array.isArray(data)) return hosts;
  for (const entry of data) {
    const hostname = originHostname(entry);
    if (hostname) hosts.add(hostname);
  }
  return hosts;
}

// The box's own named-tunnel hostname — mirrors readNamedTunnelHostnameSync()
// in src/lib/named-tunnel.ts: the `hostname=` line of the credential file,
// exactly one label under clawbox.tech, and only while a `token=` line is
// there too. The token itself is read past, never kept.
function namedTunnelHostname() {
  const file =
    process.env.CLAWBOX_NAMED_TUNNEL_FILE ||
    path.join(process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data", "cloudflared", "named-tunnel");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let hostname = null;
  let token = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("hostname=")) hostname = line.slice("hostname=".length).trim();
    else if (line.startsWith("token=")) token = line.slice("token=".length).trim();
  }
  if (!hostname || !hostname.endsWith(BOX_TUNNEL_SUFFIX)) return null;
  if (!LABEL_RE.test(hostname.slice(0, -BOX_TUNNEL_SUFFIX.length))) return null;
  if (!token || !/^[A-Za-z0-9+/_=-]{32,4096}$/.test(token)) return null;
  return hostname;
}

function isAllowedHostname(hostname) {
  if (!hostname) return false;
  if (allowedHostsFromEnv().has(hostname)) return true;
  if (net.isIP(hostname)) return true;
  if (hostname.endsWith(".local") && LABEL_RE.test(hostname.slice(0, -".local".length))) return true;
  if (hostname.endsWith(".ts.net") && isLabels(hostname.slice(0, -".ts.net".length), 2)) return true;
  if (hostname === systemHostLabel()) return true;
  if (hostname === namedTunnelHostname()) return true;
  return configuredOriginHosts().has(hostname);
}

function isAllowedHostHeader(raw) {
  const parsed = parseHostHeader(raw);
  return parsed !== null && isAllowedHostname(parsed.hostname);
}

/**
 * May this upgrade proceed? A loopback peer always may (cloudflared, local
 * processes); anyone else must have addressed the box by one of its own names.
 * Never throws — it runs in front of every upgrade.
 */
function isAllowedUpgrade(req) {
  try {
    const peer = req && req.socket && req.socket.remoteAddress;
    if (isLoopback(peer)) return true;
    return isAllowedHostHeader(req && req.headers && req.headers.host);
  } catch {
    return false;
  }
}

module.exports = {
  configuredOriginHosts,
  namedTunnelHostname,
  isAllowedHostHeader,
  isAllowedHostname,
  isAllowedUpgrade,
  parseHostHeader,
  systemHostLabel,
};
