/**
 * Dated facts: WHEN a claim holds.
 *
 * Two claims that cannot both be true at the same time may well both be true
 * at different times: a launch price and today's price, the payments still
 * unmatched on 12.10 and on 14.10, the 2023 accounts and the 2025 ones. In an
 * owner's sample of open contradiction items two in ten were exactly that, an
 * old fact against the current one. So a claim carries, when its source says
 * so, the period it holds for:
 *
 *  - `valid_from` / `valid_until` (ISO dates or datetimes; either may be
 *    absent, open-ended) and/or `as_of` (the day, or moment, it was true on)
 *    in its frontmatter. The writer fills them when the source states a
 *    period or a date ({@link textValidity}: "since 22.09.2026", "until
 *    February", "as of 30.09");
 *  - absent those, what its text says (the same reader, for claims written
 *    before the fields existed);
 *  - absent that, its page's date when the page is a SNAPSHOT: a nightly or
 *    daily report, a weekly summary, a year's accounts, a memory note
 *    ({@link pageValidity}: "Finance nightly 14.10", "2025", "Income
 *    statement Q1 2026"). An invoice or a waybill is no snapshot: its date is
 *    the document's own, and the identifier filter tells records apart.
 *
 * Two claims whose periods do not overlap are a SUPERSESSION, never a
 * contradiction ({@link periodsDisjoint}): the later one is current. A claim
 * with no period overlaps every other, so the rule errs towards pairing.
 *
 * Also here: whether a claim is HISTORICAL (marked `historical: true`, or
 * worded as one: "formerly", "the launch price was", "originally"). A
 * historical claim is never paired with a current one.
 *
 * Pure.
 */

import { MONTH_NAMES, monthNumber } from "./identifiers";

