// URL and domain matching shared by the service, the extension and the tests.
//
// Rules:
//  - Entries match a page by registrable domain (eTLD+1, private suffixes such
//    as github.io count as suffixes), exact host matches rank first.
//  - Localhost and IP literals have no registrable domain: they only match the
//    exact host and port.
//  - Filling is only ever allowed over https://, or http:// on localhost.
//  - IDN hosts are compared in their ASCII (punycode) form, so a Unicode entry
//    URL and the punycode page URL match, while look-alike hosts do not.
import { getDomain } from "tldts";
import { isIpLiteral, isLocalhost, isSecureOrLocal } from "./hosts";

export { isIpLiteral, isLocalhost };

export type MatchKind = "exact" | "domain";

export function parseWebUrl(input: string | null | undefined): URL | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  return url;
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** https:// anywhere, http:// only on localhost. */
export function isFillAllowedUrl(input: string | URL | null | undefined): boolean {
  const url = typeof input === "string" || input == null ? parseWebUrl(input ?? null) : input;
  if (!url) return false;
  return isSecureOrLocal(url.protocol, url.hostname);
}

/** eTLD+1 of a host; the host itself for localhost and IP literals. */
export function registrableDomain(hostname: string): string | null {
  const h = bareHost(hostname);
  if (!h) return null;
  if (isLocalhost(h) || isIpLiteral(h)) return h;
  const domain = getDomain(h, { allowPrivateDomains: true });
  return domain ? domain.toLowerCase() : null;
}

/** Origin string (scheme://host[:port]) or null when the URL is not a web URL. */
export function originOf(input: string | null | undefined): string | null {
  const url = parseWebUrl(input);
  return url ? url.origin : null;
}

/** Host part kept in the audit log: never paths or query strings. */
export function hostOf(input: string | null | undefined): string | null {
  const url = parseWebUrl(input);
  return url ? url.host : null;
}

/**
 * How an entry URL matches a page URL, or null.
 * The page URL must be fillable (https, or http on localhost).
 */
export function matchUrl(entryUrl: string | null | undefined, pageUrl: string | null | undefined): MatchKind | null {
  const entry = parseWebUrl(entryUrl);
  const page = parseWebUrl(pageUrl);
  if (!entry || !page) return null;
  if (!isFillAllowedUrl(page)) return null;

  const entryHost = bareHost(entry.hostname);
  const pageHost = bareHost(page.hostname);
  const local = isLocalhost(entryHost) || isIpLiteral(entryHost) || isLocalhost(pageHost) || isIpLiteral(pageHost);
  if (local) {
    return entry.host.toLowerCase() === page.host.toLowerCase() ? "exact" : null;
  }
  // An https page never matches an entry pinned to a non-default port elsewhere.
  if (entry.port && entry.port !== page.port) return null;
  if (entryHost === pageHost) return "exact";
  const a = registrableDomain(entryHost);
  const b = registrableDomain(pageHost);
  if (a && b && a === b) return "domain";
  return null;
}

/**
 * Whether a frame at `frameUrl` may receive an entry's credentials:
 * fillable scheme and a URL match.
 */
export function frameMayReceive(entryUrl: string | null | undefined, frameUrl: string | null | undefined): boolean {
  return matchUrl(entryUrl, frameUrl) !== null;
}

/**
 * The URL an entry is matched by: its `url:` field, or the first segment of its
 * name when that looks like a domain (e.g. "github.com/alice").
 */
export function entryMatchUrl(entry: { name: string; url?: string | null }): string | null {
  if (entry.url && parseWebUrl(entry.url)) return entry.url;
  const site = entry.name.split("/")[0] ?? "";
  if (/^[^\s/]+\.[^\s/]+$/.test(site) && registrableDomain(parseWebUrl(site)?.hostname ?? "")) {
    return `https://${site}`;
  }
  return null;
}

export interface Matchable {
  name: string;
  url?: string | null;
}

/** Entries matching a page, exact-host matches first, then by name. */
export function rankMatches<T extends Matchable>(entries: T[], pageUrl: string): Array<T & { match: MatchKind }> {
  const out: Array<T & { match: MatchKind }> = [];
  for (const e of entries) {
    const kind = matchUrl(entryMatchUrl(e), pageUrl);
    if (kind) out.push({ ...e, match: kind });
  }
  out.sort((a, b) => {
    if (a.match !== b.match) return a.match === "exact" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Default entry name for a captured login: "<domain>/<login>". */
export function defaultEntryName(pageUrl: string, login: string): string {
  const url = parseWebUrl(pageUrl);
  const host = url ? bareHost(url.hostname) : "site";
  const site = (url && !isLocalhost(host) && !isIpLiteral(host) ? registrableDomain(host) : host) ?? host;
  const account = sanitizeSegment(login) || "login";
  return `${sanitizeSegment(site) || "site"}/${account}`;
}

function sanitizeSegment(s: string): string {
  return s
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\]+/g, "_")
    .replace(/^[.-]+/, "")
    .slice(0, 100);
}
