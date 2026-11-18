// Host helpers without the public-suffix list, small enough for the content
// script that runs in every page.

function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

export function isIpLiteral(hostname: string): boolean {
  const h = bare(hostname);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

export function isLocalhost(hostname: string): boolean {
  const h = bare(hostname);
  return h === "localhost" || h.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(h) || h === "::1";
}

/** https:// anywhere, http:// only on localhost. */
export function isSecureOrLocal(protocol: string, hostname: string): boolean {
  if (protocol === "https:") return true;
  return protocol === "http:" && isLocalhost(hostname);
}

/**
 * Hosts of the card-field iframes of the payment providers the vault fills
 * into (on https, default port only), and only when the human started the fill
 * in that tab: Stripe Elements, Braintree Hosted Fields, Adyen Secured Fields,
 * Checkout.com Frames / Flow. Every other cross-origin frame is refused.
 */
const PAYMENT_FRAME_HOSTS: RegExp[] = [
  /^js\.stripe\.com$/,
  /^assets\.braintreegateway\.com$/,
  /^checkoutshopper-(live|test)(-[a-z]{2,4})?\.adyen\.com$/,
  /^checkoutshopper-live(-[a-z]{2,4})?\.adyenpayments\.com$/,
  /^(cdn|checkout-web-components)\.checkout\.com$/,
];

export function isPaymentFrameOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.origin !== origin) return false;
  return PAYMENT_FRAME_HOSTS.some((re) => re.test(u.hostname));
}

/**
 * Origins of the frames above `win`, parent first, top last ([] for the top
 * frame); null when they cannot be known.
 */
export function ancestorOriginsOf(win: Window): string[] | null {
  const anc = (win.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (anc && typeof anc.length === "number") return Array.from({ length: anc.length }, (_, i) => anc[i]!);
  const out: string[] = [];
  let w: Window = win;
  for (let depth = 0; depth < 32; depth++) {
    try {
      if (w === w.top) return out;
      const parent = w.parent;
      if (!parent || parent === w) return out;
      out.push(parent.location.origin);
      w = parent;
    } catch {
      return null; // cross-origin parents throw on access where ancestorOrigins is missing
    }
  }
  return null;
}
