/**
 * In-process scheduler for unattended ClawKeep backups.
 *
 * The user picks a schedule (daily/weekly + HH:MM) in the ClawKeep app and
 * we arm a single setTimeout that fires `runBackup` at that wall-clock time,
 * then re-arms for the next slot. The Next.js process is up 24/7 (it's the
 * device's UI shell), so we don't need cron / systemd timers — and avoiding
 * those keeps the schedule entirely user-editable from the GUI.
 *
 * Boot behaviour: `start()` is invoked from `instrumentation-node.ts`. It
 * reads the persisted schedule and arms only when enabled. If the device
 * was off across a scheduled slot, the next slot is the upcoming one — we
 * don't backfill (a single missed run is preferable to a thundering herd
 * if the device boots after a long outage).
 *
 * A failed run never switches auto-backup off — a quota refusal included: the
 * `.finally()` below re-arms the next slot whatever the exit code, so the
 * first slot after the account has room again backs the box up. What CAN turn
 * it off is a save, and a save made while the account was refusing
 * credentials for quota is recorded as a quota hold (`quotaHoldSinceMs`): this
 * module then probes the account and switches auto-backup back on the first
 * time credentials mint again (TASK-1211).
 */

import {
  backupExitError,
  computeNextRunMs,
  readScheduleSnapshot,
  releaseQuotaHoldIfCredentialsWork,
  runBackup,
  type ClawKeepSchedule,
} from "@/lib/clawkeep";

let armed: NodeJS.Timeout | null = null;
let armedFor: number = 0;
/** Re-read timer for an unreadable `schedule.json`. Never a backup slot. */
let retry: NodeJS.Timeout | null = null;
/** Next look at whether a quota-held account issues credentials again. */
let holdProbe: NodeJS.Timeout | null = null;
/** The quota hold on `lastGood`, or 0. */
let lastGoodHold = 0;
/** Serialises overlapping rearms so the older read cannot arm last. */
let rearmGeneration = 0;
/**
 * The last schedule this process could actually READ.
 *
 * An unreadable file is evidence of nothing, so the honest thing to keep
 * running on is the last thing that was evidence of something. Without it the
 * post-fire rearm — the one that has no live timer to preserve — had nothing
 * to fall back to and simply stopped.
 */
let lastGood: ClawKeepSchedule | null = null;

/**
 * How long to wait before looking at an unreadable `schedule.json` again.
 *
 * "Can I read the schedule?" answered once and believed for the life of the
 * process is the probe-once class, and on this file it is total: a box that
 * boots on a root-owned or half-written file would never back up again, on one
 * log line. Long enough that a genuinely broken file is not a log flood,
 * short enough that a transient EIO/EMFILE self-heals within the hour.
 */
const UNREADABLE_RETRY_MS = 15 * 60 * 1000;

/**
 * How often a quota-held box asks whether the account issues credentials
 * again. Each look is one credentials mint and one listing — no archive, no
 * upload — so hourly costs the portal little and means a box whose owner
 * freed space in the portal is backing up again within the hour.
 */
export const QUOTA_HOLD_PROBE_MS = 60 * 60 * 1000;

/**
 * The first look after boot comes sooner: the counter may well have been
 * corrected while the box was off, and restarting the box is the obvious thing
 * for an owner (or support) to try. Not immediate, so the listing does not
 * compete with everything else a Jetson is starting.
 */
export const QUOTA_HOLD_BOOT_PROBE_MS = 5 * 60 * 1000;

function clear() {
  if (armed) {
    clearTimeout(armed);
    armed = null;
    armedFor = 0;
  }
}

function clearRetry() {
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
}

function clearHoldProbe() {
  if (holdProbe) {
    clearTimeout(holdProbe);
    holdProbe = null;
  }
}

/** Arm the next quota-hold probe — only for a schedule that is off AND held. */
function armHoldProbe(schedule: ClawKeepSchedule, quotaHoldSinceMs: number, delayMs: number): void {
  clearHoldProbe();
  // `!(x > 0)` rather than `x <= 0`: a snapshot from an older shape has no
  // hold at all, and `undefined <= 0` is false.
  if (schedule.enabled || !(quotaHoldSinceMs > 0)) return;
  holdProbe = setTimeout(() => { void probeQuotaHold(); }, delayMs);
  // A probe must not be a reason for the process to stay alive.
  holdProbe.unref?.();
}

/**
 * Look once at a quota hold, and either switch auto-backup back on or look
 * again later. Never throws: a probe that fails is evidence of nothing, and
 * the hold stays.
 */
