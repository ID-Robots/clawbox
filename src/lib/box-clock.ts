/**
 * The box's clock, as the page showing it can know it.
 *
 * Every "3 minutes ago" on the desktop is the distance between a time the BOX
 * wrote (a backup's finish, a run's start, a task's end) and "now". Read off
 * the viewer's own clock, that distance carries whatever the two clocks
 * disagree by: a laptop a few seconds behind an NTP-synced box called a backup
 * that had just finished "in the future", and one ahead aged everything by its
 * lead. So "now" is the box's: the page's polls hand their answers here, each
 * answer's `Date` header says what the box's clock read when it was sent, and
 * the difference to the browser's own is kept for the rest of the page's life
 * (the next answer replaces it, so a browser clock that steps is followed).
 * Until an answer has been seen the offset is zero — the browser's clock, as
 * before.
 *
 * Client-safe and dependency-free; on the server `boxNowMs()` is `Date.now()`.
 */

/** An answer slower than this places the box's clock too loosely to keep: the
 *  trip back could be any part of it, and the previous reading is better. */
export const MAX_SAMPLE_RTT_MS = 30_000;

let offsetMs = 0;

/** What a fetch Response offers here — tests' stand-ins often carry no headers at all. */
export interface BoxClockAnswer {
  headers?: { get(name: string): string | null } | null;
}

/**
 * Learn the box's clock from one answer. `sentAtMs` and `receivedAtMs` are the
 * browser's `Date.now()` either side of the request. The box stamps `Date` as
 * the answer LEAVES — after the route has done its work — so the reading
 * belongs at `receivedAtMs`, short only by the trip back (milliseconds on the
 * box's own network), not at the middle of the round trip, which would put a
 * route's own time to answer into the offset. Anything unusable — no `Date`
 * header, one that does not parse, a round trip that ran backwards (the
 * browser's clock stepped) or took too long to trust — leaves the offset as it
 * was.
 */
export function noteBoxClock(
  answer: BoxClockAnswer | null | undefined,
  sentAtMs: number,
  receivedAtMs: number = Date.now(),
): void {
  let header: string | null | undefined;
  try {
    header = answer?.headers?.get("date");
  } catch {
    return;
  }
  if (!header) return;
  const stampedMs = Date.parse(header);
  if (!Number.isFinite(stampedMs)) return;
  const rtt = receivedAtMs - sentAtMs;
  if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_SAMPLE_RTT_MS) return;
  // An HTTP date is whole seconds, cut down: the box's clock was somewhere in
  // the second after it, and the middle of that second is the best guess.
  offsetMs = stampedMs + 500 - receivedAtMs;
}

/**
 * `fetch`, and the box's clock learned from the answer. For the page's polls
 * of /setup-api — `cache: "no-store"` ones, so the `Date` is the box's now and
 * not a cached answer's. A request that throws teaches nothing and throws on.
 */
export async function fetchFromBox(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const sentAtMs = Date.now();
  // The caller's own argument list, so `fetch` sees exactly the call it replaced.
  const res = await (init === undefined ? fetch(input) : fetch(input, init));
  noteBoxClock(res, sentAtMs);
  return res;
}

/** The box's "now", in epoch ms: the browser's clock moved by the last reading's offset. */
export function boxNowMs(browserNowMs: number = Date.now()): number {
  return browserNowMs + offsetMs;
}

/** How far the browser's clock is behind the box's (positive) or ahead of it (negative). */
export function boxClockOffsetMs(): number {
  return offsetMs;
}

/** Tests only: forget every reading. */
export function _resetBoxClockForTests(): void {
  offsetMs = 0;
}

export type BoxAge =
  | { unit: "now" }
  | { unit: "minutes" | "hours" | "days"; n: number };

/**
 * How long ago a past event on the box was, in the one unit an "x ago" label
 * says. A time AHEAD of `nowMs` reads as `now`, however far: a backup that has
 * completed did not happen in the future. A few seconds ahead is what is left
 * of a skew after the correction (the `Date` header's whole seconds, the trip
 * back, a label drawn before the first answer); further ahead means the box's
 * clock was set back since it wrote the time — the event still happened, and
 * nothing truer than "just now" can be said of when (the protection verdict
 * reads such a backup the same way: the snapshot exists). Null for a time that
 * is not a number.
 */
export function boxAge(thenMs: number, nowMs: number): BoxAge | null {
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return null;
  const elapsed = nowMs - thenMs;
  if (elapsed < 60_000) return { unit: "now" };
  if (elapsed < 3_600_000) return { unit: "minutes", n: Math.floor(elapsed / 60_000) };
  if (elapsed < 86_400_000) return { unit: "hours", n: Math.floor(elapsed / 3_600_000) };
  return { unit: "days", n: Math.floor(elapsed / 86_400_000) };
}
