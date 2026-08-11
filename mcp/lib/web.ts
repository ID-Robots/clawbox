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

// Named entities we decode to a real character. Everything else that looks like
// a named entity becomes a space (see decodeEntities).
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode HTML entities in ONE pass.
 *
 * A chain of `.replace()` calls cannot do this correctly: whichever entity is
 * decoded first re-exposes its output to every later pattern, so `&amp;lt;`
 * (a literal "&lt;" on the page) came out as "<". One pass over the input, with
 * each match resolved from a table, has no such ordering to get wrong.
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (_m: string, dec?: string, hex?: string, name?: string) => {
      const code = dec ? parseInt(dec, 10) : hex ? parseInt(hex, 16) : NaN;
      if (Number.isFinite(code)) {
        // Reject out-of-range and surrogate code points rather than throwing.
        if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[(name || "").toLowerCase()] ?? " ";
    },
  );
}

/**
 * Strip tags until the result stops changing.
 *
 * A single pass is not enough: removing the inner tag of `<<div>script>` leaves
 * `<script>`, i.e. one pass can CREATE a tag it already walked past. Iterating
 * to a fixed point is the only version of this that terminates with no tags
 * left, and each pass strictly shortens the string so the loop is bounded.
 */
export function stripTagsToFixedPoint(text: string): string {
  let prev: string;
  let out = text;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, "");
  } while (out !== prev);
  return out;
}

/** Crude but dependency-free HTML → readable text. */
/**
 * Remove a raw-text element and everything inside it.
 *
 * The end tag is `</name` followed by anything up to the first ">", because an
 * end tag may legally carry attribute-like text — `</script foo="bar">` closes
 * the element just as `</script>` does, and a pattern anchored on `>` alone
 * walks past it and leaves the whole body in the text handed to the model.
 * Requiring whitespace or ">" after the name keeps `</scriptish>` from matching.
 *
 * Applied to a fixed point: removing one element can splice the text on either
 * side into a new opening tag, so a single pass is not enough.
 */
function stripRawTextElement(text: string, name: string): string {
  const paired = new RegExp(`<${name}\\b[\\s\\S]*?</${name}(?:\\s[^>]*)?>`, "gi");
  let prev: string;
  let out = text;
  do {
    prev = out;
    out = out.replace(paired, "");
  } while (out !== prev);
  // An UNCLOSED element (truncated page, or deliberately so) never matches the
  // pair above; drop from the opening tag to the end rather than letting the
  // body through as prose.
  return out.replace(new RegExp(`<${name}\\b[\\s\\S]*$`, "i"), "");
}

export function htmlToText(html: string): string {
  let text = html;
  text = stripRawTextElement(text, "script");
  text = stripRawTextElement(text, "style");
  text = stripRawTextElement(text, "noscript");
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
  text = stripTagsToFixedPoint(text);
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