export interface Validity {
  /** The first moment the claim holds: `YYYY-MM-DD` or an ISO datetime. Null: open. */
  from: string | null;
  /** The last moment it holds (a bare day: through its end). Null: open. */
  until: string | null;
  /** Where the period was read: the claim's own fields, its text, or its page's title. */
  source: "claim" | "text" | "page";
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function day(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2199 || m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= last ? `${y}-${pad(m)}-${pad(d)}` : null;
}

function lastDay(y: number, m: number): string {
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** A field value the schema accepts as a date: `YYYY-MM-DD` or an ISO datetime. */
export function isValidityDate(value: unknown): value is string {
  return typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

function bound(value: string, end: boolean): number {
  const m = DAY_RE.exec(value);
  if (m) return end ? Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : Date.UTC(+m[1], +m[2] - 1, +m[3]);
  // A datetime without a zone is read as UTC, the same on every box.
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) || !value.includes("T") ? value : `${value}Z`);
  return Number.isFinite(t) ? t : Number.NaN;
}

/** Ranges already worked out: the pass compares one claim's period with thousands of others. */
const RANGES = new WeakMap<Validity, [number, number] | null>();

/** The period as milliseconds `[from, until]`, or null when it says nothing (or nothing sane). */
export function validityRange(v: Validity | null | undefined): [number, number] | null {
  if (!v || (!v.from && !v.until)) return null;
  const known = RANGES.get(v);
  if (known !== undefined) return known;
  const lo = v.from ? bound(v.from, false) : Number.NEGATIVE_INFINITY;
  const hi = v.until ? bound(v.until, true) : Number.POSITIVE_INFINITY;
  const range: [number, number] | null = Number.isNaN(lo) || Number.isNaN(hi) || lo > hi ? null : [lo, hi];
  RANGES.set(v, range);
  return range;
}

/** Whether two claims' periods are both known and do not overlap: one supersedes the other. */
export function periodsDisjoint(a: Validity | null | undefined, b: Validity | null | undefined): boolean {
  const ra = validityRange(a);
  const rb = validityRange(b);
  return !!ra && !!rb && (ra[1] < rb[0] || rb[1] < ra[0]);
}

/** Of two disjoint periods, the later one: it is current. */
export function laterOf(a: Validity, b: Validity): "a" | "b" {
  const ra = validityRange(a);
  const rb = validityRange(b);
  if (!ra || !rb) return "a";
  return rb[0] > ra[1] ? "b" : "a";
}

/** A period as a person reads it: "as of 2026-10-14", "since 2026-09-22", "until 2027-02-28", "2026-01-01 to 2026-03-31". */
export function describeValidity(v: Validity): string {
  const short = (s: string) => s.replace(/T(\d{2}:\d{2}).*$/, " $1");
  if (v.from && v.until) {
    if (v.from === v.until) return `as of ${short(v.from)}`;
    return `${short(v.from)} to ${short(v.until)}`;
  }
  if (v.from) return `since ${short(v.from)}`;
  return `until ${short(v.until ?? "")}`;
}

// ── reading a date ────────────────────────────────────────────────────────

interface Span {
  from: string;
  until: string;
  /** How precise: a moment, a day, a month, a quarter, a year. */
  grain: "time" | "day" | "month" | "quarter" | "year";
  length: number;
}

const M = `(${MONTH_NAMES})(?![\\p{L}])\\.?`;
const ORD = "(?:st|nd|rd|th)?";
const TIME = "(?:,?\\s*(?:at\\s+)?(\\d{1,2}):(\\d{2})(?::\\d{2})?(?:\\s*(?:z|utc)(?![\\p{L}]))?)?";
const NOT_DIGIT = "(?![\\d])";
const FORMS: ReadonlyArray<{ re: RegExp; read: (m: RegExpExecArray, ref: RefDate | null) => Omit<Span, "length"> | null }> = [
  // 2026-09-14, 2026/09/14, 2026-09-14T08:30
  {
    re: new RegExp(`(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})${NOT_DIGIT}(?:[T\\s](\\d{1,2}):(\\d{2})(?::\\d{2})?(?:\\.\\d+)?(?:\\s*(?:z|utc)(?![\\p{L}]))?)?`, "iuy"),
    read: (m) => withTime(day(+m[1], +m[2], +m[3]), m[4], m[5]),
  },
  // 14.09.2026, 14/09/2026, 14-09-2026, 14.09.2026 17:00
  {
    re: new RegExp(`(\\d{1,2})[./-](\\d{1,2})[./-](\\d{4})${NOT_DIGIT}${TIME}`, "iuy"),
    read: (m) => withTime(day(+m[3], +m[2], +m[1]), m[4], m[5]),
  },
  // Q1 2026, 2026 Q1, Q1/2026
  {
    re: /q([1-4])[\s/-]*(\d{4})(?!\d)/iuy,
    read: (m) => quarter(+m[2], +m[1]),
  },
  {
    re: /(\d{4})[\s/-]*q([1-4])(?![\p{L}\d])/iuy,
    read: (m) => quarter(+m[1], +m[2]),
  },
  // 4 June 2026, 4th of June, 2026, 4 юни 2026 — and "4 June" in the reference year
  {
    re: new RegExp(`(\\d{1,2})${ORD}\\.?[\\s/-]*(?:of\\s+)?${M},?[\\s/-]*(?:(\\d{4})${NOT_DIGIT})?${TIME}`, "iuy"),
    read: (m, ref) => withTime(dayOf(m[3] ? +m[3] : null, monthNumber(m[2]), +m[1], ref), m[4], m[5]),
  },
  // June 4, 2026, June 4th — and "June 4" in the reference year
  {
    re: new RegExp(`${M}[\\s/-]*(\\d{1,2})${ORD}${NOT_DIGIT}(?:,?[\\s/-]+(\\d{4})${NOT_DIGIT})?${TIME}`, "iuy"),
    read: (m, ref) => withTime(dayOf(m[3] ? +m[3] : null, monthNumber(m[1]), +m[2], ref), m[4], m[5]),
  },
  // June 2026, Jun-2026, юни 2026
  {
    re: new RegExp(`${M},?[\\s/-]*(\\d{4})${NOT_DIGIT}`, "iuy"),
    read: (m) => month(+m[2], monthNumber(m[1])),
  },
  // 30.09, 30/09 (and 15.10 05:00) in the reference year; never an amount ("€12.10", "19.5 mo", "12.10 EUR")
  {
    re: new RegExp(`(?<![€$£]\\s?)(\\d{1,2})[./](\\d{2})(?![./]?\\d)(?!\\s*(?:%|€|\\$|eur|bgn|usd|лв|mo(?![\\p{L}])|k(?![\\p{L}])))${TIME}`, "iuy"),
    read: (m, ref) => withTime(dayOf(null, +m[2], +m[1], ref), m[3], m[4]),
  },
  // 2025
  {
    re: /((?:19|20)\d{2})(?![\d./-]\d)(?!\d)/iuy,
    read: (m) => ({ from: `${m[1]}-01-01`, until: `${m[1]}-12-31`, grain: "year" }),
  },
  // February, in the reference year
  {
    re: new RegExp(`${M}`, "iuy"),
    read: (m, ref) => (ref ? month(yearFor(ref, monthNumber(m[1]) ?? 0, 1), monthNumber(m[1])) : null),
  },
];

/** The date a yearless one is read against (when the claim was written), and which way it leans. */
interface RefDate {
  y: number;
  m: number;
  d: number;
  /** "until February" written in October means next February; "since 30.11" written in October, last November. */
  lean: "past" | "future" | "near";
}

function yearFor(ref: RefDate, m: number, d: number): number {
  const before = m < ref.m || (m === ref.m && d < ref.d);
  const after = m > ref.m || (m === ref.m && d > ref.d);
  if (ref.lean === "future" && before) return ref.y + 1;
  if (ref.lean === "past" && after) return ref.y - 1;
  return ref.y;
}

function dayOf(y: number | null, m: number | null, d: number, ref: RefDate | null): string | null {
  if (!m) return null;
  if (y !== null) return day(y, m, d);
  return ref ? day(yearFor(ref, m, d), m, d) : null;
}

function withTime(d: string | null, hh?: string, mm?: string): Omit<Span, "length"> | null {
  if (!d) return null;
  if (hh !== undefined && mm !== undefined && +hh < 24 && +mm < 60) {
    const t = `${d}T${pad(+hh)}:${mm}:00Z`;
    return { from: t, until: t, grain: "time" };
  }
  return { from: d, until: d, grain: "day" };
}

function month(y: number, m: number | null): Omit<Span, "length"> | null {
  if (!m || y < 1900 || y > 2199) return null;
  return { from: `${y}-${pad(m)}-01`, until: lastDay(y, m), grain: "month" };
}

function quarter(y: number, q: number): Omit<Span, "length"> {
  const first = (q - 1) * 3 + 1;
  return { from: `${y}-${pad(first)}-01`, until: lastDay(y, first + 2), grain: "quarter" };
}

/**
 * The date expression that starts at `at` in `text`, or null. A bare month
 * name ("February", "May") is a date only after a word that says one follows
 * ("until February"): anywhere else "may" is a verb and "march" a walk, so a
 * title never reads one (`bareMonth: false`).
 */
function dateAt(text: string, at: number, ref: RefDate | null, bareMonth = true): Span | null {
  for (const form of bareMonth ? FORMS : FORMS.slice(0, -1)) {
    form.re.lastIndex = at;
    const m = form.re.exec(text);
    if (!m) continue;
    const span = form.read(m, ref);
    if (span) return { ...span, length: m[0].length };
  }
  return null;
}

function refDate(value: string | null | undefined, lean: RefDate["lean"]): RefDate | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? { y: +m[1], m: +m[2], d: +m[3], lean } : null;
}

