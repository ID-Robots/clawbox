import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBoxClockForTests,
  boxAge,
  boxClockOffsetMs,
  boxNowMs,
  FUTURE_SKEW_TOLERANCE_MS,
  formatBoxTime,
  MAX_SAMPLE_RTT_MS,
  noteBoxClock,
} from "@/lib/box-clock";
import { timeAgo } from "@/components/clawkeep-ui";
import { progressCardAge } from "@/lib/chat-progress-card";

/**
 * TASK-2138: every "x ago" is a box time held against "now", and "now" was
 * the browser's. A browser a few seconds behind the box called a backup that
 * had just finished "in the future"; one ahead aged everything by its lead.
 * The page's polls now say what the box's clock reads (their `Date` header),
 * and the labels are held to that.
 */

/** A whole second, so a header stamped "at" it says exactly it. */
const T = 1_793_000_000_000;

/** An answer whose `Date` header is the box's clock at `boxMs`. */
function answerAt(boxMs: number) {
  return { headers: new Headers({ date: new Date(boxMs).toUTCString() }) };
}

const MINUTE = 60_000;

beforeEach(() => {
  _resetBoxClockForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("noteBoxClock / boxNowMs", () => {
  it("is the browser's clock until an answer has been seen", () => {
    expect(boxClockOffsetMs()).toBe(0);
    expect(boxNowMs(T)).toBe(T);
  });

  it("follows a box whose clock is ahead of the browser's", () => {
    // The browser is 5 s behind: sent at T, answered at T + 200, and the box
    // stamped it 100 ms in, at its own T + 5100 (a header says T + 5 s).
    noteBoxClock(answerAt(T + 5_100), T, T + 200);
    const offset = boxClockOffsetMs();
    expect(offset).toBeGreaterThanOrEqual(4_000);
    expect(offset).toBeLessThanOrEqual(5_000);
    expect(boxNowMs(T + 10_000)).toBe(T + 10_000 + offset);
  });

  it("follows a box whose clock is behind the browser's", () => {
    noteBoxClock(answerAt(T - 10 * MINUTE + 100), T, T + 200);
    const offset = boxClockOffsetMs();
    expect(offset).toBeLessThanOrEqual(-10 * MINUTE + 1_000);
    expect(offset).toBeGreaterThanOrEqual(-10 * MINUTE - 1_000);
  });

  it("leaves clocks that agree to within what an answer can tell exactly as they were", () => {
    noteBoxClock(answerAt(T + 100), T, T + 200);
    expect(boxClockOffsetMs()).toBe(0);
    noteBoxClock(answerAt(T + 2_700), T + 2_600, T + 2_800);
    expect(boxClockOffsetMs()).toBe(0);
  });

  it("narrows with every answer instead of jumping between them", () => {
    // The box is 5.5 s ahead. Each answer alone places it within a second
    // and a bit; together they pin it, and the reading never moves back.
    const truth = 5_500;
    const readings: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const sent = T + i * 2_000 + i * 87;
      const received = sent + 120;
      noteBoxClock(answerAt(sent + 60 + truth), sent, received);
      readings.push(boxClockOffsetMs());
    }
    for (let i = 1; i < readings.length; i += 1) expect(readings[i]).toBeGreaterThanOrEqual(readings[i - 1]);
    expect(readings[readings.length - 1]).toBeGreaterThan(truth - 250);
    expect(readings[readings.length - 1]).toBeLessThanOrEqual(truth);
  });

  it("starts over when a clock steps", () => {
    noteBoxClock(answerAt(T + 5_100), T, T + 200);
    expect(boxClockOffsetMs()).toBeGreaterThan(4_000);
    // The box's clock was set back an hour (or the browser's forward).
    noteBoxClock(answerAt(T + 2_000 - 60 * MINUTE + 5_100), T + 2_000, T + 2_200);
    expect(boxClockOffsetMs()).toBeLessThan(-59 * MINUTE);
    expect(boxClockOffsetMs()).toBeGreaterThan(-61 * MINUTE);
  });

  it("ignores an answer that cannot place the box's clock", () => {
    noteBoxClock(answerAt(T + 5_100), T, T + 200);
    const held = boxClockOffsetMs();
    // No headers at all (tests' stand-ins), no Date, one that does not parse.
    noteBoxClock({}, T, T + 100);
    noteBoxClock(null, T, T + 100);
    noteBoxClock(undefined, T, T + 100);
    noteBoxClock({ headers: new Headers() }, T, T + 100);
    noteBoxClock({ headers: new Headers({ date: "not a date" }) }, T, T + 100);
    // Headers that throw when read.
    noteBoxClock({ headers: { get: () => { throw new Error("boom"); } } }, T, T + 100);
    // A round trip that ran backwards (the browser's clock stepped mid-request)
    // or took too long to place anything.
    noteBoxClock(answerAt(T + 60 * MINUTE), T + 100, T);
    noteBoxClock(answerAt(T + 60 * MINUTE), T, T + MAX_SAMPLE_RTT_MS + 1);
    noteBoxClock(answerAt(T + 60 * MINUTE), Number.NaN, T);
    expect(boxClockOffsetMs()).toBe(held);
  });

  it("reads the browser's clock when none is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    noteBoxClock(answerAt(T + 30_000), T);
    expect(boxNowMs()).toBe(T + boxClockOffsetMs());
    expect(boxClockOffsetMs()).toBe(30_000);
  });
});

