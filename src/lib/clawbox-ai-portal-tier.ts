import {
  normalizeClawboxAiTier,
  normalizeClawboxAiPlan,
  type ClawboxAiTier,
  type ClawboxAiPlan,
} from "@/lib/clawbox-ai-models";

/**
 * Resolving a `claw_*` portal token to the subscription tier it actually
 * grants.
 *
 * Extracted out of the status route so the CONFIGURE route can ask the same
 * question with the same answer. They used to disagree: status asked the
 * portal, configure trusted the wizard's plan picker, so pairing a Max token
 * through the wizard wrote the Pro model onto a Max box and the two surfaces
 * then contradicted each other (TASK-481). Sharing the module also shares the
 * cache, so the configure call almost always lands on the entry the status
 * poll just warmed rather than paying for a second round trip.
 */

// Portal endpoint that maps a `claw_*` token to its current subscription
// state. Authoritative source for the device's tier badge — local config
// only ever stored the user's wizard *selection*, which can drift from
// what the portal actually grants (Free user pastes a token + clicks Max
// pill → local says "pro" but token entitles only Free).
const PORTAL_DEVICE_INFO_URL =
  process.env.CLAWBOX_AI_DEVICE_INFO_URL?.trim()
  || "https://clawbox.com/api/clawbox-ai/device-info";

// 120s TTL > 30s poll cadence so most polls land on a warm cache. The
// portal's reconcile-tier already self-heals on its end inside its own
// 60s window, so 120s here is still bounded by Stripe truth on the
// far side.
const PORTAL_TIER_CACHE_TTL_MS = 120_000;
// 4s timeout — this fetch sits on the render path of the chat header
// and Settings card. Anything longer stacks behind the 30s poll cadence
// and stalls the badge update. On timeout we treat the portal as
// unreachable and fall back to the picker selection.
const PORTAL_FETCH_TIMEOUT_MS = 4_000;
// Bound for the in-memory token cache. A single device only has one
// active claw_ token at a time, so this only matters under factory-
// reset / multi-account dev churn — but a long-running process would
// otherwise leak entries forever.
const PORTAL_TIER_CACHE_MAX_ENTRIES = 64;
// Short negative-cache window for tokens whose last portal lookup
// resolved to `unreachable` (4xx auth failure, 5xx, or network
// error). With useClawboxLogin polling every 30s, this caps the
// per-device portal load during a sustained auth-failure or
// outage at ~1 request per 30s (down from 1-per-poll). Smaller
// than PORTAL_TIER_CACHE_TTL_MS because the positive cache is
// safe to hold longer; an unreachable verdict needs to clear
// quickly enough that recovery (token re-pair, portal recovers)
// shows up on the next poll, not minutes later.
const PORTAL_UNREACHABLE_TTL_MS = 30_000;

export interface DeviceInfoResponse {
  tier?: string;
  deviceTier?: string | null;
}

export type PortalLookup =
  | { source: "portal"; tier: ClawboxAiTier | null; plan: ClawboxAiPlan | null }
  | { source: "unreachable" };

interface PortalCacheEntry {
  tier: ClawboxAiTier | null;
  // Subscription plan behind the tier. Kept alongside `tier` because the two
  // are not interchangeable: `tier` collapses Free and "portal said something
  // we don't recognise" into the same `null`, and the image allowance has to
  // tell those apart (Free has a real 5-image allowance to show).
  plan: ClawboxAiPlan | null;
  expiresAt: number;
}

const portalTierCache = new Map<string, PortalCacheEntry>();
// token → epoch-ms timestamp when its unreachable verdict expires.
// Separate from portalTierCache because the value is "we tried and
// it failed, don't try again yet" rather than "the answer is null".
const portalUnreachableCache = new Map<string, number>();
const inFlightPortalLookups = new Map<string, Promise<PortalLookup>>();

/**
 * Writes a token's resolved tier into the in-memory cache, sweeping
 * expired entries and enforcing the size cap before insertion. Map
 * iteration order is insertion order, so the first key returned by
 * `keys()` is the oldest.
 *
 * @param token Portal token (`claw_*`) used as the cache key.
 * @param tier Resolved tier (or `null` for Free / no entitlement).
 * @param plan Resolved subscription plan (or `null` when unrecognised).
 * @param now Current epoch ms; used both for expiry comparison and to
 *   set the new entry's `expiresAt`.
 */
