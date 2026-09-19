/**
 * "This Anthropic account has hit its limit" — recognising it, reading when it
 * lifts, and choosing the account that answers next.
 *
 * WHY IT EXISTS. On 2026-09-18 the overnight coding queue died at 22:27 on
 * "You've hit your session limit · resets 10:50pm": every run and review round
 * from then until 22:50 failed, and nothing merged. The account was not broken
 * and neither was the work — one subscription's five-hour window was spent,
 * while a second account could have carried on. The pool in
 * src/lib/anthropic-accounts.ts holds the accounts; this module is the part of
 * the decision that needs no disk: which failures are a LIMIT (and so a reason
 * to change accounts rather than to fail), when the limit lifts, and which
 * account is next.
 *
 * PURE ON PURPOSE. No `fs`, no config store, no clock of its own — `now` is
 * always a parameter — so the MCP server and the browser can import it, and
 * every rule here is pinned by a unit test without a box around it.
 *
 * NARROW ON PURPOSE. A limit is a reason to move a run to another account and
 * to resume it there. Anything this mistook for a limit would bounce a run that
 * failed for a real reason from account to account, so only the CLI's own
 * wording of a usage cap counts, and only at the head of the failure: a run
 * working on this very file fails with sentences ABOUT limits, and those are
 * the run's words, not Anthropic's.
 */

/** What kind of cap an account hit — said to the owner, never a code path. */
export type AnthropicLimitKind = "session" | "weekly" | "rate" | "credit";

export interface AnthropicLimit {
  kind: AnthropicLimitKind;
  /** When the account is expected back (ms since the epoch), or null when the message did not say. */
  resetsAt: number | null;
}

/**
 * How long an account is set aside when the refusal named no time.
 *
 * Five hours is the subscription's own session window: the one limit that
 * carries no reset time in every CLI version is the session one, and waiting a
 * whole window is the answer that never hands a run back to an account that is
 * still refusing.
 */
export const DEFAULT_LIMIT_MS = 5 * 60 * 60_000;

/**
 * The longest reset this box believes. A parsed time further out than this is
 * a misread (a date without a year that already passed, say), and trusting it
 * would park an account for a month.
 */
export const MAX_LIMIT_MS = 8 * 24 * 60 * 60_000;

/** How much of a failure is looked at: the CLI puts its own line first. */
const HEAD_CHARS = 400;

/**
 * The CLI's wordings of a spent subscription window, oldest first. Every one of
 * them has been printed by some Claude Code release:
 *
 *   Claude AI usage limit reached|1758231000
 *   Claude AI usage limit reached. Your limit will reset at 5pm (Europe/Sofia).
 *   5-hour limit reached ∙ resets 3pm
 *   Session limit reached ∙ resets 10:50pm
 *   You've hit your session limit · resets 10:50pm
 *   Weekly limit reached ∙ resets Oct 9, 10am
 *   You've hit your weekly limit · resets Mon 9am
 *   Opus weekly limit reached ∙ resets Oct 9 at 10am
 */
