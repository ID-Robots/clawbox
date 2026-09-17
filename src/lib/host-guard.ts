import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { resolveConfigRoot } from "./config-store";
import {
  loadConfiguredOrigins,
  normalizeOrigin,
  resolveOriginsPath,
} from "./control-ui-origins";

/**
 * Which names this box is willing to be addressed as.
 *
 * WHY. A browser sends whatever name the user typed in the `Host` header, and
 * until this module existed `src/middleware.ts` never looked at it: any name
 * that resolved to the box was served, and `src/lib/same-origin.ts` then
 * measured "same origin" against that very header, so it agreed with whatever
 * the caller claimed. That is the DNS-rebinding shape — an attacker publishes
 * `evil.example` with a one-second TTL and re-points it at the box's LAN
 * address while their page is open.
 *
 * What that buys the attacker, precisely, because the scope of every gate here
 * follows from it: NOT the owner's session. `clawbox_session` is set with no
 * `Domain` (src/app/login-api/route.ts), so it is host-only — after the rebind
 * the browser sends the attacker's own cookies, not the box's. What the
 * attacker gets is the box's ORIGIN, and with it same-origin READ of everything
 * the box serves without a cookie: the bootstrap `/setup-api` allow-list on a
 * box that has not finished setup or was just factory-reset (from which the
 * wizard can be driven and the owner password set), the public gateway assets,
 * a public webapp, an `/apps/<id>/` proxy — and `isSameOriginRequest()` itself,
 * which compares the Origin's host with the request's Host and therefore says
 * "yes" to a page whose Origin IS the rebound name.
 *
 * The guard is the one already written for the gateway proxy's reflection
 * decision (`isReflectableHost` + the configured control-UI origins), lifted
 * here unchanged so the proxy and the middleware cannot drift apart. The set
 * the middleware admits is a strict SUPERSET of what the proxy will reflect —
 * it also admits an IPv6 literal, a `.ts.net` name and the tunnel hostname,
 * none of which `isReflectableHost()` returns true for. Widening either one
 * does not widen the other; `isAllowedRequestHost()` is the middleware's list
 * and `isReflectableHost()` is the proxy's.
 *
 * Its sibling in `scripts/hermes-dashboard-proxy.js` is a separate process that
 * cannot import TypeScript; `ALLOWED_HOSTS`'s default and `MDNS_LABEL_RE` are
 * kept identical in both, and src/tests/unit/host-guard.test.ts asserts it.
 *
 * HARNESS-FIRST NOTE. OpenClaw does keep a list of the origins this box is
 * reachable on — `gateway.controlUi.allowedOrigins`, rebuilt by
 * `scripts/gateway-pre-start.sh` on every boot from the configured mDNS name,
 * both AP addresses and every live LAN IPv4, and already read and written from
 * TypeScript by `src/lib/openclaw-config.ts`. It is not used as the source
 * here because it is BOOT-FROZEN: it cannot follow a rename (TASK-808) or a new
 * tunnel hostname without restarting the gateway, and this guard decides
 * whether the box answers at all, so a stale entry there would lock the owner
 * out until a reboot. The operator-supplied half of that same list —
 * `data/control-ui-origins.json`, validated by `control-ui-origins.ts` and by
 * the gateway's own `scripts/gateway_origins.py` — IS the mechanism used for a
 * custom origin, rather than a second store.
 *
 * Ports are deliberately not part of the decision (except for an exactly
 * configured origin): the box listens on one port, and a rebind is about the
 * NAME.
 */

const ALLOWED_PROTOS = new Set(["http", "https"]);

/**
 * Where the gateway proxy sends a browser when it cannot reflect the request's
 * own host. It lives here, not in gateway-proxy.ts, because the guard has to
 * admit it: an operator who points CANONICAL_ORIGIN at their own name without
 * also listing it would otherwise be redirected straight into a 421.
 */
