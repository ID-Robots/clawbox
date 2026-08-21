/**
 * In-process scheduler for unattended memory indexing.
 *
 * Deliberately the same shape as `clawkeep-scheduler.ts`, which already runs
 * ClawKeep's unattended backups: one persisted schedule, one armed timer,
 * re-armed after every fire, started from `instrumentation-node.ts`. That is
 * what makes "reuse one managed schedule rather than creating duplicates" and
 * "the schedule survives reboot and update" true by construction — the state
 * lives in a file under the ClawKeep data dir and the timer is rebuilt from it
 * at every boot, so there is no crontab entry to duplicate, orphan or lose.
 *
 * A device that was off across a slot does not backfill: one missed
 * incremental index costs nothing, and a device booting after a long outage
 * should not immediately spend its first minutes embedding.
 */

import {
  computeNextMemoryRunMs,
  readMemorySchedule,
  startMemoryIndex,
  type MemoryIndexSchedule,
} from "@/lib/clawkeep-memory";

let armed: NodeJS.Timeout | null = null;
let armedFor = 0;

function clear(): void {
  if (armed) {
    clearTimeout(armed);
    armed = null;
    armedFor = 0;
  }
}

function fire(): void {
  // Incremental, never a full reindex: a scheduled run must not spend hours
  // re-embedding everything unattended. `startMemoryIndex` is single-flight,
  // so a manual run already in progress simply declines this one.
  void startMemoryIndex("incremental", "schedule")
    .catch((err) => {
      console.warn(
        "[clawkeep-memory-scheduler] scheduled index failed:",
        err instanceof Error ? err.message : err,
      );
    })
    .finally(() => {
      void rearm();
    });
}

async function rearm(): Promise<void> {
  clear();
  arm(await readMemorySchedule());
}

function arm(schedule: MemoryIndexSchedule): void {
  if (!schedule.enabled) return;
  const next = computeNextMemoryRunMs(schedule, new Date());
  if (next <= 0) return;
  // setTimeout wraps past 2^31-1 ms and would fire immediately; a daily or
  // weekly slot never comes close, so this is defence in depth.
  const delayMs = Math.min(next - Date.now(), 0x7fffffff);
  armedFor = next;
  armed = setTimeout(fire, Math.max(0, delayMs));
}

/** Boot hook — call once at process start. Idempotent. */
export async function start(): Promise<void> {
  clear();
  arm(await readMemorySchedule());
}

/** Re-read the persisted schedule and re-arm, after the user saves one. */
export async function refresh(): Promise<void> {
  await rearm();
}

/** When the next scheduled fire is, in unix ms. 0 means disarmed. */
export function nextRunAtMs(): number {
  return armedFor;
}