function rememberTier(
  token: string,
  tier: ClawboxAiTier | null,
  plan: ClawboxAiPlan | null,
  now: number,
) {
  for (const [key, entry] of portalTierCache) {
    if (entry.expiresAt <= now) portalTierCache.delete(key);
  }
  while (portalTierCache.size >= PORTAL_TIER_CACHE_MAX_ENTRIES) {
    const oldest = portalTierCache.keys().next().value;
    if (oldest === undefined) break;
    portalTierCache.delete(oldest);
  }
  portalTierCache.set(token, { tier, plan, expiresAt: now + PORTAL_TIER_CACHE_TTL_MS });
}

/**
 * Maps the portal's `device-info` response to the local `ClawboxAiTier`
 * enum the UI badges already understand. Prefers the device-pair stamp
 * (`deviceTier`) when present; otherwise translates the user's plan
 * name (`tier`) to its corresponding device-tier. The local enum is
 * `"flash"` (Pro plan / V4 Flash model) and `"pro"` (Max plan / V4 Pro
 * model); Free / unpaid resolves to `null` (no paid badge rendered).
 *
 * @param body Parsed JSON from `/api/clawbox-ai/device-info`.
 * @returns The badge-facing tier, or `null` for Free.
 */
export function mapPortalTier(body: DeviceInfoResponse): ClawboxAiTier | null {
  const plan = (body.tier ?? "").trim().toLowerCase();
  // Subscription plan is the source of truth — a stale or bogus
  // deviceTier stamp on a Free account must never grant a paid badge.
  if (plan !== "pro" && plan !== "max") return null;
  // Paid: prefer the explicit device-pair stamp (lets Max subs run
  // flash); otherwise map plan → device tier.
  const stamped = normalizeClawboxAiTier(body.deviceTier);
  if (stamped) return stamped;
  return plan === "max" ? "pro" : "flash";
}

/**
 * Resolves a `claw_*` token's current tier against the portal, with
 * a short in-memory cache and concurrent-request de-duplication.
 *
 * Cache semantics:
 *   - 200 OK: parsed tier is cached for `PORTAL_TIER_CACHE_TTL_MS`.
 *   - Non-200 / network error: token is marked unreachable for
 *     `PORTAL_UNREACHABLE_TTL_MS` so we don't hit the portal every
 *     30 s status poll during a sustained auth failure or outage.
 *     A successful 200 clears the unreachable mark so recovery is
 *     responsive.
 *
 * 401/403 are deliberately treated the same as 5xx/network errors
 * (unreachable) rather than as a definitive "Free" verdict — see
 * the non-200 branch in the body for the rationale.
 *
 * @param token The bearer token to look up.
 * @returns Either a definitive `{ source: "portal", tier }` answer or
 *   `{ source: "unreachable" }` when the portal couldn't respond.
 */
export async function fetchPortalTier(token: string): Promise<PortalLookup> {
  const now = Date.now();
  const cached = portalTierCache.get(token);
  if (cached && cached.expiresAt > now) {
    return { source: "portal", tier: cached.tier, plan: cached.plan };
  }

  const unreachableUntil = portalUnreachableCache.get(token);
  if (unreachableUntil !== undefined && unreachableUntil > now) {
    return { source: "unreachable" };
  }

  const existing = inFlightPortalLookups.get(token);
  if (existing) return existing;

  const promise = (async (): Promise<PortalLookup> => {
    const markUnreachable = (): PortalLookup => {
      portalUnreachableCache.set(token, now + PORTAL_UNREACHABLE_TTL_MS);
      return { source: "unreachable" };
    };
    try {
      const res = await fetch(PORTAL_DEVICE_INFO_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PORTAL_FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.json() as DeviceInfoResponse;
        const tier = mapPortalTier(body);
        const plan = normalizeClawboxAiPlan(body.tier);
        rememberTier(token, tier, plan, now);
        portalUnreachableCache.delete(token);
        return { source: "portal", tier, plan };
      }
      // 401/403 is ambiguous: it can mean genuinely Free OR token
      // revoked / migrated / corrupted on a still-paid account. We
      // can't tell from the response alone, and treating it as
      // "Free" silently downgrades paid users with broken auth (and
      // fires the downgrade-celebration popup). Mark unreachable
      // instead so callers preserve localTier.
      return markUnreachable();
    } catch {
      return markUnreachable();
    }
  })();

  inFlightPortalLookups.set(token, promise);
  try {
    return await promise;
  } finally {
    inFlightPortalLookups.delete(token);
  }
}

/**
 * Test-only escape hatch — clears both the value cache and any
 * in-flight lookups so vitest's `beforeEach` can start each test from
 * a clean module-state. Not for production use.
 */
export function _resetPortalTierCache() {
  portalUnreachableCache.clear();
  portalTierCache.clear();
  inFlightPortalLookups.clear();
}