const SESSION_RE = /(?:claude ai usage limit reached|(?:5|five)[- ]hour limit reached|session limit reached|you(?:'|’)ve hit your (?:session |usage |5-hour )?limit|you(?:'|’)ve reached your (?:session |usage )?limit|usage limit reached)/i;
const WEEKLY_RE = /(?:weekly limit reached|you(?:'|’)ve hit your (?:\w+ )?weekly limit|(?:opus|sonnet) (?:weekly )?limit reached)/i;
/**
 * An API key's cap. Claude Code retries a 429 by itself and only gives up after
 * its own backoff, so reaching the run's failure means the minute's allowance
 * really is gone — and the organisation's error type is the stable part.
 */
const RATE_RE = /\brate_limit_error\b|\b429\b[^\n]{0,80}rate limit|exceed (?:the|your) (?:organization'?s? )?rate limit/i;
/** A prepaid key with nothing left on it — capped as surely as a window. */
const CREDIT_RE = /credit balance is too low/i;

/**
 * Is this failure an Anthropic account at its limit?
 *
 * Only the head of the text is read, and the caller hands over the run's
 * failure, never its whole transcript: see the header.
 */
export function detectAnthropicLimit(text: string | null | undefined, now: number, timeZone?: string): AnthropicLimit | null {
  if (typeof text !== "string") return null;
  const head = text.trim().slice(0, HEAD_CHARS);
  if (!head) return null;
  let kind: AnthropicLimitKind | null = null;
  // Weekly first: "Opus weekly limit reached" also contains "limit reached".
  if (WEEKLY_RE.test(head)) kind = "weekly";
  else if (SESSION_RE.test(head)) kind = "session";
  else if (RATE_RE.test(head)) kind = "rate";
  else if (CREDIT_RE.test(head)) kind = "credit";
  if (!kind) return null;
  return { kind, resetsAt: parseLimitReset(head, now, timeZone) };
}

// ── when the limit lifts ────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * "resets 10:50pm", "resets 10pm (Europe/Sofia)", "resets Oct 9, 10am",
 * "resets Oct 9 at 10am", "resets Mon 9am", "will reset at 5pm", "resets 22:50".
 * The words before the clock are optional, and so is the zone after it.
 */
const RESET_RE = new RegExp(
  String.raw`\breset(?:s|ting)?\s+(?:at\s+|on\s+)?`
  + String.raw`(?:(?<weekday>sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?`
  + String.raw`(?:(?<month>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?`
  + String.raw`(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>am|pm|a\.m\.|p\.m\.)?`
  + String.raw`(?:\s*\((?<zone>[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*)\))?`,
  "i",
);

/** The pipe form: `Claude AI usage limit reached|1758231000` — epoch seconds. */
const EPOCH_RE = /\|\s*(\d{10})\b/;

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The wall clock of `at` in `zone`, as numbers. */
function wallClock(at: number, zone: string | undefined): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")) - 1,
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase().slice(0, 3)),
  };
}

/** The instant a wall-clock time in `zone` names, DST included (checked twice across a transition). */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): number {
  const asUtc = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (t: number) => {
    const w = wallClock(t, zone);
    return Date.UTC(w.year, w.month, w.day, w.hour, w.minute) - Math.floor(t / 60_000) * 60_000;
  };
  let guess = asUtc - offsetAt(asUtc);
  guess = asUtc - offsetAt(guess);
  return guess;
}

/**
 * When the refusal says the account is back, or null when it does not say (or
 * says something this box cannot trust — past, or more than a week out).
 *
 * The clock is read in the zone the message names, else in `timeZone` (the
 * box's own zone, which is what the CLI printed it in), else the process zone.
 * A time with no date is the NEXT time the clock shows it: "resets 10:50pm"
 * seen at 22:27 is twenty-three minutes away, seen at 23:10 it is tomorrow.
 */
export function parseLimitReset(text: string, now: number, timeZone?: string): number | null {
  const epoch = EPOCH_RE.exec(text);
  if (epoch) return sane(Number(epoch[1]) * 1000, now);
  const m = RESET_RE.exec(text);
  if (!m?.groups) return null;
  const g = m.groups;
  let hour = Number(g.hour);
  const minute = g.minute ? Number(g.minute) : 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  const ampm = g.ampm?.toLowerCase().replace(/\./g, "");
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  } else if (!g.minute) {
    // A bare number with neither minutes nor am/pm ("resets 3") is not a clock.
    return null;
  }
  const zone = validZone(g.zone) ?? validZone(timeZone);
  const today = wallClock(now, zone);

  if (g.month && g.day) {
    const month = MONTHS.indexOf(g.month.toLowerCase().slice(0, 3));
    const day = Number(g.day);
    if (month < 0 || day < 1 || day > 31) return null;
    let at = instantOf(today.year, month, day, hour, minute, zone);
    // No year in the message: a date that has passed this year is next year's
    // (a "resets Jan 2" read on Dec 30).
    if (at <= now - 60_000) at = instantOf(today.year + 1, month, day, hour, minute, zone);
    return sane(at, now);
  }

  let dayOffset = 0;
  if (g.weekday) {
    const want = WEEKDAYS.indexOf(g.weekday.toLowerCase().slice(0, 3));
    if (want < 0 || today.weekday < 0) return null;
    dayOffset = (want - today.weekday + 7) % 7;
  }
  // Day arithmetic in UTC on the zone's own calendar date, so a month end rolls over.
  const base = new Date(Date.UTC(today.year, today.month, today.day + dayOffset));
  let at = instantOf(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute, zone);
  if (at <= now) {
    const next = new Date(Date.UTC(today.year, today.month, today.day + dayOffset + (g.weekday ? 7 : 1)));
    at = instantOf(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), hour, minute, zone);
  }
  return sane(at, now);
}

