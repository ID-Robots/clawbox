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
const { isLoopback } = require("./proxy-peer.js");

const DEFAULT_ALLOWED_HOSTS = "clawbox.local,10.42.0.1,10.43.0.1,localhost";
const DEFAULT_ORIGINS_PATH = "/home/clawbox/clawbox/data/control-ui-origins.json";
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ORIGIN_RE = /^https?:\/\/([a-z0-9.-]+)(?::\d{1,5})?\/?$/i;

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

// Hostnames of the owner-configured control UI origins. Only a DNS name matters
// here — an IP literal is admitted on its own — so a plain origin shape is
// enough; anything else in the file is ignored, never thrown over.
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
    if (typeof entry !== "string") continue;
    const match = ORIGIN_RE.exec(entry.trim());
    if (!match) continue;
    const hostname = match[1].toLowerCase();
    if (hostname.split(".").every((l) => LABEL_RE.test(l))) hosts.add(hostname);
  }
  return hosts;
}

function isAllowedHostname(hostname) {
  if (!hostname) return false;
  if (allowedHostsFromEnv().has(hostname)) return true;
  if (net.isIP(hostname)) return true;
  if (hostname.endsWith(".local") && LABEL_RE.test(hostname.slice(0, -".local".length))) return true;
  if (hostname.endsWith(".ts.net") && isLabels(hostname.slice(0, -".ts.net".length), 2)) return true;
  if (hostname === systemHostLabel()) return true;
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
  isAllowedHostHeader,
  isAllowedHostname,
  isAllowedUpgrade,
  parseHostHeader,
  systemHostLabel,
};
