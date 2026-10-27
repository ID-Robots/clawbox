/**
 * How often a coding run's record is written back to disk, while it streams.
 *
 * WHY THIS IS A MODULE OF ITS OWN. `coding-agent.ts` is 14k lines with a
 * process-wide store and a dozen imports that reach for the device; the rule
 * below is arithmetic, and the test that pins it should not have to boot any
 * of that.
 *
 * WHAT IT FIXES. The runs file is written WHOLE on every flush — up to
 * MAX_RUNS_KEPT records, ~700 KB here — and the stream path asks to persist
 * once per parsed harness line. Measured on a fresh run: 35 inode changes in
 * 63 seconds and 24.5 MB written to carry 721 KB of stream output; an
 * eight-minute run cost 180–300 MB of writes for a 20 KB record. Nothing reads
 * the record faster than that: the Coding Agent window polls at 5 s, and the
 * stream itself is journalled line by line under
 * `data/coding-agent-streams/`, so a slower record flush loses no step.
 *
 * A status change still flushes within `STATE_FLUSH_MS`, and `flushDeadline`
 * only ever moves a pending flush EARLIER — a burst of stream lines can never
 * delay a settle.
 */

/** The state-change cadence: what `persist()` uses unless told otherwise. */
export const STATE_FLUSH_MS = 1_000;

/** The streaming cadence: what the per-line stream path uses. */
export const STREAM_FLUSH_MS = 5_000;

/**
 * When a coalesced flush should happen, given one already scheduled.
 *
 * `existingDueAt` is the deadline of the timer already armed, or null when
 * none is. The rule: a flush is never pushed further out than the caller
 * asking now would put it, so earlier always wins.
 */
export function flushDeadline(existingDueAt: number | null, now: number, delayMs: number): number {
  const wanted = now + delayMs;
  if (existingDueAt === null) return wanted;
  return Math.min(existingDueAt, wanted);
}
