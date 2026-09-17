import { normalizeClawaiUsage, type ClawaiUsage } from "@/lib/clawai-usage";

/**
 * Asking the portal for this box's ClawBox AI usage. SERVER ONLY — it is handed
 * the device credential, which never reaches a browser.
 *
 * Every "no" is a state the usage card draws rather than an error it throws:
 *  - `refused`     — the portal answered 401/403/404: it does not hand usage to
 *                    this credential. The card points at the portal instead.
 *  - `unreachable` — offline, timed out, 5xx, or `metering_unavailable`: a
 *                    moment, not a verdict. The card says so and asks again.
 *  - `invalid`     — a 200 that is not a usage payload (an interception page).
 */

export type ClawaiUsageUnavailable = "not_connected" | "refused" | "unreachable" | "invalid";

export type ClawaiUsageAnswer =
  | { available: true; usage: ClawaiUsage }
  | { available: false; reason: ClawaiUsageUnavailable };

const DEFAULT_USAGE_URL = "https://clawbox.com/api/portal/usage";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The portal address, or a throw for an override the credential must not be
 * sent to: anything but HTTPS, except plain HTTP to this machine (a test
 * portal). An unsafe explicit override is refused rather than quietly replaced
 * by the default — a box configured to talk to one place must not talk to
 * another — and `askPortal` answers the throw as `unreachable`.
 */
function usageUrl(): string {
  const override = process.env.CLAWBOX_AI_USAGE_URL?.trim();
  if (!override) return DEFAULT_USAGE_URL;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error("CLAWBOX_AI_USAGE_URL is not a URL");
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return url.toString();
  }
  throw new Error("CLAWBOX_AI_USAGE_URL must be https, or http to this machine");
}

/** On the render path of a Settings card; a slow portal must not hold it. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * The card polls once a minute and more than one tab can have Settings open.
 * Thirty seconds keeps that to one portal read per half-minute per credential
 * without the bars visibly lagging a chat turn the owner just sent.
 */
export const CLAWAI_USAGE_CACHE_TTL_MS = 30_000;

let cache: { token: string; until: number; answer: ClawaiUsageAnswer } | null = null;

/** Tests only. */
export function _resetClawaiUsageCache(): void {
  cache = null;
}

async function askPortal(token: string): Promise<ClawaiUsageAnswer> {
  let res: Response;
  try {
    res = await fetch(usageUrl(), {
      // The credential goes to the portal and nowhere else: only the standard
      // Authorization header (a runtime drops it on a cross-origin redirect,
      // which a custom header would survive), and no redirect is followed at
      // all — a 3xx is answered as `unreachable` below.
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { available: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { available: false, reason: "refused" };
  }
  // Not ok covers a redirect too (`redirect: "manual"` hands it back unfollowed).
  if (!res.ok) return { available: false, reason: "unreachable" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { available: false, reason: "invalid" };
  }
  const usage = normalizeClawaiUsage(body);
  return usage ? { available: true, usage } : { available: false, reason: "invalid" };
}

/** The usage answer for this credential, from a half-minute cache when one is fresh. */
export async function fetchClawaiUsage(token: string): Promise<ClawaiUsageAnswer> {
  const now = Date.now();
  if (cache && cache.token === token && cache.until > now) return cache.answer;
  const answer = await askPortal(token);
  cache = { token, until: now + CLAWAI_USAGE_CACHE_TTL_MS, answer };
  return answer;
}
