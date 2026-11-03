import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FUTURE_SKEW_TOLERANCE_MS,
  HELD_READING_FRESH_MS,
  MAX_SAMPLE_RTT_MS,
  PRECISE_READING_HOLD_MS,
  _resetBoxClockForTests,
  boxAge,
  boxClockOffsetMs,
  boxElapsedMs,
  boxNow,
  fetchWithBoxClock,
  noteBoxClock,
  noteBoxTime,
} from "@/lib/box-clock";
import { timeAgo } from "@/components/clawkeep-ui";
import { progressCardAge } from "@/lib/chat-progress-card";

/**
 * TASK-2138: "Last backup: in the future" right after Back up now. The box
 * stamps the backup with ITS clock; the page judged it against the browser's,
 * a few seconds behind. `box-clock` measures the gap off the box's answers and
 * moves "now" by it, and clamps what is left of it into "just now".
 */

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** The English the ClawKeep keys say, enough to read `timeAgo`'s answer. */
const t = (key: string, params?: Record<string, string | number>): string => {
  const words: Record<string, string> = {
    "clawkeep.never": "never",
    "clawkeep.inFuture": "in the future",
    "clawkeep.justNow": "just now",
    "clawkeep.minutesAgo": "{count}m ago",
    "clawkeep.hoursAgo": "{count}h ago",
    "clawkeep.daysAgo": "{count}d ago",
  };
  return (words[key] ?? key).replace("{count}", String(params?.count ?? ""));
};

/** One request to a box whose clock reads `skewMs` ahead of the browser's (negative: behind). */
function answerFrom(skewMs: number, { sentAt, rtt = 40 }: { sentAt: number; rtt?: number }) {
  const boxAtMidpoint = sentAt + rtt / 2 + skewMs;
  return { sentAt, receivedAt: sentAt + rtt, serverNowMs: boxAtMidpoint };
}

/** A fetch Response stand-in whose Date header says `ms` (whole seconds, as HTTP does). */
function withDate(ms: number) {
  return { headers: new Headers({ date: new Date(ms).toUTCString() }) };
}

const BROWSER_NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

beforeEach(() => {
  _resetBoxClockForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BROWSER_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetBoxClockForTests();
});

describe("box-clock: before any reading", () => {
  it("is the browser's clock", () => {
    expect(boxClockOffsetMs()).toBe(0);
    expect(boxNow()).toBe(BROWSER_NOW);
  });

  it("still calls a backup a few seconds ahead 'just now', not 'in the future'", () => {
    // The original report: the browser 5 s behind, nothing measured yet.
    expect(timeAgo(BROWSER_NOW + 5 * SEC, t)).toBe("just now");
  });
});

describe("box-clock: browser BEHIND the box", () => {
  it("learns the gap from the body's reading and calls a backup the box just finished 'just now'", () => {
    const skew = 5 * SEC;
    const a = answerFrom(skew, { sentAt: BROWSER_NOW - 40 });
    expect(noteBoxTime(a.serverNowMs, a.sentAt, a.receivedAt)).toBe(true);
    expect(boxClockOffsetMs()).toBe(skew);
    expect(boxNow()).toBe(BROWSER_NOW + skew);

    const lastBackupAtMs = BROWSER_NOW + skew - 1 * SEC; // the box's clock, a second ago
    expect(timeAgo(lastBackupAtMs, t)).toBe("just now");
    expect(boxAge(lastBackupAtMs)).toEqual({ unit: "now", n: 0 });
  });

  it("a gap past the tolerance read 'in the future' off the browser's clock; the box's clock says 'just now'", () => {
    const skew = 10 * MIN;
    const lastBackupAtMs = BROWSER_NOW + skew - 2 * SEC;
    expect(timeAgo(lastBackupAtMs, t, BROWSER_NOW)).toBe("in the future");

    const a = answerFrom(skew, { sentAt: BROWSER_NOW - 40 });
    noteBoxTime(a.serverNowMs, a.sentAt, a.receivedAt);
    expect(timeAgo(lastBackupAtMs, t)).toBe("just now");
    // And it keeps ageing on the box's clock.
    vi.setSystemTime(BROWSER_NOW + 3 * MIN);
    expect(timeAgo(lastBackupAtMs, t)).toBe("3m ago");
  });

  it("learns it from the Date header when the body has no reading", () => {
    const skew = 7 * MIN;
    const sentAt = BROWSER_NOW - 100;
    const boxAtSend = sentAt + 50 + skew;
    expect(noteBoxClock(withDate(boxAtSend), sentAt, BROWSER_NOW)).toBe(true);
    // Whole seconds plus the middle of the lost one: within a second of the truth.
    expect(Math.abs(boxClockOffsetMs() - skew)).toBeLessThanOrEqual(SEC);
    expect(timeAgo(BROWSER_NOW + skew - 3 * SEC, t)).toBe("just now");
  });
});

