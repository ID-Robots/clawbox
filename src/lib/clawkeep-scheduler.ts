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
 */

import {
  backupExitError,
  computeNextRunMs,
  readScheduleSnapshot,
  runBackup,
  type ClawKeepSchedule,
} from "@/lib/clawkeep";

let armed: NodeJS.Timeout | null = null;
let armedFor: number = 0;
/** Re-read timer for an unreadable `schedule.json`. Never a backup slot. */
let retry: NodeJS.Timeout | null = null;
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

function fireBackup(): void {
  // The slot is being consumed now, so stop claiming it is still ahead:
  // without this, `armedFor` names a time in the past for as long as the
  // backup runs, and `nextRunAtMs()` — the number an admin surface prints as
  // "next run" — reports it. Same reason `clawkeep-memory-scheduler.ts`
  // clears at the top of its own `fire()`.
  clear();
  // Best-effort: if a manual backup is already running the daemon will
  // serialise via its own heartbeat lock, so we don't gate here.
  //
  // A scheduled run must create + upload a REAL backup — `idle: true` only
  // sends a heartbeat ping (and short-circuits within the heartbeat interval),
  // so it would silently never back anything up. The manual "Backup now" path
  // uses idle:false; the scheduler must too.
  void runBackup({ idle: false })
    .then((result) => {
      // `runBackup` rejects only for an unpaired box; every other failure —
      // the daemon missing from PATH (127), a bad config (64), a token error
      // (65), the kill-timer (124), a revoked pairing (3) — RESOLVES carrying
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
async function rearm(): Promise<void> {
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
  applySchedule(snapshot.schedule);
}

function onUnreadableSchedule(): void {
  // Keep backing the box up on the last schedule that WAS readable. At boot
  // there is none, and then there is nothing to arm — but the retry below is
  // what stops that being permanent.
  if (lastGood) applySchedule(lastGood);
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

function applySchedule(schedule: ClawKeepSchedule): void {
  clear();
  arm(schedule);
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
  await rearm();
}

/**
 * Re-arm after the owner saves. Call from /setup-api/clawkeep/schedule.
 *
 * The route hands over the schedule `writeSchedule()` just returned, because
 * it is authoritative and re-reading the file it has only now renamed can
 * fail: a transient error on the save path would otherwise leave the OLD
 * cadence armed while the PUT answered 200, so a box would keep backing up
 * after the owner switched auto-backup off. Falls back to a read when no
 * schedule is supplied.
 */
export async function refresh(schedule?: ClawKeepSchedule): Promise<void> {
  if (!schedule) {
    await rearm();
    return;
  }
  ++rearmGeneration;
  clearRetry();
  lastGood = schedule;
  applySchedule(schedule);
}

/** When the next scheduled fire is, in unix ms. 0 means disarmed. Useful
 * for tests + admin UIs. */
export function nextRunAtMs(): number {
  return armedFor;
}
