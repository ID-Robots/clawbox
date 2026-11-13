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

/**
 * What kind of cap an account hit — said to the owner, never a code path.
 * `spend`: the subscription's monthly spend limit on extra usage (TASK-2141).
 */
export type AnthropicLimitKind = "session" | "weekly" | "rate" | "credit" | "spend";

export const ANTHROPIC_LIMIT_KINDS: readonly AnthropicLimitKind[] = ["session", "weekly", "rate", "credit", "spend"];

export interface AnthropicLimit {
  kind: AnthropicLimitKind;
  /** When the account is expected back (ms since the epoch), or null when the message did not say. */
  resetsAt: number | null;
  /**
   * The model family whose own week is spent ("opus", "fable"), when the CLI's
   * words name one: only runs on that model are capped, not the account.
   * Absent: the account's own window.
   */
  model?: string;
}

/** The model families Anthropic's subscriptions name today. */
const KNOWN_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

/**
 * A model's family, the part Anthropic's model-scoped weeks are matched on
 * (TASK-2141): `claude-fable-5-1` and "Fable" are both `fable`,
 * `claude-3-5-sonnet-20241022` is `sonnet`, `opus[1m]` is `opus`,
 * `openrouter/anthropic/claude-haiku-4.5` is `haiku`. A known family anywhere
 * in it; else the word after "claude"; else its first word of three letters
 * or more that is not the vendor's name. Null for nothing to go on.
 */
