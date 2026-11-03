/**
 * Local HTTPS in the browser (docs/design/local-https.md, "Moving the
 * browser"): a page the owner opened on http://<IP> (or <name>.local) moves to
 * the box's https://<id>.lan.clawbox.com — but only once THIS browser has
 * reached that address itself.
 *
 * Why the browser and not a server redirect: whether the name resolves is
 * decided by the resolver the BROWSER uses. A router with DNS-rebind
 * protection drops a public name that answers with a private address, and a
 * 301 from the box would then strand the owner on a DNS error page with no
 * way back to the http address that works. So the box only says where the
 * secure address is and that its certificate is valid
 * (/setup-api/local-https/hint); the page fetches that address (no-cors: a
 * DNS failure, a refused connection or a certificate the browser does not
 * trust all reject the fetch) and moves only when it answered. A probe that
 * failed is not repeated in the same tab.
 */

export const LOCAL_HTTPS_HINT_PATH = "/setup-api/local-https/hint";
export const PROBE_TIMEOUT_MS = 3_500;
export const PROBE_FAILED_KEY = "clawbox:local-https-probe-failed";

const URL_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lan\.clawbox\.com(?::\d{1,5})?$/;

export interface LocationLike {
  protocol: string;
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
}

/** Only a page on plain HTTP and not on loopback ever considers moving. */
export function mayMove(location: LocationLike): boolean {
  if (location.protocol !== "http:") return false;
  const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host !== "localhost" && !host.startsWith("127.") && host !== "::1";
}

/** The `url` of a hint answer, when it is one this page may go to. */
export function hintTarget(body: unknown): string | null {
  const url = (body as { url?: unknown } | null)?.url;
  return typeof url === "string" && URL_RE.test(url) ? url : null;
}

/** The same page on the secure origin. */
export function movedUrl(target: string, location: LocationLike): string {
  return `${target}${location.pathname}${location.search}${location.hash}`;
}

/** Can this browser reach `target`? Resolves false on DNS, TLS, network failure or timeout. */
export async function probeLocalHttps(
  target: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(`${target}${LOCAL_HTTPS_HINT_PATH}`, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the box where its secure address is: the url, or null. Never throws. */
export async function fetchHint(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(LOCAL_HTTPS_HINT_PATH, { cache: "no-store" });
    if (!res.ok) return null;
    return hintTarget(await res.json());
  } catch {
    return null;
  }
}
