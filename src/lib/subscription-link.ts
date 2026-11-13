import { get, set, setMany } from "@/lib/config-store";
import {
  normalizeClawboxAiPlanTier,
  normalizeClawboxAiTier,
  type ClawboxAiPlanTier,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";
import {
  mapPortalPlanVerdict,
  portalRefusedTheToken,
  type DeviceInfoResponse,
} from "@/lib/clawbox-ai-portal-tier";
import { isClawboxAiToken } from "@/lib/clawai-token";

/**
 * A ClawBox subscription LINKED to this box for its plan alone (TASK-2501).
 * SERVER ONLY.
 *
 * The device-code sign-in (`/setup-api/ai-models/clawai/start` + `/poll`) has
 * always done two things at once: it paired the box with the owner's portal
 * account, and it made ClawBox AI the box's chat model. An owner who runs the
 * box on its local engine, or on their own API key, and wants the plan's
 * features (the coding agent, Memory Shard, Remote Control…) had no way to get
 * the first without the second. The link is the first alone: the portal token
 * is kept where only the plan readers look, and no model, provider, gateway or
 * Hermes setting is touched.
 *
 * ITS OWN KEYS, never `clawai_token` / `clawai_tier` / `clawai_plan_tier`, and
 * that is the point of the module:
 *
 * - `clawai_token` is the chat credential. Everything that spends ClawBox AI —
 *   cloud speech and transcription, image generation, vision, cloud embeddings,
 *   Prime Radiant's Flash client — finds it through `resolveClawaiToken`. A
 *   linked token stored there would quietly start all of them, which is exactly
 *   what an owner who chose "no cloud AI" asked not to happen.
 * - `clawai_tier` / `clawai_plan_tier` are read by the two ROOT boot scripts to
 *   arm or withdraw the cloud voice (see `clawai-plan-tier.ts`). A plan written
 *   there by the link would arm a cloud voice on a box that has no ClawBox AI
 *   credential at all.
 *
 * And its own portal lookup rather than `fetchPortalTier`, because that
 * module's caches assume ONE ClawBox AI credential per box: a 200 for any token
 * clears every recorded refusal, and `clawaiTokenRejectedByPortal` scans for
 * one without a key. A link refused by the portal would then paint the ClawBox
 * AI provider row "Needs sign-in" — or a working link would wipe the refusal of
 * a dead chat credential.
 */

/** The portal token the link holds. A `*_token` key, so the credential redactor already hides it. */
export const SUBSCRIPTION_LINK_TOKEN_KEY = "subscription_link_token";

/**
 * The plan the portal last reported for the linked account: `"free"`,
 * `"flash"` (the Pro plan) or `"pro"` (the Max plan) — the names are off by
 * one, see `paid-plan-gate.ts`. ABSENT when the portal has not answered for
 * this link yet: not knowing is not a plan, and nothing is unlocked on it.
 */
export const SUBSCRIPTION_LINK_PLAN_KEY = "subscription_link_plan";

const DEFAULT_DEVICE_INFO_URL = "https://clawbox.com/api/clawbox-ai/device-info";

/** Read per call, so a box (or a test) pointed at another portal does not need a restart of this module. */
function deviceInfoUrl(): string {
  return process.env.CLAWBOX_AI_DEVICE_INFO_URL?.trim() || DEFAULT_DEVICE_INFO_URL;
}

/** The same bound the ClawBox AI badge lookup has: this sits on the status poll. */
const LOOKUP_TIMEOUT_MS = 4_000;
/** A portal answer is reused for two minutes, so the 5 s paid-gate poll costs the portal nothing. */
const LOOKUP_TTL_MS = 120_000;
/** No answer is retried after 30 s, so a recovered uplink shows up on the next poll or so. */
const UNREACHABLE_TTL_MS = 30_000;

/** What the portal said about the linked token. */
export type SubscriptionLinkLookup =
  | {
      source: "portal";
      /**
       * `mapPortalPlanVerdict`'s three-valued reading: a paid tier, `"free"`,
       * or null for an answer this build cannot interpret.
       */
      plan: ClawboxAiPlanTier | null;
    }
  | {
      source: "unreachable";
      /** The PORTAL refused the token (its own `invalid_token` envelope), as opposed to not answering. */
      rejected: boolean;
    };

/** One remembered answer, keyed by the token it was about. */
let lookupCache: { token: string; lookup: SubscriptionLinkLookup; until: number } | null = null;
let inFlight: { token: string; promise: Promise<SubscriptionLinkLookup> } | null = null;

/**
 * How many times the link has been written or removed in this process.
 *
 * A refresh snapshots it before asking the portal and writes nothing if it has
 * moved: up to four seconds pass before the portal answers, and an answer about
 * a token the owner has since replaced or unlinked is not this box's plan. The
 * stored token is compared as well, which also covers a write from another
 * process.
 */
let linkGeneration = 0;

/** Test seam: forget every remembered answer and the generation. */
export function _resetSubscriptionLinkForTests(): void {
  lookupCache = null;
  inFlight = null;
  linkGeneration = 0;
}

/**
 * Ask the portal what plan the account behind `token` pays for.
 *
 * Never throws: a timeout, a dead uplink or a refusal is an `unreachable`
 * answer, with `rejected` set only when the portal itself named the token as
 * the reason (the same bar `fetchPortalTier` holds). `fresh` skips the
 * remembered answer — the link itself asks with it, because a token the box
 * has just been handed has never been asked about.
 */
export async function lookupLinkedPlan(
  token: string,
  options: { fresh?: boolean } = {},
): Promise<SubscriptionLinkLookup> {
  const now = Date.now();
  if (!options.fresh && lookupCache?.token === token && lookupCache.until > now) {
    return lookupCache.lookup;
  }
  if (inFlight?.token === token) return inFlight.promise;

  const promise = (async (): Promise<SubscriptionLinkLookup> => {
    let lookup: SubscriptionLinkLookup;
    try {
      const res = await fetch(deviceInfoUrl(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.json() as DeviceInfoResponse;
        lookup = { source: "portal", plan: mapPortalPlanVerdict(body ?? {}) };
      } else {
        lookup = { source: "unreachable", rejected: await portalRefusedTheToken(res) };
      }
    } catch {
      lookup = { source: "unreachable", rejected: false };
    }
    const ttl = lookup.source === "portal" ? LOOKUP_TTL_MS : UNREACHABLE_TTL_MS;
    lookupCache = { token, lookup, until: Date.now() + ttl };
    return lookup;
  })();

  inFlight = { token, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

/** The link as it sits in `data/config.json`. */
export interface SubscriptionLink {
  token: string;
  /** The plan on record, or null when the portal has not answered for this link. */
  plan: ClawboxAiPlanTier | null;
}

/** A stored value that is a portal token, trimmed — or null. */
function linkedToken(value: unknown): string | null {
  return typeof value === "string" && isClawboxAiToken(value) ? value.trim() : null;
}

/**
 * The paid tier the link vouches for, from the two stored values: `"flash"`
 * (Pro), `"pro"` (Max), or null for Free, for a plan not known yet, and for a
 * plan with no link token beside it — a plan is only ever a fact about the
 * token it was read for.
 *
 * PURE, for callers that already hold the store (the coding agent's status
 * reads `config.json` once for everything it reports).
 */
export function linkedPaidTier(planValue: unknown, tokenValue: unknown): ClawboxAiTier | null {
  return linkedToken(tokenValue) ? normalizeClawboxAiTier(planValue) : null;
}

/** The link on record, or null when this box has none. Throws only when the store cannot be read. */
export async function readSubscriptionLink(): Promise<SubscriptionLink | null> {
  const token = linkedToken(await get(SUBSCRIPTION_LINK_TOKEN_KEY));
  if (!token) return null;
  return { token, plan: normalizeClawboxAiPlanTier(await get(SUBSCRIPTION_LINK_PLAN_KEY)) };
}

/** {@link linkedPaidTier} over the store. Null when the store cannot be read: no plan is unlocked on a failed read. */
export async function readLinkedPaidTier(): Promise<ClawboxAiTier | null> {
  try {
    const link = await readSubscriptionLink();
    return link ? normalizeClawboxAiTier(link.plan) : null;
  } catch {
    return null;
  }
}

/** How a link attempt ended. `message` is the owner's sentence; `code` is what a caller matches on. */
export type SubscriptionLinkOutcome =
  | { ok: true; plan: ClawboxAiPlanTier | null }
  | {
      ok: false;
      code: "invalid_token" | "token_rejected" | "superseded" | "store_failed";
      message: string;
    };

/**
 * Link the account behind `token` to this box, for its plan only.
 *
 * Asks the portal once (fresh) and records the token and the plan in ONE store
 * write, so the plan on record is always a fact about the token beside it. A
 * portal that does not answer still links: the plan is left unknown — nothing
 * unlocks on it — and the status poll fills it in when the portal is back. A
 * portal that REFUSES the token does not: there is nothing to link.
 *
 * Touches nothing else. No provider, model, gateway or Hermes setting moves,
 * and the ClawBox AI credential keys are not read or written.
 */
export async function linkSubscription(token: string): Promise<SubscriptionLinkOutcome> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!isClawboxAiToken(trimmed)) {
    return {
      ok: false,
      code: "invalid_token",
      message: "The ClawBox portal answered with a credential this box does not recognise. Request a new code and try again.",
    };
  }
  const generation = ++linkGeneration;
  const lookup = await lookupLinkedPlan(trimmed, { fresh: true });
  if (lookup.source === "unreachable" && lookup.rejected) {
    return {
      ok: false,
      code: "token_rejected",
      message: "The ClawBox portal refused the credential it just issued. Request a new code and try again.",
    };
  }
  // Another link or an unlink started while the portal answered: that one is
  // the owner's latest word, and this one must not land over it.
  if (generation !== linkGeneration) {
    return {
      ok: false,
      code: "superseded",
      message: "Another subscription change on this box replaced this one. Request a new code if it is still needed.",
    };
  }
  const plan = lookup.source === "portal" ? lookup.plan : null;
  try {
    // Bumped in the same synchronous step as the write (`setMany` reads and
    // writes the file before its first await), so a refresh that read the
    // previous token can never land its plan after this.
    linkGeneration += 1;
    // `undefined` deletes: a re-link whose portal did not answer must not keep
    // the previous account's plan beside the new token.
    await setMany({
      [SUBSCRIPTION_LINK_TOKEN_KEY]: trimmed,
      [SUBSCRIPTION_LINK_PLAN_KEY]: plan ?? undefined,
    });
  } catch {
    return {
      ok: false,
      code: "store_failed",
      message: "This box could not save the subscription link. Check the device's storage and try again.",
    };
  }
  return { ok: true, plan };
}

/** What the status poll learns about the link. Never carries the token. */
export interface SubscriptionLinkStatus {
  /** The plan on record after this refresh, or null when not known. */
  plan: ClawboxAiPlanTier | null;
  /** The portal refused the linked token on this ask: a re-link is due, and nothing is unlocked on it meanwhile. */
  rejected: boolean;
  /** This refresh recorded a different plan than the box had. */
  changed: boolean;
}

/**
 * Re-read the linked account's plan from the portal and record it when it
 * moved — the upgrade or lapse on the portal reaching the box without a
 * re-link. Null when the box has no link (or the store cannot be read).
 *
 * The rules:
 * - "we cannot tell" never overwrites "we were told": an unreachable portal
 *   and an answer this build cannot read keep the plan on record.
 * - a REFUSAL is not "we cannot tell". The portal named this token as invalid
 *   in its own envelope (`portalRefusedTheToken`'s bar, not any 401/403 off
 *   the wire), so the token vouches for nothing any more and the plan on
 *   record is forgotten — kept, a token revoked on the portal would go on
 *   unlocking paid features after the subscription behind it lapsed. This is
 *   deliberately NOT the ClawBox AI rule (TASK-468 keeps that badge on a
 *   refusal), because there the credential is also the chat's and the badge
 *   only decorates it; here the plan is all the link is for. The token itself
 *   stays, so the surfaces can say a re-link is due.
 * - an answer about a token the box no longer holds is neither recorded nor
 *   reported: a re-link or an unlink that lands while the portal answers is
 *   the owner's latest word.
 */
export async function refreshSubscriptionLink(): Promise<SubscriptionLinkStatus | null> {
  const generation = linkGeneration;
  let link: SubscriptionLink | null;
  try {
    link = await readSubscriptionLink();
  } catch {
    return null;
  }
  if (!link) return null;
  const asked = link;
  const lookup = await lookupLinkedPlan(asked.token);

  // The answer is about `asked`. If the link moved while the portal answered,
  // it describes nothing on this box: answer from the store as it is now, and
  // let the next poll ask about the new token.
  if (generation !== linkGeneration) {
    const now = await readSubscriptionLink().catch(() => null);
    return now ? { plan: now.plan, rejected: false, changed: false } : null;
  }

  let next: ClawboxAiPlanTier | null;
  if (lookup.source === "portal") {
    if (lookup.plan === null || lookup.plan === asked.plan) {
      return { plan: asked.plan, rejected: false, changed: false };
    }
    next = lookup.plan;
  } else if (lookup.rejected) {
    if (asked.plan === null) return { plan: null, rejected: true, changed: false };
    next = null;
  } else {
    return { plan: asked.plan, rejected: false, changed: false };
  }

  try {
    const stored = linkedToken(await get(SUBSCRIPTION_LINK_TOKEN_KEY));
    // Checked and written in ONE synchronous step — `set` reads and writes the
    // file before its first await, and the link and unlink bump the
    // generation in the same step as their own writes — so nothing in this
    // process can land between the check and the write.
    if (generation !== linkGeneration || stored !== asked.token) {
      const now = await readSubscriptionLink().catch(() => null);
      return now ? { plan: now.plan, rejected: false, changed: false } : null;
    }
    // `undefined` deletes: a refused token's plan is forgotten, not set to Free.
    await set(SUBSCRIPTION_LINK_PLAN_KEY, next ?? undefined);
  } catch {
    // Best effort, like the ClawBox AI plan stamp: the next poll writes it
    // again. A refusal is still reported, and the gate re-reads the store.
    return { plan: asked.plan, rejected: lookup.source === "unreachable" && lookup.rejected, changed: false };
  }
  return { plan: next, rejected: lookup.source === "unreachable" && lookup.rejected, changed: true };
}

/**
 * Remove the link. Answers whether there was one.
 *
 * The token itself stays listed on the portal, where the owner can revoke it;
 * on this box nothing is left that could unlock a feature with it.
 */
export async function unlinkSubscription(): Promise<boolean> {
  linkGeneration += 1;
  const had = linkedToken(await get(SUBSCRIPTION_LINK_TOKEN_KEY)) !== null;
  // Again in the same synchronous step as the write: see `linkSubscription`.
  linkGeneration += 1;
  await setMany({
    [SUBSCRIPTION_LINK_TOKEN_KEY]: undefined,
    [SUBSCRIPTION_LINK_PLAN_KEY]: undefined,
  });
  lookupCache = null;
  return had;
}
