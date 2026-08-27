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
import http from "node:http";
import https from "node:https";
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
    // Documentation and benchmarking ranges. Not routable on the internet, so
    // nothing legitimate serves an image from one — but a LAN is free to use
    // them internally, which is exactly the case this guard exists for.
    if (a === 198 && (b === 18 || b === 19)) return true;   // benchmarking
    if (a === 198 && b === 51) return true;                 // TEST-NET-2
    if (a === 203 && b === 0) return true;                  // TEST-NET-3
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

/** A hostname resolved to ONE address that every hop will be pinned to. */
interface Pin {
  address: string;
  family: number;
}

/**
 * Resolve a hostname, refuse it if ANY address it answers with is private, and
 * return the single address the connection will actually use.
 *
 * TWO guarantees, and the second is the one that is easy to miss:
 *
 *  1. Every address is checked, not just the first. A name that answers with
 *     one public and one loopback address is a rebinding attempt, and picking
 *     the public one to validate is exactly what makes the check useless.
 *
 *  2. The address is then PINNED, because validating a NAME and then handing
 *     that name to an HTTP client leaves a time-of-check/time-of-use gap: the
 *     client resolves it again when it opens the socket, and a hostile server
 *     answering with a short TTL can return a public address for our lookup
 *     and a private one for the client's. Losing that race would not be a
 *     blind request — a fetched image comes back to the owner as a `data:`
 *     URI, so it would read a LAN service and render it.
 */
async function resolvePin(hostname: string): Promise<Pin | null> {
  // `URL.hostname` KEEPS the brackets on an IPv6 literal — `http://[::1]/`
  // gives back "[::1]", which `net.isIP` does not recognise. Without this the
  // address would not be seen as a literal at all and would be handed to the
  // resolver instead of being refused outright.
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literal = net.isIP(bare);
  // A literal address in the URL never reaches a resolver, so there is no
  // second lookup that could disagree and nothing to pin against.
  if (literal) return isPrivateAddress(bare) ? null : { address: bare, family: literal };
  try {
    const results = await lookup(bare, { all: true, verbatim: true });
    if (results.length === 0) return null;
    if (results.some((r) => isPrivateAddress(r.address))) return null;
    return { address: results[0].address, family: results[0].family };
  } catch {
    return null;
  }
}

/** A URL this module is willing to aim a request at, with its pinned address. */
async function isFetchable(raw: string): Promise<{ url: URL; pin: Pin } | null> {
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
  const pin = await resolvePin(url.hostname);
  return pin ? { url, pin } : null;
}

/** What one hop produced. */
type Hop =
  | { kind: "redirect"; location: string }
  | { kind: "image"; mime: string; bytes: Buffer };

/**
 * One request, with its socket pinned to `pin.address`.
 *
 * `node:https` rather than `fetch`, and that is the whole point: its `lookup`
 * hook is what lets the address be decided by US instead of resolved again by
 * the client. The URL itself is left untouched, so SNI, the Host header and
 * certificate validation all still refer to the real hostname — rewriting the
 * URL to the IP would have quietly broken every one of them.
 *
 * Redirects are NOT followed here. The caller re-validates and re-pins each
 * hop, because a follower that only ever saw the first URL would walk happily
 * from a public host to 127.0.0.1.
 */
function requestPinned(url: URL, pin: Pin, signal: AbortSignal): Promise<Hop | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Hop | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const transport = url.protocol === "https:" ? https : http;
    let request: http.ClientRequest;
    try {
      request = transport.request(
        url,
        {
          method: "GET",
          signal,
          timeout: ONE_TIMEOUT_MS,
          headers: {
            // No cookies, no referer, no identifying agent string. The sender
            // learns that the image was fetched and nothing else.
            accept: "image/*",
            "user-agent": "ClawBox",
          },
          // THE PIN. Node asks for an array when it passed `all`, and for a
          // bare address otherwise; both shapes are answered with the one
          // address that was validated above.
          lookup: ((
            _hostname: string,
            options: { all?: boolean },
            callback: unknown,
          ) => {
            if (options?.all) {
              (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
                { address: pin.address, family: pin.family },
              ]);
              return;
            }
            (callback as (e: null, a: string, f: number) => void)(null, pin.address, pin.family);
          }) as never,
        },
        (response) => {
          const status = response.statusCode ?? 0;

          // A hop we are not going to read. Destroying it releases the socket
          // rather than leaving the connection pending on a device that has
          // few of them to spare.
          const discard = (value: Hop | null): void => {
            response.destroy();
            done(value);
          };

          if (status >= 300 && status < 400) {
            const location = response.headers.location;
            discard(location ? { kind: "redirect", location } : null);
            return;
          }
          if (status < 200 || status >= 300) {
            discard(null);
            return;
          }

          const type = (response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          const mime = type === "image/jpg" ? "image/jpeg" : type;
          // `nosniff` reasoning applied at the source: if the server does not
          // call it an image we will not treat it as one, whatever the bytes
          // turn out to look like.
          if (!ALLOWED_TYPES.has(mime)) {
            discard(null);
            return;
          }

          const declared = Number(response.headers["content-length"] ?? "");
          if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
            discard(null);
            return;
          }

          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.length;
            // A server that lied in Content-Length is stopped HERE, mid-stream,
            // and not after the whole thing has already been buffered.
            if (total > MAX_IMAGE_BYTES) {
              discard(null);
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            const bytes = Buffer.concat(chunks);
            done(bytes.length > 0 ? { kind: "image", mime, bytes } : null);
          });
          response.on("error", () => discard(null));
        },
      );
    } catch {
      // A malformed target that survived URL parsing.
      done(null);
      return;
    }

    // One unreachable or sulking tracker costs its own image and nothing else.
    request.on("error", () => done(null));
    request.on("timeout", () => {
      request.destroy();
      done(null);
    });
    request.end();
  });
}

/**
 * Fetch one image, following a bounded number of redirects and re-validating —
 * and re-pinning — the destination at every hop.
 */
async function fetchOne(
  start: { url: URL; pin: Pin },
  signal: AbortSignal,
): Promise<string | null> {
  let target = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (signal.aborted) return null;
    const result = await requestPinned(target.url, target.pin, signal);
    if (!result) return null;
    if (result.kind === "image") {
      return `data:${result.mime};base64,${result.bytes.toString("base64")}`;
    }
    let next: URL;
    try {
      next = new URL(result.location, target.url);
    } catch {
      return null;
    }
    const checked = await isFetchable(next.toString());
    if (!checked) return null;
    target = checked;
  }
  return null;
}

/**
 * Fetch the images a message references, returning a URL → `data:` URI map.
 *
 * `signal` is the owner's own request: closing the panel stops the outbound
 * work instead of leaving it running against its own deadline.
 *
 * Failures are silent by design — one unreachable tracker must not turn "show
 * me this email" into an error. An image that could not be fetched simply
 * stays blocked, which is the state the owner started in.
 */
export async function fetchRemoteImages(
  urls: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const budget = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let spent = 0;

  for (const raw of urls.slice(0, MAX_IMAGES)) {
    if (budget.aborted || spent >= MAX_TOTAL_BYTES) break;
    const target = await isFetchable(raw);
    if (!target) continue;
    const data = await fetchOne(target, budget);
    if (!data) continue;
    // The data: URI is roughly 4/3 of the bytes; budget on what is actually
    // going into the response, not on the wire size.
    spent += data.length;
    if (spent > MAX_TOTAL_BYTES) break;
    out.set(raw, data);
  }
  return out;
}
