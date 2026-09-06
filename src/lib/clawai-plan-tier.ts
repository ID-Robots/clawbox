import { get, set } from "@/lib/config-store";
import {
  CLAWBOX_AI_PLAN_UNPAID,
  normalizeClawboxAiPlanTier,
  normalizeClawboxAiTier,
  type ClawboxAiPlanTier,
} from "@/lib/clawbox-ai-models";

/**
 * The subscription PLAN the portal reports for this box's credential, written
 * down where the ROOT boot scripts can read it. SERVER ONLY.
 *
 * Split out for the same reason `clawai-credential-refusal.ts` was: three of
 * the four readers of "may this box have the cloud voice" are not in the Next
 * process — `scripts/gateway-pre-start.sh`, which decides whether to declare
 * the OpenClaw speech provider at all, `scripts/register-mcp.sh`, which does
 * the same on Hermes, and the next Next process after a restart. The portal is
 * the only thing that knows the answer and only this app can ask it, so the
 * answer has to be left somewhere both boot scripts can find it.
 */

/**
 * The store key.
 *
 * A sibling of `clawai_tier` and NOT a replacement for it. The two answer
 * different questions and `clawbox-ai-portal-tier.ts` spells out which is
 * which: `mapPortalTier` prefers the portal's `deviceTier` stamp on purpose,
 * because it answers "what should this BOX default to" and a Max subscriber is
 * allowed to run Flash here; `mapPortalPlanTier` answers "what does this
 * ACCOUNT pay for", which is "the only question an entitlement may be derived
 * from. Read the first for a default to write; read this one before refusing
 * anything."
 *
 * TASK-744 is what reading the wrong one costs: the speech gate on both
 * editions read the device stamp, so a Max subscriber whose box is stamped
 * `deviceTier: "flash"` — a state `mapPortalTier` preserves deliberately — had
 * his cloud voice DELETED at every boot.
 *
 * ALWAYS WRITTEN BESIDE `clawai_tier`, in the same store write, and deleted in
 * that same write when the writer had no portal answer. The badge and the plan
 * therefore always describe the same account: a plan that outlived the
 * credential it was read for would be a fact about a retired account deciding
 * whether this box keeps its voice.
 */
export const CLAWAI_PLAN_TIER_KEY = "clawai_plan_tier";

/**
 * The device badge's key, spelled here so this module can read the pair.
 *
 * Deliberately not exported: the two routes that WRITE it already keep their
 * own constant, and a shared name would invite a caller to read the badge
 * alone — which is the thing this module exists to stop.
 */
const CLAWAI_DEVICE_TIER_KEY = "clawai_tier";

/**
 * The unpaid word and the plan vocabulary, re-exported from their one home so
 * the boot scripts' parity test and every caller here name the same values.
 * `mapPortalPlanVerdict` is the only thing allowed to DECIDE that a portal
 * answer means unpaid — see its docblock for why `mapPortalPlanTier`'s `null`
 * may not be read as one.
 */
export { CLAWBOX_AI_PLAN_UNPAID as CLAWAI_PLAN_UNPAID } from "@/lib/clawbox-ai-models";
export type { ClawboxAiPlanTier as ClawaiPlanTier } from "@/lib/clawbox-ai-models";

/**
 * ARM side: the tier a box may be GIVEN the cloud voice on — the plan when the
 * portal has told us one, the device stamp only when it has not.
 *
 * The fallback belongs on this side alone. Arming is recoverable — the worst it
 * does is write our own fields to our own values, and the next boot takes it
 * back once the plan is on record — so a box whose plan nobody has asked about
 * yet is better served by the badge than by silence. Every box in the field is
 * in that state until its first successful status poll.
 *
 * ONE rule, three implementations — this one and a transcription in each boot
 * script, because neither shell can import TypeScript. The suite pins the three
 * together; nothing else stops them drifting into disagreeing about which boxes
 * have a cloud voice.
 */
export function clawaiEntitlementTier(
  planTier: unknown,
  deviceTier: unknown,
): ClawboxAiPlanTier | null {
  return normalizeClawboxAiPlanTier(planTier) ?? normalizeClawboxAiTier(deviceTier);
}

/**
 * WITHDRAW side: may this box's cloud voice be TAKEN AWAY?
 *
 * THE PLAN ALONE, and never the device stamp. This is the one irreversible act
 * in either boot script, and the stamp is a DEFAULT a Max subscriber is allowed
 * to have set to Flash — refusing on it is TASK-744 itself, and deleting on it
 * is TASK-744 with the customer's configuration gone. So a box whose plan is
 * not on record keeps what it has: not knowing is not a downgrade, and the cost
 * of holding is a refused round trip per spoken reply until the next poll,
 * against the cost of deleting, which is a Max subscriber's voice.
 *
 * @param planTier the recorded plan, as it sits in the store.
 * @param entitledTier the tier the proxy serves speech to (`"pro"`, the tier of
 *   the MAX plan — the names are off by one on purpose). Passed in rather than
 *   imported so this module does not pull `hermes-tts.ts`'s graph behind it.
 */
export function clawaiSpeechWithdrawable(planTier: unknown, entitledTier: string): boolean {
  const plan = normalizeClawboxAiPlanTier(planTier);
  return plan !== null && plan !== entitledTier;
}

/**
 * The same ARM rule, over the two stamps as they sit in `data/config.json`.
 *
 * The one TypeScript reader, so no surface derives the pair for itself. Reads
 * both keys, because "the plan is unknown" is a fact about the store rather
 * than about either value on its own.
 */
