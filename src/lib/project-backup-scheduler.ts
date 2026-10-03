// ── The daily auto-backup of project folders (TASK-1358) ────────────────────
//
// The ClawKeep schedulers' shape (clawkeep-scheduler.ts): `start()` from
// instrumentation at boot, an unref'd timer, re-armed in `finally` so one
// failed pass never ends the schedule. Simpler than theirs because the rule is:
// "once a day per folder, only when something changed", not "at 03:00". So
// this wakes every hour and backs up whatever is due — the due rule and the
// records live in project-backup.ts and data/config.json, which is what makes
// a restart, a sleep or a clock change harmless: nothing here is a deadline
// that can be missed, only a question asked again an hour later.
//
// The first look waits a few minutes after boot, so a box that just came up
// is not pushing to GitHub while it is still starting its own services.

const FIRST_CHECK_MS = 5 * 60 * 1000;
export const CHECK_EVERY_MS = 60 * 60 * 1000;

let armed: ReturnType<typeof setTimeout> | null = null;
let armedFor = 0;
let passing = false;

function arm(delayMs: number): void {
  if (armed) clearTimeout(armed);
  armedFor = Date.now() + delayMs;
  armed = setTimeout(() => { void fire(); }, delayMs);
  // A timer must never be the reason the process stays alive.
  armed.unref?.();
}

async function fire(): Promise<void> {
  armed = null;
  armedFor = 0;
  if (passing) return;
  passing = true;
  try {
    // Imported late: the backup module pulls in the coding agent's GitHub
    // code, which a box that never backs a project up has no reason to load.
    const { runDueAutoBackups } = await import("@/lib/project-backup");
    await runDueAutoBackups();
  } catch (err) {
    console.error("[project-backup-scheduler] daily backup pass failed:", err instanceof Error ? err.message : err);
  } finally {
    passing = false;
    arm(CHECK_EVERY_MS);
  }
}

/** Boot hook — call once at process start. Idempotent. */
export async function start(): Promise<void> {
  if (armed || passing) return;
  arm(FIRST_CHECK_MS);
}

/** Run one pass now (tests, and a caller that knows something just became due). */
export async function checkNow(): Promise<void> {
  if (armed) clearTimeout(armed);
  armed = null;
  await fire();
}

/** When the next look is due, in unix ms. 0 while a pass is running or before start(). */
export function nextCheckAtMs(): number {
  return armedFor;
}

/** Test-only: disarm. */
export function _stopForTest(): void {
  if (armed) clearTimeout(armed);
  armed = null;
  armedFor = 0;
  passing = false;
}
