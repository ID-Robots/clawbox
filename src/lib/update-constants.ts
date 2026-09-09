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
  "The update was interrupted before it could finish: the web server was replaced while it ran, "
  + "and no step is left to resume. Nothing was rolled back — start the update again.";
