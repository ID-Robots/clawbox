/**
 * "Does this box's ClawBox AI account pay for the feature being asked for?"
 *
 * PURE, and client-safe on purpose: the two enable routes refuse on it and the
 * two first-run wizards draw themselves from it, so the one place the tier
 * arithmetic lives has to be importable from both sides. The server reads the
 * tier through `@/lib/paid-plan-gate-server`, which is where `config-store`
 * enters; nothing in this file touches the disk.
 *
 * THE TIER NAMES ARE OFF BY ONE and always have been (see
 * `CLAWBOX_AI_TIER_LABEL`): the internal `flash` is the plan marketed as
 * **Pro**, and the internal `pro` is the plan marketed as **Max**. "Pro or
 * Max" is therefore `flash | pro`, which is every paid tier there is — so
 * {@link isPaidPlan} is deliberately written as "is it one of the two paid
 * tiers" rather than as a list of feature-specific names. Free and
 * not-connected are both `null`, and both fail the gate.
 *
 * Owner's decision, 2026-09-14: the Coding Agent and Memory Shard need a paid
 * plan, and the first step of each wizard offers the upgrade instead.
 */

import { normalizeClawboxAiTier } from "@/lib/clawbox-ai-models";

/** The features this gate governs. One name, used by the routes and the UI. */
export const PAID_FEATURES = ["coding_agent", "memory_shard"] as const;
export type PaidFeature = (typeof PAID_FEATURES)[number];

/**
 * The stable name every refusal carries, and the one the UI matches on.
 *
 * Deliberately the SAME word the portal's own 402 uses
 * (`/setup-api/ai-models/clawai/poll`), because it means the same thing on
 * both sides of the box: this account does not pay for what was asked for.
 */
export const PAID_PLAN_REQUIRED_CODE = "paid_plan_required";

/**
 * Is the gate switched on at all?
 *
 * A constant rather than a condition, the shape
 * `HARNESS_SWAP_BUSINESS_PLAN_REQUIRED` already has: if the owner ever rules
 * that one of these ships on Free, this is the single line that changes and
 * `planGateFor`'s `required` parameter is what makes the flipped case testable
 * today.
 */
export const PAID_PLAN_GATE_REQUIRED = true;

/**
 * What a status payload says about the gate, so a surface never has to derive
 * it a second time.
 *
 * `plan` is the entitlement tier as it sits on the box — `"flash"`, `"pro"`,
 * or `null` for Free and for a box with no ClawBox AI account at all. It is
 * the INTERNAL name: a screen that prints it must map it through
 * `CLAWBOX_AI_TIER_LABEL` or the `ai.planName*` keys, never show it raw.
 */
export interface PlanGate {
  /** Does this build ask for a paid plan for the feature? */
  required: boolean;
  /** May the feature be switched on right now? */
  satisfied: boolean;
  /** The entitlement tier on record, or null for Free / not connected. */
  plan: string | null;
}

/** One of the two PAID tiers — i.e. the Pro plan or the Max plan. */
export function isPaidPlan(tier: unknown): boolean {
  return normalizeClawboxAiTier(tier) !== null;
}

/**
 * The gate, as a pure function of the tier.
 *
 * `required` is a parameter so the switched-off case is reachable from a test
 * without touching the constant every caller reads.
 */
export function planGateFor(
  tier: unknown,
  required: boolean = PAID_PLAN_GATE_REQUIRED,
): PlanGate {
  const plan = normalizeClawboxAiTier(tier);
  return { required, satisfied: !required || plan !== null, plan };
}

/**
 * A `planGate` off the wire, or nothing — never a half-read object.
 *
 * Both apps poll a route that may be answered by an OLDER server (a tab left
 * open across an update), where the field is simply absent. That is "do not
 * draw the notice", not "this box has no plan", so the guard is total and the
 * callers keep whatever they had.
 */
export function isPlanGate(value: unknown): value is PlanGate {
  if (typeof value !== "object" || value === null) return false;
  const gate = value as Partial<PlanGate>;
  return typeof gate.required === "boolean"
    && typeof gate.satisfied === "boolean"
    && (typeof gate.plan === "string" || gate.plan === null);
}

/**
 * Is turning this feature ON the thing the plan is in the way of?
 *
 * The screen-side reading of the same rule the routes enforce, and it takes
 * `enabled` for a reason: the switch of a feature that is already ON must stay
 * live, because turning it off is always allowed. Only the off-to-on
 * transition is blocked, and only when a gate this build actually asks for is
 * unsatisfied — an absent gate (an older server) blocks nothing.
 */
export function enableBlockedBy(gate: PlanGate | undefined, enabled: boolean): boolean {
  return !enabled && gate?.required === true && gate.satisfied === false;
}

/**
 * Would this request switch the feature ON, or finish its wizard?
 *
 * The gate's shape, and the reason it is not "refuse every write": an owner
 * whose subscription lapsed still owns the box. Nothing is auto-disabled, the
 * settings of a feature that is already on stay editable — including switching
 * it OFF — and what a Free account cannot do is turn either feature on or mark
 * its onboarding finished.
 */
export function bodyWouldEnable(body: { enabled?: unknown; setupComplete?: unknown }): boolean {
  return body.enabled === true || body.setupComplete === true;
}

/**
 * How each feature is NAMED in the refusal.
 *
 * A total record rather than a ternary, so a third feature added to
 * {@link PAID_FEATURES} is a compile error here instead of silently borrowing
 * another one's name.
 */
const FEATURE_NAME: Record<PaidFeature, string> = {
  coding_agent: "The coding agent",
  memory_shard: "Memory Shard",
};

/**
 * The English floor for the refusal.
 *
 * Every surface words the refusal from {@link PAID_PLAN_REQUIRED_CODE}, which
 * all ten locales carry; this is what a caller with no catalogue gets, and it
 * names the plans as the customer knows them — never the internal tier ids.
 */
export function paidPlanRefusalText(feature: PaidFeature): string {
  return `${FEATURE_NAME[feature]} needs a ClawBox Pro or Max plan. Connect a paid ClawBox AI account on this box, then switch it on.`;
}
