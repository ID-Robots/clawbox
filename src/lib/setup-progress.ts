/**
 * The setup wizard's step numbering, and the one question two routes ask of it.
 *
 * `setup_progress_step` is the wizard's own record of how far the owner got:
 * `goToStep(n)` persists it through `/setup-api/setup/progress` at the moment a
 * step is passed, and it only ever moves forward. It is therefore the durable
 * answer to "has this box been through step N?", which is a different question
 * from any one step's own configuration flag.
 */

/** The wizard's first step (WiFi). */
export const SETUP_MIN_STEP = 1;
/** The completion overlay, which `startCompletion` persists. */
export const SETUP_MAX_STEP = 6;
/** The Update step, between WiFi and Credentials. */
export const SETUP_UPDATE_STEP = 2;

/**
 * A persisted step, or null when the store holds something that is not one.
 *
 * Unbounded on purpose — `bounded` is for validating what a CALLER sends. A
 * value already on disk may come from a build whose wizard had more steps than
 * this one, and reading such a box as "no progress at all" would walk its owner
 * back through screens they have already answered.
 */
export function parseSetupProgressStep(value: unknown, bounded = false): number | null {
  const step = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(step)) return null;
  if (step < SETUP_MIN_STEP) return null;
  if (bounded && step > SETUP_MAX_STEP) return null;
  return step;
}

/**
 * Has the wizard's Update step been passed on this box?
 *
 * Derived from the wizard's progress rather than from a flag of its own,
 * because the Update step is the one step that can be satisfied by doing
 * NOTHING: on a freshly flashed box it reports "System is up to date" and
 * auto-advances, so no update runs and the updater writes no record.
 *
 * `update_completed` in `data/config.json` is NOT that record and must not be
 * borrowed for it: `src/lib/updater.ts` writes it (with `update_completed_at`)
 * only after a full run finishes, and `/setup-api/update/status` synthesises a
 * `completed` phase with every step green from it. Setting it here would have
 * that route report an update that never ran. TASK-863.
 */
export function updateStepPassed(config: Record<string, unknown>): boolean {
  const step = parseSetupProgressStep(config.setup_progress_step);
  return step !== null && step > SETUP_UPDATE_STEP;
}
