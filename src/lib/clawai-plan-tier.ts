import { get, set } from "@/lib/config-store";
import { normalizeClawboxAiTier, type ClawboxAiTier } from "@/lib/clawbox-ai-models";

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
 * Values are the same two-value enum `clawai_tier` uses (`"flash"` for the Pro
 * plan, `"pro"` for the Max plan — the names are off by one on purpose, see
 * `CLAWBOX_AI_MODEL_BY_TIER`). Anything else, `null` included, means the portal
 * has told us nothing we can act on, and every reader falls back to the device
 * stamp there rather than treating it as a downgrade.
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
 * The tier an ENTITLEMENT may be decided from: the plan when the portal has
 * told us one, and the device stamp only when it has not.
 *
 * ONE rule, four implementations — this one, `speechEntitledTier()`, and a
 * transcription of it in each boot script — because neither shell can import
 * TypeScript. The suites pin the four together; nothing else stops them
 * drifting into disagreeing about which boxes have a cloud voice.
 *
 * `null` is "nobody has told us", and it is NOT "not entitled": a caller that
 * refuses on it turns a portal outage or a box the status poll has never run on
 * into a downgrade. Callers that DESTROY configuration must require a non-null
 * answer; callers that merely decline to arm may treat it as declining.
 */
export function clawaiEntitlementTier(
  planTier: unknown,
  deviceTier: unknown,
): ClawboxAiTier | null {
  return normalizeClawboxAiTier(planTier) ?? normalizeClawboxAiTier(deviceTier);
}

/**
 * The same rule, over the two stamps as they sit in `data/config.json`.
 *
 * The one TypeScript reader, so no surface derives the pair for itself. Reads
 * both keys, because "the plan is unknown" is a fact about the store rather
 * than about either value on its own.
 */
export async function readClawaiEntitlementTier(): Promise<ClawboxAiTier | null> {
  const [planTier, deviceTier] = await Promise.all([
    get(CLAWAI_PLAN_TIER_KEY),
    get(CLAWAI_DEVICE_TIER_KEY),
  ]);
  return clawaiEntitlementTier(planTier, deviceTier);
}

/**
 * Record the portal's plan answer.
 *
 * Only a portal-ANSWERED lookup may call this — never the wizard's plan picker,
 * which is a guess the account has not been consulted about (TASK-481), and
 * never an `unreachable` verdict, which is the not-knowing this key exists to
 * keep distinguishable.
 *
 * Read before write, so the overwhelmingly common path (the plan has not
 * changed) never opens the store for writing, and best-effort for the same
 * reason the refusal stamp is: a badge poll must not fail because a hint could
 * not be saved. What it costs when it fails is honest and bounded — the boot
 * scripts go on reading the device stamp, which is what they did before this
 * key existed.
 */
export async function persistClawaiPlanTier(planTier: ClawboxAiTier | null): Promise<void> {
  try {
    const stored = normalizeClawboxAiTier(await get(CLAWAI_PLAN_TIER_KEY));
    if (stored === planTier) return;
    // `undefined` DELETES the key, which is the honest record of "the portal
    // answered and this account has no paid plan": there is no third enum value
    // for it, and writing `null` would be read back as a plan we cannot act on
    // anyway. Both leave the boot scripts on the device stamp.
    await set(CLAWAI_PLAN_TIER_KEY, planTier ?? undefined);
  } catch {
    // See the docblock. The next poll writes it again.
  }
}

/**
 * Forget the recorded plan — the credential changed, so the plan on record
 * belongs to an account this box no longer holds a token for.
 *
 * Called from `forgetClawaiCredentialRefusal`, the one funnel every credential
 * writer already goes through, rather than beside each of them: a writer that
 * retired the refusal and left the plan would let the PREVIOUS account's Max
 * plan keep the cloud voice armed on a box that has just been re-linked to a
 * lower one, which is a refused round trip per spoken reply and the panel
 * calling the voice configured while it happens. That funnel fires on every
 * credential WRITE rather than only on a change, and clearing too eagerly is
 * the safe direction here: it puts both boot scripts back on the device stamp
 * until the next status poll answers — which is exactly, and only, where they
 * were before this key existed. Clearing too seldom would be a fact about a
 * retired account overriding a fresh one.
 *
 * Costs nothing when it lands on a box whose plan has not been recorded — the
 * read below is what decides.
 */
export async function clearClawaiPlanTier(): Promise<void> {
  try {
    if ((await get(CLAWAI_PLAN_TIER_KEY)) === undefined) return;
    await set(CLAWAI_PLAN_TIER_KEY, undefined);
  } catch {
    // Bounded the same way: an uncleared plan costs one status poll, after
    // which the portal's answer for the credential the box now holds replaces
    // it.
  }
}
