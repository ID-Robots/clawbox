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
   * When the schedule was last *armed* — switched on, or tightened to a
   * shorter cadence. Not "when schedule.json was last written": `writeSchedule`
   * lands the file on every save, and the same file holds the retention count
   * and the time of day, so a file stamp would restart this grace every time
   * the owner nudged a setting. See {@link deriveProtection}.
   */
  scheduleArmedAtMs?: number;
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
 * The longest window {@link expectedBackupWindowMs} ever returns — the weekly
 * one. A backup older than this is stale under every cadence there is, so no
 * grace may reach past it.
 */
export const MAX_BACKUP_WINDOW_MS = 7 * DAY_MS + BACKUP_GRACE_MS;

/**
 * The hard cap on a single backup run. `runBackup()` in `src/lib/clawkeep.ts`
 * spawns every backup on this box — manual and scheduled alike, since the
 * standalone `clawkeep/systemd/` timers are deliberately not installed and the
 * in-Next scheduler drives runs instead — and SIGKILLs the daemon at this mark.
 * Declared here, where nothing is imported, so the kill timer and the UI's
 * liveness rule below are the same number by construction.
 *
 * It is ClawKeep's own number, not one ClawBox picked: `clawkeep/systemd/
 * clawkeepd.service` declares `TimeoutStartSec=4h` for this very binary, which
 * is the daemon's answer to "how long may one backup take". Because those
 * timers are not installed, this is the only ceiling ClawBox itself imposes on
 * a run, so a shorter one here is the box overruling the daemon.
 *
 * It is not the only ceiling that EXISTS. The daemon shells out for four steps
 * and carries a cap on each: `backup create` and `backup verify` in
 * `openclaw.py`, and `openssl enc` / `enc -d` in `crypto.py`. Those bind
 * first, whatever this constant allows. They were 30, 5, 30 and 30 minutes and
 * all now take one `limits.SUBPROCESS_TIMEOUT_S`, the same four hours;
 * `clawkeep-backup-run-cap.test.ts` reads them back out of the Python and pins
 * them against this value. Only the ARCHIVE step differs by edition — the
 * Hermes backend builds its tarball in-process with `tarfile` — while the
 * encrypt and decrypt steps run outside any edition branch, so both SKUs carry
 * the openssl cap.
 *
 * It was 60 minutes, written when a Jetson backup took 2-5 minutes. TASK-675
 * made 10 GB+ archives the supported case and the validated 12 GiB run took
 * ~86 minutes — so the box SIGKILLed, around 70% of the upload, the very run
 * the multipart chunking and the portal's credential-TTL fix had gone to work
 * to make possible, and answered "backup timed out" over a healthy transfer.
 * `clawkeep-backup-run-cap.test.ts` reads the unit file and pins the two
 * together so they cannot drift apart again.
 */
export const BACKUP_RUN_CAP_MS = 4 * HOUR_MS;

/**
 * The hard cap on a single RESTORE, and on how long a `restoring.flag` may be
 * believed. Declared beside the backup's for the reason the module gives
 * above: these are one number by construction, not three that happen to agree.
 *
 * It is the same four hours, and deliberately so — `TimeoutStartSec=4h` is a
 * bound on one whole ClawKeep run, and a restore is one. What was wrong was
 * not that the restore lacked a multiplier but that it had HALF the backup's
 * budget, 30 minutes against 60, for work that is at least symmetric: the
 * download mirrors the upload, and decrypt, extract and `openclaw backup
 * verify` all come on top. That put a 12 GB restore out of reach before
 * TASK-675's archives existed, and being SIGKILLed part-way through a restore
 * is worse than being killed part-way through a backup, because what is being
 * rewritten is the box's own state.
 */
export const RESTORE_RUN_CAP_MS = BACKUP_RUN_CAP_MS;

/**
 * How long a `"running"` status may stand before the run behind it is a corpse
 * rather than a slow backup.
 *
 * This is not "silence since the last sign of life". `runner.py` stamps
 * `last_heartbeat_at_ms` once, as the run starts, and writes it again only on a
 * terminal status; what it keeps publishing while a run is in flight is
 * `last_step_at_ms` (one stamp per phase) and `upload_bytes_done` (re-saved
 * every 250 ms), neither of which touches the heartbeat and neither of which
 * moves at all during the archive build. So the heartbeat measures how long the
 * run has been going — and the only honest bound on that is the cap the process
 * that spawned it enforces. Past {@link BACKUP_RUN_CAP_MS} the daemon has been
 * SIGKILLed and there is nothing left to pulse for; before it, the run may well
 * be alive, and the old 30-minute rule (written when a Jetson backup took 2-5
 * minutes) declared healthy ones dead — dropping the shelf's progress pulse
 * and, on a box whose first backup it was, turning the shelf shield red while
 * the upload was fine.
 *
 * What this deliberately does NOT do is invent a looser window than the cap:
 * pulsing past it would be a progress indicator for a process that no longer
 * exists. It follows the cap instead, which is why raising the cap for
 * TASK-675's 10 GB+ archives also fixed the other half of that defect — at 60
 * minutes the shelf went dark on a 12 GB upload that was still going.
 *
 * The remaining looseness is that the heartbeat measures DURATION, not
 * progress: a run SIGKILLed at the cap — or orphaned by a Next restart, which
 * takes the kill timer with it — leaves `"running"` behind and the pulse stays
 * on until the window closes, now four hours rather than one.
 *
 * What is missing is NOT a daemon-side stamp. `runner.py`'s
 * `_on_upload_progress` already persists `upload_bytes_done` on a 250 ms
 * throttle, `getStatus()` already reads it into `uploadBytesDone`, and the
 * card already draws a throughput figure from it: a counter that has not moved
 * across several polls IS the liveness signal, on today's boxes. What is
 * missing is a consumer — `isBackupRunning` is handed only the two heartbeat
 * fields, so giving it progress means changing its inputs and every caller
 * (the shelf, the card, the hook, `backup_status`), and the archive-build
 * phase still has only `currentStepAtMs` to go on. That is a change with its
 * own RED, not a line in this one.
 *
 * Two edges this leaves open, neither of which touches the protection verdict —
 * `lastBackupAtMs` stops moving either way, so the age term below still lapses
 * the box on schedule:
 *   - a SIGKILLed run leaves `"running"` in state.json for ever (nothing gets
 *     to write a terminal status), so the pulse stays on until the cap;
 *   - if the Next process restarts mid-run its kill timer dies with it, and a
 *     daemon that then outlives the cap keeps working while the pulse stops.
 * Making a failed run stop answering "ok" at all is TASK-672's job, not this
 * module's — it judges the facts as they are published today.
 */