export function modelFamily(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const words = model.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  const known = words.find((w) => KNOWN_FAMILIES.includes(w));
  if (known) return known;
  const claude = words.indexOf("claude");
  if (claude >= 0 && words[claude + 1] && words[claude + 1] !== "anthropic") return words[claude + 1];
  return words.find((w) => w !== "claude" && w !== "anthropic") ?? null;
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
 *   You've hit your limit                                   (CLI 2.1.317, TASK-2141)
 *
 * "You've hit your … limit" in any other words is read as the session window
 * too, with no time: what it really was is Anthropic's answer to give
 * (src/lib/coding-agent.ts asks it).
 */
const SESSION_RE = /(?:claude ai usage limit reached|(?:5|five)[- ]hour limit reached|session limit reached|you(?:'|’)ve (?:hit|reached) your (?:[\w-]+ ){0,2}limit|usage limit reached)/i;
const WEEKLY_RE = /(?:weekly limit reached|you(?:'|’)ve (?:hit|reached) your (?:\w+ )?weekly limit|(?:opus|sonnet) (?:weekly )?limit reached)/i;
/**
 * The subscription's monthly spend limit on extra usage (CLI 2.1.317):
 * "You've hit your monthly spend limit". Its own kind — it is not a window
 * that resets in hours.
 */
const SPEND_RE = /you(?:'|’)ve (?:hit|reached) your monthly spend limit|monthly spend limit reached/i;
/**
 * The CLI saying a window is full and it CARRIES ON (CLI 2.1.317, the usage
 * scheme of 2026-11) — on extra usage, or inside a grace window:
 *
 *   Usage limit reached · continuing automatically
 *   Usage limit reached again · continuing automatically
 *   Usage limit reached — grace window active
 *
 * Not a stop: the run is still working, on the same account. The notice — the
 * phrase and its "Usage limit reached (again)" lead-in — is taken out of the
 * head before any limit is looked for in it; whatever else its line says
 * stays.
 */
const CARRYING_ON_RE = /\bcontinuing automatically\b|\bgrace window (?:is )?active\b/i;
const CARRYING_ON_PARTS_RE = /\bcontinuing automatically\b|\bgrace window (?:is )?active\b|\b(?:claude ai )?usage limit reached(?: again)?\b/gi;
/** What a line is left with at its ends once a notice is out of it. */
const SEPARATORS_AT_ENDS_RE = /^[\s·∙•—–|:;,.-]+|[\s·∙•—–|:;,.-]+$/g;
/**
 * A limit line that names the model whose own week is spent — "Opus weekly
 * limit reached", "You've hit your Fable limit". Only a family Anthropic's
 * subscriptions name: "You've hit your Max limit" names a plan, and
 * "Context limit reached" is no usage cap at all. A family this does not know
 * yet is told apart by Anthropic's answer instead (`weekly_scoped`).
 */
const SCOPED_RE = /\b(opus|sonnet|haiku|fable)(?:\s+weekly)?\s+limit reached|you(?:'|’)ve (?:hit|reached) your\s+(opus|sonnet|haiku|fable)\s+(?:weekly\s+)?limit\b/i;

/** The head of a failure with the CLI's "carrying on" notices taken out (CARRYING_ON_RE). */
function stopWords(head: string): string {
  return head
    .split(/\r?\n/)
    .map((line) => (CARRYING_ON_RE.test(line) ? line.replace(CARRYING_ON_PARTS_RE, " ").replace(SEPARATORS_AT_ENDS_RE, "").trim() : line))
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();
}

/** The model a limit line names (SCOPED_RE), as a family; null for the account's own window. */
function scopedModel(head: string): string | null {
  const m = SCOPED_RE.exec(head);
  return modelFamily(m?.[1] ?? m?.[2] ?? null);
}

/**
 * Is this the CLI saying a usage window is full while it carries on by itself
 * (CARRYING_ON_RE)? `grace` for the grace window, `continuing` for the rest;
 * null for anything else — and for a head that ALSO carries a real stop, which
 * detectAnthropicLimit answers.
 */
export function detectAnthropicLimitNotice(text: string | null | undefined): "continuing" | "grace" | null {
  if (typeof text !== "string") return null;
  const head = text.trim().slice(0, HEAD_CHARS);
  if (!CARRYING_ON_RE.test(head) || stopWords(head) !== "") return null;
  return /\bgrace window\b/i.test(head) ? "grace" : "continuing";
}
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
  // "continuing automatically" is the CLI carrying on, not stopping (TASK-2141).
  const head = stopWords(text.trim().slice(0, HEAD_CHARS));
  if (!head) return null;
  let kind: AnthropicLimitKind | null = null;
  // Spend first: it is a limit of its own, whatever else the line says.
  if (SPEND_RE.test(head)) kind = "spend";
  // Weekly next: "Opus weekly limit reached" also contains "limit reached".
  else if (WEEKLY_RE.test(head)) kind = "weekly";
  else if (SESSION_RE.test(head)) kind = "session";
  else if (RATE_RE.test(head)) kind = "rate";
  else if (CREDIT_RE.test(head)) kind = "credit";
  // A model-scoped week the CLI words in a way the lines above do not know.
  const model = kind === "spend" || kind === "credit" ? null : scopedModel(head);
  if (!kind && !model) return null;
  const resetsAt = parseLimitReset(head, now, timeZone);
  return model ? { kind: "weekly", resetsAt, model } : { kind: kind as AnthropicLimitKind, resetsAt };
}

// ── a credential Anthropic refused ──────────────────────────────────────────

/**
 * The CLI's and the API's wordings of a refused credential (TASK-1260):
 *
 *   Invalid API key · Please run /login
 *   OAuth token revoked · Please run /login
 *   Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error",…}}
 *   401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}
 *   invalid x-api-key
 *   OAuth access token has been revoked          (bare, as a run reported it; TASK-1235)
 *
 * A 401 is NOT a limit: the account is not coming back by itself at a reset,
 * it needs the owner (or a renewal). So it is its own answer, and the caller
 * confirms it against Anthropic before taking the account out — a token the box
 * can still renew was merely stale in the process that used it.
 */
// Anthropic's and the CLI's OWN words only — never a bare "401 Unauthorized",
// which is also what a package registry says to a run that is publishing.
const AUTH_RE = /(?:\bauthentication_error\b|invalid (?:x-api-key|api key|bearer token)|oauth (?:access )?token (?:has )?(?:expired|been revoked|revoked)|please run \/login|failed to authenticate)/i;

/**
 * Anthropic refusing the ACCOUNT rather than its token: the organisation a
 * subscription belongs to has switched Claude Code off for it. Seen in the
 * field (TASK-1271) as "Your organization has disabled Claude subscription
 * access for Claude Code", two seconds into a run. Not a limit — nothing lifts
 * it at a reset — and not a stale token either: the grant renews perfectly
 * well, so confirming it the way a 401 is confirmed would keep the account in
 * and put the work straight back on it. Only the owner (or that
 * organisation's admin) can bring it back.
 */
const ACCOUNT_DISABLED_RE = /\borgani[sz]ation has disabled\b[^\n.]{0,40}\bsubscription access\b/i;

/**
 * Is this failure Anthropic refusing the credential itself (a 401, a revoked
 * grant) or the account behind it? Only the head, for the reason
 * `detectAnthropicLimit` gives.
 */
export function detectAnthropicAuthFailure(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const head = text.trim().slice(0, HEAD_CHARS);
  return head !== "" && (AUTH_RE.test(head) || ACCOUNT_DISABLED_RE.test(head));
}

/** Is it the account switched off for good (see ACCOUNT_DISABLED_RE)? Only the head. */
export function detectAnthropicAccountDisabled(text: string | null | undefined): boolean {
  return typeof text === "string" && ACCOUNT_DISABLED_RE.test(text.trim().slice(0, HEAD_CHARS));
}

export type AnthropicFailure =
  | { type: "limit"; limit: AnthropicLimit }
  /**
   * `permanent`: refused for good (an account its organisation switched off).
   * There is nothing to confirm — the token would renew — so the caller takes
   * the account out as it is, instead of asking Anthropic about the credential.
   */
  | { type: "auth"; permanent?: true }
  /**
   * A bare rate limit — no usage-limit wording, no reset time — from a caller
   * that did NOT retry it first (`transientRate`). It may be a per-minute
   * throttle that clears in seconds, so it is not yet an account at its cap.
   */
  | { type: "throttled" };

/**
 * A gateway's failover reason can name the class of a failure its words do not
 * (its own copy, "API rate limit reached", carries no provider text). Only the
 * three that mean "this ACCOUNT", never a timeout or a format error — and never
 * an overload, which is Anthropic's capacity, not the account's cap.
 */
const OVERLOAD_RE = /\boverload(?:ed)?(?:_error)?\b|\b529\b/i;

/**
 * Limit or refused credential, or neither. A limit wins when both read true:
 * the CLI's limit line is the more specific answer, and a limit is the one
 * that lifts by itself.
 */
export function classifyAnthropicFailure(
  text: string | null | undefined,
  now: number,
  opts: {
    timeZone?: string;
    reason?: string | null;
    /**
     * The failure comes from something that does not back off and retry a 429
     * itself (the gateway's chat and crons), unlike Claude Code: a rate limit
     * with no reset time is then `throttled`, not yet a limit.
     */
    transientRate?: boolean;
  } = {},
): AnthropicFailure | null {
  const limit = detectAnthropicLimit(text, now, opts.timeZone);
  if (limit && opts.transientRate && limit.kind === "rate" && limit.resetsAt === null) return { type: "throttled" };
  if (limit) return { type: "limit", limit };
  if (detectAnthropicAccountDisabled(text)) return { type: "auth", permanent: true };
  if (detectAnthropicAuthFailure(text)) return { type: "auth" };
  const reason = typeof opts.reason === "string" ? opts.reason.trim().toLowerCase() : "";
  // The CLI carrying on by itself is no failure of the account, whatever the
  // reason it came with (TASK-2141).
  if (detectAnthropicLimitNotice(text)) return null;
  const words = typeof text === "string" ? text.trim().slice(0, HEAD_CHARS) : "";
  if (reason === "rate_limit" && !OVERLOAD_RE.test(words)) {
    const resetsAt = words ? parseLimitReset(words, now, opts.timeZone) : null;
    if (resetsAt === null && opts.transientRate) return { type: "throttled" };
    return { type: "limit", limit: { kind: "rate", resetsAt } };
  }
  if (reason === "billing") return { type: "limit", limit: { kind: "credit", resetsAt: null } };
  if (reason === "auth" || reason === "auth_permanent") return { type: "auth" };
  return null;
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
 *  - `expired`: its credential has run out and the box holds nothing to renew
 *    it with (an OAuth token past its end with no refresh token, a `claude`
 *    sign-in that is gone). A renewal that merely could not reach Anthropic
 *    marks nothing. Not a limit, and nothing brings it back but a working
 *    credential.
 *  - `revoked`: Anthropic refused the credential outright. The owner has to
 *    re-authenticate.
 */
export type AnthropicAccountStatus = "ok" | "limited" | "expired" | "revoked";

export const ANTHROPIC_ACCOUNT_STATUSES: readonly AnthropicAccountStatus[] = ["ok", "limited", "expired", "revoked"];

/**
 * A model's own week spent on an account (TASK-2141): Anthropic caps some
 * models with a week of their own (`weekly_scoped`) inside the account's.
 * Only runs on that model are kept off the account until `until`; the account
 * stays `ok` for everything else, and the box's active account does not move.
 */
export interface ModelLimit {
  /** The family a run's model is matched on (modelFamily). */
  family: string;
  /** Anthropic's own name for it, for the owner ("Fable"). */
  name: string;
  until: number;
  /**
   * Set from Anthropic's usage reading alone (TASK-2515), not from a refusal:
   * a later reading that shows the week with room again lifts it. Absent: a
   * run was refused on it, and only its time (or the owner) ends it.
   */
  fromUsage?: true;
}

export interface PoolMember {
  id: string;
  status: AnthropicAccountStatus;
  limitedUntil: number | null;
  /** `oauth`, `api_key` or `login` (src/lib/anthropic-accounts.ts); only the "most room" pick reads it. */
  kind?: string;
  /** The model weeks spent on it; absent is none. */
  modelLimits?: readonly ModelLimit[];
}

/** Until when a run on `model` is kept off this account by that model's own week; null when it is not. */
export function modelLimitedUntil(account: PoolMember, model: string | null | undefined, now: number): number | null {
  const family = modelFamily(model);
  if (!family || !account.modelLimits) return null;
  const week = account.modelLimits.find((l) => l.family === family && l.until > now);
  return week ? week.until : null;
}

/** The model weeks still running on this account. */
export function activeModelLimits(account: PoolMember, now: number): ModelLimit[] {
  return (account.modelLimits ?? []).filter((l) => l.until > now);
}

/**
 * When the first account comes back by itself for a run on `model`: each
 * account's own limit and that model's week, whichever ends later, the
 * earliest of those. Null when none will — every account usable now, or
 * needing the owner. poolHealth's `nextResetAt` with the model's weeks in it.
 */
export function nextResetFor(accounts: readonly PoolMember[], now: number, model?: string | null): number | null {
  let next: number | null = null;
  for (const account of accounts) {
    const status = effectiveStatus(account, now);
    if (status === "expired" || status === "revoked") continue;
    const ends = [status === "limited" ? account.limitedUntil : null, modelLimitedUntil(account, model, now)].filter((t): t is number => t !== null);
    if (ends.length === 0) continue;
    const back = Math.max(...ends);
    if (next === null || back < next) next = back;
  }
  return next;
}

/**
 * How the next account is picked when one has to be: `order`, the owner's
 * order (the default); or `most-room`, the subscription whose fullest usage
 * window has the most room left.
 */
export type PickMode = "order" | "most-room";

export const PICK_MODES: readonly PickMode[] = ["order", "most-room"];

export interface PickOptions {
  /** Unset is `order`. */
  mode?: PickMode;
  /**
   * Per account id, how full its fullest window is (the session and the
   * account's week, and — for a pick for one model — that model's own week;
   * Anthropic's percent): the window closest to running out decides. An
   * account with no entry has no reading.
   */
  fullness?: ReadonlyMap<string, number>;
  /**
   * The model the pick is for (a run's `--model`), TASK-2141: an account whose
   * week for THAT model is spent (ModelLimit) is not handed out — and stays
   * available to runs on every other model. Unset: any model.
   */
  model?: string | null;
}

/**
 * The "most room" ranking: the `oauth` accounts with a reading, the least
 * full first; then every other subscription (an `oauth` account with no
 * reading, the `login`); then the `oauth` accounts whose reading says they are
 * spent (100: a move onto one is refused at the next turn, while an unread
 * one may well have room); then the API keys — an API key never goes ahead of
 * a subscription. The owner's order breaks every tie.
 */
function byMostRoom<T extends PoolMember>(accounts: readonly T[], fullness: ReadonlyMap<string, number>): T[] {
  const tier = (a: T) => {
    if (a.kind === "api_key") return 3;
    if (a.kind !== "oauth" || !fullness.has(a.id)) return 1;
    return (fullness.get(a.id) ?? 0) >= 100 ? 2 : 0;
  };
  return accounts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => tier(x.a) - tier(y.a)
      || (tier(x.a) === 0 ? (fullness.get(x.a.id) ?? 0) - (fullness.get(y.a.id) ?? 0) : 0)
      || x.i - y.i)
    .map(({ a }) => a);
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

/** Usable, and — for a run on `model` — that model's own week is not spent on it. */
export function isUsableFor(account: PoolMember, now: number, model?: string | null): boolean {
  return isUsable(account, now) && modelLimitedUntil(account, model, now) === null;
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
 *
 * With the owner's `most-room` pick (`opts`), the first usable one in THAT
 * ranking (byMostRoom) instead; with no reading at all it is the owner's
 * order with the API keys after the subscriptions.
 */
export function pickAccount<T extends PoolMember>(accounts: readonly T[], now: number, exclude: ReadonlySet<string> = new Set(), opts: PickOptions = {}): T | null {
  const usable = accounts.filter((a) => !exclude.has(a.id) && isUsableFor(a, now, opts.model));
  if (opts.mode !== "most-room") return usable[0] ?? null;
  return byMostRoom(usable, opts.fullness ?? new Map())[0] ?? null;
}

/**
 * THE ACTIVE ACCOUNT (TASK-1260): the one every Claude consumer on the box —
 * coding runs, the gateway's agents and their crons — uses right now.
 *
 * STICKY by default. The box stays on the account it moved to until THAT one
 * cannot answer; then it takes the first usable one in the owner's order. A
 * limit that resets on account #1 does not move anything back — that would
 * interrupt the gateway for no gain, and the owner is paying for both.
 *
 * `returnToPrimary` is the owner's preference for the opposite: always the
 * first usable account, so #1 is used again the moment its limit is over (the
 * pool's behaviour before TASK-1260). `reselect` is a one-off of the same rule,
 * for a change the owner made to the order: the account they put first is the
 * one they mean.
 *
 * The pick itself is pickAccount's, in the owner's `mode`: sticky either way,
 * so "most room" decides only when the active account has to move. With
 * `returnToPrimary` or `reselect` the owner's order decides — "the first
 * account" is the one they put first.
 */
export function resolveActiveAccount<T extends PoolMember>(
  accounts: readonly T[],
  activeId: string | null,
  now: number,
  opts: { returnToPrimary?: boolean; reselect?: boolean } & PickOptions = {},
): T | null {
  if (!opts.returnToPrimary && !opts.reselect && activeId) {
    const current = accounts.find((a) => a.id === activeId);
    if (current && isUsable(current, now)) return current;
  }
  return pickAccount(accounts, now, new Set(), opts.reselect || opts.returnToPrimary ? {} : opts);
}

/**
 * The account a spawn should use: the active one, unless the caller has just
 * seen it refuse (`exclude`) — then the first other usable one, by pickAccount
 * in the owner's `mode`.
 */
export function pickForSpawn<T extends PoolMember>(
  accounts: readonly T[],
  activeId: string | null,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
  opts: PickOptions = {},
): T | null {
  const active = activeId ? accounts.find((a) => a.id === activeId) : undefined;
  if (active && !exclude.has(active.id) && isUsableFor(active, now, opts.model)) return active;
  return pickAccount(accounts, now, exclude, opts);
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