describe("boxAge", () => {
  it("gives the age in the one unit a label says", () => {
    expect(boxAge(T, T + 59_999)).toEqual({ unit: "now", n: 0 });
    expect(boxAge(T, T + 60_000)).toEqual({ unit: "minutes", n: 1 });
    expect(boxAge(T, T + 59 * MINUTE + 59_000)).toEqual({ unit: "minutes", n: 59 });
    expect(boxAge(T, T + 2 * 60 * MINUTE + 59_000)).toEqual({ unit: "hours", n: 2 });
    expect(boxAge(T, T + 3 * 24 * 60 * MINUTE)).toEqual({ unit: "days", n: 3 });
  });

  it("reads a time the clocks' leftover disagreement puts ahead as just now", () => {
    expect(boxAge(T + 1_000, T)).toEqual({ unit: "now", n: 0 });
    expect(boxAge(T + FUTURE_SKEW_TOLERANCE_MS, T)).toEqual({ unit: "now", n: 0 });
  });

  it("gives no age to a time further ahead than that", () => {
    expect(boxAge(T + FUTURE_SKEW_TOLERANCE_MS + 1, T)).toEqual({ unit: "ahead", n: 0 });
    expect(boxAge(T + 24 * 60 * MINUTE, T)).toEqual({ unit: "ahead", n: 0 });
  });

  it("is null for a time that is not a number", () => {
    expect(boxAge(Number.NaN, T)).toBeNull();
    expect(boxAge(T, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("formatBoxTime", () => {
  it("prints the date and the time", () => {
    const text = formatBoxTime(T, "en");
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/\d{1,2}:\d{2}/);
  });

  it("falls back to the browser's locale for one it cannot use", () => {
    expect(formatBoxTime(T, "not_a-locale!")).toMatch(/2026/);
  });

  it("prints a dash for a time that is not a date", () => {
    expect(formatBoxTime(Number.NaN)).toBe("—");
  });
});

describe("the labels, held to the box's clock", () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    params?.count !== undefined ? `${key}:${params.count}` : key;

  it("a backup that has just finished on a box ahead of the browser is just now, not in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    // The box is 45 s ahead; its backup finished 2 s ago on its own clock.
    noteBoxClock(answerAt(T + 45_000), T - 100, T);
    const finished = T + 45_000 - 2_000;
    expect(timeAgo(finished, t)).toBe("clawkeep.justNow");
    expect(progressCardAge(finished, boxNowMs())).toEqual({ unit: "now", n: 0 });
  });

  it("a browser ahead of the box does not age what the box did by its lead", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    // The browser is 10 min ahead; the backup finished 3 min ago on the box.
    noteBoxClock(answerAt(T - 10 * MINUTE), T - 100, T);
    expect(timeAgo(T - 10 * MINUTE - 3 * MINUTE, t)).toBe("clawkeep.minutesAgo:3");
  });

  it("a time far ahead of the box's clock prints as itself", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const later = T + 3 * 60 * MINUTE;
    expect(timeAgo(later, t)).toBe(formatBoxTime(later));
    expect(progressCardAge(later, boxNowMs())).toEqual({ unit: "ahead", n: 0 });
  });

  it("a caller's own sampled clock is still the one used", () => {
    expect(timeAgo(T, t, T + 5 * MINUTE)).toBe("clawkeep.minutesAgo:5");
    expect(timeAgo(0, t, T)).toBe("clawkeep.never");
  });
});