export const CANONICAL_ORIGIN = process.env.CANONICAL_ORIGIN || "http://clawbox.local";

function canonicalOriginHost(): string | null {
  try {
    return new URL(CANONICAL_ORIGIN).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || "clawbox.local,10.42.0.1,10.43.0.1,localhost")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

// Single hostname label — letters/digits/hyphens, no dots, no leading/trailing
// hyphen. It validates the nodename's first label below, and we append `.local`
// to that ourselves; allowing dots in the input would let a host header like
// `evil..local` slip through host comparison. Same regex as MDNS_LABEL_RE in
// scripts/hermes-dashboard-proxy.js, and as HOSTNAME_RE in the rename route, so
// every name a rename can produce is a label all three accept.
const MDNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The names this box calls itself, from the kernel's nodename: the BARE
 * hostname and its `<label>.local` form. The bare one is what a router that
 * registers the DHCP hostname, or a LAN with a DNS search domain, serves the
 * desktop on (`http://clawbox/`) — TASK-808. The LAN-domain form
 * (`clawbox.lan`) is deliberately not derived: its only source is the
 * DHCP-supplied search domain, so admitting `<nodename>.<whatever DHCP says>`
 * would let a hostile DHCP server nominate a publicly registrable name as a
 * rebind target.
 *
 * Read per call, never cached for the process lifetime: a rename applies
 * `hostnamectl set-hostname` without restarting this server, so a name captured
 * at first use would answer for the old one for the rest of the process's life.
 */
export function systemHostnames(): string[] {
  let label: string;
  try {
    // A nodename carrying a domain (`clawbox.lan`) still yields `clawbox`.
    label = os.hostname().trim().toLowerCase().split(".")[0];
  } catch (err) {
    // Both of this box's own names have just disappeared from the allow-list;
    // that must not be silent.
    console.warn(`[host-guard] could not read the system hostname: ${errorText(err)}`);
    return [];
  }
  if (!MDNS_LABEL_RE.test(label)) return [];
  return [label, `${label}.local`];
}

// A Tailscale MagicDNS name, `<machine>.<tailnet>.ts.net`.
//
// README, control-ui-origins.ts and scripts/gateway_origins.py all promise that
// a `.ts.net` name reaches the box with no configuration, and the firewall keeps
// 100.64/10 open for it as "a documented ClawBox feature"
// (src/tests/unit/clawbox-firewall-policy.test.ts). Before this guard existed
// that was true by omission — the middleware answered to everything. It has to
// stay true by construction.
//
// Admitted the way scripts/hermes-dashboard-proxy.js admits any `<label>.local`,
// and for the same reason: a MagicDNS name resolves ONLY inside a tailnet the
// device is a member of, so a remote attacker cannot publish one that a victim's
// browser will resolve to this box. The narrower rule — only
// `<nodename>.<tailnet>.ts.net` — was rejected because the Tailscale machine
// name is renamed independently of the kernel nodename in the admin console, and
// a guard that silently 421s a renamed machine restores the feature only for the
// default case. The residual is a box whose owner joins a HOSTILE tailnet, who
// by then has network-level access to it anyway.
const TS_NET_SUFFIX = ".ts.net";

function isTailscaleName(hostname: string): boolean {
  if (!hostname.endsWith(TS_NET_SUFFIX)) return false;
  const labels = hostname.slice(0, -TS_NET_SUFFIX.length).split(".");
  // At least `<machine>.<tailnet>`, every label well-formed — so `..ts.net` and
  // `evil..ts.net` are not names, they are ways past a suffix test.
  return labels.length >= 2 && labels.every((label) => MDNS_LABEL_RE.test(label));
}

/**
 * The gateway proxy's reflection predicate, unchanged.
 *
 * Without renamed-host support, ALLOWED_HOSTS was frozen to `clawbox.local`
 * at install time, so any rename bounced the user to a NXDOMAIN page when
 * the gateway was busy and we fell back to CANONICAL_ORIGIN.
 */
export function isReflectableHost(rawHost: string): boolean {
  if (ALLOWED_HOSTS.has(rawHost)) return true;
  if (net.isIPv4(rawHost)) return true;
  // Last, so a listed name or a LAN IP is answered without the uname(2) call.
  if (systemHostnames().includes(rawHost)) return true;
  return false;
}

// Trusted control UI origins — a narrow escape hatch for genuinely
// cross-origin/custom-origin deployments (see control-ui-origins.ts and
// README). Unlike isReflectableHost() above (host-only, scheme/port-
// agnostic), a configured origin must match EXACTLY: scheme, host, and
// port (including a non-default port) all have to agree with an entry in
// the configured list. A configured hostname does not get reflected on a
// different scheme or port than what was configured.
let cachedConfiguredOrigins: Set<string> | undefined;
let cachedConfiguredOriginsSignature: string | undefined;

/**
 * Identity + mtime of a file, as a cache key. `missing` is a value like any
 * other, so a file that appears or is deleted invalidates the cache too.
 */
function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${filePath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function getConfiguredOrigins(): Set<string> {
  const originsPath = resolveOriginsPath();
  const signature = fileSignature(originsPath);
  if (
    cachedConfiguredOrigins !== undefined &&
    cachedConfiguredOriginsSignature === signature
  ) {
    return cachedConfiguredOrigins;
  }

  const { origins, warnings } = loadConfiguredOrigins(originsPath);
  for (const warning of warnings) {
    console.warn(`[host-guard] ${warning}`);
  }
  cachedConfiguredOrigins = new Set(origins);
  cachedConfiguredOriginsSignature = signature;
  return cachedConfiguredOrigins;
}

export function isConfiguredOrigin(proto: string, hostHeader: string): boolean {
  const { origin } = normalizeOrigin(`${proto}://${hostHeader}`);
  return origin !== null && getConfiguredOrigins().has(origin);
}

/** The request's scheme, from the proxy hop in front of us. Defaults to http. */
export function requestProto(headers: Headers): string {
  const rawProto = headers.get("x-forwarded-proto");
  return (
    rawProto
      ?.split(",")
      .map((t) => t.trim().toLowerCase())
      .find((t) => ALLOWED_PROTOS.has(t)) ?? "http"
  );
}

// ─── The public hostname the tunnel publishes ────────────────────────────────
//
// cloudflared forwards the request with the PUBLIC name in Host
// (`<x>.trycloudflare.com`), which is neither this box's own name nor an IP, so
// without this the guard would 421 the whole of Remote Access.
//
// The app already knows that name and writes it down in two places — no third
// store is invented here:
//   - data/cloudflared/tunnel.url, written by scripts/run-tunnel.sh for
//     clawbox-tunnel.service (src/lib/cloudflared.ts `TUNNEL_URL_FILE`), and
//     REMOVED when the unit stops, so a retired hostname stops being admitted;
//   - data/tunnel-url.txt, written by the in-app spawned tunnel
//     (src/lib/tunnel.ts), removed by stopTunnel().
// Both paths are re-derived here rather than imported, so the middleware bundle
// does not pull in child_process through those modules;
// src/tests/unit/host-guard.test.ts asserts the two spellings still agree.
//
// Read per request behind an mtime cache, never probed once: the unit restarts
// on failure and every restart publishes a NEW hostname, so a set captured at
// startup would lock the owner out of the address they were just given.

/** Shape of a Cloudflare Quick Tunnel URL — mirrors cloudflared.ts. */
const TUNNEL_URL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/i;

/** The two files the app already writes the public hostname into. Exported for the drift test. */
export function tunnelUrlFiles(): string[] {
  const root = resolveConfigRoot();
  return [
    path.join(root, "data", "cloudflared", "tunnel.url"),
    path.join(process.env.CLAWBOX_DATA_DIR || path.join(root, "data"), "tunnel-url.txt"),
  ];
}

let cachedTunnelHosts: Set<string> | undefined;
let cachedTunnelSignature: string | undefined;

export function tunnelHostnames(): Set<string> {
  const files = tunnelUrlFiles();
  const signature = files.map(fileSignature).join("|");
  if (cachedTunnelHosts !== undefined && cachedTunnelSignature === signature) {
    return cachedTunnelHosts;
  }

  const hosts = new Set<string>();
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8").trim();
    } catch {
      // A missing file is the normal "no tunnel" case and says nothing.
      continue;
    }
    // Shape-checked, never trusted as free text: this file decides who the box
    // answers to, and a truncated or hand-edited line must widen nothing. It is
    // also the state cloudflared.ts documents as real, and it takes remote
    // access down — so it is reported rather than swallowed.
    if (!TUNNEL_URL_PATTERN.test(raw)) {
      console.warn(
        `[host-guard] ${file} does not hold a quick-tunnel URL; the public `
        + "hostname is not admitted. Remote Access will answer 421 until the "
        + "tunnel republishes it."
      );
      continue;
    }
    try {
      hosts.add(new URL(raw).hostname.toLowerCase());
    } catch (err) {
      console.warn(`[host-guard] ${file} is not a parsable URL: ${errorText(err)}`);
    }
  }

  cachedTunnelHosts = hosts;
  cachedTunnelSignature = signature;
  return hosts;
}

