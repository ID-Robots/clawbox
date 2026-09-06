import {
  normalizeAllowedModelIds,
  normalizeClawboxAiTier,
  type ClawboxAiTier,
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
// Enough for the service's own error envelope and nothing like enough for an
// interception page. Only ever parsed, never shown.
const MAX_ERROR_BODY_BYTES = 4_096;

export interface DeviceInfoResponse {
  tier?: string;
  deviceTier?: string | null;
  /**
   * Model ids this token may run, as the portal publishes them (bare ids,
   * e.g. `["deepseek-v4-flash","deepseek-v4-pro",…]`). The portal's own
   * answer to "what is this account entitled to" — see
   * `portalDeniesClawboxAiModel`, which is the only thing allowed to read it
   * as a refusal. Absent on older portal builds.
   */
  allowedModels?: unknown;
}

export type PortalLookup =
  | {
      source: "portal";
      tier: ClawboxAiTier | null;
      /**
       * The PLAN, read WITHOUT the device stamp — see `mapPortalPlanTier`.
       *
       * `tier` above prefers `deviceTier`, so it answers "what does this box
       * default to", not "what does this account pay for". Anything deciding
       * ENTITLEMENT needs the second question, and collapsing the two into one
       * field is how a Max subscriber's box came to refuse the model he pays
       * for (TASK-691).
       */
      planTier: ClawboxAiTier | null;
      /** Entitled model ids, or null when the portal published none. */
      allowedModels: string[] | null;
    }
  | {
      source: "unreachable";
      /**
       * The portal ANSWERED and refused this credential (401/403), as opposed
       * to not answering at all.
       *
       * The tier is preserved either way — see the non-200 branch below, and
       * TASK-468: a revoked token on a still-paid account must not demote the
       * badge. But "the portal said no" and "the portal said nothing" are not
       * the same fact, and collapsing them is what let Settings paint
       * "Connected · Pro" over a credential the box had just been told was
       * dead (TASK-419). Callers that report health must read this; callers
       * that report the TIER must keep ignoring it.
       */
      rejected: boolean;
    };

interface PortalCacheEntry {
  tier: ClawboxAiTier | null;
  planTier: ClawboxAiTier | null;
  allowedModels: string[] | null;
  expiresAt: number;
}

const portalTierCache = new Map<string, PortalCacheEntry>();
// token → when its unreachable verdict expires, and whether that verdict was
// the portal REFUSING the credential rather than failing to answer.
// Separate from portalTierCache because the value is "we tried and
// it failed, don't try again yet" rather than "the answer is null".
const portalUnreachableCache = new Map<string, { until: number; rejected: boolean }>();
const inFlightPortalLookups = new Map<string, Promise<PortalLookup>>();

/**
 * Writes a token's resolved tier into the in-memory cache, sweeping
 * expired entries and enforcing the size cap before insertion. Map
 * iteration order is insertion order, so the first key returned by
 * `keys()` is the oldest.
 *
 * @param token Portal token (`claw_*`) used as the cache key.
 * @param tier Resolved tier (or `null` for Free / no entitlement).
 * @param now Current epoch ms; used both for expiry comparison and to
 *   set the new entry's `expiresAt`.
 */
function rememberTier(
  token: string,
  tier: ClawboxAiTier | null,
  planTier: ClawboxAiTier | null,
  allowedModels: string[] | null,
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
  portalTierCache.set(token, {
    tier,
    planTier,
    allowedModels,
    expiresAt: now + PORTAL_TIER_CACHE_TTL_MS,
  });
}

/**
 * The entitlement list out of a device-info body, or null when the portal
 * published none. Normalised through the one shared rule so the server and
 * the client cannot disagree about what an empty list means.
 */
export function mapPortalAllowedModels(body: DeviceInfoResponse): string[] | null {
  return normalizeAllowedModelIds(body.allowedModels);
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
 * The subscription PLAN, mapped to the same two-value enum and ignoring the
 * device stamp entirely: Max plan -> `"pro"`, Pro plan -> `"flash"`, anything
 * unpaid -> `null`.
 *
 * The sibling of {@link mapPortalTier}, and the difference between them is the
 * whole of TASK-691. `mapPortalTier` prefers `deviceTier` on purpose, because
 * it answers "what should this BOX default to" and a Max subscriber is allowed
 * to run Flash here. This one answers "what does this ACCOUNT pay for", which
 * is the only question an entitlement may be derived from. Read the first for a
 * default to write; read this one before refusing anything.
 */
export function mapPortalPlanTier(body: DeviceInfoResponse): ClawboxAiTier | null {
  const plan = (body.tier ?? "").trim().toLowerCase();
  if (plan === "max") return "pro";
  if (plan === "pro") return "flash";
  return null;
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
 * the non-200 branch in the body for the rationale. They are still
 * DISTINGUISHABLE: the unreachable verdict carries `rejected`, which says
 * whether the portal refused the credential or simply never answered.
 *
 * @param token The bearer token to look up.
 * @returns Either a definitive `{ source: "portal", tier }` answer or
 *   `{ source: "unreachable", rejected }` when it couldn't be trusted —
 *   `rejected` true only when the portal itself refused the credential.
 */
export async function fetchPortalTier(token: string): Promise<PortalLookup> {
  const now = Date.now();
  const cached = portalTierCache.get(token);
  if (cached && cached.expiresAt > now) {
    return {
      source: "portal",
      tier: cached.tier,
      planTier: cached.planTier,
      allowedModels: cached.allowedModels,
    };
  }

  const negative = portalUnreachableCache.get(token);
  if (negative !== undefined && negative.until > now) {
    return { source: "unreachable", rejected: negative.rejected };
  }

  const existing = inFlightPortalLookups.get(token);
  if (existing) return existing;

  const promise = (async (): Promise<PortalLookup> => {
    const markUnreachable = (rejected: boolean): PortalLookup => {
      portalUnreachableCache.set(token, {
        until: now + PORTAL_UNREACHABLE_TTL_MS,
        rejected,
      });
      return { source: "unreachable", rejected };
    };
    try {
      const res = await fetch(PORTAL_DEVICE_INFO_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PORTAL_FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.json() as DeviceInfoResponse;
        const tier = mapPortalTier(body);
        const planTier = mapPortalPlanTier(body);
        const allowedModels = mapPortalAllowedModels(body);
        rememberTier(token, tier, planTier, allowedModels, now);
        // Every negative verdict, not just this token's. A device holds ONE
        // ClawBox AI credential at a time, so a 200 for the one it holds now
        // says the rejection recorded against the one it held a minute ago is
        // about a credential that no longer exists — and `clawaiTokenRejectedByPortal`
        // scans, so leaving it would keep the Providers strip in "Needs
        // sign-in" for the rest of that entry's window after a re-link.
        portalUnreachableCache.clear();
        return { source: "portal", tier, planTier, allowedModels };
      }
      // 401/403 is ambiguous AS A TIER: it can mean genuinely Free OR token
      // revoked / migrated / corrupted on a still-paid account. We
      // can't tell from the response alone, and treating it as
      // "Free" silently downgrades paid users with broken auth (and
      // fires the downgrade-celebration popup). Mark unreachable
      // instead so callers preserve localTier.
      //
      // It is NOT ambiguous as a CREDENTIAL — but only when the PORTAL is the
      // one refusing. A corporate proxy, a hotel captive portal, a CDN
      // anti-bot page or an ISP interception can all answer 403 to this GET,
      // and calling one of those a rejection would tell an owner with a
      // perfectly valid token to re-link the device: the same false claim this
      // change exists to end, pointing the other way. So the body has to look
      // like the service's own auth error (`{error:{code:"invalid_token"|
      // "missing_token"}}`, the shape it documents) before the verdict says so.
      return markUnreachable(await portalRefusedTheToken(res));
    } catch {
      // A timeout, a dead uplink, a DNS failure: the portal said nothing at
      // all, so it said nothing about the credential either. Reporting this as
      // a rejection would tell a customer on a train to re-link a device that
      // is perfectly fine.
      return markUnreachable(false);
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
 * Has the portal refused this box's ClawBox AI token? Answered WITHOUT asking
 * it, and without reading the credential.
 *
 * For the readers that must not add traffic: `provider-status.ts` is polled and
 * states in as many words that it probes nothing. This answers only from the
 * negative cache `fetchPortalTier` has already filled — so on a cold process it
 * is `false`, meaning "nobody has asked", and the row stays exactly where beta
 * left it. `/setup-api/ai-models/status` fills that cache every 30 s for as
 * long as any client is open, which is whenever this strip is on screen.
 *
 * Scanned rather than keyed, so the caller needs no token: a device holds one
 * ClawBox AI credential at a time, entries live 30 s, and a re-link mints a new
 * key — so a live `rejected` entry is this box's, or is seconds from expiring.
 */
export function clawaiTokenRejectedByPortal(): boolean {
  const now = Date.now();
  for (const entry of portalUnreachableCache.values()) {
    if (entry.rejected && entry.until > now) return true;
  }
  return false;
}

/**
 * Did the PORTAL refuse this token, or did something on the way refuse the
 * request?
 *
 * Only `{ error: { code: "invalid_token" | "missing_token" } }` — the shape the
 * service documents (see `harness/clawai-images.ts`) — counts. Fails closed:
 * an HTML interstitial, an empty body, a truncated read or an unrecognised code
 * all answer false, which leaves the verdict at plain "unreachable" and the
 * badge exactly where beta left it.
 *
 * Bounded, because an interception page can be arbitrarily large and this sits
 * on the render path of the chat header.
 */
async function portalRefusedTheToken(res: Response): Promise<boolean> {
  if (res.status !== 401 && res.status !== 403) return false;
  const body = res.body;
  if (!body) return false;
  // Counted as it arrives. `res.text()` would buffer whatever the far side
  // sends BEFORE anything could object to its size, and the 4 s timeout above
  // bounds duration, not bytes — while a 401/403 is exactly the response an
  // interception appliance answers with a full HTML page, on a device where
  // memory is the scarce thing. Past the cap this is not the envelope we are
  // looking for, and draining the rest of it buys nothing.
  const reader = body.getReader();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > MAX_ERROR_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return false;
        }
        chunks.push(Buffer.from(value).toString("utf8"));
      }
      if (done) break;
    }
  } catch {
    return false;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(chunks.join(""));
  } catch {
    return false;
  }
  const error = (payload as { error?: unknown } | null)?.error;
  const code = (error as { code?: unknown } | null)?.code;
  return code === "invalid_token" || code === "missing_token";
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