// ── what a claim's text says ──────────────────────────────────────────────

const AS_OF_WORDS = "as\\s+of|as\\s+at|as\\s+on|към|по\\s+състояние\\s+(?:на|към)";
const FROM_WORDS = "since|valid\\s+from|effective(?:\\s+(?:from|as\\s+of|on))?|as\\s+from|starting(?:\\s+(?:from|on))?|beginning|считано\\s+от|в\\s+сила\\s+от|от\\s+(?=\\S+\\s+(?:нататък|насам))";
const UNTIL_WORDS = "until|till|valid\\s+(?:until|through|thru|to)|through|thru|up\\s+to\\s+and\\s+including|в\\s+сила\\s+до|валиден\\s+до|валидна\\s+до|валидно\\s+до";
const PHRASE = new RegExp(`(?<![\\p{L}])(?:(${AS_OF_WORDS})|(${FROM_WORDS})|(${UNTIL_WORDS}))\\s+(?:the\\s+)?(?:end\\s+of\\s+)?`, "giu");

/**
 * The period a claim's text states, read only from what says it is one: "as
 * of 30.09.2026", "since 22.09.2026", "until February", "valid from 1 Oct
 * 2026 until 31 Dec 2026", "Q3 2026" after "as of". A date that is the FACT
 * itself ("the invoice is dated 14.09.2026", "the period is 2026-07-10 to
 * 2026-08-10") is no validity and is never read. A yearless date ("30.09",
 * "February") is read in the year of `written` (when the claim was written),
 * leaning the way its word does: "until February" written in October is next
 * February. Null when the text states no period.
 */
