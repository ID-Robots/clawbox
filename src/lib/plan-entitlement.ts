import { normalizeClawboxAiTier, type ClawboxAiTier } from "@/lib/clawbox-ai-models";
import {
  CLAWAI_PLAN_TIER_KEY,
  clawaiEntitlementTier,
  readClawaiEntitlementTier,
} from "@/lib/clawai-plan-tier";
import {
  SUBSCRIPTION_LINK_PLAN_KEY,
  SUBSCRIPTION_LINK_TOKEN_KEY,
  linkedPaidTier,
  readLinkedPaidTier,
} from "@/lib/subscription-link";

/**
 * "Which paid plan does this box's owner have?" — whichever way the account
 * reached the box (TASK-2501). SERVER ONLY.
 *
 * THE CONTRACT the plan-gated features read, kept to one small interface on
 * purpose. Until now the only answer came from the ClawBox AI credential, so
 * "has a plan" and "chats through ClawBox AI" were one fact. They are two: a
 * subscription may be linked for its plan alone (`@/lib/subscription-link`)
 * while the box runs its local engine or the owner's own key. A feature asks
 * this module, never one source directly, so the next source — or a change in
 * which source wins — is one entry in {@link PLAN_ENTITLEMENT_SOURCES} rather
 * than an edit in every gate.
 *
 * What it does NOT answer: whether ClawBox AI's CLOUD may be used. The cloud
 * voice, cloud embeddings and the rest still read the ClawBox AI credential and
 * its plan (`clawai-plan-tier.ts`), because a linked subscription carries no
 * chat credential and the owner who linked one asked for no cloud AI.
 */

/** Where an entitlement came from. */
export type PlanEntitlementSourceId = "clawai" | "subscription_link";

/** One way an account can vouch for a plan on this box. */
export interface PlanEntitlementSource {
  readonly id: PlanEntitlementSourceId;
  /**
   * The tier this source vouches for, as it sits on the box. Anything that is
   * not a paid tier — `"free"`, null, a word this build does not know — vouches
   * for nothing. A source that throws vouches for nothing either.
   */
  readTier(): Promise<unknown>;
}

/** The answer: the best paid tier any source vouches for, and which one did. */
export interface PlanEntitlement {
  /** `"flash"` (the Pro plan), `"pro"` (the Max plan), or null for no paid plan on record. */
  tier: ClawboxAiTier | null;
  /** The source the tier came from; null exactly when `tier` is. */
  source: PlanEntitlementSourceId | null;
}

/** Max over Pro: the names are off by one, so `"pro"` (Max) ranks above `"flash"` (Pro). */
const TIER_RANK: Record<ClawboxAiTier, number> = { flash: 1, pro: 2 };

/**
 * The best paid tier among `candidates`, in order: on a tie the FIRST source
 * wins, so the ClawBox AI credential keeps answering for a box that has both.
 * PURE.
 */
export function strongestEntitlement(
  candidates: ReadonlyArray<{ id: PlanEntitlementSourceId; tier: unknown }>,
): PlanEntitlement {
  let best: PlanEntitlement = { tier: null, source: null };
  for (const candidate of candidates) {
    const tier = normalizeClawboxAiTier(candidate.tier);
    if (!tier) continue;
    if (best.tier === null || TIER_RANK[tier] > TIER_RANK[best.tier]) {
      best = { tier, source: candidate.id };
    }
  }
  return best;
}

/**
 * The same answer from a `data/config.json` snapshot a caller already holds.
 * PURE. The coding agent's status reads the store once for everything it
 * reports; this keeps it on the rule every other gate reads.
 */
export function planEntitlementFromStore(store: Readonly<Record<string, unknown>>): PlanEntitlement {
  return strongestEntitlement([
    { id: "clawai", tier: clawaiEntitlementTier(store[CLAWAI_PLAN_TIER_KEY], store.clawai_tier) },
    {
      id: "subscription_link",
      tier: linkedPaidTier(store[SUBSCRIPTION_LINK_PLAN_KEY], store[SUBSCRIPTION_LINK_TOKEN_KEY]),
    },
  ]);
}

/** The sources, in the order a tie is settled. */
export const PLAN_ENTITLEMENT_SOURCES: readonly PlanEntitlementSource[] = [
  { id: "clawai", readTier: readClawaiEntitlementTier },
  { id: "subscription_link", readTier: readLinkedPaidTier },
];

/**
 * The plan as this box stands. A source that cannot be read vouches for
 * nothing, so a failed read never unlocks a feature — and never hides a plan
 * another source can still vouch for.
 */
export async function readPlanEntitlement(
  sources: readonly PlanEntitlementSource[] = PLAN_ENTITLEMENT_SOURCES,
): Promise<PlanEntitlement> {
  const candidates = await Promise.all(sources.map(async (source) => ({
    id: source.id,
    // Through a `then`, so a reader that throws before its first await is
    // caught the same way as one that rejects.
    tier: await Promise.resolve().then(() => source.readTier()).catch(() => null),
  })));
  return strongestEntitlement(candidates);
}
