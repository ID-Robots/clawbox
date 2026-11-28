/**
 * In-process timer for the weekly update check (TASK-2260) — the shape of
 * `openclaw-db-maintenance-scheduler.ts`: one timer, rebuilt from the state at
 * every boot, after the owner flips the switch and after the box's timezone
 * changes; re-armed after every fire. No crontab entry or systemd timer to
 * duplicate or orphan.
 *
 * The timer only WAKES the check. Whether one is due is decided from
 * `data/update-notice.json` when it fires (`runWeeklyUpdateCheck`), so a timer
 * that fired early, a second module copy or a restart cannot check twice — and
 * a box that was off across Monday's slot checks once at its next start that
 * week, `BOOT_DELAY_MS` after the web server comes up, when the network and the
 * harness have had a moment to settle.
 *
 * Armed even while the switch is OFF: the slot then records the week as
 * skipped, which keeps "switched back on on Thursday" from turning into an
 * immediate check. The timer lives in `processStore`, because the boot hook
 * that arms it and the route that re-arms it are separate module copies.
 *
 * SERVER ONLY.
 */

import { processStore } from "@/lib/process-store";
import { readUpdateNoticeState, runWeeklyUpdateCheck } from "@/lib/update-notice";
import { planNextCheck, UPDATE_CHECK_RETRY_MS } from "@/lib/update-notice-schedule";

/** How long after the web server starts a due (catch-up) check waits. */
export const BOOT_DELAY_MS = 3 * 60_000;

/** The longest a Node timer can hold (~24.8 days); a week fits, but never trust it blindly. */
const MAX_TIMER_MS = 0x7fffffff;

/**
 * `CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS`: a SHORTER boot delay, for a lab board
 * proving the catch-up path without sitting through three minutes per try.
 * Only ever shortens, and never below one second.
 */
export function bootDelayMs(): number {
  const raw = Number(process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return BOOT_DELAY_MS;
  return Math.max(1_000, Math.min(BOOT_DELAY_MS, Math.floor(raw)));
}

const state = processStore("update-notice:scheduler", () => ({
  timer: null as NodeJS.Timeout | null,
  armedFor: 0,
  generation: 0,
  startedAt: Date.now(),
  /** After a run that broke, nothing before this — so a broken data/ cannot spin the timer. */
  backoffUntil: 0,
}));

function clear(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.armedFor = 0;
}

function fire(): void {
  clear();
  void runWeeklyUpdateCheck(new Date())
    .then((result) => {
      state.backoffUntil = result.failed ? Date.now() + UPDATE_CHECK_RETRY_MS : 0;
      if (result.ran) console.log(`[update-notice] week ${result.week}: ${result.outcome}${result.via ? ` (via ${result.via})` : ""}`);
    })
    .catch((err) => console.warn("[update-notice] the weekly check failed:", err instanceof Error ? err.message : err))
    .finally(() => {
      void rearm();
    });
}

async function rearm(): Promise<void> {
  const generation = ++state.generation;
  clear();
  let at: number;
  try {
    const plan = planNextCheck(await readUpdateNoticeState(), new Date());
    at = Math.max(plan.at, state.startedAt + bootDelayMs(), state.backoffUntil);
  } catch (err) {
    console.warn("[update-notice] could not plan the weekly check:", err instanceof Error ? err.message : err);
    return;
  }
  if (generation !== state.generation) return;
  state.armedFor = at;
  state.timer = setTimeout(fire, Math.max(0, Math.min(at - Date.now(), MAX_TIMER_MS)));
  state.timer.unref?.();
}

/** Boot hook — call once at process start. Idempotent. */
export async function start(): Promise<void> {
  await rearm();
}

/** Re-plan after the owner flips the switch or the box's timezone changes. */
export async function refresh(): Promise<void> {
  await rearm();
}

/** When the timer next wakes, unix ms; 0 when it is not armed. */
export function nextRunAtMs(): number {
  return state.armedFor;
}

/** Disarm (tests). */
export function stop(): void {
  state.generation++;
  clear();
}

/** Tests only: pretend the web server started at `startedAt`. */
export function resetStartForTests(startedAt: number = Date.now()): void {
  stop();
  state.startedAt = startedAt;
  state.backoffUntil = 0;
}
