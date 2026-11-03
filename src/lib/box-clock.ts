/**
 * The box's clock, as the page showing it can know it.
 *
 * Every "3 minutes ago" on the desktop is the distance between a time the BOX
 * wrote (a backup's finish, a run's start, a task's end) and "now". Read off
 * the viewer's own clock, that distance carries whatever the two clocks
 * disagree by: a laptop a few seconds behind an NTP-synced box called a backup
 * that had just finished "in the future", and one ahead aged everything by its
 * lead. So "now" is the box's: the page's polls hand their answers here, and
 * each answer's `Date` header says what the box's clock read while the request
 * was out. Until an answer has been seen the offset is zero — the browser's
 * clock, as before. The polls are named (the desktop's notice poll, the
 * ClawKeep status poll, the Memory Shard and Coding Agent status reads, the
 * background tasks list and the chat's coding runs poll), not
 * every fetch the page makes: those are answered fresh every time, where an
 * answer the browser kept in its HTTP cache carries the Date it was first
 * sent with.
 *
 * One answer does not give the offset, only a window it lies in: the header
 * is whole seconds, cut down, and stamped somewhere between the browser's
 * send and receive. The windows of successive answers are intersected, so
 * while the two clocks hold steady the reading only narrows, and a clock that
 * ticks by the second ("running 1:23") does not jump back and forth between
 * polls. An answer whose window misses the one held means a clock moved (one
 * was stepped, or they drifted apart past what is held) and starts over from
 * it — at most once in a long while, by about a second for a drift. Of the
 * window held, the offset is the value nearest zero: clocks that agree to
 * within what the answers can tell are left exactly as they were, and two
 * that do not are corrected by no more than the answers prove.
 *
 * Client-safe and dependency-free; on the server nothing is ever noted, so
 * `boxNowMs()` is `Date.now()`.
 */

/**
 * How far ahead of "now" a time may lie and still read as "just now". What is
 * left of a skew after the correction — the `Date` header's whole second, the
 * part of the round trip that cannot be placed, an answer from before the
 * first one arrived — is a few seconds; two minutes covers that with room to
 * spare, and is still short enough that a time further ahead is not passed off
 * as fresh.
 */
export const FUTURE_SKEW_TOLERANCE_MS = 2 * 60_000;

/** An answer slower than this places the box's clock too loosely to start
 *  from: its window is the whole round trip wide. */
export const MAX_SAMPLE_RTT_MS = 30_000;

/** The offset's window, box minus browser, in ms; null until an answer is noted. */
let held: { lo: number; hi: number } | null = null;
let offsetMs = 0;

/** What a fetch Response offers here — tests' stand-ins often carry no headers at all. */
export interface BoxClockAnswer {
  headers?: { get(name: string): string | null } | null;
}

/**
 * Learn the box's clock from one answer. `sentAtMs` and `receivedAtMs` are the
 * browser's `Date.now()` either side of the request. Anything unusable — no
 * `Date` header, one that does not parse, a round trip that ran backwards (the
 * browser's clock stepped mid-request) or took too long to place anything —
 * leaves the reading as it was.
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
  if (!Number.isFinite(stampedMs) || !Number.isFinite(sentAtMs) || !Number.isFinite(receivedAtMs)) return;
  const rtt = receivedAtMs - sentAtMs;
  if (rtt < 0 || rtt > MAX_SAMPLE_RTT_MS) return;
  // The box read somewhere in [stamped, stamped + 1 s) — an HTTP date is cut
  // down to the second — at a browser time somewhere in [sent, received].
  const lo = stampedMs - receivedAtMs;
  const hi = stampedMs + 1000 - sentAtMs;
  if (held && lo <= held.hi && hi >= held.lo) {
    held = { lo: Math.max(lo, held.lo), hi: Math.min(hi, held.hi) };
  } else {
    held = { lo, hi };
  }
  offsetMs = held.lo > 0 ? held.lo : held.hi < 0 ? held.hi : 0;
}

/** The box's "now", in epoch ms: the browser's clock moved by the offset held. */
export function boxNowMs(browserNowMs: number = Date.now()): number {
  return browserNowMs + offsetMs;
}

/** How far the browser's clock is behind the box's (positive) or ahead of it (negative). */
export function boxClockOffsetMs(): number {
  return offsetMs;
}

/** Tests only: forget every reading. */
export function _resetBoxClockForTests(): void {
  held = null;
  offsetMs = 0;
}

export type BoxAgeUnit = "now" | "minutes" | "hours" | "days" | "ahead";

/**
 * How long ago a past event on the box was, in the one unit an "x ago" label
 * says (`n` is 0 for `now` and `ahead`). A time up to
 * `FUTURE_SKEW_TOLERANCE_MS` ahead of `nowMs` is the clocks' leftover
 * disagreement and reads as `now` — a backup that has completed did not
 * happen in the future. One further ahead than that has no age that can
 * honestly be given (the box's clock was set back since it was written) and is
 * `ahead`: the caller prints the time itself instead (`formatBoxTime`). Null
 * for a time that is not a number.
 */
export function boxAge(thenMs: number, nowMs: number): { unit: BoxAgeUnit; n: number } | null {
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return null;
  const elapsed = nowMs - thenMs;
  if (elapsed < -FUTURE_SKEW_TOLERANCE_MS) return { unit: "ahead", n: 0 };
  if (elapsed < 60_000) return { unit: "now", n: 0 };
  if (elapsed < 3_600_000) return { unit: "minutes", n: Math.floor(elapsed / 60_000) };
  if (elapsed < 86_400_000) return { unit: "hours", n: Math.floor(elapsed / 3_600_000) };
  return { unit: "days", n: Math.floor(elapsed / 86_400_000) };
}

/** A box time as the date and time themselves ("3 Nov 2026, 16:51"), for one
 *  that has no age to give. Without a `locale`, the one the page is drawn in
 *  (`<html lang>`, kept in step with the UI's by `useSyncHtmlLang`), else the
 *  browser's own. */
export function formatBoxTime(ms: number, locale?: string): string {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return "—";
  const lang = locale ?? (typeof document !== "undefined" ? document.documentElement.lang || undefined : undefined);
  try {
    return at.toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
}
