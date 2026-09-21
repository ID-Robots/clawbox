/**
 * Is this address one of OURS — loopback, private, link-local, multicast?
 *
 * Lifted out of the browser route, which has always had to answer it before
 * sending Chromium anywhere, because a second caller now needs exactly the same
 * answer: the delivery pipeline fetches and screenshots a deployment's URL
 * (the delivery pipeline), and that URL comes back from the host rather than
 * from this box. Two copies of a private-range table is precisely the shape of
 * a rule that is right in one place and a year stale in the other.
 *
 * Fails CLOSED everywhere it cannot tell: an unrecognised `::ffff:` shape is
 * private, and a host that does not resolve is not a public host.
 */
import net from "net";
import { lookup as dnsLookup } from "dns/promises";

/** True for loopback, private, CGNAT, link-local and multicast addresses. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // 100.64/10 CGNAT
    if (p[0] >= 224) return true;
    return false;
  }
  const lc = ip.toLowerCase();
  if (lc === "::1" || lc === "::") return true;
  // fe80::/10 link-local spans fe80–febf, not just the fe80 prefix; fc00::/7
  // unique-local is fc/fd. ff00::/8 is multicast.
  if (/^fe[89ab]/.test(lc) || lc.startsWith("fc") || lc.startsWith("fd") || lc.startsWith("ff")) return true;
  if (lc.startsWith("::ffff:")) {
    // IPv4-mapped IPv6. WHATWG URL normalizes these to the HEX form
    // (::ffff:7f00:1), so a plain recurse on the suffix (expecting dotted
    // ::ffff:127.0.0.1) misses loopback/private targets. Canonicalize both
    // forms to dotted IPv4; fail closed on any unrecognized ::ffff: shape.
    const mapped = lc.slice(7);
    if (net.isIPv4(mapped)) return isPrivateIp(mapped);
    const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hx) {
      const hi = parseInt(hx[1], 16), lo = parseInt(hx[2], 16);
      return isPrivateIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return true;
  }
  return false;
}

/**
 * getaddrinfo runs on the libuv threadpool (size 4 by default). A hostile or
 * dead resolver can hang each lookup for the OS timeout, and enough concurrent
 * callers would exhaust the pool and stall unrelated fs/crypto work. Cap the
 * wait so every caller fails closed instead of blocking indefinitely.
 */
export const DNS_TIMEOUT_MS = 3000;

export async function lookupWithTimeout(host: string): Promise<{ address: string }[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([dnsLookup(host, { all: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is `host` somewhere on the public internet?
 *
 * "localhost" and anything under `.localhost` are refused by name — they are
 * this box whatever the resolver currently says — and everything else is
 * resolved and every answer checked, because one A record pointing inside is
 * enough.
 */
export async function hostIsPublic(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (!bare) return false;
  if (bare === "localhost" || bare.endsWith(".localhost")) return false;
  if (net.isIP(bare)) return !isPrivateIp(bare);
  try {
    const results = await lookupWithTimeout(bare);
    if (results.length === 0) return false;
    return !results.some((r) => isPrivateIp(r.address));
  } catch {
    return false;
  }
}
