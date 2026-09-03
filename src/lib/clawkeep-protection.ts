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
 * This module is the one protection judgement: ClawKeep's own shield, the
 * desktop shelf shield and the `backup_status` MCP tool all derive from it, so
 * they cannot disagree about whether the box is protected.
 *
 * Mapping the EXIT_* taxonomy so a failed backup stops answering HTTP 200 is
 * a separate change (TASK-672); this module only judges the facts as they are
 * published today.
 */

export type ProtectionState = "protected" | "lapsed" | "unprotected";

/** Why {@link deriveProtection} landed on its state — drives the copy. */
export type ProtectionReason = "ok" | "error" | "blocked" | "stale" | "never";

/** The part of `ClawKeepSchedule` the age term needs. */
export interface ProtectionSchedule {
  enabled: boolean;
  frequency: "daily" | "weekly";
}

/** The part of `ClawKeepStatus` the judgement needs. */
export interface ProtectionInput {
  lastBackupAtMs: number;
  lastHeartbeatAtMs?: number;
  lastHeartbeatStatus?: string;
  schedule?: ProtectionSchedule | null;
  /**
   * When the schedule was last written (`schedule.json`'s mtime — the file is
   * landed by atomic rename, so its mtime is exactly that moment). Arming a
   * schedule must not lapse a box retroactively; see {@link deriveProtection}.
   */
  scheduleChangedAtMs?: number;
  /**
   * False when the device has no backup-encryption passphrase. Encryption is
   * mandatory, so the runner refuses every run (`EXIT_NEED_PASSPHRASE`) until
   * one is set. Optional: a caller that does not publish it is simply not
   * judged on it.
   */
  encryptionConfigured?: boolean;
}

export interface Protection {
  state: ProtectionState;
  reason: ProtectionReason;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
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
 * last snapshot.
 *
 * Beta applied a flat 7 days to *every* box, scheduled or not. That rule is
 * gone: a scheduled box is now judged against its own cadence (stricter for a
 * nightly schedule, slightly looser for a weekly one) and 7 days survives only
 * as the no-schedule fallback.
 */
export const UNSCHEDULED_MAX_AGE_MS = 7 * DAY_MS;

/**
 * If a "running" status has not been refreshed in this long, the run is dead
 * (systemd kill, OOM, power cut mid-backup) rather than slow — `runner.py`
 * persists `"running"` before it starts, and nothing overwrites it if the
 * process never returns. Real Jetson backups finish in 2-5 minutes.
 */
export const STALE_RUNNING_MS = 30 * MINUTE_MS;

/** How old the last good backup may get before the box counts as lapsed. */
export function expectedBackupWindowMs(schedule?: ProtectionSchedule | null): number {
  if (!schedule?.enabled) return UNSCHEDULED_MAX_AGE_MS;
  const period = schedule.frequency === "weekly" ? 7 * DAY_MS : DAY_MS;
  return period + BACKUP_GRACE_MS;
}

/**
 * Is a backup genuinely in flight? A stuck `"running"` must not be shown as
 * progress for ever, and must not hide the protection verdict behind it.
 */
export function isBackupRunning(
  status: { lastHeartbeatStatus?: string; lastHeartbeatAtMs?: number } | null | undefined,
  nowMs: number,
): boolean {
  if (!status) return false;
  if (status.lastHeartbeatStatus !== "running") return false;
  if (!status.lastHeartbeatAtMs) return false;
  return nowMs - status.lastHeartbeatAtMs < STALE_RUNNING_MS;
}

/**
 * The one protection judgement.
 *
 * `nowMs` is passed in rather than read from the clock so callers can sample
 * it on a tick of their own: a box whose daemon is gone keeps answering
 * `/setup-api/clawkeep` with the same bytes forever, and a status that never
 * changes must still age.
 */
export function deriveProtection(status: ProtectionInput, nowMs: number): Protection {
  // An explicit failure outranks the clock: the daemon ran, and said so.
  if (status.lastHeartbeatStatus === "error") return { state: "lapsed", reason: "error" };

  const everRan = status.lastBackupAtMs > 0;
  // A refusal is not a slow run — waiting out the window would report green
  // over a box on which nothing can succeed. `EXIT_NEED_PASSPHRASE` (9) stamps
  // "needs-passphrase"; `encryptionConfigured === false` says the same thing
  // before the runner has even been asked.
  if ((status.lastHeartbeatStatus === "needs-passphrase" || status.encryptionConfigured === false)
    && everRan) {
    return { state: "lapsed", reason: "blocked" };
  }
  // Never ran one — a fresh install is "not set up yet", not "lapsed".
  if (!everRan) return { state: "unprotected", reason: "never" };

  // Age from whichever is later: the last good backup, or the moment the
  // schedule changed. Arming auto-backup shrinks the window (7 days → 36 h),
  // and applying that retroactively would lapse a box on the same click for a
  // run that is not due yet — blaming a scheduled run that has never run.
  // Only an armed schedule gets the grace; with auto-backup off there is no
  // run to wait for.
  const anchor = status.schedule?.enabled
    ? Math.max(status.lastBackupAtMs, status.scheduleChangedAtMs ?? 0)
    : status.lastBackupAtMs;
  // A backup dated ahead of the clock is skew, not staleness: the subtraction
  // goes negative and the box stays protected.
  if (nowMs - anchor > expectedBackupWindowMs(status.schedule)) {
    return { state: "lapsed", reason: "stale" };
  }
  return { state: "protected", reason: "ok" };
}
