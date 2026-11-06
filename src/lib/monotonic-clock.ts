/**
 * Milliseconds on a monotonic clock, for deadlines and elapsed times. Only the
 * difference between two readings means anything.
 *
 * The box has no battery-backed RTC: after a cold boot it runs on the clock it
 * saved at shutdown until timesyncd steps it forward — half a day after a night
 * off — in the same minute the update's second half and the gateway's start are
 * being waited for. A `Date.now()` deadline taken before that step has passed
 * the moment after it. Anything that is not a deadline — a journal `--since`, a
 * file's mtime, a time stored for another process — stays on `Date.now()`.
 *
 * No imports: the desktop's polls use it too (`visible-interval.ts`).
 */
export function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
