import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUTURE_SKEW_TOLERANCE_MS,
  MAX_SAMPLE_RTT_MS,
  _resetBoxClockForTests,
  boxAge,
  boxClockOffsetMs,
  boxNowMs,
  fetchFromBox,
  noteBoxClock,
} from "@/lib/box-clock";

/**
 * Every "x ago" on the desktop measures a time the BOX wrote against "now".
 * On the browser's clock, a viewer a few seconds behind the box saw a backup
 * that had just finished "in the future", and one ahead of it saw everything
 * older than it was. These pin the box's "now" as the page learns it from the
 * answers' `Date` header, both ways round, and the "just now" a leftover skew
 * reads as.
 */

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;
/** The browser's clock in these tests, on a whole second. */
const BROWSER_NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

/** An answer whose `Date` header says the box's clock read `boxMs` as it left. */
function stamped(boxMs: number): { headers: Headers } {
  return { headers: new Headers({ date: new Date(boxMs).toUTCString() }) };
}

beforeEach(() => {
  _resetBoxClockForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the box's clock, learned from an answer's Date header", () => {
  it("is the browser's own clock until an answer has been seen", () => {
    expect(boxClockOffsetMs()).toBe(0);
    expect(boxNowMs(BROWSER_NOW)).toBe(BROWSER_NOW);
  });

  it("runs ahead of a browser that is behind the box", () => {
    // The box reads 12:00:30 while the browser reads 12:00:00.
    noteBoxClock(stamped(BROWSER_NOW + 30 * SEC), BROWSER_NOW - 40, BROWSER_NOW);
    // The header's whole second, plus half of the second it was cut from.
    expect(boxClockOffsetMs()).toBe(30 * SEC + 500);
    expect(boxNowMs(BROWSER_NOW + 10 * SEC)).toBe(BROWSER_NOW + 40 * SEC + 500);
  });

  it("runs behind a browser that is ahead of the box", () => {
    noteBoxClock(stamped(BROWSER_NOW - 5 * MIN), BROWSER_NOW - 40, BROWSER_NOW);
    expect(boxClockOffsetMs()).toBe(-5 * MIN + 500);
    expect(boxNowMs(BROWSER_NOW)).toBe(BROWSER_NOW - 5 * MIN + 500);
  });

  it("places the reading where the answer arrived, not halfway through a slow route", () => {
    // Clocks in step; the route took 20 s and stamped its answer as it left.
    // Halfway would have put the box 10 s ahead of a browser that is not behind.
    noteBoxClock(stamped(BROWSER_NOW), BROWSER_NOW - 20 * SEC, BROWSER_NOW);
    expect(boxClockOffsetMs()).toBe(500);
  });

  it("follows the newest answer, so a browser clock that steps is followed", () => {
    noteBoxClock(stamped(BROWSER_NOW + 30 * SEC), BROWSER_NOW, BROWSER_NOW);
    noteBoxClock(stamped(BROWSER_NOW - 30 * SEC), BROWSER_NOW, BROWSER_NOW);
    expect(boxClockOffsetMs()).toBe(-30 * SEC + 500);
  });

  it("keeps the last reading when an answer cannot place the box's clock", () => {
    noteBoxClock(stamped(BROWSER_NOW + 30 * SEC), BROWSER_NOW, BROWSER_NOW);
    const kept = boxClockOffsetMs();
    const throwing = { headers: { get: () => { throw new Error("no headers here"); } } };
    const unusable: Array<[Parameters<typeof noteBoxClock>[0], number, number]> = [
      [null, BROWSER_NOW, BROWSER_NOW],
      [undefined, BROWSER_NOW, BROWSER_NOW],
      // A test's stand-in Response, or one whose headers are gone.
      [{}, BROWSER_NOW, BROWSER_NOW],
      [{ headers: null }, BROWSER_NOW, BROWSER_NOW],
      [{ headers: new Headers() }, BROWSER_NOW, BROWSER_NOW],
      [{ headers: new Headers({ date: "not a date" }) }, BROWSER_NOW, BROWSER_NOW],
      [throwing, BROWSER_NOW, BROWSER_NOW],
      // The browser's clock stepped back while the request was out.
      [stamped(BROWSER_NOW - HOUR), BROWSER_NOW, BROWSER_NOW - SEC],
      // Too slow to say when the stamp was made.
      [stamped(BROWSER_NOW - HOUR), BROWSER_NOW - MAX_SAMPLE_RTT_MS - 1, BROWSER_NOW],
      [stamped(BROWSER_NOW - HOUR), Number.NaN, BROWSER_NOW],
    ];
    for (const [answer, sent, received] of unusable) {
      noteBoxClock(answer, sent, received);
      expect(boxClockOffsetMs()).toBe(kept);
    }
  });

  it("takes the answer's arrival from the browser's clock when not told it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BROWSER_NOW);
    noteBoxClock(stamped(BROWSER_NOW + 2 * MIN), BROWSER_NOW - 100);
    expect(boxClockOffsetMs()).toBe(2 * MIN + 500);
    expect(boxNowMs()).toBe(BROWSER_NOW + 2 * MIN + 500);
  });
});

