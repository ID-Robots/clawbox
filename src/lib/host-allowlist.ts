import { statSync } from "fs";
import net from "net";
import os from "os";
import { loadConfiguredOrigins, resolveOriginsPath } from "@/lib/control-ui-origins";

/**
 * The names the app on port 80 answers to.
 *
 * WHY. The session cookie is host-only and SameSite=Lax. A browser attaches it
 * to a top-level navigation on whatever name the owner's browser used to reach
 * the box, and a page served on that SAME name can read everything the box
 * answers. So a name that resolves to the box but is not one of its own —
 * `intranet` handed out by a hostile DHCP search domain, a hosts entry, a
 * rebinding record — would be an origin an attacker's page shares with the
 * owner's desktop. The Hermes dashboard proxy (scripts/hermes-dashboard-proxy.js)
 * has refused such names since it shipped; this is the same allow-list for the
 * app itself, applied by src/middleware.ts and, for WebSocket upgrades that
 * never reach Next, by production-server.js through scripts/host-allowlist.js
 * (a CommonJS mirror of this file — src/tests/unit/host-allowlist-parity.test.ts
 * runs one table over both).
 *
 * Admitted, in order of cost:
 *   1. ALLOWED_HOSTS (default `clawbox.local,10.42.0.1,10.43.0.1,localhost`) —
 *      the proxy's list and gateway-proxy.ts's, one env var for all three.
 *   2. Any IP literal. A rebinding attack needs a NAME it controls; an address
 *      the browser typed is the box itself.
 *   3. `<label>.local` — mDNS-only, not registrable by a remote party, and any
 *      label, because a rename changes it without restarting this server.
 *   4. `<label>.<label>.ts.net` — a Tailscale MagicDNS machine name, a
 *      documented way to reach the box (scripts/clawbox-firewall.sh keeps CGNAT
 *      open for it). The zone is Tailscale's; nobody else answers for it.
 *   5. The box's own bare nodename, read per call so a rename is followed.
 *   6. The host of an owner-configured control UI origin
 *      (data/control-ui-origins.json, src/lib/control-ui-origins.ts) — the
 *      documented escape hatch for a reverse proxy on another name.
 *
 * Deliberately NOT admitted: `<nodename>.<search domain>` (`clawbox.lan`). The
 * only source of that suffix is DHCP, which is exactly the party this refuses
 * to trust. A box reached that way still has `.local`, its IP and its bare name.
 *
 * The Cloudflare tunnel is not a name at all (its Host is the tunnel's own
 * `*.trycloudflare.com` or a custom domain); the caller admits it by its
 * `CF-Connecting-IP`, which scripts/proxy-peer.js deletes from every request
 * whose socket peer is not loopback — see `isTunnelRequest`.
 */

const DEFAULT_ALLOWED_HOSTS = "clawbox.local,10.42.0.1,10.43.0.1,localhost";

/** One DNS label. Same regex as MDNS_LABEL_RE in the dashboard proxy and gateway-proxy.ts. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ParsedHost {
  hostname: string;
  port: string | null;
}

/** Split a Host header into hostname and port. `[::1]:80` → `::1`. Null when malformed. */
export function parseHostHeader(raw: string | null | undefined): ParsedHost | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(value);
  if (v6) return { hostname: v6[1], port: v6[2] ?? null };
  const parts = value.split(":");
  if (parts.length > 2) return null;
  const hostname = parts[0].replace(/\.$/, "");
  if (!hostname) return null;
  if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return null;
  return { hostname, port: parts[1] ?? null };
}

function allowedHostsFromEnv(): Set<string> {
  return new Set(
    (process.env.ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS)
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The kernel's nodename as one label, or null. Per call: a rename restarts nothing. */
export function systemHostLabel(): string | null {
  let label: string;
  try {
    label = os.hostname().trim().toLowerCase().split(".")[0];
  } catch {
    return null;
  }
  return LABEL_RE.test(label) ? label : null;
}

function isLabels(value: string, count: number): boolean {
  const labels = value.split(".");
  return labels.length === count && labels.every((l) => LABEL_RE.test(l));
}

let configuredHosts: { signature: string; hosts: Set<string> } | null = null;

function configuredOriginHosts(): Set<string> {
  const file = resolveOriginsPath();
  let signature: string;
  try {
    const st = statSync(file);
    signature = `${file}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    signature = `${file}:missing`;
  }
  if (configuredHosts?.signature === signature) return configuredHosts.hosts;
  const hosts = new Set<string>();
  if (!signature.endsWith(":missing")) {
    for (const origin of loadConfiguredOrigins(file).origins) {
      try {
        hosts.add(new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, ""));
      } catch {
        // loadConfiguredOrigins only returns parseable origins; nothing to add.
      }
    }
  }
  configuredHosts = { signature, hosts };
  return hosts;
}

/** Is `hostname` (already lower-cased, brackets stripped) one of this box's own names? */
export function isAllowedHostname(hostname: string): boolean {
  if (!hostname) return false;
  if (allowedHostsFromEnv().has(hostname)) return true;
  if (net.isIP(hostname)) return true;
  if (hostname.endsWith(".local") && LABEL_RE.test(hostname.slice(0, -".local".length))) return true;
  if (hostname.endsWith(".ts.net") && isLabels(hostname.slice(0, -".ts.net".length), 2)) return true;
  if (hostname === systemHostLabel()) return true;
  return configuredOriginHosts().has(hostname);
}

/** Is the raw Host header one this box answers to? A missing or malformed one is not. */
export function isAllowedHostHeader(raw: string | null | undefined): boolean {
  const parsed = parseHostHeader(raw);
  return parsed !== null && isAllowedHostname(parsed.hostname);
}

/**
 * A request cloudflared delivered. Only meaningful behind production-server.js,
 * whose scripts/proxy-peer.js deletes CF-Connecting-IP(v6) from every request
 * whose socket peer is not loopback — so a LAN browser cannot claim to be the
 * tunnel, while the tunnel (which connects from loopback) always carries it.
 */
export function isTunnelRequest(headers: Headers): boolean {
  return Boolean(headers.get("cf-connecting-ip")?.trim() || headers.get("cf-connecting-ipv6")?.trim());
}