export function textValidity(text: string, written?: string | null): Validity | null {
  let from: string | null = null;
  let until: string | null = null;
  PHRASE.lastIndex = 0;
  for (const m of text.matchAll(PHRASE)) {
    const lean: RefDate["lean"] = m[1] ? "past" : m[2] ? "near" : "future";
    const span = dateAt(text, (m.index ?? 0) + m[0].length, refDate(written, lean));
    if (!span) continue;
    if (m[1]) {
      from = span.from;
      until = span.until;
    } else if (m[2]) {
      from = span.from;
    } else {
      until = span.until;
    }
  }
  if (!from && !until) return null;
  const v: Validity = { from, until, source: "text" };
  return validityRange(v) ? v : null;
}

/** The validity a claim's own frontmatter fields give: `valid_from` / `valid_until`, else `as_of`. */
export function fieldValidity(claim: { valid_from?: unknown; valid_until?: unknown; as_of?: unknown }): Validity | null {
  const from = isValidityDate(claim.valid_from) ? claim.valid_from : null;
  const until = isValidityDate(claim.valid_until) ? claim.valid_until : null;
  if (from || until) {
    const v: Validity = { from, until, source: "claim" };
    return validityRange(v) ? v : null;
  }
  if (isValidityDate(claim.as_of)) return { from: claim.as_of, until: claim.as_of, source: "claim" };
  return null;
}

// ── what a page's title says ──────────────────────────────────────────────

/** Title words of a page that is a picture of one moment or period: a report, a summary, accounts, a memory note. */
const SNAPSHOT_WORDS = new RegExp(
  `(?<![\\p{L}])(?:${[
    "reports?", "nightly", "daily", "weekly", "monthly", "quarterly", "annual", "yearly", "summar(?:y|ies)", "updates?",
    "status", "snapshots?", "memory", "notes", "minutes", "digest", "log", "journal", "recap", "forecasts?",
    "projections?", "actuals", "budgets?", "statements?", "accounts", "balance sheet", "p&l", "pnl", "dashboard",
    "metrics", "kpis?", "stand-?up", "newsletter", "brief(?:ing)?", "diagnosis", "run", "fy",
    "отчети?", "баланс", "справк[аи]", "дневен", "седмичен", "месечен", "годишен", "годишни",
  ].join("|")})(?![\\p{L}])`,
  "iu",
);

