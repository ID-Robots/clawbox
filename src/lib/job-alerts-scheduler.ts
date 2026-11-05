/**
 * The timer behind the scheduled-job alerts (src/lib/job-alerts.ts): a check
 * every {@link JOB_ALERTS_INTERVAL_MS}, the first one after the boot rush.
 *
 * In-process, armed by the boot hook (src/instrumentation.ts) like the memory
 * and database schedules — no systemd unit or crontab entry to install,
 * duplicate or orphan, and the check runs where the notice ring and the
 * Telegram send already are. A check costs one loopback WebSocket call on
 * OpenClaw or one file read per profile on Hermes. The switch is read at
 * every check, so turning the alerts off needs no re-arm. The timers live in
 * `processStore` because the boot hook and the routes are separate module
 * copies.
 *
 * SERVER ONLY.
 */

import { checkScheduledJobs } from "@/lib/job-alerts";
import { processStore } from "@/lib/process-store";

export const JOB_ALERTS_INTERVAL_MS = 2 * 60_000;
/** Past the boot rush: the gateway is still starting for the first minute or so. */
export const JOB_ALERTS_FIRST_CHECK_MS = 90_000;

const state = processStore("job-alerts:scheduler", () => ({
  first: null as NodeJS.Timeout | null,
  every: null as NodeJS.Timeout | null,
}));

function tick(): void {
  void checkScheduledJobs().catch((err) => {
    console.warn("[job-alerts] check failed:", err instanceof Error ? err.message : err);
  });
}

/** Boot hook — call once at process start. Idempotent. */
export function start(): void {
  if (state.every) return;
  state.first = setTimeout(tick, JOB_ALERTS_FIRST_CHECK_MS);
  state.first.unref?.();
  state.every = setInterval(tick, JOB_ALERTS_INTERVAL_MS);
  state.every.unref?.();
}

/** Disarm (tests). */
export function stop(): void {
  if (state.first) clearTimeout(state.first);
  if (state.every) clearInterval(state.every);
  state.first = null;
  state.every = null;
}