async function probeQuotaHold(): Promise<void> {
  clearHoldProbe();
  const generation = rearmGeneration;
  let check: Awaited<ReturnType<typeof releaseQuotaHoldIfCredentialsWork>>;
  try {
    check = await releaseQuotaHoldIfCredentialsWork();
  } catch (err) {
    console.warn(
      "[clawkeep-scheduler] quota-hold check failed (auto-backup stays paused):",
      err instanceof Error ? err.message : err,
    );
    check = { outcome: "held" };
  }
  if (check.outcome === "released") {
    // The file now says "on", and the answer is newer than anything read
    // before it — so it wins over an in-flight rearm, like a save does.
    ++rearmGeneration;
    clearRetry();
    lastGood = check.schedule;
    lastGoodHold = 0;
    applySchedule(check.schedule, 0);
    console.warn(
      "[clawkeep-scheduler] the ClawKeep account issues credentials again — auto-backup is back on"
        + (armedFor > 0 ? ` (next run ${new Date(armedFor).toISOString()})` : ""),
    );
    return;
  }
  // A save or a rearm while this probe ran has armed whatever it needed.
  if (generation !== rearmGeneration) return;
  if (check.outcome === "held" && lastGood) armHoldProbe(lastGood, lastGoodHold, QUOTA_HOLD_PROBE_MS);
}

