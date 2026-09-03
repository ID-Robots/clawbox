/**
 * Is this box protected *right now*?
 *
 * The shield used to answer "did this box ever complete a backup" — any
 * `lastBackupAtMs > 0` was green unless an error heartbeat had arrived. The
 * two failures that keep a box unprotected the longest write no heartbeat at
 * all, so neither of them ever turned it amber:
 *
 *   - `EXIT_AUTH_REVOKED` (3) — `clawkeep/clawkeep/runner.py` returns before
 *     any portal exchange ("No portal exchange happened — don't heartbeat or
 *     stamp state"), so `lastHeartbeatStatus` keeps the previous run's "ok".
 *   - a daemon that is gone (systemd exec failure, 127) never runs a line, so
 *     nothing is written either way.
 *
 * In both cases `lastBackupAtMs` simply stops moving. The age of the last
 * *successful* backup is therefore the only fact that distinguishes a
 * protected box from a silently broken one, and it is a fact the daemon
 * already publishes — no new probe is needed.
 *
 * Mapping the EXIT_* taxonomy so a failed backup stops answering HTTP 200 is
 * a separate change (TASK-672); this module only judges the facts as they are
 * published today.
 */

export type ProtectionState = "protected" | "lapsed" | "unprotected";

/** Why {@link deriveProtection} landed on its state — drives the copy. */
export type ProtectionReason = "ok" | "error" | "stale" | "never";

/** The part of `ClawKeepSchedule` the age term needs. */
export interface ProtectionSchedule {
  enabled: boolean;
  frequency: "daily" | "weekly";
}

/** The part of `ClawKeepStatus` the age term needs. */
export interface ProtectionInput {
  lastBackupAtMs: number;
  lastHeartbeatStatus?: string;
  schedule?: ProtectionSchedule | null;
}

export interface Protection {
  state: ProtectionState;
  reason: ProtectionReason;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Slack allowed on top of the schedule's own period before a missed run
 * counts against the box. Wide enough that a late nightly run, a reboot or a
 * DST hop does not cry wolf; narrow enough that a nightly schedule lapses
 * within a day and a half — the 36 h the owner asked for.
 */
export const BACKUP_GRACE_MS = 12 * HOUR_MS;

/**
 * Window for a box with no schedule armed. There is no expected cadence to
 * derive one from, so this is a judgement call rather than arithmetic: a week
 * is the point past which a manual-only box has certainly drifted from its
 * last snapshot. It is also what the desktop shelf shield already used, so
 * both surfaces keep agreeing.
 */
export const UNSCHEDULED_MAX_AGE_MS = 7 * DAY_MS;

/** How old the last good backup may get before the box counts as lapsed. */
export function expectedBackupWindowMs(schedule?: ProtectionSchedule | null): number {
  if (!schedule?.enabled) return UNSCHEDULED_MAX_AGE_MS;
  const period = schedule.frequency === "weekly" ? 7 * DAY_MS : DAY_MS;
  return period + BACKUP_GRACE_MS;
}

/**
 * The one protection judgement, shared by ClawKeep's own shield and the
 * desktop shelf shield so the two can never disagree.
 *
 * `nowMs` is passed in rather than read from the clock so callers can sample
 * it on a tick of their own: a box whose daemon is gone keeps answering
 * `/setup-api/clawkeep` with the same bytes forever, and a status that never
 * changes must still age.
 */
export function deriveProtection(status: ProtectionInput, nowMs: number): Protection {
  // An explicit failure outranks the clock: the daemon ran, and said so.
  if (status.lastHeartbeatStatus === "error") return { state: "lapsed", reason: "error" };
  // Never ran one — a fresh install is "not set up yet", not "lapsed".
  if (!(status.lastBackupAtMs > 0)) return { state: "unprotected", reason: "never" };
  // `nowMs <= 0` means the caller has not sampled a clock yet; a backup dated
  // in the future is a clock skew, not a stale one. Neither ages anything out.
  const age = nowMs - status.lastBackupAtMs;
  if (nowMs > 0 && age > expectedBackupWindowMs(status.schedule)) {
    return { state: "lapsed", reason: "stale" };
  }
  return { state: "protected", reason: "ok" };
}