// ─── Recovery ────────────────────────────────────────────────────────────────
//
// An operator who narrowed ALLOWED_HOSTS wrongly, or whose box answers to a
// name none of the sources above can see, must not be locked out of their own
// device. `HOST_GUARD=off` in the web server's environment file
// (/home/clawbox/clawbox/.env, read by config/clawbox-setup.service) followed
// by a restart admits every Host again:
//
//     ssh clawbox@<box>
//     echo 'HOST_GUARD=off' >> /home/clawbox/clawbox/.env
//     sudo -n systemctl restart clawbox-setup
//
// `.env` is owned by the clawbox user, so anything running as that user — SSH,
// the in-UI terminal, the agent's run_command — can switch this off, which is
// the same reasoning that moved the EDITION lock to root-owned
// /etc/clawbox/edition.env (the last EnvironmentFile= of that unit, deliberately
// after .env). The difference is that the edition lock defends a commercial SKU
// against its own owner, while this defends the owner against a remote page: the
// clawbox user already owns the source tree this guard is compiled from and can
// restart the unit, so a root-owned file would move the switch, not close it.
// The warning below is what makes it visible instead.
//
// Deliberately NOT in a customer-facing doc: it turns the rebind guard off for
// the whole device, and it is a recovery step, not a setting.

const HOST_GUARD_OFF_VALUES = new Set(["off", "0", "false", "no"]);
// Once per request would drown the journal; exactly once per process would mean
// a box left with the guard off says so in a boot message nobody reads again.
// Hourly is often enough to find in `journalctl -u clawbox-setup` weeks later.
const ESCAPE_HATCH_LOG_INTERVAL_MS = 60 * 60 * 1000;
let escapeHatchLoggedAt = 0;

