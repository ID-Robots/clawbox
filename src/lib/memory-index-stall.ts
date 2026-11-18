/**
 * When a Memory Shard index pass counts as STUCK (TASK-2431).
 *
 * A pass used to be abandoned two hours after it started, whatever it was
 * doing. With the on-box embedder a full pass over ~99k passages takes 2.5 to
 * 9 hours, so that budget ended every full pass on such a box while it was
 * working — and a pass that could never finish was never going to be the
 * owner's fault. Age says nothing about whether a pass is stuck; progress
 * does. So the rule is: a pass whose process is alive and still moving is
 * never stopped, however long it runs, and a pass that has not moved for the
 * stall window is.
 *
 * "Moving" is whatever the pass already reports: files finished, chunks in the
 * index it is writing, passages embedded, documents converted. Any of them
 * changing is progress (see `progressMark`); nothing else is — not output, not
 * time passing, not the `elapsed` clock the CLI repaints every second.
 *
 * Pure: no filesystem, no module state. `clawkeep-memory.ts` owns the pass,
 * the run record and the wording.
 */

/** No progress for this long and the pass is stuck. */
export const DEFAULT_MEMORY_INDEX_STALL_MS = 30 * 60_000;
/**
 * Bounds for `CLAWKEEP_MEMORY_INDEX_STALL_MS`. The floor is for a test that
 * wants a stall in seconds; the ceiling keeps a typo from switching the
 * watchdog off, which is what a window of years would do.
 */
const MIN_STALL_MS = 1_000;
const MAX_STALL_MS = 24 * 60 * 60_000;

/**
 * The stall window, from `CLAWKEEP_MEMORY_INDEX_STALL_MS` (milliseconds).
 * Omitted, empty, fractional or out of bounds: the 30-minute default.
 */
export function memoryIndexStallMs(configured: string | undefined): number {
  const raw = configured?.trim();
  if (!raw) return DEFAULT_MEMORY_INDEX_STALL_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= MIN_STALL_MS && parsed <= MAX_STALL_MS
    ? parsed
    : DEFAULT_MEMORY_INDEX_STALL_MS;
}

/** Whole minutes, at least one, for a log line. */
export function stallMinutes(stallMs: number): number {
  return Math.max(1, Math.round(stallMs / 60_000));
}

/**
 * The counts a pass reports, as one comparable value. Two reports with the
 * same mark are the same place; a report with a different mark is progress.
 *
 * Every count, not only the bar's fraction: chunks climb while `filesDone`
 * holds still for a large file on the OpenClaw arm. Work that moves none of
 * them — passages embedded inside one file, documents converted before the
 * scan has a total — reaches the watchdog as a heartbeat instead
 * (`LocalIndexPassOptions.onHeartbeat`).
 */
export function progressMark(progress: { filesDone: number; filesTotal: number; chunks: number }): string {
  return `${progress.filesDone}:${progress.filesTotal}:${progress.chunks}`;
}

export interface StallWatchdog {
  /** The pass moved. Cheap: a pass over unchanged files calls it thousands of times a second. */
  touch(): void;
  /** Disarm. Idempotent. */
  stop(): void;
}

/**
 * Calls `onStall` once the pass has gone `stallMs` without a `touch`.
 *
 * Measured in ticks of a timer, never by comparing wall-clock readings: a
 * Jetson without a clock battery boots with a wrong date and NTP moves it by
 * days, and a watchdog reading `Date.now()` across that jump would call a
 * working pass stuck. A tick at which the pass had moved resets the count, so
 * the alarm comes between `stallMs` and `stallMs` + one tick after the last
 * real progress — never earlier than the window.
 */
export function startStallWatchdog(stallMs: number, onStall: (idleMs: number) => void): StallWatchdog {
  const tickMs = Math.min(60_000, Math.max(250, Math.floor(stallMs / 6)));
  let moved = false;
  let idleMs = 0;
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (moved) {
      moved = false;
      idleMs = 0;
      return;
    }
    idleMs += tickMs;
    if (idleMs >= stallMs) {
      stop();
      onStall(idleMs);
    }
  }, tickMs);
  // Never what keeps a process alive: the pass it watches does that.
  timer.unref?.();
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }
  return {
    touch: () => { moved = true; },
    stop,
  };
}

/**
 * What a run record that says `running` really is, read by a process that is
 * NOT supervising it (the supervising one has its own watchdog, which knows
 * about progress the throttled record does not carry yet).
 *
 * - `lost`: its process is gone — a reboot, a crash, a restarted web server.
 * - `stalled`: its process is there but the record has not moved for the
 *   stall window. Also what a pid reused after a power cut looks like, which
 *   is why liveness alone is not enough.
 * - `going`: neither.
 *
 * No age rule: a record that keeps moving is going at hour nine as at minute
 * one. The reference point is the last progress the record carries, or its
 * start when it carries none (a pass that has not reported yet, a record an
 * older build wrote).
 */
export function staleRunVerdict(record: {
  startedAtMs: number;
  progressAtMs: number;
  alive: boolean;
}, nowMs: number, stallMs: number): "going" | "lost" | "stalled" {
  if (!record.alive) return "lost";
  const since = Math.max(record.startedAtMs, record.progressAtMs);
  return nowMs - since > stallMs ? "stalled" : "going";
}
