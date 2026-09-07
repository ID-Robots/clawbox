/**
 * The drift vocabulary, with NOTHING behind it.
 *
 * `build-identity.ts` — where these codes are produced — imports `child_process`,
 * `fs/promises` and `path`, and `BuildIdentityPanel.tsx` already imports from it.
 * That is safe only while every such import is type-only: the first component to
 * reach for a runtime value would pull the Node built-ins into the browser bundle
 * and fail the build, which is the same trap `update-constants.ts` exists for
 * (`RESTART_STEP_ID`). So the codes, the predicate and the wording rules live
 * here, with no imports at all, and `build-identity.ts` re-exports the type.
 */

/**
 * Every drift code. The union below is DERIVED from it, which is what stops the
 * two from disagreeing: a code added to the type has to be added here.
 */
export const DRIFT_CODES = [
  "build-from-other-commit",
  "build-info-not-for-deployed-assets",
  "build-predates-checkout",
  "build-unstamped",
  "checkout-dirty",
  "checkout-behind-pin",
  "no-pin",
] as const;

export type DriftCode = (typeof DRIFT_CODES)[number];

/** Is this warning code one of the drift diagnoses, rather than some other update warning? */
export function isDriftCode(code: string): code is DriftCode {
  return (DRIFT_CODES as readonly string[]).includes(code);
}

/**
 * The codes the build-versus-checkout comparison produces.
 *
 * They are ALTERNATIVES in one if/else chain, not independent facts: one
 * underlying "the build is not the code on disk" can surface as any of them,
 * and can move between them as the box changes. So they are resolved and
 * restated together, never one by one.
 */
export const BUILD_AXIS_CODES: readonly DriftCode[] = [
  "build-from-other-commit",
  "build-info-not-for-deployed-assets",
  "build-predates-checkout",
  "build-unstamped",
];

export function isBuildAxisCode(code: string): boolean {
  return (BUILD_AXIS_CODES as readonly string[]).includes(code);
}

/** The one line a finished run leaves behind about drift it resolved. */
export const DRIFT_RESOLVED_CODE = "drift-resolved";

/**
 * The calls to action `computeDrift` ends a reason with.
 *
 * Named rather than matched, because the one place they must come OFF — the
 * past-tense history line a completed update leaves behind — has to drop
 * exactly the imperative and keep every fact, and a regex over owner-facing
 * English is how that goes wrong quietly. `computeDrift` builds its reasons
 * from these, so the list cannot fall out of step with the sentences.
 */
export const DRIFT_ACTION_REALIGN = " — run Update to realign.";
export const DRIFT_ACTION_REBUILD_FROM_CHECKOUT = " — run Update to rebuild from this checkout.";
export const DRIFT_ACTION_REBUILD = " — run Update to rebuild.";

const DRIFT_ACTIONS = [
  DRIFT_ACTION_REALIGN,
  DRIFT_ACTION_REBUILD_FROM_CHECKOUT,
  DRIFT_ACTION_REBUILD,
] as const;

/**
 * A drift reason with its call to action taken off, ending in a full stop.
 *
 * What a past-tense retelling may quote: the shas and the branch survive — a
 * support engineer reading a screenshot can still tell a box one commit behind
 * from one 71 behind — while "run Update to realign" does not reach an owner
 * whose update has just realigned the box.
 */
export function driftFact(reason: string): string {
  for (const action of DRIFT_ACTIONS) {
    if (reason.endsWith(action)) return `${reason.slice(0, -action.length)}.`;
  }
  return reason;
}