export const STALE_RUNNING_MS = BACKUP_RUN_CAP_MS;

/** How old the last good backup may get before the box counts as lapsed. */
export function expectedBackupWindowMs(schedule?: ProtectionSchedule | null): number {
  if (!schedule?.enabled) return UNSCHEDULED_MAX_AGE_MS;
  const period = schedule.frequency === "weekly" ? 7 * DAY_MS : DAY_MS;
  return period + BACKUP_GRACE_MS;
}

/**
 * Is a backup genuinely in flight? A stuck `"running"` must not be shown as
 * progress for ever, and must not hide the protection verdict behind it — but
 * a slow one must not be declared dead either. See {@link STALE_RUNNING_MS}.
 */
export function isBackupRunning(
  status: { lastHeartbeatStatus?: string; lastHeartbeatAtMs?: number } | null | undefined,
  nowMs: number,
): boolean {
  if (!status) return false;
  if (status.lastHeartbeatStatus !== "running") return false;
  if (!status.lastHeartbeatAtMs) return false;
  // A heartbeat AHEAD of the reader's clock is skew, not a longer run: the
  // stamp comes off a box with no battery-backed RTC and is judged against a
  // browser's. A little of it is the gap between the two reads and belongs to
  // a run that has genuinely just started; a stamp further ahead than a whole
  // run may last is a broken clock. Believing that one pins the shelf's pulse
  // — and the card's progress panel, which hides the verdict behind it — for
  // as long as the skew lasts, over a run that was SIGKILLed at the cap and
  // can never publish a terminal status to end it.
  if (status.lastHeartbeatAtMs - nowMs > STALE_RUNNING_MS) return false;
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
  const everRan = status.lastBackupAtMs > 0;
  // A refusal is not a slow run — waiting out the window would report green
  // over a box on which nothing can succeed. `EXIT_NEED_PASSPHRASE` (9) stamps
  // "needs-passphrase"; `encryptionConfigured === false` says the same thing
  // before the runner has even been asked.
  //
  // This outranks a plain "error" because the runner publishes
  // `"needs-passphrase" if ok else "error"` — a box with no passphrase whose
  // heartbeat could not reach the portal lands on "error", and "one retry and
  // we'll lock it back down" is the wrong remedy for a box that has nothing to
  // retry with.
  if (everRan
    && (status.lastHeartbeatStatus === "needs-passphrase"
      || status.encryptionConfigured === false)) {
    return { state: "lapsed", reason: "blocked" };
  }
  // An explicit failure outranks the clock: the daemon ran, and said so.
  if (status.lastHeartbeatStatus === "error") return { state: "lapsed", reason: "error" };
  // Never ran one — a fresh install is "not set up yet", not "lapsed".
  if (!everRan) return { state: "unprotected", reason: "never" };

  // Arming auto-backup, or tightening its cadence, shrinks the tolerated age
  // (7 days to 36 h). Applying that retroactively would lapse a box on the
  // same click for a run that is not due yet, so while the new window runs its
  // first course the age is measured from the arm rather than from the backup.
  //
  // `scheduleArmedAtMs` is minted by `writeSchedule()`, and only there, because
  // only there is the window the box was being judged against a moment ago
  // known. It does not move on a plain re-save — otherwise nudging the backup
  // time or the retention count would hand a box whose backups died ten days
  // ago a fresh 36 h of green, on the very card the lapsed copy sends the owner
  // to — and it is not minted at all for a box the previous window had already
  // lapsed, so toggling the switch off and on cannot rescue one either.
  //
  // It is clamped to `now` here because it comes off the box's clock and is
  // judged against the reader's, which is a browser sampling a 60 s tick: a
  // stamp a few seconds "ahead" is that gap, not skew, and discarding it would
  // lapse the box on the very click the grace exists for. Clamping honours it
  // as "just armed" instead — and the ceiling below is what stops a genuinely
  // skewed RTC (these boxes have no battery-backed clock) turning that into
  // green for as long as wall-clock takes to catch up.
  const armedAtMs = Math.min(status.scheduleArmedAtMs ?? 0, nowMs);
  const armGrace = status.schedule?.enabled
    && nowMs - status.lastBackupAtMs <= MAX_BACKUP_WINDOW_MS
    ? armedAtMs
    : 0;
  const anchor = Math.max(status.lastBackupAtMs, armGrace);
  // A *backup* dated ahead of the clock is the harmless kind of skew: the
  // snapshot exists, so the subtraction goes negative and the box stays green.
  if (nowMs - anchor > expectedBackupWindowMs(status.schedule)) {
    return { state: "lapsed", reason: "stale" };
  }
  return { state: "protected", reason: "ok" };
}