describe("box-clock: browser AHEAD of the box", () => {
  it("does not age a fresh backup by the browser's lead", () => {
    const skew = -10 * MIN;
    const lastBackupAtMs = BROWSER_NOW + skew - 2 * SEC; // the box finished it 2 s ago
    // Read off the browser, the lead was the backup's age.
    expect(timeAgo(lastBackupAtMs, t, BROWSER_NOW)).toBe("10m ago");

    const a = answerFrom(skew, { sentAt: BROWSER_NOW - 40 });
    noteBoxTime(a.serverNowMs, a.sentAt, a.receivedAt);
    expect(boxClockOffsetMs()).toBe(skew);
    expect(timeAgo(lastBackupAtMs, t)).toBe("just now");
    expect(timeAgo(lastBackupAtMs - 2 * HOUR, t)).toBe("2h ago");
  });

  it("from the Date header too", () => {
    const skew = -3 * HOUR;
    expect(noteBoxClock(withDate(BROWSER_NOW - 30 + skew), BROWSER_NOW - 60, BROWSER_NOW)).toBe(true);
    expect(Math.abs(boxClockOffsetMs() - skew)).toBeLessThanOrEqual(SEC);
    expect(timeAgo(BROWSER_NOW + skew - 5 * SEC, t)).toBe("just now");
    expect(progressCardAge(BROWSER_NOW + skew - 5 * MIN - 30 * SEC, boxNow())).toEqual({ unit: "minutes", n: 5 });
  });
});

describe("box-clock: the clamp", () => {
  it("treats a time up to the tolerance ahead as just now, and further ahead as the future", () => {
    expect(boxElapsedMs(BROWSER_NOW + FUTURE_SKEW_TOLERANCE_MS, BROWSER_NOW)).toBe(0);
    expect(boxAge(BROWSER_NOW + FUTURE_SKEW_TOLERANCE_MS, BROWSER_NOW)).toEqual({ unit: "now", n: 0 });
    expect(boxElapsedMs(BROWSER_NOW + FUTURE_SKEW_TOLERANCE_MS + 1, BROWSER_NOW)).toBe(-FUTURE_SKEW_TOLERANCE_MS - 1);
    expect(boxAge(BROWSER_NOW + FUTURE_SKEW_TOLERANCE_MS + 1, BROWSER_NOW)).toEqual({ unit: "future", n: 0 });
    expect(timeAgo(BROWSER_NOW + 90 * SEC, t, BROWSER_NOW)).toBe("just now");
    expect(timeAgo(BROWSER_NOW + 3 * MIN, t, BROWSER_NOW)).toBe("in the future");
  });

  it("counts the past in whole units", () => {
    expect(boxAge(BROWSER_NOW - 59 * SEC, BROWSER_NOW)).toEqual({ unit: "now", n: 0 });
    expect(boxAge(BROWSER_NOW - 61 * SEC, BROWSER_NOW)).toEqual({ unit: "minutes", n: 1 });
    expect(boxAge(BROWSER_NOW - 59 * MIN, BROWSER_NOW)).toEqual({ unit: "minutes", n: 59 });
    expect(boxAge(BROWSER_NOW - 5 * HOUR, BROWSER_NOW)).toEqual({ unit: "hours", n: 5 });
    expect(boxAge(BROWSER_NOW - 50 * HOUR, BROWSER_NOW)).toEqual({ unit: "days", n: 2 });
  });

  it("has no age for a time that is not a number", () => {
    expect(boxAge(Number.NaN)).toBeNull();
    expect(boxElapsedMs(1, Number.POSITIVE_INFINITY)).toBeNull();
    expect(timeAgo(Number.NaN, t)).toBe("never");
    expect(timeAgo(0, t)).toBe("never");
  });

  it("the chat's progress card never says a note is from the future", () => {
    expect(progressCardAge(BROWSER_NOW + 30 * MIN, BROWSER_NOW)).toEqual({ unit: "now", n: 0 });
    expect(progressCardAge(BROWSER_NOW + 30 * SEC, BROWSER_NOW)).toEqual({ unit: "now", n: 0 });
    expect(progressCardAge(null, BROWSER_NOW)).toBeNull();
  });
});