/** True when the operator has switched the guard off in the unit's environment. */
export function isHostGuardDisabled(): boolean {
  const value = process.env.HOST_GUARD?.trim().toLowerCase();
  if (!value || !HOST_GUARD_OFF_VALUES.has(value)) return false;
  const now = Date.now();
  if (escapeHatchLoggedAt === 0 || now - escapeHatchLoggedAt >= ESCAPE_HATCH_LOG_INTERVAL_MS) {
    escapeHatchLoggedAt = now;
    console.warn(
      "[host-guard] HOST_GUARD is off — every Host header is admitted. "
      + "This device has no DNS-rebinding protection until the setting is "
      + "removed from its environment file."
    );
  }
  return true;
}

// ─── The decision ────────────────────────────────────────────────────────────

/**
 * Split a Host header into its hostname and port. Handles `[::1]:8090`, and
 * returns the hostname WITHOUT brackets. Mirrors splitHost() in
 * scripts/hermes-dashboard-proxy.js.
 */
export function splitHostHeader(raw: string | null | undefined): { hostname: string; port: string } | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(value);
  if (v6) return { hostname: v6[1], port: v6[2] || "" };
  const parts = value.split(":");
  if (parts.length > 2) return null; // bare IPv6 without brackets — not valid in a Host header
  const hostname = parts[0];
  if (!hostname) return null;
  if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return null;
  return { hostname, port: parts[1] || "" };
}

