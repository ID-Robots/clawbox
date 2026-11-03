/**
 * The box's clock, as a page showing the box can know it.
 *
 * Every "3m ago" on the desktop is the distance between a time the BOX wrote
 * (a backup's finish, a memory index run, a coding run's start, the agent's
 * progress note) and "now". Read off the browser's own clock, that distance
 * carries whatever the two clocks disagree by: a laptop a few seconds behind
 * the box said a backup that had just finished was "in the future", and one
 * running ahead aged everything by its lead. So "now" here is the box's.
 *
 * The page's requests hand their answers in: `noteBoxTime` takes a reading the
 * box put in a body (`serverNowMs` on GET /setup-api/clawkeep, to the
 * millisecond), `noteBoxClock` the `Date` header every answer carries (whole
 * seconds). The box's reading is placed at the middle of the round trip and the
 * difference to the browser's clock is kept for the rest of the page's life —
 * the next reading replaces it unless it is rougher than the one held (and
 * that one under a minute old), so a browser clock that steps is followed.
 * `boxNow()` is the browser's clock moved by that difference; until a reading
 * has been taken the difference is zero, the browser's clock as before.
 *
 * What a reading cannot remove — the header's lost fraction of a second, the
 * half of the round trip that cannot be placed, a "now" a page sampled before
 * the answer landed — is a few seconds at most, and `boxAge` absorbs it: a
 * time up to `FUTURE_SKEW_TOLERANCE_MS` ahead is "just now", never "in the
 * future".
 *
 * Client-safe and dependency-free; module state, one per page.
 */

/**
 * How far ahead of "now" a time the box wrote may lie and still read as just
 * now. The leftover of a corrected skew is seconds; two minutes covers that
 * (and a window's "now" sampled up to a minute before the answer it draws)
 * with room to spare, and is short enough that a time further ahead — the
 * box's clock set back after it was written — is not passed off as fresh.
 */
export const FUTURE_SKEW_TOLERANCE_MS = 2 * 60_000;

/** A reading whose round trip took longer than this places the box's clock too
 *  loosely (half the round trip is its error); the previous offset is kept. */
export const MAX_SAMPLE_RTT_MS = 30_000;

/**
 * While a millisecond reading (a body's `serverNowMs`) is younger than this, a
 * `Date` header does not replace it. The header is coarser, and behind the
 * remote-access tunnel it can be the tunnel edge's clock rather than the box's,
 * so alternating the two would make the offset flap by the gap between them.
 */
export const PRECISE_READING_HOLD_MS = 5 * 60_000;

/**
 * While the reading held is younger than this, one rougher than it by more
 * than `ROUGHER_SLACK_MS` does not replace it: a 25 s answer (±12 s) would
 * otherwise undo a 40 ms one. Once it is older, the newest reading wins, so a
 * browser clock that stepped is followed within a minute however slow the box.
 */
export const HELD_READING_FRESH_MS = 60_000;
const ROUGHER_SLACK_MS = 1_000;

let offsetMs = 0;
/** When (on the monotonic clock) the last millisecond reading was taken. */
let preciseTakenAt: number | null = null;
/** The reading the offset came from: how far off it can be, and when it was taken. */
let held: { errorMs: number; at: number } | null = null;

function monotonicMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function take(boxMs: number, sentAtMs: number, receivedAtMs: number, precise: boolean): boolean {
  if (!Number.isFinite(boxMs) || boxMs <= 0) return false;
  if (!Number.isFinite(sentAtMs) || !Number.isFinite(receivedAtMs)) return false;
  // A round trip that ran backwards is the browser's clock stepping mid-request.
  const rtt = receivedAtMs - sentAtMs;
  if (rtt < 0 || rtt > MAX_SAMPLE_RTT_MS) return false;
  const at = monotonicMs();
  if (!precise && preciseTakenAt !== null && at - preciseTakenAt < PRECISE_READING_HOLD_MS) return false;
  // Half the round trip cannot be placed, and a header loses up to a second.
  const errorMs = rtt / 2 + (precise ? 0 : 500);
  if (held && errorMs > held.errorMs + ROUGHER_SLACK_MS && at - held.at < HELD_READING_FRESH_MS) return false;
  offsetMs = boxMs - (sentAtMs + receivedAtMs) / 2;
  held = { errorMs, at };
  if (precise) preciseTakenAt = at;
  return true;
}

