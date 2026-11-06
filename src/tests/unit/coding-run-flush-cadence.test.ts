/**
 * A coding run's record is flushed on the state cadence (1 s) for a status
 * change and on the stream cadence (5 s) for harness output.
 *
 * WHY. The runs file is rewritten whole on every flush, and the stream path
 * asks to persist once per parsed line — measured 35 inode changes in 63 s and
 * 24.5 MB written to carry 721 KB of stream output. The rule that keeps a
 * status change from being starved by that burst is `flushDeadline`: a flush is
 * never pushed further out than the caller asking now would put it.
 */
import { describe, expect, it } from "vitest";
import { STATE_FLUSH_MS, STREAM_FLUSH_MS, flushDeadline } from "@/lib/run-flush-cadence";

describe("the cadences", () => {
  it("gives a status change a second and a stream line five", () => {
    expect(STATE_FLUSH_MS).toBe(1_000);
    expect(STREAM_FLUSH_MS).toBe(5_000);
    expect(STREAM_FLUSH_MS).toBeGreaterThan(STATE_FLUSH_MS);
  });
});

describe("flushDeadline", () => {
  it("schedules a flush when none is armed", () => {
    expect(flushDeadline(null, 10_000, STREAM_FLUSH_MS)).toBe(15_000);
  });

  it("does not push a scheduled flush out: a burst of stream lines stays one write", () => {
    // A line at t=0 arms 5 s. Nine more lines arrive inside the window and
    // must not move it — that is the whole point of the change.
    let due: number | null = flushDeadline(null, 0, STREAM_FLUSH_MS);
    const armed = due;
    for (let t = 100; t < 5_000; t += 500) due = flushDeadline(due, t, STREAM_FLUSH_MS);
    expect(due).toBe(armed);
  });

  it("brings the flush forward for a status change inside a stream window", () => {
    const streamDue = flushDeadline(null, 0, STREAM_FLUSH_MS);
    expect(flushDeadline(streamDue, 500, STATE_FLUSH_MS)).toBe(1_500);
  });

  it("keeps the earlier of two deadlines, whichever order they arrive in", () => {
    expect(flushDeadline(1_500, 900, STREAM_FLUSH_MS)).toBe(1_500);
    expect(flushDeadline(5_000, 4_900, STATE_FLUSH_MS)).toBe(5_000);
  });
});
