// Client-safe constants shared between `src/lib/updater.ts` (server-only —
// uses child_process/fs) and `src/components/SettingsApp.tsx` (client). Pulling
// `RESTART_STEP_ID` directly from `updater.ts` causes Next.js to bundle the
// whole updater module for the browser, which fails at compile time on the
// Node built-ins.

export const RESTART_STEP_ID = "restart";

/** Where the owner is sent while an update owns the box. */
export const UPDATING_PAGE = "/updating";

/**
 * The header the middleware stamps on `/setup-api` responses while the update
 * lock is held.
 *
 * Here rather than in `update-lock.ts` for that file's own reason: it opens with
 * `import fs`, so a client component reading the constant would drag the whole
 * lock module — and Node's fs — into the browser bundle.
 *
 * It exists because the middleware's redirect only fires on a NAVIGATION, and a
 * desktop that was already open when an update began makes none: it stayed put,
 * kept polling, and went blank when the rebuild stopped the web server under it,
 * leaving a manual reload as the only way to the screen built for this. The
 * header rides on requests the desktop already makes, so nothing new is polled.
 */
export const UPDATE_LOCK_HEADER = "x-clawbox-update-lock";

/**
 * The sentence an interrupted run is reported with — and the IDENTITY of that
 * verdict, which is why it lives here rather than inside `updater.ts`.
 *
 * The verdict is remembered in memory as well as on disk, and the reader that
 * decided it need not be the process that ran the update. Recognising the state
 * it left is what lets a completion take it back, so the status route and the
 * updater have to agree on the exact string — and a test that hand-copies it
 * would go on passing while the real gate stopped matching.
 */
export const INTERRUPTED_MESSAGE =
  "The update was interrupted before it could finish: the process running it went away while it ran, "
  + "and no step is left to resume. Nothing was rolled back — start the update again.";

/**
 * The opening every interruption verdict shares — and what `isInterruptedVerdict`
 * recognises the verdict BY. The sentence names the step and the cause when the
 * lock holder recorded them (update-lock.ts), so the whole string is no longer
 * one constant to compare against; the opening is.
 */
export const INTERRUPTED_MESSAGE_PREFIX = "The update was interrupted before it could finish";

/**
 * How a run was cut short, as the lock holder's record tells it.
 *
 * `reboot` — the holder was written on ANOTHER boot: the box restarted, or lost
 * power, under the run. `replaced` — the same boot, so the web server was
 * replaced under it. `unknown` — a lock from a build that predates the holder
 * record, or a record that could not be read.
 */
export type InterruptionCause = "reboot" | "replaced" | "unknown";

/** What the box knows about an interrupted run, resolved against the step list. */
export interface InterruptionDetail {
  cause: InterruptionCause;
  /** The id of the step the run was on, when the holder recorded one. */
  step?: string;
  /** Its label, for the sentence — resolved by the reader that has the list. */
  stepLabel?: string;
  /**
   * A run cut short on this step leaves the box without its assistant until
   * the step runs again: the two that replace the core on disk, and the one
   * that starts the gateway back up after them (`openclaw_install` stops it
   * and LEAVES it stopped; `gateway_setup` is what restarts it).
   */
  assistantAtRisk?: boolean;
}

/** The steps between "the gateway is stopped for the core swap" and "it is up again". */
export const ASSISTANT_DOWN_STEP_IDS: ReadonlySet<string> = new Set(["openclaw_install", "openclaw_patch", "gateway_setup"]);

/**
 * Each cause in the words the evidence supports and no more: a lock holder
 * from another boot proves a restart, one from this boot proves a replaced
 * web server, and no holder proves only that the process went away — which
 * is what the no-record sentence (`INTERRUPTED_MESSAGE`) says too, so a box
 * that predates the record is never told a cause nobody measured.
 */
function interruptionCauseText(cause: InterruptionCause): string {
  if (cause === "reboot") return "the box restarted — or lost power —";
  if (cause === "replaced") return "the web server was replaced";
  return "the process running it went away";
}

/**
 * Word the verdict from what is known.
 *
 * With nothing known it is exactly `INTERRUPTED_MESSAGE`, so a box that
 * predates the holder record reads as it always did. With the step known the
 * sentence names it and says that Resume continues from there — because it
 * does: `runUpdate` resumes a fresh run from the recorded step (or from the
 * power-profile step before it, which unpins the clocks for the rest of the
 * update), and the failed panel's Resume button is what starts one. On 2026-09-16
 * three field boxes went dark mid `openclaw_install`, and the verdict blamed a
 * replaced web server and offered a fresh start over a box with no core.
 */
export function interruptedMessage(detail: InterruptionDetail): string {
  const risk = detail.assistantAtRisk
    ? " The assistant may be unavailable until the update finishes."
    : "";
  if (detail.stepLabel) {
    return `${INTERRUPTED_MESSAGE_PREFIX}: ${interruptionCauseText(detail.cause)} while "${detail.stepLabel}" was running. `
      + `Nothing was rolled back — Resume continues the update from there.${risk}`;
  }
  if (detail.cause !== "reboot") return INTERRUPTED_MESSAGE;
  return `${INTERRUPTED_MESSAGE_PREFIX}: ${interruptionCauseText(detail.cause)} while it ran, `
    + "and no step is left to resume. Nothing was rolled back — start the update again.";
}

/** The sentence on the step itself, in the step list. */
export function interruptedStepError(detail: InterruptionDetail): string {
  const cause = detail.cause === "reboot"
    ? "The box restarted — or lost power —"
    : detail.cause === "replaced"
      ? "The web server was replaced"
      : "The process running the update went away";
  return `${cause} while this step was running.`;
}