describe("box-clock: readings it will not take", () => {
  it("keeps the offset for anything it cannot place", () => {
    noteBoxTime(BROWSER_NOW + 5 * SEC, BROWSER_NOW - 40, BROWSER_NOW);
    const before = boxClockOffsetMs();

    expect(noteBoxTime("1700000000000", BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);
    expect(noteBoxTime(Number.NaN, BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);
    expect(noteBoxTime(0, BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);
    // The browser's clock stepped back mid-request.
    expect(noteBoxTime(BROWSER_NOW + HOUR, BROWSER_NOW, BROWSER_NOW - 10)).toBe(false);
    // Too slow to place.
    expect(noteBoxTime(BROWSER_NOW + HOUR, BROWSER_NOW - MAX_SAMPLE_RTT_MS - 1, BROWSER_NOW)).toBe(false);

    expect(noteBoxClock(null, BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);
    expect(noteBoxClock({}, BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);
    expect(noteBoxClock({ headers: new Headers() }, BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);
    expect(noteBoxClock({ headers: new Headers({ date: "not a date" }) }, BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);
    const throwing = { headers: { get: () => { throw new Error("boom"); } } };
    expect(noteBoxClock(throwing, BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);

    expect(boxClockOffsetMs()).toBe(before);
  });

  it("lets a body's millisecond reading outrank the Date header until it goes stale", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(BROWSER_NOW);
    noteBoxTime(BROWSER_NOW - 20 + 4 * SEC, BROWSER_NOW - 40, BROWSER_NOW);
    expect(boxClockOffsetMs()).toBe(4 * SEC);

    // A header a whole minute off (a tunnel edge's clock, say) does not replace it…
    expect(noteBoxClock(withDate(BROWSER_NOW + MIN), BROWSER_NOW - 40, BROWSER_NOW)).toBe(false);
    expect(boxClockOffsetMs()).toBe(4 * SEC);

    // …until no body has said anything for the hold.
    vi.advanceTimersByTime(PRECISE_READING_HOLD_MS + 1);
    const now = Date.now();
    expect(noteBoxClock(withDate(now + MIN), now - 40, now)).toBe(true);
    expect(Math.abs(boxClockOffsetMs() - MIN)).toBeLessThanOrEqual(SEC);
  });

  it("does not let a slow answer undo a quick one while that one is fresh", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(BROWSER_NOW);
    noteBoxTime(BROWSER_NOW - 20 + 4 * SEC, BROWSER_NOW - 40, BROWSER_NOW);
    // 25 s round trip: its midpoint could be 12 s off either way.
    expect(noteBoxTime(BROWSER_NOW + 30 * SEC, BROWSER_NOW - 25 * SEC, BROWSER_NOW)).toBe(false);
    expect(boxClockOffsetMs()).toBe(4 * SEC);

    // Once the quick one is a minute old, the newest reading wins again.
    vi.advanceTimersByTime(HELD_READING_FRESH_MS + 1);
    const now = Date.now();
    expect(noteBoxTime(now + 30 * SEC, now - 25 * SEC, now)).toBe(true);
    expect(boxClockOffsetMs()).toBe(30 * SEC + 12_500);
  });

  it("follows the newest reading", () => {
    noteBoxTime(BROWSER_NOW - 20 + 5 * SEC, BROWSER_NOW - 40, BROWSER_NOW);
    noteBoxTime(BROWSER_NOW - 20 - 2 * MIN, BROWSER_NOW - 40, BROWSER_NOW);
    expect(boxClockOffsetMs()).toBe(-2 * MIN);
  });
});

describe("fetchWithBoxClock", () => {
  it("calls fetch exactly as given and reads the answer's Date header", async () => {
    const skew = 6 * MIN;
    const fetchMock = vi.fn(async (input: unknown) => ({ ok: true, status: 200, url: String(input), headers: new Headers({ date: new Date(Date.now() + skew).toUTCString() }) }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithBoxClock("/setup-api/setup/status");
    expect(fetchMock).toHaveBeenLastCalledWith("/setup-api/setup/status");
    expect(fetchMock.mock.calls[0]).toHaveLength(1);
    expect(Math.abs(boxClockOffsetMs() - skew)).toBeLessThanOrEqual(SEC);

    const init = { cache: "no-store" as const };
    await fetchWithBoxClock("/setup-api/clawkeep/memory", init);
    expect(fetchMock).toHaveBeenLastCalledWith("/setup-api/clawkeep/memory", init);
  });

  it("hands back an answer without headers untouched", async () => {
    const answer = { ok: true, status: 200, json: async () => ({}) };
    vi.stubGlobal("fetch", vi.fn(async () => answer));
    expect(await fetchWithBoxClock("/x")).toBe(answer);
    expect(boxClockOffsetMs()).toBe(0);
  });
});
