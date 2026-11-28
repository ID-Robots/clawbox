import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairingPollCadence } from "@/lib/pairing-poll-cadence";

/**
 * The desktop's Telegram pairing poll asked every 20 s, so an access
 * request reached the owner's screen up to 20 s late. It asks every 3 s now
 * where a request can appear, and keeps 20 s on a box with no bot. Driven
 * here beat by beat, the way `setVisibleInterval` drives the poll: one
 * interval at the fast beat, skipping beats while slow.
 */

const BEAT = 3_000;
const SLOW = 20_000;

/** Run `beats` beats; the number that asked. */
function beats(cadence: ReturnType<typeof pairingPollCadence>, beats: number): number {
  let asked = 0;
  for (let i = 0; i < beats; i++) {
    vi.advanceTimersByTime(BEAT);
    if (cadence.shouldAsk()) asked++;
  }
  return asked;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pairingPollCadence", () => {
  it("asks at every beat until an answer says otherwise", () => {
    const cadence = pairingPollCadence(BEAT, SLOW);
    expect(cadence.shouldAsk()).toBe(true);
    expect(beats(cadence, 5)).toBe(5);
  });

  it("asks every beat with a bot", () => {
    const cadence = pairingPollCadence(BEAT, SLOW);
    cadence.shouldAsk();
    cadence.answered({ configured: true, pending: [] });
    expect(beats(cadence, 10)).toBe(10);
  });

  it("slows to the no-bot cadence on a confident configured:false, on the beat", () => {
    const cadence = pairingPollCadence(BEAT, SLOW);
    cadence.shouldAsk();
    cadence.answered({ configured: false, pending: [] });
    // 20 s on a 3 s beat is every 7th beat (21 s), never sooner.
    for (let i = 1; i <= 6; i++) {
      vi.advanceTimersByTime(BEAT);
      expect(cadence.shouldAsk()).toBe(false);
    }
    vi.advanceTimersByTime(BEAT);
    expect(cadence.shouldAsk()).toBe(true);
    // 63 beats more (189 s): one ask in seven.
    expect(beats(cadence, 63)).toBe(9);
  });

  it("keeps the slow rhythm when a browser fires a beat a little late or early", () => {
    const cadence = pairingPollCadence(BEAT, SLOW);
    cadence.shouldAsk();
    cadence.answered({ configured: false, pending: [] });
    // The 6th beat, late: still too soon.
    vi.advanceTimersByTime(6 * BEAT + 900);
    expect(cadence.shouldAsk()).toBe(false);
    // The 7th beat, early: asks.
    vi.advanceTimersByTime(BEAT - 1_800);
    expect(cadence.shouldAsk()).toBe(true);
  });

  it("speeds up again at the next beat once a bot is configured", () => {
    const cadence = pairingPollCadence(BEAT, SLOW);
    cadence.shouldAsk();
    cadence.answered({ configured: false, pending: [] });
    vi.advanceTimersByTime(7 * BEAT);
    expect(cadence.shouldAsk()).toBe(true);
    cadence.answered({ configured: true, pending: [] });
    expect(beats(cadence, 3)).toBe(3);
  });

  it("stays fast when the box cannot tell whether it has a bot", () => {
    // An unreadable credential: the page still draws the store's requests.
    const cadence = pairingPollCadence(BEAT, SLOW);
    cadence.shouldAsk();
    cadence.answered({ configured: false, unknown: true, pending: [] });
    expect(beats(cadence, 4)).toBe(4);
  });

  it("keeps its cadence through a failed ask or an answer that says neither", () => {
    const slow = pairingPollCadence(BEAT, SLOW);
    slow.shouldAsk();
    slow.answered({ configured: false, pending: [] });
    // A failed ask passes nothing; a 200 that is not the route's answer says nothing.
    slow.answered(null);
    slow.answered({ error: "internal" });
    expect(beats(slow, 6)).toBe(0);

    const fast = pairingPollCadence(BEAT, SLOW);
    fast.shouldAsk();
    fast.answered({ configured: true, pending: [] });
    fast.answered(null);
    fast.answered({ error: "internal" });
    expect(beats(fast, 3)).toBe(3);
  });
});
