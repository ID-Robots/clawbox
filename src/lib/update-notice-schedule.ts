/**
 * WHEN the weekly update check runs (TASK-2260) — pure arithmetic, no I/O, so
 * every rule below is a unit test away from proof.
 *
 * MONDAY, 10:00 ON THE BOX'S OWN CLOCK, plus this box's jitter. "The box's
 * clock" is the PROCESS zone: src/lib/timezone.ts (`applyProcessTimeZone`)
 * keeps it on the zone the owner chose, which is the same contract every other
 * device-local schedule here keeps (`clawkeep-scheduler`, the nightly database
 * check). So `Date#getDay` / `setHours` below ARE the owner's Monday morning.
 *
 * THE JITTER is per box and fixed: a number of seconds drawn once, when the
 * state file is first written, and kept. Ten thousand boxes all asking GitHub
 * at 10:00:00 sharp is the burst that gets a fleet refused (TASK-655 measured
 * what that does to the update check); an hour's spread is enough, and a fixed
 * one means a box's slot does not wander from week to week.
 *
 * ONCE PER WEEK, AND THE WEEK IS NAMED. `weekKey` is the local date of the
 * week's Monday. A week whose check finished — or was switched off — is
 * recorded under that name, so a restart, an update or a second timer never
 * checks twice, and a box that was OFF across Monday's slot still checks once,
 * at its next start that week: the slot has passed and the week is not done.
 *
 * A CHECK THAT COULD NOT LOOK (GitHub unreachable, the box offline) does not
 * finish the week. It is tried again `UPDATE_CHECK_RETRY_MS` later, for as long
 * as the week lasts; the next week starts clean.
 */

/** `Date#getDay` numbering: 0 is Sunday, so Monday is 1. */
export const UPDATE_CHECK_WEEKDAY = 1;
/** The local hour the slot opens at — daytime, when the owner can act on it. */
export const UPDATE_CHECK_HOUR = 10;
/** The jitter is drawn from [0, this) seconds: up to an hour after the hour. */
export const UPDATE_CHECK_JITTER_MAX_S = 60 * 60;
/** How long a check that could not reach the update remote waits before it tries again. */
export const UPDATE_CHECK_RETRY_MS = 60 * 60 * 1000;

/** What the plan needs from the persisted state. */
export interface UpdateCheckScheduleState {
  /** The `weekKey` of the last week whose check finished (or was switched off). */
  lastCheckedWeek: string | null;
  /** When a check last FAILED to look, in unix ms; null when the last one settled. */
  lastAttemptAt: number | null;
  /** This box's fixed jitter, seconds. */
  jitterS: number;
}

export interface UpdateCheckPlan {
  /** When to run, unix ms. At or before "now" means it is due. */
  at: number;
  /** The week that run settles. */
  week: string;
}

/** A jitter the arithmetic can trust, whatever was on disk. */
export function clampJitter(jitterS: unknown): number {
  if (typeof jitterS !== "number" || !Number.isFinite(jitterS)) return 0;
  return Math.min(UPDATE_CHECK_JITTER_MAX_S - 1, Math.max(0, Math.floor(jitterS)));
}

/** A fresh jitter for a box that has none yet. `random` is injectable for tests. */
export function drawJitter(random: () => number = Math.random): number {
  return clampJitter(random() * UPDATE_CHECK_JITTER_MAX_S);
}

/** Local midnight of the Monday that starts the week `now` falls in. */
export function weekStart(now: Date): Date {
  const start = new Date(now.getTime());
  start.setHours(0, 0, 0, 0);
  const back = (start.getDay() - UPDATE_CHECK_WEEKDAY + 7) % 7;
  start.setDate(start.getDate() - back);
  // `setDate` keeps the wall-clock time across a DST change, but a zone whose
  // clocks jump AT midnight can leave 01:00 behind; the hour is not part of
  // the week's name, so put it back where the slot arithmetic expects it.
  start.setHours(0, 0, 0, 0);
  return start;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The week's name: its Monday's local date, `YYYY-MM-DD`. */
export function weekKey(now: Date): string {
  const monday = weekStart(now);
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

/** The slot of the week that starts at `monday`: 10:00 local plus the jitter. */
export function slotOf(monday: Date, jitterS: number): number {
  const slot = new Date(monday.getTime());
  slot.setHours(UPDATE_CHECK_HOUR, 0, 0, 0);
  return slot.getTime() + clampJitter(jitterS) * 1000;
}

/**
 * The next time the check should run, judged at `now`.
 *
 *   - This week not done, slot still ahead       → this week's slot.
 *   - This week not done, slot passed            → now (on time, or the
 *     catch-up after downtime) — unless a check already failed to look since
 *     the slot, in which case one retry interval after that attempt.
 *   - This week done                             → next Monday's slot.
 */
export function planNextCheck(state: UpdateCheckScheduleState, now: Date): UpdateCheckPlan {
  const nowMs = now.getTime();
  const monday = weekStart(now);
  const thisWeek = weekKey(now);
  const thisSlot = slotOf(monday, state.jitterS);

  if (state.lastCheckedWeek !== thisWeek) {
    if (nowMs < thisSlot) return { at: thisSlot, week: thisWeek };
    const failedSinceSlot = typeof state.lastAttemptAt === "number"
      && state.lastAttemptAt >= thisSlot
      && state.lastAttemptAt <= nowMs;
    const retryAt = failedSinceSlot ? (state.lastAttemptAt as number) + UPDATE_CHECK_RETRY_MS : nowMs;
    return { at: Math.max(nowMs, retryAt), week: thisWeek };
  }

  const nextMonday = new Date(monday.getTime());
  nextMonday.setDate(nextMonday.getDate() + 7);
  return { at: slotOf(weekStart(nextMonday), state.jitterS), week: weekKey(nextMonday) };
}

/** Is the check due at `now`? The plan's own answer, for the code that wakes up. */
export function isCheckDue(state: UpdateCheckScheduleState, now: Date): UpdateCheckPlan | null {
  const plan = planNextCheck(state, now);
  return plan.at <= now.getTime() ? plan : null;
}