/**
 * Learn the box's clock from a reading it put in a body. `sentAtMs` and
 * `receivedAtMs` are the browser's `Date.now()` either side of the request.
 * Anything that is not a positive number of ms, or a round trip that ran
 * backwards or took too long to place, leaves the offset as it was. Answers
 * whether the reading was taken.
 */
export function noteBoxTime(boxTimeMs: unknown, sentAtMs: number, receivedAtMs: number = Date.now()): boolean {
  return typeof boxTimeMs === "number" && take(boxTimeMs, sentAtMs, receivedAtMs, true);
}

/** What a fetch Response offers here — tests' stand-ins often carry no headers at all. */
export interface BoxClockAnswer {
  headers?: { get(name: string): string | null } | null;
}

/**
 * Learn the box's clock from an answer's `Date` header. No header, one that
 * does not parse, or a round trip that cannot be placed leaves the offset as
 * it was, and so does any header while a body's reading is fresh. Answers
 * whether the reading was taken.
 */
export function noteBoxClock(
  answer: BoxClockAnswer | null | undefined,
  sentAtMs: number,
  receivedAtMs: number = Date.now(),
): boolean {
  let header: string | null | undefined;
  try {
    header = answer?.headers?.get("date");
  } catch {
    return false;
  }
  if (!header) return false;
  const stampedMs = Date.parse(header);
  // An HTTP date is whole seconds, cut down: the box's clock was somewhere in
  // the second after it, and the middle of that second is the best guess.
  return Number.isFinite(stampedMs) && take(stampedMs + 500, sentAtMs, receivedAtMs, false);
}

/**
 * `fetch`, with the answer's `Date` header handed to `noteBoxClock`. Called
 * exactly as `fetch` is (no `init` when the caller gave none), so a test's
 * stand-in sees the same call.
 */
export async function fetchWithBoxClock(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const sentAtMs = Date.now();
  const res = init === undefined ? await fetch(input) : await fetch(input, init);
  noteBoxClock(res, sentAtMs);
  return res;
}

/** The box's "now", in epoch ms: the browser's clock moved by the last reading's offset. */
export function boxNow(browserNowMs: number = Date.now()): number {
  return browserNowMs + offsetMs;
}

/** How far the browser's clock is behind the box's (positive) or ahead of it (negative). */
export function boxClockOffsetMs(): number {
  return offsetMs;
}

/** Tests only: forget every reading. */
export function _resetBoxClockForTests(): void {
  offsetMs = 0;
  preciseTakenAt = null;
  held = null;
}

/**
 * How long before `nowMs` the box wrote `thenMs`, in ms. A time up to
 * `FUTURE_SKEW_TOLERANCE_MS` ahead is the clocks' leftover disagreement and is
 * 0; one further ahead stays negative, because no age can honestly be given
 * for it and a caller should say so rather than call it fresh. Null for a time
 * that is not a finite number.
 */
export function boxElapsedMs(thenMs: number, nowMs: number = boxNow()): number | null {
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return null;
  const elapsed = nowMs - thenMs;
  return elapsed < 0 && elapsed >= -FUTURE_SKEW_TOLERANCE_MS ? 0 : elapsed;
}

export type BoxAgeUnit = "now" | "minutes" | "hours" | "days" | "future";

/**
 * How long ago a time the box wrote was, in the one unit an "x ago" label
 * says: `now` under a minute (and for a time a little ahead, see
 * `boxElapsedMs`), then whole minutes, hours and days. `future` only for a
 * time more than `FUTURE_SKEW_TOLERANCE_MS` ahead. Null for a time that is not
 * a finite number.
 */
export function boxAge(thenMs: number, nowMs: number = boxNow()): { unit: BoxAgeUnit; n: number } | null {
  const elapsed = boxElapsedMs(thenMs, nowMs);
  if (elapsed === null) return null;
  if (elapsed < 0) return { unit: "future", n: 0 };
  if (elapsed < 60_000) return { unit: "now", n: 0 };
  if (elapsed < 3_600_000) return { unit: "minutes", n: Math.floor(elapsed / 60_000) };
  if (elapsed < 86_400_000) return { unit: "hours", n: Math.floor(elapsed / 3_600_000) };
  return { unit: "days", n: Math.floor(elapsed / 86_400_000) };
}
