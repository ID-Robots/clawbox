// ── Fetching the pictures a message points at, only when asked ───────────────
//
// A remote image in an email is a read receipt. The URL is unique to the
// recipient, and loading it tells the sender that this person opened this
// message, when, and from roughly where. That is why the full view blocks them
// by default and why this module runs ONLY after the owner has clicked.
//
// THIS IS NOT AN OPEN PROXY, and the reason is structural rather than a matter
// of validation. The caller never supplies a URL. The route re-reads the
// message from the mailbox, `remoteImageUrls` extracts the URLs the MESSAGE
// contains, and only those are fetched. There is no request shape that can aim
// this code at an address of the caller's choosing — the worst an attacker can
// do is put a URL in an email and persuade the owner to press "load images",
// which is exactly the request a mail client is supposed to be able to make.
//
// The SSRF guard below is therefore a second line, not the first. It exists
// because "the URL came from an email" still means "a stranger chose it", and
// this device sits on a home LAN with other things on it: a router admin page,
// a printer, a NAS, the ClawBox's own loopback services. A message that embeds
// `<img src="http://192.168.1.1/reboot">` must not get a free request to it
// merely because the owner wanted to see a logo.
//
// WHY THE DEVICE FETCHES RATHER THAN THE BROWSER: the dashboard's CSP allows
// `img-src 'self' data: blob:` and deliberately does not allow `https:`.
// Loading images in the browser would mean widening that policy for every page
// in the app to serve one feature — trading a global guarantee for a local
// convenience. Fetching here and handing the bytes back as `data:` URIs keeps
// the CSP exactly as strict as it is today, and has the side benefit that the
// sender learns the device's address rather than anything about the browser.

import { lookup } from "node:dns/promises";
import net from "node:net";

/** Most images fetched for one message. */
const MAX_IMAGES = 20;
/** Largest single image accepted, in bytes. */
const MAX_IMAGE_BYTES = 512 * 1024;
/** Total budget across the message, so one mail cannot fill the response. */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** Whole-batch deadline. A slow tracker must not hold the request open. */
const TOTAL_TIMEOUT_MS = 12_000;
/** Per-request deadline. */
const ONE_TIMEOUT_MS = 6_000;
/** Redirects followed, each re-validated from scratch. */
const MAX_REDIRECTS = 2;

/** The image types a browser will paint and our sanitiser will accept back. */
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
]);

/**
 * True when an address belongs to the device, the LAN, or any other range that
 * is not the public internet.
 *
 * Everything a mail image could legitimately want lives on a public address.
 * Anything else is either this appliance talking to itself or something else on
 * the owner's network, and neither is a picture in an email.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true;                     // "this network"
    if (a === 10) return true;                    // private
    if (a === 127) return true;                   // loopback
    if (a === 169 && b === 254) return true;      // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // carrier-grade NAT
    if (a === 192 && b === 0) return true;        // IETF protocol assignments
    if (a >= 224) return true;                    // multicast and reserved
    return false;
  }
  if (version === 6) {
    const value = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
    if (value === "::" || value === "::1") return true;
    // IPv4 mapped/compatible — re-check the embedded address rather than
    // letting `::ffff:127.0.0.1` through as "some IPv6 address".
    const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^f[cd]/.test(value)) return true;        // unique local
    if (/^fe[89ab]/.test(value)) return true;     // link-local
    if (/^ff/.test(value)) return true;           // multicast
    return false;
  }
  // Not an IP at all: refuse rather than guess.
  return true;
}

/**
 * Resolve a hostname and refuse it if ANY address it answers with is private.
 *
 * Every address is checked, not just the first: a name that resolves to one
 * public and one loopback address is a DNS-rebinding attempt, and picking the
 * public one to validate is exactly the mistake that makes the check useless.
 */
async function hostIsPublic(hostname: string): Promise<boolean> {
  // A bare IP in the URL never reaches a resolver, so check it directly.
  if (net.isIP(hostname)) return !isPrivateAddress(hostname);
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

/** A URL this module is willing to aim a request at. */
async function isFetchable(raw: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Credentials in an image URL are a way to make the device authenticate
  // somewhere on the owner's behalf.
  if (url.username || url.password) return null;
  if (!(await hostIsPublic(url.hostname))) return null;
  return url;
}

/** Read a capped number of bytes, aborting the moment the cap is passed. */
async function readCapped(response: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  const body = response.body;
  if (!body) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // A server that lied in Content-Length is stopped here, not after the
      // whole thing has already been buffered.
      if (total > limit) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch one image, following a bounded number of redirects and re-validating
 * the destination at every hop.
 *
 * Redirects are followed MANUALLY (`redirect: "manual"`) for that reason: the
 * built-in follower would happily walk from a public host to `127.0.0.1`,
 * because the guard only ever saw the first URL.
 */
async function fetchOne(start: URL, signal: AbortSignal): Promise<string | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const timer = AbortSignal.timeout(ONE_TIMEOUT_MS);
    const merged = AbortSignal.any([signal, timer]);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: merged,
        headers: {
          // No cookies, no referer, no identifying agent string. The sender
          // learns that the image was fetched and nothing else.
          accept: "image/*",
          "user-agent": "ClawBox",
        },
        cache: "no-store",
      });
    } catch {
      return null;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return null;
      }
      const checked = await isFetchable(next.toString());
      if (!checked) return null;
      url = checked;
      continue;
    }

    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const mime = type === "image/jpg" ? "image/jpeg" : type;
    // `nosniff` reasoning applied at the source: if the server does not call it
    // an image we will not treat it as one, whatever the bytes look like.
    if (!ALLOWED_TYPES.has(mime)) return null;
    // A body that errors mid-stream must cost this one image, not the whole
    // batch: "show me this email" has to survive one misbehaving tracker.
    let bytes: Buffer | null;
    try {
      bytes = await readCapped(response, MAX_IMAGE_BYTES);
    } catch {
      return null;
    }
    if (!bytes || bytes.length === 0) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  return null;
}

/**
 * Fetch the images a message references, returning a URL → `data:` URI map.
 *
 * Failures are silent by design: one unreachable tracker must not turn "show me
 * this email" into an error. An image that could not be fetched simply stays
 * blocked, which is the same state the owner started in.
 */
export async function fetchRemoteImages(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  let spent = 0;

  for (const raw of urls.slice(0, MAX_IMAGES)) {
    if (deadline.aborted || spent >= MAX_TOTAL_BYTES) break;
    const url = await isFetchable(raw);
    if (!url) continue;
    const data = await fetchOne(url, deadline);
    if (!data) continue;
    // The data: URI is roughly 4/3 of the bytes; budget on what is actually
    // going into the response, not on the wire size.
    spent += data.length;
    if (spent > MAX_TOTAL_BYTES) break;
    out.set(raw, data);
  }
  return out;
}
