/**
 * What the OAuth sign-in save does when `openclaw doctor --fix` exits non-zero
 * after it has written the legacy auth-profiles.json (SUP-1023, "Credential
 * migration failed").
 *
 * WHY THIS FILE EXISTS. The save imports a subscription sign-in by writing the
 * legacy file and running doctor, whose JSON → sqlite auth migration is the
 * FIRST thing it does. Doctor then goes on to repair the config and the
 * plugins, and every one of those later steps can make it exit 1 with the
 * credential already safe in the store — measured on 2026.11.3 in a throwaway
 * home, with a second writer touching openclaw.json while doctor ran:
 *
 *     Migrated auth profile JSON … into SQLite (archive: …).
 *     The config changed after Doctor prepared these repairs.
 *     Doctor finished, but config fixes were not applied.          (exit 1)
 *
 * The legacy file was gone, the archive was there, the profile was in the
 * store — and the route read the exit code as "the migration failed", renamed
 * a file that no longer existed and answered 502 "Credential migration
 * failed". The next sign-in did the same. An exit code is not the migration's
 * verdict; the store is.
 *
 * Doctor can also fail BEFORE it migrates (the same writer, an instant earlier:
 * "Config unavailable … Doctor could not complete maintenance", store empty),
 * and that one a second run heals once the other writer is done. So the save
 * does, in this order: run doctor again when a second run can change the
 * answer; failing that, take "the legacy file is gone" as the cue to ask the
 * gateway's store whether the sign-in is in it; and only when neither shows the
 * credential, roll back as it always did.
 *
 * Pure helpers only — no fs, no store reads — so the route's mocks of both
 * leave them as they are.
 */

/** Env knob for the pause before the second doctor run. See {@link doctorRetryPauseMs}. */
export const DOCTOR_RETRY_PAUSE_ENV = "CLAWBOX_DOCTOR_RETRY_PAUSE_MS";

/** Long enough for a writer that collided with the first run to finish its write. */
const DOCTOR_RETRY_PAUSE_DEFAULT_MS = 3_000;
/** Whatever a typo asks for, the owner is not kept waiting longer than this on top of two doctor runs. */
const DOCTOR_RETRY_PAUSE_CEILING_MS = 30_000;

/**
 * The pause, read per call. A value that is not a number of milliseconds is
 * the default rather than a budget: `NaN` here would otherwise become a
 * zero-length wait and race the very writer the pause is for. The suites set
 * it to 0 (vitest.config.ts) so a rolled-back sign-in does not cost them
 * three seconds each.
 */
export function doctorRetryPauseMs(): number {
  const raw = process.env[DOCTOR_RETRY_PAUSE_ENV];
  if (raw === undefined || raw.trim() === "") return DOCTOR_RETRY_PAUSE_DEFAULT_MS;
  const asked = Number(raw);
  if (!Number.isFinite(asked) || asked < 0) return DOCTOR_RETRY_PAUSE_DEFAULT_MS;
  return Math.min(asked, DOCTOR_RETRY_PAUSE_CEILING_MS);
}

export async function pauseBeforeDoctorRetry(): Promise<void> {
  const ms = doctorRetryPauseMs();
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Doctor said, in so many words, that it will say the same thing again: it
 * read a config it cannot parse (a second run reads the same bytes).
 */
const DETERMINISTIC_DOCTOR_FAILURE_RE =
  /is not parseable and cannot be repaired automatically/i;

/**
 * Is a second `doctor --fix` worth its cost (a CLI cold start and whatever
 * doctor then does, a minute or more on a Jetson)?
 *
 * Yes for anything that is plausibly a collision or a leftover: a refused
 * config write, a locked store, a half-finished earlier run whose receipts the
 * next run finalises. No when:
 *   - the run was KILLED at its budget — a second one would double a wait that
 *     already ended in failure, and the next sign-in's doctor finalises what
 *     the first left; and
 *   - the CLI could not be run at all (ENOENT/EACCES on the binary), or doctor
 *     read a config that cannot be parsed — the same thing happens again.
 * The named refusals (legacy exec approvals, service ownership, a gateway that
 * is not down) never get here: they are outcomes, not errors, and the route
 * does not retry those either.
 */
export function doctorFailureIsRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // By name, not `instanceof`: dozens of suites replace `@/lib/openclaw-config`
  // with a factory that carries no such class.
  if (err.name === "OpenclawSpawnTimeoutError") return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "EACCES") return false;
  return !DETERMINISTIC_DOCTOR_FAILURE_RE.test(err.message);
}

/**
 * How much of doctor's ending one journal line carries. Past `logSafe`'s own
 * 200-character default, which keeps the HEAD of a value and so would throw
 * away exactly the part that is wanted: the caller passes this to both.
 */
export const DOCTOR_TAIL_CHARS = 400;

/** Terminal chrome of doctor's `note()` boxes: the frame, not the words. */
const DOCTOR_BOX_CHARACTERS = /[│├└┌┐┘┤┬┴┼─╮╯╭╰◇◆●○]/gu;

/**
 * The end of what a failed doctor said, for ONE journal line: frame characters
 * dropped, whitespace collapsed, the LAST `max` characters kept — a doctor's
 * verdict is its last line, and its first screen is the banner. The input is
 * the CLI's own output (paths, profile ids, never a token); the caller still
 * runs it through `logSafe`.
 */
export function doctorFailureTail(err: unknown, max = DOCTOR_TAIL_CHARS): string {
  const text = (err instanceof Error ? err.message : String(err))
    .replace(DOCTOR_BOX_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}