describe("fetchFromBox", () => {
  it("answers what fetch answered, learning the box's clock from it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BROWSER_NOW);
    const answer = { ok: true, ...stamped(BROWSER_NOW + 90 * SEC) };
    const fetchMock = vi.fn(async () => answer);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFromBox("/setup-api/clawkeep", { cache: "no-store" })).resolves.toBe(answer);
    expect(boxClockOffsetMs()).toBe(90 * SEC + 500);
    // The call it replaced, argument for argument — no `init` the caller did not pass.
    await fetchFromBox("/setup-api/clawkeep/memory");
    expect(fetchMock.mock.calls).toEqual([
      ["/setup-api/clawkeep", { cache: "no-store" }],
      ["/setup-api/clawkeep/memory"],
    ]);
  });

  it("throws what fetch threw and learns nothing", async () => {
    noteBoxClock(stamped(BROWSER_NOW - 10 * SEC), BROWSER_NOW, BROWSER_NOW);
    const kept = boxClockOffsetMs();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(fetchFromBox("/setup-api/clawkeep")).rejects.toThrow("Failed to fetch");
    expect(boxClockOffsetMs()).toBe(kept);
  });
});

describe("boxAge", () => {
  const NOW = BROWSER_NOW;

  it("says how long ago, in the one unit a label uses", () => {
    expect(boxAge(NOW, NOW)).toEqual({ unit: "now" });
    expect(boxAge(NOW - 59 * SEC, NOW)).toEqual({ unit: "now" });
    expect(boxAge(NOW - MIN, NOW)).toEqual({ unit: "minutes", n: 1 });
    expect(boxAge(NOW - 59 * MIN, NOW)).toEqual({ unit: "minutes", n: 59 });
    expect(boxAge(NOW - HOUR, NOW)).toEqual({ unit: "hours", n: 1 });
    expect(boxAge(NOW - 23 * HOUR, NOW)).toEqual({ unit: "hours", n: 23 });
    expect(boxAge(NOW - 24 * HOUR, NOW)).toEqual({ unit: "days", n: 1 });
    expect(boxAge(NOW - 30 * 24 * HOUR, NOW)).toEqual({ unit: "days", n: 30 });
  });

  it("reads a time a little ahead of now — the clocks' leftover skew — as just now", () => {
    expect(boxAge(NOW + 1, NOW)).toEqual({ unit: "now" });
    expect(boxAge(NOW + 5 * SEC, NOW)).toEqual({ unit: "now" });
    expect(boxAge(NOW + FUTURE_SKEW_TOLERANCE_MS, NOW)).toEqual({ unit: "now" });
  });

  it("gives no age to a time further ahead than any skew explains", () => {
    expect(FUTURE_SKEW_TOLERANCE_MS).toBe(2 * MIN);
    expect(boxAge(NOW + FUTURE_SKEW_TOLERANCE_MS + 1, NOW)).toEqual({ unit: "ahead" });
    expect(boxAge(NOW + 3 * HOUR, NOW)).toEqual({ unit: "ahead" });
  });

  it("is null for a time that is not a number", () => {
    expect(boxAge(Number.NaN, NOW)).toBeNull();
    expect(boxAge(NOW, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("a backup the box finished three seconds ago", () => {
  // The box's clock at the moment the label is drawn.
  const BOX_NOW = BROWSER_NOW;
  const finishedAt = BOX_NOW - 3 * SEC;

  it("is just now on a browser 10 minutes behind the box, not in the future", () => {
    const browserNow = BOX_NOW - 10 * MIN;
    expect(boxAge(finishedAt, browserNow)).toEqual({ unit: "ahead" });
    noteBoxClock(stamped(BOX_NOW), browserNow - 50, browserNow);
    expect(boxAge(finishedAt, boxNowMs(browserNow))).toEqual({ unit: "now" });
  });

  it("is just now on a browser 10 minutes ahead of the box, not 10 minutes ago", () => {
    const browserNow = BOX_NOW + 10 * MIN;
    expect(boxAge(finishedAt, browserNow)).toEqual({ unit: "minutes", n: 10 });
    noteBoxClock(stamped(BOX_NOW), browserNow - 50, browserNow);
    expect(boxAge(finishedAt, boxNowMs(browserNow))).toEqual({ unit: "now" });
  });

  it("is just now on a browser a few seconds behind, even before any answer has been seen", () => {
    expect(boxAge(finishedAt, BOX_NOW - 8 * SEC)).toEqual({ unit: "now" });
  });
});