export async function readClawaiEntitlementTier(): Promise<ClawboxAiPlanTier | null> {
  const [planTier, deviceTier] = await Promise.all([
    get(CLAWAI_PLAN_TIER_KEY),
    get(CLAWAI_DEVICE_TIER_KEY),
  ]);
  return clawaiEntitlementTier(planTier, deviceTier);
}

/**
 * A portal answer about this box's plan, or the absence of one.
 *
 * `verdict` is `mapPortalPlanVerdict`'s value — a paid tier, the unpaid word,
 * or `null` for an answer this build cannot interpret. NOT `mapPortalPlanTier`,
 * whose `null` also covers an absent field and an unknown plan name; recording
 * either of those as unpaid hands the boot scripts a licence to delete.
 *
 * The OBJECT's presence says the portal answered at all — an `unreachable`
 * lookup, a probe that threw, and a caller that never asked all pass nothing,
 * and are all "we do not know".
 */
export interface ClawaiPortalPlan {
  verdict: ClawboxAiPlanTier | null;
}

/**
 * The value to write for {@link CLAWAI_PLAN_TIER_KEY} in the same store write
 * that records `clawai_tier`.
 *
 * `undefined` is a DELETE in `set`/`setMany`, and that is the answer for a
 * writer with no portal answer: it has just rewritten the badge for whatever
 * account this box now holds, and leaving the previous account's plan beside it
 * is how a retired Max plan comes to keep a Pro box's cloud voice armed.
 */
export function clawaiPlanTierForStore(
  portalPlan: ClawaiPortalPlan | undefined,
): ClawboxAiPlanTier | undefined {
  // An answer we could not interpret is a DELETE too, not an unpaid plan: the
  // boot scripts read a recorded plan as one they were told, and one of them
  // destroys configuration on it. Falling back to the badge for the ARM is the
  // right cost of not understanding the portal; deleting a Max subscriber's
  // voice is not.
  return portalPlan?.verdict ?? undefined;
}

/**
 * How many times the box's ClawBox AI credential has been REPLACED.
 *
 * A plain counter, never anything derived from a token — the same shape, and
 * the same reason, as `provenGeneration` in `clawbox-ai-portal-tier.ts`. It
 * lives in this thin module rather than in `@/lib/harness/credentials` because
 * the status route is one of its readers and importing that module into a badge
 * route drags the whole Hermes adapter graph in behind it.
 */
let credentialGeneration = 0;

/** Read the counter, to be handed back to {@link persistClawaiPlanTier}. */
export function clawaiPlanGeneration(): number {
  return credentialGeneration;
}

/**
 * The credential was rewritten — anything learned about the old one is about an
 * account this box has moved on from.
 *
 * Called from `forgetClawaiCredentialRefusal`, the funnel every credential
 * writer already goes through. Nothing is CLEARED here: the writers record or
 * delete the plan in the same store write as the badge, so there is never a
 * moment where one describes a different account than the other. This only
 * stops an answer that was already in flight from landing afterwards.
 *
 * DELIBERATELY OVER-APPROXIMATE. Two of that funnel's three callers reach it on
 * any credential WRITE, a re-paste of the identical token included, so the
 * counter moves more often than the credential really changes. That is the safe
 * direction and the reason it is not narrowed: bumping too often defers one
 * poll's plan write by 30 seconds, and bumping too seldom records a retired
 * account's plan and lets the next boot decide this box's entitlement from it.
 */
export function noteClawaiCredentialReplaced(): void {
  credentialGeneration += 1;
}

/** Test seam: forget the generation. */
export function _resetClawaiPlanGeneration(): void {
  credentialGeneration = 0;
}

/**
 * Record what the portal said this account's plan is.
 *
 * ONLY a portal-ANSWERED lookup may call this, and it passes
 * `mapPortalPlanVerdict`'s three-valued reading: a paid tier, the unpaid word,
 * or `null` for an answer this build cannot interpret — which is stored as an
 * absent key, exactly like never having asked. The wizard's plan picker is a
 * guess the account has not been consulted about (TASK-481) and an
 * `unreachable` lookup is the not-knowing this key exists to keep
 * distinguishable; neither may reach this function.
 *
 * `askedAtGeneration` is the credential counter as it stood when the lookup was
 * SENT. Up to four seconds pass before the portal answers, and the box can be
 * re-linked inside that window — writing then would be a plan for a token the
 * box no longer holds, which is how a retired Pro plan comes to withdraw a Max
 * subscriber's voice at the next boot. The same guard, for the same race, that
 * `clearPersistedClawaiCredentialRefusal`'s `notRecordedSince` is.
 *
 * Read before write, so the overwhelmingly common path (the plan has not
 * changed) never opens the store for writing, and best-effort for the same
 * reason the refusal stamp is: a badge poll must not fail because a hint could
 * not be saved. What it costs when it fails is honest and bounded — the boot
 * scripts go on reading the badge for the ARM and withdraw nothing at all.
 */
export async function persistClawaiPlanTier(
  portalPlan: ClawaiPortalPlan,
  askedAtGeneration?: number,
): Promise<void> {
  if (askedAtGeneration !== undefined && askedAtGeneration !== credentialGeneration) return;
  try {
    const next = clawaiPlanTierForStore(portalPlan);
    if (normalizeClawboxAiPlanTier(await get(CLAWAI_PLAN_TIER_KEY)) === (next ?? null)) return;
    await set(CLAWAI_PLAN_TIER_KEY, next);
  } catch {
    // See the docblock. The next poll writes it again.
  }
}