/**
 * The host the request was addressed to: the Host header first, the URL's as a
 * fallback — the same order src/lib/same-origin.ts reads it in. The fallback is
 * what a non-browser caller that speaks HTTP/1.0 relies on.
 */
export function requestHostHeader(headers: Headers, fallbackHost: string): string {
  return (headers.get("host")?.trim() || fallbackHost || "").toLowerCase();
}

/**
 * Is this a name this box answers to?
 *
 * Ordered so the two addresses the docs advertise are answered without a
 * uname(2) or a stat():
 *   1. `isReflectableHost` — ALLOWED_HOSTS (`clawbox.local`, the two AP
 *      addresses, `localhost`), any IPv4 literal, then this box's own name,
 *      bare and `.local`, read per call so a rename needs no restart;
 *   2. any IPv6 literal — an address cannot be DNS-rebound, and `[::1]` is how
 *      some on-box callers reach :80 (see install-x64.sh's loopback list);
 *   3. a Tailscale MagicDNS name;
 *   4. the host CANONICAL_ORIGIN redirects to, so the fallback redirect cannot
 *      land on a 421;
 *   5. the hostname the tunnel published, or an exactly configured control-UI
 *      origin (scheme + host + port).
 */
export function isAllowedRequestHost(headers: Headers, fallbackHost: string): boolean {
  if (isHostGuardDisabled()) return true;
  const hostHeader = requestHostHeader(headers, fallbackHost);
  const split = splitHostHeader(hostHeader);
  if (!split) return false;
  const { hostname } = split;
  if (isReflectableHost(hostname)) return true;
  if (net.isIPv6(hostname)) return true;
  if (isTailscaleName(hostname)) return true;
  if (hostname === canonicalOriginHost()) return true;
  if (tunnelHostnames().has(hostname)) return true;
  return isConfiguredOrigin(requestProto(headers), hostHeader);
}

/**
 * The names to put in front of an owner who typed one the box does not know.
 *
 * This box's own names and the configured defaults — never the tunnel hostname
 * or a configured origin, which are not this caller's business, and never a
 * loopback name: whoever is reading this reached the box over the network, and
 * `localhost` would send them to their own machine.
 */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function advertisedHostNames(): string[] {
  const names: string[] = [];
  for (const name of [...systemHostnames(), ...ALLOWED_HOSTS]) {
    if (!LOOPBACK_NAMES.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** A Host header is caller-controlled; echo only printable ASCII, and not much of it. */
function displayHost(raw: string): string {
  const clipped = raw.slice(0, 64);
  return clipped.replace(/[^\x20-\x7e]|[<>]/g, "?") || "(no name)";
}

/**
 * The body of the 421. Plain text, a few lines, and it NAMES the addresses that
 * work — the owner who typed a name their router invented needs to be told what
 * to type instead, not just refused.
 */
export function misdirectedRequestBody(hostHeader: string): string {
  return [
    `This ClawBox does not answer to the name "${displayHost(hostHeader)}".`,
    "",
    "Open it at one of these instead, or at its IP address on your network:",
    ...advertisedHostNames().map((name) => `  ${name}`),
    "",
  ].join("\n");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