function sane(at: number, now: number): number | null {
  if (!Number.isFinite(at) || at <= now || at - now > MAX_LIMIT_MS) return null;
  return at;
}

/** The reset to act on: the parsed one, else the default window from now. */
export function limitUntil(limit: AnthropicLimit | null, now: number): number {
  return limit?.resetsAt ?? now + DEFAULT_LIMIT_MS;
}

// ── which account is next ───────────────────────────────────────────────────

/**
 * What an account IS for the pool's arithmetic. The rest of its record — the
 * label, the email, the credential — does not decide anything here.
 *
 *  - `ok`: can answer.
 *  - `limited`: at a usage cap until `limitedUntil`; back by itself after that.
 *  - `expired`: its credential needs renewing before it can answer (an OAuth
 *    access token this box could not refresh right now, a `claude` sign-in that
 *    is gone). Not a limit, and nothing brings it back but a working credential.
 *  - `revoked`: Anthropic refused the credential outright. The owner has to
 *    re-authenticate.
 */
export type AnthropicAccountStatus = "ok" | "limited" | "expired" | "revoked";

export const ANTHROPIC_ACCOUNT_STATUSES: readonly AnthropicAccountStatus[] = ["ok", "limited", "expired", "revoked"];

export interface PoolMember {
  id: string;
  status: AnthropicAccountStatus;
  limitedUntil: number | null;
}

/** The status as of `now`: a limit whose time has come is simply over. */
export function effectiveStatus(account: PoolMember, now: number): AnthropicAccountStatus {
  if (account.status === "limited") {
    return account.limitedUntil !== null && account.limitedUntil <= now ? "ok" : "limited";
  }
  return account.status;
}

export function isUsable(account: PoolMember, now: number): boolean {
  return effectiveStatus(account, now) === "ok";
}

/**
 * The account that answers next: the FIRST usable one in priority order.
 *
 * Priority, never round-robin, and that is what "return to the preferred
 * account once its limit resets" means in practice: nothing has to switch
 * back, because the moment account #1's limit is over it is the first usable
 * account again and the next pick is it. `exclude` is the account that has just
 * refused — named so a caller that has not recorded the limit yet cannot be
 * handed the same account straight back.
 */
export function pickAccount<T extends PoolMember>(accounts: readonly T[], now: number, exclude: ReadonlySet<string> = new Set()): T | null {
  return accounts.find((a) => !exclude.has(a.id) && isUsable(a, now)) ?? null;
}

export interface PoolHealth {
  total: number;
  /** Accounts that can answer right now. */
  healthy: number;
  /** Accounts at a usage cap that will lift by itself. */
  limited: number;
  /** Accounts that need the owner (expired or revoked). */
  needsAttention: number;
  /** Every account is at a limit or needs attention, and at least one account exists. */
  allLimited: boolean;
  /** The earliest time a limited account comes back, or null when none will by itself. */
  nextResetAt: number | null;
}

export function poolHealth(accounts: readonly PoolMember[], now: number): PoolHealth {
  let healthy = 0;
  let limited = 0;
  let needsAttention = 0;
  let nextResetAt: number | null = null;
  for (const account of accounts) {
    const status = effectiveStatus(account, now);
    if (status === "ok") healthy += 1;
    else if (status === "limited") {
      limited += 1;
      if (account.limitedUntil !== null && (nextResetAt === null || account.limitedUntil < nextResetAt)) {
        nextResetAt = account.limitedUntil;
      }
    } else needsAttention += 1;
  }
  return {
    total: accounts.length,
    healthy,
    limited,
    needsAttention,
    allLimited: accounts.length > 0 && healthy === 0,
    nextResetAt,
  };
}

/** "22:50", in the box's zone — the one way a reset time is said in English copy. */
export function formatResetClock(at: number, timeZone?: string): string {
  const w = wallClock(at, validZone(timeZone));
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}
