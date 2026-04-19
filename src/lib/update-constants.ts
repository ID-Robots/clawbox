// Client-safe constants shared between `src/lib/updater.ts` (server-only —
// uses child_process/fs) and `src/components/SettingsApp.tsx` (client). Pulling
// `RESTART_STEP_ID` directly from `updater.ts` causes Next.js to bundle the
// whole updater module for the browser, which fails at compile time on the
// Node built-ins.

export const RESTART_STEP_ID = "restart";
