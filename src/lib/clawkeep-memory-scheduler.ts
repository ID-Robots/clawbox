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
import { getMemoryShardEnabled } from "@/lib/memory-shard";
import { updateInFlight } from "@/lib/updater";

let armed: NodeJS.Timeout | null = null;
let armedFor = 0;
/**
 * Discards a re-arm whose schedule read was overtaken by a newer one. Two
 * saves in quick succession both clear the timer and both await the file; if
 * the older read resolves last it would arm the schedule the user just
 * replaced.
 */
let rearmGeneration = 0;

function clear(): void {
  if (armed) {
    clearTimeout(armed);
    armed = null;
    armedFor = 0;
  }
}

function fire(): void {
  // Drop the consumed slot first. Otherwise `armedFor` keeps pointing at a
  // time that has already passed for as long as the index runs, and the panel
  // shows a "next run" in the past.
  clear();
  void runSlot()
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

async function runSlot(): Promise<void> {
  // The owner's switch, read when the slot FIRES and not only when it was
  // armed. A switch flipped after the timer was set has to be honoured too —
  // an "off" that still spends the night embedding the owner's documents
  // because a timer predates it is exactly the half-applied setting this
  // feature must not have.
  if (!(await getMemoryShardEnabled())) {
    console.log("[clawkeep-memory-scheduler] skipped: Memory Shard is switched off");
    return;
  }
  // An update owns the OpenClaw store while it runs: post_update repairs it
  // with the gateway masked and stopped so there is ONE writer, and
  // `openclaw memory index` would be a second. A slot that lands inside an
  // update is skipped — one missed incremental pass costs nothing (see the
  // file comment) — and the next one runs as normal.
  if (await updateInFlight()) {
    console.log("[clawkeep-memory-scheduler] skipped: an update is in progress");
    return;
  }
  // Incremental, never a full reindex: a scheduled run must not spend hours
  // re-embedding everything unattended. The one exception is a box with no
  // index at all, where an incremental pass cannot succeed — startMemoryIndex
  // settles that through the same rule as the button, so the two agree. It
  // is single-flight, and declines this slot before it asks anything of the
  // CLI, so a manual run already in progress keeps its record; the one log
  // line is the only trace a declined slot leaves.
  const { accepted } = await startMemoryIndex("incremental", "schedule");
  if (!accepted) console.log("[clawkeep-memory-scheduler] skipped: an index run is in progress");
}

async function rearm(): Promise<void> {
  const generation = ++rearmGeneration;
  clear();
  const [schedule, enabled] = await Promise.all([readMemorySchedule(), getMemoryShardEnabled()]);
  if (generation !== rearmGeneration) return;
  // Switched off means NO timer, not a timer that fires into the skip above:
  // `nextRunAtMs()` is the number the app prints as "next run", and a box whose
  // indexing is off must not name an hour it will index at. Boot goes through
  // here too, so a box that was switched off before a reboot comes back
  // disarmed rather than re-armed by the schedule file alone.
  if (!enabled) return;
  arm(schedule);
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
  // Through the same serialised path, so a boot racing a save cannot arm the
  // older of the two schedules.
  await rearm();
}

/** Re-read the persisted schedule and re-arm, after the user saves one. */
export async function refresh(): Promise<void> {
  await rearm();
}

/** When the next scheduled fire is, in unix ms. 0 means disarmed. */
export function nextRunAtMs(): number {
  return armedFor;
}