function fireBackup(): void {
  // The slot is being consumed now, so stop claiming it is still ahead:
  // without this, `armedFor` names a time in the past for as long as the
  // backup runs, and `nextRunAtMs()` — the number an admin surface prints as
  // "next run" — reports it. Same reason `clawkeep-memory-scheduler.ts`
  // clears at the top of its own `fire()`.
  clear();
  // NOT gated on a run already being in flight, and the reason given here
  // used to be false: "the daemon will serialise via its own heartbeat lock".
  // There is no such lock — no pidfile, no flock, nothing in `daemon.py`,
  // `runner.py` or `state.py` — so two `clawkeepd` processes will happily
  // stage two multi-GB archives and upload both. It has been survivable
  // because the window is small; raising the run cap to four hours for
  // TASK-675's 12 GB archives widens it, since a manual backup started late
  // in the evening can still be running when the nightly slot fires. Closing
  // it properly is the daemon's own single-instance guard rather than a
  // check here, which could only ever narrow the race.
  //
  // A scheduled run must create + upload a REAL backup — `idle: true` only
  // sends a heartbeat ping (and short-circuits within the heartbeat interval),
  // so it would silently never back anything up. The manual "Backup now" path
  // uses idle:false; the scheduler must too.
  void runBackup({ idle: false })
    .then((result) => {
      // `runBackup` rejects only for an unpaired box; every other failure —
      // the daemon missing from PATH (127), a bad config (64), a token error
      // (65), the kill-timer (124), a revoked pairing (3), a full account
      // (2) — RESOLVES carrying
      // the exit code, so the `.catch` below never sees it, and unlogged those
      // were a nightly no-op. For the missing-daemon case this is the ONLY
      // thing that can report it at all: the Settings card's backup button is
      // disabled on `!daemonInstalled`, so nobody can even try by hand.
      if (result.exitCode !== 0) {
        const tail = result.stderr.trim().slice(-500);
        // Same classification the route answers with (TASK-672), so an
        // operator reading this log and an owner reading the panel are told the
        // same thing about the same run. Non-null by construction here — the
        // only exit code it answers `null` for is 0.
        const classified = backupExitError(result.exitCode)!;
        console.warn(
          "[clawkeep-scheduler] auto-backup failed:",
          `clawkeepd exited ${result.exitCode} (${classified.code}: ${classified.message})`
            + (tail ? ` — ${tail}` : ""),
        );
      }
    })
    .catch((err) => {
      console.warn("[clawkeep-scheduler] auto-backup failed:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      // Re-arm for the next slot.
      void rearm();
    });
}

/**
 * Re-read the schedule and re-arm, without letting an unreadable file be read
 * as the owner switching auto-backup off.
 *
 * An unreadable `schedule.json` sanitises to `DEFAULT_SCHEDULE`, whose
 * `enabled` is false, so this used to tear the nightly timer down and go
 * quiet: a box that had been backing up every night simply stopped, on nothing
 * but a transient EACCES/EIO/EMFILE or a JSON truncated by a power cut
 * (TASK-433). `readScheduleSnapshot()` already separates "no file" — a box
 * that has never had a schedule — from "there is a file and it says nothing we
 * can read", which is evidence of nothing.
 *
 * What this does NOT do is fix the same symptom on the OWNER's side: `GET
 * /setup-api/clawkeep/schedule` and `getStatus()` both still flatten
 * `unreadable` to `DEFAULT_SCHEDULE`, so while the engine keeps backing the
 * box up the card still reads "auto-backup is off" and `deriveProtection`
 * still judges it on the 7-day unscheduled window. Carrying `unreadable`
 * through to a card state is a change with its own copy in ten locales; this
 * one keeps the backups running.
 */
async function rearm(holdProbeDelayMs: number = QUOTA_HOLD_PROBE_MS): Promise<void> {
  const generation = ++rearmGeneration;
  const snapshot = await readScheduleSnapshot();
  // A concurrent rearm — a save landing during boot, or two saves in quick
  // succession — read after this one did, so its answer is the newer.
  if (generation !== rearmGeneration) return;
  if (snapshot.unreadable) {
    onUnreadableSchedule();
    return;
  }
  clearRetry();
  lastGood = snapshot.schedule;
  lastGoodHold = snapshot.quotaHoldSinceMs;
  applySchedule(snapshot.schedule, snapshot.quotaHoldSinceMs, holdProbeDelayMs);
}

function onUnreadableSchedule(): void {
  // Keep backing the box up on the last schedule that WAS readable. At boot
  // there is none, and then there is nothing to arm — but the retry below is
  // what stops that being permanent.
  if (lastGood) applySchedule(lastGood, lastGoodHold);
  console.warn(
    "[clawkeep-scheduler] schedule.json could not be read — "
      + (armedFor > 0
        ? `keeping the last schedule that was (next run ${new Date(armedFor).toISOString()})`
        // Nothing armed is two different facts and only one is an alarm: a box
        // whose owner switched auto-backup off is behaving correctly, a box
        // that has never managed to read the file is not.
        : lastGood
          ? "auto-backup was last known to be off"
          : "nothing is armed and nothing has been read yet")
      + `; trying again in ${Math.round(UNREADABLE_RETRY_MS / 60_000)} min`,
  );
  clearRetry();
  retry = setTimeout(() => { void rearm(); }, UNREADABLE_RETRY_MS);
  // A re-read must not be a reason for the process to stay alive.
  retry.unref?.();
}

function applySchedule(
  schedule: ClawKeepSchedule,
  quotaHoldSinceMs: number,
  holdProbeDelayMs: number = QUOTA_HOLD_PROBE_MS,
): void {
  clear();
  arm(schedule);
  armHoldProbe(schedule, quotaHoldSinceMs, holdProbeDelayMs);
  // The one choke point every arm path goes through, and the last place this
  // card's own symptom can still hide: `arm()` returns silently when the
  // schedule is enabled and `computeNextRunMs()` answers 0. The range check on
  // `timeOfDay` closes the way that used to happen, but two inputs still
  // reach it — the weekly loop's 9-hop clock/DST guard, and any schedule
  // handed to `refresh()` that did not come through `sanitiseSchedule()`.
  // Auto-backup reading as on with no timer armed must never be silent again.
  if (schedule.enabled && armedFor === 0) {
    console.warn(
      "[clawkeep-scheduler] auto-backup is on but the schedule computes no next run"
        + ` (${schedule.frequency} ${schedule.timeOfDay} weekday ${schedule.weekday})`
        + " — nothing is armed",
    );
  }
}

function arm(schedule: ClawKeepSchedule): void {
  if (!schedule.enabled) return;
  const next = computeNextRunMs(schedule, new Date());
  if (next <= 0) return;
  // Clamp delays into 32-bit (~24.8 days) since setTimeout otherwise
  // wraps and fires immediately. For weekly/daily slots the delay never
  // exceeds 7 days, so this is a defence-in-depth check.
  const delayMs = Math.min(next - Date.now(), 0x7fffffff);
  if (delayMs <= 0) {
    // Schedule already past — fire on the next event-loop tick.
    armedFor = Date.now();
    armed = setTimeout(fireBackup, 0);
    return;
  }
  armedFor = next;
  armed = setTimeout(fireBackup, delayMs);
}

/** Boot hook — call once at process start. Idempotent. */
export async function start(): Promise<void> {
  await rearm(QUOTA_HOLD_BOOT_PROBE_MS);
}

/**
 * Re-arm after the owner saves. Call from /setup-api/clawkeep/schedule.
 *
 * The route hands over the schedule `writeSchedule()` just returned, because
 * it is authoritative and re-reading the file it has only now renamed can
 * fail: a transient error on the save path would otherwise leave the OLD
 * cadence armed while the PUT answered 200, so a box would keep backing up
 * after the owner switched auto-backup off. Falls back to a read when no
 * schedule is supplied. `quotaHoldSinceMs` is the hold that same write
 * returned: a save that paused auto-backup for a full account starts the probe
 * that switches it back on, and any other save stops it.
 */
export async function refresh(schedule?: ClawKeepSchedule, quotaHoldSinceMs: number = 0): Promise<void> {
  if (!schedule) {
    await rearm();
    return;
  }
  ++rearmGeneration;
  clearRetry();
  lastGood = schedule;
  lastGoodHold = quotaHoldSinceMs;
  applySchedule(schedule, quotaHoldSinceMs);
}

/**
 * Look at a quota hold now rather than at the next hourly probe. Called after
 * a backup succeeded by hand — the owner freed space and pressed "Back up
 * now" — so auto-backup comes back with the run that proved it can. A no-op
 * when no hold is known.
 */
export async function recheckQuotaHold(): Promise<void> {
  if (!(lastGoodHold > 0)) return;
  await probeQuotaHold();
}

/** When the next scheduled fire is, in unix ms. 0 means disarmed. Useful
 * for tests + admin UIs. */
export function nextRunAtMs(): number {
  return armedFor;
}