/** Every date expression in a title, left to right, none overlapping; never a bare month name. */
function datesIn(text: string, ref: RefDate | null): Span[] {
  const out: Span[] = [];
  for (let at = 0; at < text.length; ) {
    const before = at === 0 ? "" : text[at - 1];
    if (/[\p{L}\p{N}]/u.test(before) || !/[\p{L}\p{N}]/u.test(text[at])) {
      at += 1;
      continue;
    }
    const span = dateAt(text, at, ref, false);
    if (span && !/[\p{L}\p{N}]/u.test(text[at + span.length] ?? "")) {
      out.push(span);
      at += span.length;
    } else {
      at += 1;
    }
  }
  return out;
}

/** Whether a title is nothing but a period: "2023", "31.12.2025", "Q1 2026". */
function periodOnly(title: string, spans: readonly Span[]): boolean {
  const total = spans.reduce((n, s) => n + s.length, 0);
  return spans.length > 0 && title.replace(/[^\p{L}\p{N}]+/gu, "").length <= total;
}

/** Whether a page is a SNAPSHOT: what was true on its date (a report, a summary, a year's accounts), so its claims hold as of then. */
export function snapshotPage(title: string | null | undefined, type?: string | null): boolean {
  if (!title) return false;
  if (type === "metric") return true;
  return SNAPSHOT_WORDS.test(title) || periodOnly(title, datesIn(title, null));
}

/**
 * The period a SNAPSHOT page's title names, which its claims hold for when
 * they state none of their own: the moment or day it was taken on ("Finance
 * nightly 15.10 05:00", "Daily report 2026-10-14"; several days: from the
 * first to the last), else its month, quarter or year ("Income statement Q1
 * 2026", "2025"). A yearless date is read in the year the page was written
 * (`written`). Null for a page that is no snapshot, or a title with no date.
 */
export function pageValidity(title: string | null | undefined, type?: string | null, written?: string | null): Validity | null {
  if (!title || !snapshotPage(title, type)) return null;
  const spans = datesIn(title, refDate(written, "past"));
  if (spans.length === 0) return null;
  for (const grain of ["time", "day", "month", "quarter", "year"] as const) {
    const at = spans.filter((s) => s.grain === grain || (grain === "day" && s.grain === "time"));
    if (at.length === 0) continue;
    const from = at.map((s) => s.from).sort()[0];
    const until = at.map((s) => s.until).sort().at(-1) ?? from;
    return { from, until, source: "page" };
  }
  return null;
}

/**
 * A claim's period: its own fields first, then what its text states, then
 * its page's (a snapshot's title). `written` is when the claim was written
 * (its `updatedAt`), for yearless dates. Null: it holds whenever.
 */
export function claimValidity(
  claim: { text: string; valid_from?: unknown; valid_until?: unknown; as_of?: unknown; updatedAt?: unknown },
  page: { title?: string | null; type?: string | null; generatedAt?: string | null } = {},
): Validity | null {
  const written = typeof claim.updatedAt === "string" ? claim.updatedAt : (page.generatedAt ?? null);
  return fieldValidity(claim) ?? textValidity(claim.text, written) ?? pageValidity(page.title, page.type, page.generatedAt ?? written);
}

// ── historical claims ─────────────────────────────────────────────────────

const HISTORICAL_CUE = new RegExp(
  `(?<![\\p{L}])(?:${[
    "formerly", "previously", "originally", "used\\s+to", "no\\s+longer", "at\\s+(?:the\\s+)?launch", "launch\\s+price",
    "pre-?launch\\s+price", "old\\s+price", "historically", "първоначално", "вече\\s+не", "предишн[аи]те?\\s+цен[аи]",
  ].join("|")})(?![\\p{L}])`,
  "iu",
);

/** Whether a claim is HISTORICAL: marked `historical: true`, or worded as a past state of things ("formerly", "the launch price was"). */
export function historicalClaim(claim: { text: string; historical?: unknown }): boolean {
  return claim.historical === true || HISTORICAL_CUE.test(claim.text);
}
