/**
 * In-process scheduler for the nightly OpenClaw database check — the shape of
 * `prime-radiant/nightly-scheduler.ts`: one schedule (the device store's
 * `openclaw_db_maintenance`, on at 04:30 local by default), one timer rebuilt
 * from it at every boot and after every save, re-armed after every fire. No
 * crontab entry or systemd timer to duplicate or orphan.
 *
 * A slot only STARTS a run (`startDbMaintenance`); the run measures first and
 * stops the gateway only when a database needs compacting and the core says
 * the gateway is idle, so most nights it reads a few file headers and is done.
 * A box that was off across a slot does not backfill. A slot that finds no
 * OpenClaw (the Hermes edition), an update or a run already going is skipped
 * with one log line. The timer lives in `processStore`, because the boot hook
 * that arms it and the route that re-arms it are separate module copies.
 *
 * SERVER ONLY.
 */

import { processStore } from "@/lib/process-store";
import {
  parseDbMaintenanceTime,
  readDbMaintenanceSchedule,
  startDbMaintenance,
  type DbMaintenanceSchedule,
} from "@/lib/openclaw-db-maintenance";

const state = processStore("openclaw-db-maintenance:scheduler", () => ({
  timer: null as NodeJS.Timeout | null,
  armedFor: 0,
  generation: 0,
}));

/** The next local `HH:MM` after `now`, in unix ms; 0 when the schedule is off or unreadable. */
export function computeNextDbMaintenanceMs(schedule: DbMaintenanceSchedule, now: Date): number {
  if (!schedule.enabled) return 0;
  const t = parseDbMaintenanceTime(schedule.time);
  if (!t) return 0;
  const next = new Date(now.getTime());
  next.setHours(t.hour, t.minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(t.hour, t.minute, 0, 0);
  }
  return next.getTime();
}

function clear(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.armedFor = 0;
}

async function runSlot(): Promise<void> {
  // Read again when the slot FIRES: a switch turned off after the timer was set is honoured.
  if (!(await readDbMaintenanceSchedule()).enabled) return;
  const start = await startDbMaintenance("scheduled");
  if (start.started) {
    console.log(`[db-maintenance-scheduler] nightly check started${start.survivesRestart ? "" : " (as a child of the web server)"}`);
  } else {
    console.log(`[db-maintenance-scheduler] skipped: ${start.code}${start.detail ? ` (${start.detail})` : ""}`);
  }
}

function fire(): void {
  clear();
  void runSlot()
    .catch((err) => console.warn("[db-maintenance-scheduler] nightly check failed:", err instanceof Error ? err.message : err))
    .finally(() => {
      void rearm();
    });
}

async function rearm(): Promise<void> {
  const generation = ++state.generation;
  clear();
  let schedule: DbMaintenanceSchedule;
  try {
    schedule = await readDbMaintenanceSchedule();
  } catch {
    return;
  }
  if (generation !== state.generation) return;
  const next = computeNextDbMaintenanceMs(schedule, new Date());
  if (next <= 0) return;
  state.armedFor = next;
  state.timer = setTimeout(fire, Math.max(0, Math.min(next - Date.now(), 0x7fffffff)));
  state.timer.unref?.();
}

/** Boot hook — call once at process start. Idempotent. */
export async function start(): Promise<void> {
  await rearm();
}

/** Re-read the schedule and re-arm, after the owner saves it. */
export async function refresh(): Promise<void> {
  await rearm();
}

/** When the next scheduled check is, in unix ms. 0 means disarmed. */
export function nextRunAtMs(): number {
  return state.armedFor;
}

/** Disarm (tests). */
export function stop(): void {
  state.generation++;
  clear();
}
