// Outbound HTTP for web_fetch / web_search, with the SSRF guard that keeps the
// agent off the box's own internal services.
//
// Without it, an agent steerable by any page it reads could pivot to the
// loopback setup API, Ollama, the CDP port, VNC, or cloud metadata (169.254).
// Carried over unchanged in substance from the previous implementation — this
// part was already correct.

import net from "net";
import { lookup as dnsLookup } from "dns/promises";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local / cloud metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // 100.64/10 CGNAT
    if (p[0] >= 224) return true; // multicast / reserved
    return false;
  }
  const lc = ip.toLowerCase();
  if (lc === "::1" || lc === "::") return true;
  if (/^fe[89ab]/.test(lc)) return true; // fe80::/10 link-local
  if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // fc00::/7 unique-local
  if (lc.startsWith("ff")) return true; // ff00::/8 multicast
  if (lc.startsWith("::ffff:")) {
    // IPv4-mapped IPv6. WHATWG URL normalises these to the HEX form
    // (::ffff:7f00:1), not dotted, so a plain recurse on the suffix misses
    // loopback targets. Canonicalise both forms; fail closed on anything else.
    const mapped = lc.slice(7);
    if (net.isIPv4(mapped)) return isPrivateIp(mapped);
    const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hx) {
      const hi = parseInt(hx[1], 16);
      const lo = parseInt(hx[2], 16);
      return isPrivateIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return true;
  }
  return false;
}

const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked internal address");
    return;
  }
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("blocked internal host");
  const results = await dnsLookup(host, { all: true });
  for (const r of results) {
    if (isPrivateIp(r.address)) throw new Error("blocked internal host");
  }
}

/**
 * fetch() that validates the host on every redirect hop and drops auth headers
 * across origins. (Residual TOCTOU DNS-rebind between lookup and connect is
 * accepted; closing it fully needs IP-pinned connects.)
 */
export async function safeFetch(url: string, init: RequestInit, maxRedirects = 5): Promise<Response> {
  let currentUrl = new URL(url);
  const headers = new Headers(init.headers);
  for (let i = 0; i <= maxRedirects; i++) {
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
      throw new Error("blocked redirect scheme");
    }
    await assertPublicHost(currentUrl.hostname);
    const res = await fetch(currentUrl, { ...init, headers, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, currentUrl);
      if (next.origin !== currentUrl.origin) {
        for (const h of SENSITIVE_HEADERS) headers.delete(h);
      }
      currentUrl = next;
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Crude but dependency-free HTML → readable text. */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|main)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*");
  text = text.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<pre>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-zA-Z]+;/g, " ");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
