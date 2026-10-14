/**
 * In-process scheduler for Prime Radiant's nightly pass — the same shape as
 * `clawkeep-memory-scheduler.ts`: one schedule (the settings file's
 * `nightly`), one armed timer rebuilt from it at every boot and after every
 * save, re-armed after every fire. No crontab entry to duplicate or orphan.
 *
 * A box that was off across a slot does not backfill; the next night runs as
 * usual. A slot that finds no vault, a pass already running or an update in
 * progress is skipped with one log line. The timer lives in `processStore`,
 * because the boot hook that arms it and the settings route that re-arms it
 * are separate module copies.
 *
 * SERVER ONLY.
 */

import { processStore } from "@/lib/process-store";
import { runNightly } from "./nightly";
import { parseNightlyTime, readSettings, type NightlySettings } from "./settings";
import { vaultInitialised } from "./vault";

const state = processStore("prime-radiant:nightly-scheduler", () => ({
  timer: null as NodeJS.Timeout | null,
  armedFor: 0,
  generation: 0,
}));

/** The next local `HH:MM` after `now`, in unix ms; 0 when the schedule is off or unreadable. */
export function computeNextNightlyMs(schedule: NightlySettings, now: Date): number {
  if (!schedule.enabled) return 0;
  const t = parseNightlyTime(schedule.time);
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

async function updateRunning(): Promise<boolean> {
  try {
    const { updateInFlight } = await import("@/lib/updater");
    return await updateInFlight();
  } catch {
    return false;
  }
}

async function runSlot(): Promise<void> {
  // The schedule is read again when the slot FIRES: a switch turned off after
  // the timer was set is honoured.
  if (!readSettings().nightly.enabled) return;
  if (!(await vaultInitialised())) {
    console.log("[prime-radiant-scheduler] skipped: the vault has not been created yet");
    return;
  }
  // An update rewrites the box while it runs; one missed night costs nothing.
  if (await updateRunning()) {
    console.log("[prime-radiant-scheduler] skipped: an update is in progress");
    return;
  }
  const run = await runNightly("schedule");
  console.log(run ? `[prime-radiant-scheduler] nightly pass ${run.id}: ${run.status}` : "[prime-radiant-scheduler] skipped: a pass is already running");
}

function fire(): void {
  clear();
  void runSlot()
    .catch((err) => console.warn("[prime-radiant-scheduler] nightly pass failed:", err instanceof Error ? err.message : err))
    .finally(() => {
      void rearm();
    });
}

async function rearm(): Promise<void> {
  const generation = ++state.generation;
  clear();
  let schedule: NightlySettings;
  try {
    schedule = readSettings().nightly;
  } catch {
    return;
  }
  if (generation !== state.generation) return;
  const next = computeNextNightlyMs(schedule, new Date());
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

/** When the next scheduled pass is, in unix ms. 0 means disarmed. */
export function nextRunAtMs(): number {
  return state.armedFor;
}

/** Disarm (tests). */
export function stop(): void {
  state.generation++;
  clear();
}
