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

import { computeNextRunMs, readSchedule, runBackup, type ClawKeepSchedule } from "@/lib/clawkeep";

let armed: NodeJS.Timeout | null = null;
let armedFor: number = 0;

function clear() {
  if (armed) {
    clearTimeout(armed);
    armed = null;
    armedFor = 0;
  }
}

function fireBackup(): void {
  // Best-effort: if a manual backup is already running the daemon will
  // serialise via its own heartbeat lock, so we don't gate here.
  void runBackup({ idle: true })
    .catch((err) => {
      console.warn("[clawkeep-scheduler] auto-backup failed:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      // Re-arm for the next slot.
      void rearm();
    });
}

async function rearm(): Promise<void> {
  clear();
  const schedule = await readSchedule();
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
  clear();
  const schedule = await readSchedule();
  arm(schedule);
}

/** Re-read the persisted schedule and rearm. Call after the user saves new
 * schedule settings via /setup-api/clawkeep/schedule. */
export async function refresh(): Promise<void> {
  await rearm();
}

/** When the next scheduled fire is, in unix ms. 0 means disarmed. Useful
 * for tests + admin UIs. */
export function nextRunAtMs(): number {
  return armedFor;
}
