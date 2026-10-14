/**
 * A coding run's or team's TIME BUDGET — how long the owner lets it work — and
 * the records it keeps of how that time was spent.
 *
 * Pure on purpose: no fs, no node imports, only `Intl`. The start UI imports it
 * to show what a task's words were understood as before anything starts; the
 * routes import it to resolve the same words with the box's clock and zone. One
 * parser, so the preview and the stored deadline cannot disagree.
 *
 * Stored as an ABSOLUTE deadline (ISO 8601, UTC) plus the label the owner
 * chose: a deadline survives a restart and a queue, where a duration would
 * quietly restart its clock. "Box-local" means the zone the routes pass in —
 * the OS zone (`readOsTimeZone`), never the browser's.
 *
 * Precedence (`resolveBudget`): the picker beats the task's words, the words
 * beat the owner's default, and nothing at all is no budget — a run without
 * one behaves exactly as before the budget existed.
 */

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** Every kind of budget: the four chips, and a period picked from the calendar (or one the words named). */
export const BUDGET_PRESETS = ["30m", "1h", "morning", "1d", "custom"] as const;
export type BudgetPreset = (typeof BUDGET_PRESETS)[number];

/** The presets a chip — and the settings default — offers: everything but a picked period. */
export const BUDGET_PRESET_CHIPS = ["30m", "1h", "morning", "1d"] as const;
export type BudgetChip = (typeof BUDGET_PRESET_CHIPS)[number];

/** Where a budget came from: the start UI's picker (or a caller's `budget` field), the task's own words, or the owner's default. */
export const BUDGET_SOURCES = ["picker", "text", "default"] as const;
export type BudgetSource = (typeof BUDGET_SOURCES)[number];

export interface TimeBudget {
  /** When the work must have stopped: ISO 8601 in UTC (`Date#toISOString`). */
  deadline: string;
  /** What was chosen, in English — "1 hour", "Until Fri 17 Oct, 18:00". The UI words a chip from `preset`, and shows this for `custom`. */
  label: string;
  preset: BudgetPreset;
  source: BudgetSource;
  /** When the budget was resolved (ISO, UTC) — the clock "time used" counts from. */
  setAt: string;
  /** A picked period's start (ISO, UTC), when the owner gave one. Time used counts from the later of this and `setAt`. */
  start?: string;
  /**
   * The SPEND ceiling beside the time ceiling, in tokens — the unit this box
   * measures spend in (CodingRun.tokensUsed, summed over a team's runs).
   * Work stops at whichever comes first, the deadline or this, and the stop
   * reason says which ("time" or "cost"). Absent: no spend ceiling of the
   * budget's own. A budget longer than LONG_BUDGET_MS that names none takes
   * the owner's existing token cap (`withDefaultTokenCap`).
   */
  tokenCap?: number;
}

/** A budget, or the sentence that says why the input was not one. `budget: null` is an explicit "no budget" (`"none"`). */
export type BudgetResult = { ok: true; budget: TimeBudget | null } | { ok: false; error: string };

/** Where in a task's words a budget was found. */
export interface TextBudgetMatch {
  /** The words that said it, as written in the task. */
  phrase: string;
  /** Where they start in the task (after Unicode NFC normalisation). */
  index: number;
  /** Which language's phrasing matched. */
  lang: "en" | "bg" | "de";
}

/** What the task's words said: a budget, or a budget this box will not take (past, too long, too short) and why. */
export type TextBudgetResult =
  | { ok: true; budget: TimeBudget; match: TextBudgetMatch }
  | { ok: false; error: string; match: TextBudgetMatch };

export type BudgetResolution =
  | {
      ok: true;
      /** The budget the run or team works to, or null for none. */
      budget: TimeBudget | null;
      /** Which rule decided: `none` when nothing set one, or the explicit `"none"`. */
      from: "picker" | "text" | "default" | "none";
      /** What the task's words said, when they were read (not when the picker decided). A refused one is kept here and ignored. */
      text: TextBudgetResult | null;
    }
  | { ok: false; error: string };

// ─── Bounds ──────────────────────────────────────────────────────────────────

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** A budget LONGER than this starts a coding team; this long or shorter is fine for one run. */
export const TEAM_BUDGET_THRESHOLD_MS = 30 * MINUTE_MS;
/** Shorter than this is not a budget a run can plan in. */
export const MIN_BUDGET_MS = 5 * MINUTE_MS;
/** Further away than this is refused: a run is not left working for weeks on one sentence. */
export const MAX_BUDGET_MS = 14 * DAY_MS;
/** "Until tomorrow morning" is the next 08:00, box-local. */
export const MORNING_HOUR = 8;
/** …at least this far away: at 07:30 "until tomorrow morning" means tomorrow, not half an hour. */
export const MORNING_MIN_LEAD_MS = HOUR_MS;
/** A day named without a time ("until Friday") ends at this hour; "tomorrow" alone ends at MORNING_HOUR. */
export const END_OF_DAY_HOUR = 18;
/** The longest label this box writes or reads back. */
export const MAX_BUDGET_LABEL_CHARS = 120;
/** A budget LONGER than this, naming no spend ceiling, takes the owner's token cap as one. */
export const LONG_BUDGET_MS = 2 * HOUR_MS;
/** The smallest spend ceiling a budget may name — the owner's token cap has the same floor. */
export const MIN_BUDGET_TOKEN_CAP = 10_000;
/** The safety margin is the larger of this… */
export const SAFETY_MARGIN_MIN_MS = 10 * MINUTE_MS;
/** …and this share of the whole budget. */
export const SAFETY_MARGIN_FRACTION = 0.1;
/** The longest `budget` token a caller may send. */
const MAX_TOKEN_CHARS = 200;

/** The chips' labels, in English; the UI translates by preset id. */
export const PRESET_LABELS: Record<BudgetChip, string> = {
  "30m": "30 minutes",
  "1h": "1 hour",
  morning: "Until tomorrow morning",
  "1d": "1 day",
};

const PRESET_DURATION_MS: Record<Exclude<BudgetChip, "morning">, number> = {
  "30m": 30 * MINUTE_MS,
  "1h": HOUR_MS,
  "1d": DAY_MS,
};

export function isBudgetPreset(v: unknown): v is BudgetPreset {
  return typeof v === "string" && (BUDGET_PRESETS as readonly string[]).includes(v);
}

export function isBudgetChip(v: unknown): v is BudgetChip {
  return typeof v === "string" && (BUDGET_PRESET_CHIPS as readonly string[]).includes(v);
}

// ─── Clock and zone ──────────────────────────────────────────────────────────

type Now = Date | number;

function nowMs(now: Now): number {
  return typeof now === "number" ? now : now.getTime();
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** An IANA zone this engine knows, else "UTC" — a box with a broken zone still gets a budget. */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz.trim()) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return tz.trim();
  } catch {
    return "UTC";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
}

/** The wall clock in `tz` at `ms`. */
function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // Some engines answered "24" for midnight under hour12:false; h23 should not, but cost nothing to guard.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: Math.max(0, WEEKDAY_SHORT.indexOf(p.weekday as (typeof WEEKDAY_SHORT)[number])),
  };
}

/** The zone's offset from UTC at `ms`, in ms (east positive). */
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const whole = Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * The instant a wall-clock time in `tz` names. In the hour a clock goes back
 * the earlier of the two is taken; a time inside the hour a clock skips is
 * read with the offset from before the jump, so it lands just after it.
 */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = wall - offsetAt(wall - DAY_MS, tz);
  const after = wall - offsetAt(wall + DAY_MS, tz);
  const matches = (t: number) => {
    const p = localParts(t, tz);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  };
  const valid = [before, after].filter(matches).sort((a, b) => a - b);
  return valid.length ? valid[0] : before;
}

/** A calendar date `n` days from the given one (no zone involved: dates only). */
function addDays(year: number, month: number, day: number, n: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** "Fri 17 Oct, 18:00" — the deadline on the box's wall clock, in English. */
export function formatLocalDeadline(at: string | number, tz: string): string {
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const p = localParts(ms, safeTimeZone(tz));
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${WEEKDAY_SHORT[p.weekday]} ${p.day} ${MONTH_SHORT[p.month - 1]}, ${hh}:${mm}`;
}

/** "45 minutes", "2 hours", "1 h 30 min", "3 days", "1 d 4 h" — a span in English. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days === 0) {
    if (mins === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
    return `${hours} h ${mins} min`;
  }
  if (hours === 0 && mins === 0) return `${days} day${days === 1 ? "" : "s"}`;
  if (mins === 0) return `${days} d ${hours} h`;
  return `${days} d ${hours} h ${mins} min`;
}

// ─── Building a budget ───────────────────────────────────────────────────────

/** The next MORNING_HOUR on the box's wall clock that is at least MORNING_MIN_LEAD_MS away. */
function nextMorning(now: number, tz: string): number {
  const today = localParts(now, tz);
  for (let add = 0; add <= 2; add++) {
    const d = addDays(today.year, today.month, today.day, add);
    const at = zonedToUtc(d.year, d.month, d.day, MORNING_HOUR, 0, tz);
    if (at - now >= MORNING_MIN_LEAD_MS) return at;
  }
  // Unreachable on any real zone: two days on, 08:00 is always far enough.
  return now + DAY_MS;
}

/**
 * A chip's budget, from `now`: 30 minutes, 1 hour, 1 day (24 hours of the
 * clock, so a DST change does not lengthen or shorten it), or until the next
 * 08:00 box-local that is at least an hour away.
 */
export function presetBudget(preset: BudgetChip, now: Now, tz: string, source: BudgetSource = "picker"): TimeBudget {
  const at = nowMs(now);
  const deadline = preset === "morning" ? nextMorning(at, safeTimeZone(tz)) : at + PRESET_DURATION_MS[preset];
  return { deadline: iso(deadline), label: PRESET_LABELS[preset], preset, source, setAt: iso(at) };
}

/** The checks every deadline passes, whatever named it. Null when it is fine. */
function deadlineProblem(deadline: number, workStart: number, now: number): string | null {
  if (!Number.isFinite(deadline)) return "The time budget's end is not a time this box can read.";
  if (deadline <= now) return `The time budget ends in the past (${iso(deadline)}). Pick an end later than now.`;
  if (deadline - now > MAX_BUDGET_MS) return `A time budget can run at most ${MAX_BUDGET_MS / DAY_MS} days; that one ends ${iso(deadline)}.`;
  if (deadline - Math.max(now, workStart) < MIN_BUDGET_MS) return `A time budget must be at least ${MIN_BUDGET_MS / MINUTE_MS} minutes long.`;
  return null;
}

/** The preset a duration IS, when it is one — "60 minutes" reads back as the 1-hour chip. */
function presetForDuration(ms: number): BudgetChip | null {
  for (const [preset, d] of Object.entries(PRESET_DURATION_MS)) if (d === ms) return preset as BudgetChip;
  return null;
}

/** A budget of `ms` from now, or why not. */
export function durationBudget(ms: number, now: Now, source: BudgetSource = "picker"): BudgetResult {
  const at = nowMs(now);
  if (!Number.isFinite(ms) || ms <= 0) return { ok: false, error: "A time budget must be a length of time greater than zero." };
  const problem = deadlineProblem(at + ms, at, at);
  if (problem) return { ok: false, error: problem };
  const preset = presetForDuration(ms);
  return {
    ok: true,
    budget: {
      deadline: iso(at + ms),
      label: preset ? PRESET_LABELS[preset] : formatDuration(ms),
      preset: preset ?? "custom",
      source,
      setAt: iso(at),
    },
  };
}

const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * An ISO 8601 date-time, as ms — or null. One WITHOUT an offset
 * ("2026-10-15T18:00", what a datetime-local field gives) is read on the
 * box's wall clock, since every time the owner is shown is box-local.
 */
export function parseIsoInstant(text: string, tz: string): number | null {
  const m = ISO_INSTANT_RE.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  // A day the month does not have (31 Feb) is refused, not rolled into March.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  // Kept to the millisecond, so a deadline this box answered reads back as itself.
  const millis = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
  const zone = m[8];
  if (!zone) {
    const at = zonedToUtc(year, month, day, hour, minute, safeTimeZone(tz));
    return at + second * 1000 + millis;
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (zone.toUpperCase() === "Z") return wall;
  const sign = zone[0] === "-" ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const oh = Number(digits.slice(0, 2));
  const om = Number(digits.slice(2) || "0");
  if (oh > 14 || om > 59) return null;
  return wall - sign * (oh * HOUR_MS + om * MINUTE_MS);
}

/**
 * A period picked from the calendar: its end (ISO), and optionally its start.
 * The end must be in the future, at most 14 days away and at least 5 minutes
 * after the later of now and the start.
 */
export function customBudget(
  endIso: string,
  now: Now,
  startIso?: string | null,
  opts: { tz?: string; source?: BudgetSource; label?: string } = {},
): BudgetResult {
  const at = nowMs(now);
  const tz = safeTimeZone(opts.tz);
  const end = typeof endIso === "string" ? parseIsoInstant(endIso, tz) : null;
  if (end === null) return { ok: false, error: "The time budget's end is not a time this box can read: use ISO 8601, e.g. 2026-10-15T18:00:00Z." };
  let start: number | null = null;
  if (startIso !== undefined && startIso !== null && startIso !== "") {
    start = typeof startIso === "string" ? parseIsoInstant(startIso, tz) : null;
    if (start === null) return { ok: false, error: "The time budget's start is not a time this box can read: use ISO 8601, e.g. 2026-10-15T09:00:00Z." };
    if (start >= end) return { ok: false, error: "The time budget's start must be before its end." };
  }
  const problem = deadlineProblem(end, start ?? at, at);
  if (problem) return { ok: false, error: problem };
  const label = typeof opts.label === "string" && opts.label.trim() ? cleanLabel(opts.label) : `Until ${formatLocalDeadline(end, tz)}`;
  return {
    ok: true,
    budget: {
      deadline: iso(end),
      label,
      preset: "custom",
      source: opts.source ?? "picker",
      setAt: iso(at),
      ...(start !== null ? { start: iso(start) } : {}),
    },
  };
}

function cleanLabel(label: string): string {
  return label.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_BUDGET_LABEL_CHARS);
}

const DURATION_TOKEN_RE = /^(\d{1,5}(?:[.,]\d{1,2})?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i;
const ISO_DURATION_RE = /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?)?$/i;

/** "90m", "2h", "1.5 hours", "3d", "PT2H" → ms; anything else → null. */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  const m = DURATION_TOKEN_RE.exec(t);
  if (m) {
    const n = Number(m[1].replace(",", "."));
    const unit = m[2].toLowerCase();
    const per = unit.startsWith("d") ? DAY_MS : unit.startsWith("h") ? HOUR_MS : MINUTE_MS;
    const ms = Math.round(n * per);
    return ms > 0 ? ms : null;
  }
  const p = ISO_DURATION_RE.exec(t);
  if (p && (p[1] || p[2] || p[3])) {
    const ms = Number(p[1] ?? 0) * DAY_MS + Number(p[2] ?? 0) * HOUR_MS + Number(p[3] ?? 0) * MINUTE_MS;
    return ms > 0 ? ms : null;
  }
  return null;
}

const TOKEN_ALIASES: Record<string, BudgetChip> = {
  "30min": "30m",
  "30-minutes": "30m",
  "1hour": "1h",
  "1-hour": "1h",
  "tomorrow-morning": "morning",
  tomorrow_morning: "morning",
  "until-morning": "morning",
  "1day": "1d",
  "1-day": "1d",
};

/**
 * A caller's `budget` string: a chip ("30m", "1h", "morning", "1d"), a
 * duration ("90m", "3h", "2d", "PT2H"), an end time (ISO 8601; without an
 * offset it is box-local), a period "start/end", or "none" for an explicit
 * no-budget. Anything else, a past end, or one more than 14 days away is
 * refused with a sentence that says what this box takes.
 */
export function parseBudgetToken(token: string, now: Now, tz: string): BudgetResult {
  const raw = typeof token === "string" ? token.trim() : "";
  const unknown = (): BudgetResult => ({
    ok: false,
    error: `The time budget "${raw.slice(0, 40)}${raw.length > 40 ? "…" : ""}" is not one this box knows. `
      + "Use 30m, 1h, morning or 1d, a length such as 90m or 3h, an end time in ISO 8601 (e.g. 2026-10-15T18:00:00Z), a period \"start/end\", or \"none\".",
  });
  if (!raw || raw.length > MAX_TOKEN_CHARS) return unknown();
  const lower = raw.toLowerCase();
  if (lower === "none") return { ok: true, budget: null };
  const chip = isBudgetChip(lower) ? lower : TOKEN_ALIASES[lower];
  if (chip) return { ok: true, budget: presetBudget(chip, now, tz, "picker") };
  const duration = parseDuration(raw);
  if (duration !== null) return durationBudget(duration, now, "picker");
  if (raw.includes("/")) {
    const [start, end, ...extra] = raw.split("/");
    if (extra.length || !start || !end) return unknown();
    if (parseIsoInstant(start, tz) === null || parseIsoInstant(end, tz) === null) return unknown();
    return customBudget(end, now, start, { tz });
  }
  if (parseIsoInstant(raw, tz) !== null) return customBudget(raw, now, null, { tz });
  return unknown();
}

/** A spend ceiling as given: a whole number of tokens, at least MIN_BUDGET_TOKEN_CAP — else null. */
function readTokenCap(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_BUDGET_TOKEN_CAP ? v : null;
}

/**
 * The `budget` field of a start request, whatever shape it came in: a token
 * (see parseBudgetToken), or `{ preset }`, or `{ preset: "custom", end, start? }`
 * (`deadline` is read as `end`, so a budget this box answered can be sent back).
 * The object shapes may name a spend ceiling, `tokenCap` (whole tokens, at
 * least MIN_BUDGET_TOKEN_CAP; null or absent for none).
 * The caller decides what absent means — this reads a value that is there.
 */
export function readBudgetInput(raw: unknown, now: Now, tz: string): BudgetResult {
  if (typeof raw === "string") return parseBudgetToken(raw, now, tz);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const preset = typeof o.preset === "string" ? o.preset.trim().toLowerCase() : undefined;
    const end = typeof o.end === "string" ? o.end : typeof o.deadline === "string" ? o.deadline : undefined;
    const start = typeof o.start === "string" ? o.start : undefined;
    if (preset === "none") return { ok: true, budget: null };
    const named = o.tokenCap !== undefined && o.tokenCap !== null;
    const tokenCap = readTokenCap(o.tokenCap);
    if (named && tokenCap === null) {
      return { ok: false, error: `The time budget's token ceiling must be a whole number of at least ${MIN_BUDGET_TOKEN_CAP} tokens — or null for none.` };
    }
    const capped = (r: BudgetResult): BudgetResult =>
      r.ok && r.budget && tokenCap !== null ? { ok: true, budget: { ...r.budget, tokenCap } } : r;
    if (preset && isBudgetChip(preset)) return capped({ ok: true, budget: presetBudget(preset, now, tz, "picker") });
    if ((preset === undefined || preset === "custom") && end !== undefined) {
      return capped(customBudget(end, now, start, { tz, ...(typeof o.label === "string" && preset === "custom" ? { label: o.label } : {}) }));
    }
  }
  return {
    ok: false,
    error: "The time budget must be a preset (30m, 1h, morning, 1d), a length such as 90m, an end time in ISO 8601, "
      + "{ preset: \"custom\", end, start?, tokenCap? }, or \"none\".",
  };
}

/**
 * A budget LONGER than LONG_BUDGET_MS that names no spend ceiling of its own
 * takes the owner's existing token cap as one — so a day-long budget cannot
 * spend without bound on extra work. Shorter budgets, a budget that named
 * its own, and a box whose owner set no cap are returned as they are.
 */
export function withDefaultTokenCap(budget: TimeBudget, ownerTokenLimit: number | null | undefined): TimeBudget {
  if (budget.tokenCap !== undefined) return budget;
  const cap = readTokenCap(ownerTokenLimit);
  if (cap === null || budgetDurationMs(budget) <= LONG_BUDGET_MS) return budget;
  return { ...budget, tokenCap: cap };
}

// ─── Reading the task's words ────────────────────────────────────────────────

/** A letter or digit in any script — what a word boundary is NOT. (No lookbehind: older Safari has none.) */
const WORD = "\\p{L}\\p{N}";
const LEFT = `(^|[^${WORD}])`;
const RIGHT = `(?=$|[^${WORD}])`;
/**
 * The start of a clause: the text's start, a sentence mark or a comma followed
 * by a space ("1.5 hours" is not a clause break), a line break, an opening
 * bracket — and a list bullet after any of them. Not a colon: "Timeout: 2
 * hours" is a feature, not a budget.
 */
const CLAUSE = `((?:^|[.!?;,]\\s+|[\\n\\r(\\[])\\s*(?:[-–—•*]\\s+)?)`;
/** A sentence of its own: only a sentence end or a line break before it — never a bracket or a bullet, where "(2 hours)" is an estimate. */
const SENTENCE = `((?:^|[.!?]\\s+|[\\n\\r])\\s*)`;

const NUMBER_WORDS: Record<string, number> = {
  // en
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, fifty: 50, ninety: 90,
  // bg
  един: 1, една: 1, едно: 1, два: 2, две: 2, три: 3, четири: 4, пет: 5, шест: 6, седем: 7, осем: 8, девет: 9,
  десет: 10, петнадесет: 15, петнайсет: 15, двадесет: 20, двайсет: 20, тридесет: 30, трийсет: 30,
  четиридесет: 40, четирийсет: 40, петдесет: 50, деветдесет: 90,
  // de
  ein: 1, eine: 1, einen: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6, sieben: 7,
  acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12, fünfzehn: 15, zwanzig: 20, dreißig: 30,
  dreissig: 30, vierzig: 40, fünfundvierzig: 45, fünfzig: 50, neunzig: 90, eineinhalb: 1.5, anderthalb: 1.5,
};
const NUMBER_WORD_RE = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|");

/** Unit words, longest first so a shorter one never wins on a prefix. */
const UNIT_WORDS: [string, number][] = [
  ["денонощия", DAY_MS], ["денонощие", DAY_MS], ["minutes", MINUTE_MS], ["minuten", MINUTE_MS], ["минути", MINUTE_MS],
  ["минута", MINUTE_MS], ["stunden", HOUR_MS], ["minute", MINUTE_MS], ["stunde", HOUR_MS], ["hours", HOUR_MS],
  ["часът", HOUR_MS], ["tagen", DAY_MS], ["hour", HOUR_MS], ["mins", MINUTE_MS], ["часа", HOUR_MS], ["days", DAY_MS],
  ["tage", DAY_MS], ["дена", DAY_MS], ["hrs", HOUR_MS], ["min", MINUTE_MS], ["мин", MINUTE_MS], ["час", HOUR_MS],
  ["std", HOUR_MS], ["day", DAY_MS], ["tag", DAY_MS], ["дни", DAY_MS], ["ден", DAY_MS], ["hr", HOUR_MS],
];
/** One-letter units, only straight after digits ("2h", "30m"). */
const SHORT_UNITS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS, ч: HOUR_MS };
const UNIT_RE = UNIT_WORDS.map(([w]) => w).join("|");
const HALF_RE = "(?:and\\s+a\\s+half|и\\s+половина|und\\s+ein\\s+halb)";
/** Words that may stand between the cue and the amount: "you have ABOUT 2 hours". */
const APPROX_RE = "(?:(?:up\\s+to|about|around|roughly|approximately|approx\\.?|около|приблизително|ungefähr|ungefaehr|etwa|circa|ca\\.)\\s+)?";

const unitMs = (word: string): number => {
  const w = word.toLowerCase();
  return UNIT_WORDS.find(([u]) => u === w)?.[1] ?? SHORT_UNITS[w] ?? 0;
};

/** "half an hour", "половин час", "eine halbe Stunde", "a couple of hours" — the amounts that are not a number and a unit. */
const SPECIAL_DURATIONS: [RegExp, number][] = [
  [new RegExp(`^${APPROX_RE}(?:half\\s+an\\s+hour|a\\s+half[-\\s]hour|half[-\\s]an[-\\s]hour)${RIGHT}`, "iu"), 30 * MINUTE_MS],
  [new RegExp(`^${APPROX_RE}a\\s+couple\\s+(?:of\\s+)?hours${RIGHT}`, "iu"), 2 * HOUR_MS],
  [new RegExp(`^${APPROX_RE}половин\\s+час${RIGHT}`, "iu"), 30 * MINUTE_MS],
  [new RegExp(`^${APPROX_RE}половин\\s+ден${RIGHT}`, "iu"), 12 * HOUR_MS],
  [new RegExp(`^${APPROX_RE}(?:eine\\s+)?halbe\\s+stunde${RIGHT}`, "iu"), 30 * MINUTE_MS],
  [new RegExp(`^${APPROX_RE}(?:einen\\s+)?halben\\s+tag${RIGHT}`, "iu"), 12 * HOUR_MS],
];

/** NUMBER [and a half] UNIT [and a half] [lang], at the start of `rest`. */
const AMOUNT_RE = new RegExp(
  `^${APPROX_RE}(?:(\\d{1,4}(?:[.,]\\d{1,2})?)\\s*(${UNIT_RE}|[mhdч])|(${NUMBER_WORD_RE})(\\s+${HALF_RE})?\\s+(${UNIT_RE})|(${UNIT_RE}))(\\s+${HALF_RE})?(?:\\s+lang)?${RIGHT}`,
  "iu",
);

interface DurationHit {
  len: number;
  ms: number;
}

/** The units Bulgarian says without a number: "имаш час" is "you have an hour". Nothing else stands bare — "you have days of data" is no budget. */
const BARE_UNITS = new Set(["час", "ден"]);

/**
 * A length of time at the very start of `rest`. `bare` allows a unit with no
 * number ("имаш час") — only behind a real cue word, never as a clause of its
 * own.
 */
function durationAt(rest: string, bare: boolean): DurationHit | null {
  for (const [re, ms] of SPECIAL_DURATIONS) {
    const m = re.exec(rest);
    if (m) return { len: m[0].length, ms };
  }
  const m = AMOUNT_RE.exec(rest);
  if (!m) return null;
  let amount: number;
  let unit: string;
  if (m[1] !== undefined) {
    amount = Number(m[1].replace(",", "."));
    unit = m[2];
  } else if (m[3] !== undefined) {
    amount = NUMBER_WORDS[m[3].toLowerCase()] ?? NaN;
    if (m[4]) amount += 0.5;
    unit = m[5];
  } else {
    if (!bare || !BARE_UNITS.has(m[6].toLowerCase())) return null;
    amount = 1;
    unit = m[6];
  }
  if (m[7]) amount += 0.5;
  const per = unitMs(unit);
  const ms = Math.round(amount * per);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { len: m[0].length, ms };
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3, thursday: 4, thurs: 4,
  thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
  неделя: 0, понеделник: 1, вторник: 2, сряда: 3, четвъртък: 4, петък: 5, събота: 6,
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6,
};
const WEEKDAY_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");
const DAY_PREFIX_RE = "(?:(?:on|this|next|this\\s+coming|в|във|този|тази|следващия|следващата|am|diesen|nächsten|naechsten|kommenden)\\s+)?";

/** "tomorrow morning", "the morning", "утре сутринта", "morgen früh". */
const MORNING_RE = new RegExp(
  `^(?:(?:tomorrow\\s+)?(?:the\\s+)?morning|(?:утре\\s+)?сутрин(?:та)?|morgen\\s+(?:früh|frueh|in\\s+der\\s+früh|vormittag))${RIGHT}`,
  "iu",
);
/** A day: today, tomorrow, the day after, a weekday, or an ISO date. */
const DAY_RE = new RegExp(
  `^(?:(today|днес|heute)|(tomorrow|утре|morgen)|((?:the\\s+)?day\\s+after\\s+tomorrow|вдругиден|übermorgen|uebermorgen)|${DAY_PREFIX_RE}(${WEEKDAY_RE})|(\\d{4})-(\\d{2})-(\\d{2}))${RIGHT}`,
  "iu",
);
const CONNECTOR_RE = /^(?:\s*,)?\s+(?:(?:at\s+around|at|@|um|в|около|gegen)\s+)?/iu;
const AT_WORD_RE = /^(?:\s*,)?\s+(?:at\s+around|at|@|um|в|около|gegen)\s+/iu;
/** Clock times: "6pm", "6:30 p.m.", "18:00", "18h30", "18.00 Uhr", "18 ч.", "18 Uhr". */
const TIME_RE = new RegExp(
  "^(?:(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)"
    + "|(\\d{1,2})[:h](\\d{2})(?:\\s*(?:uhr|ч\\.?|часа|h))?"
    + "|(\\d{1,2})\\.(\\d{2})\\s*(?:uhr|ч\\.?|часа|h)"
    + "|(\\d{1,2})\\s*(?:uhr|ч\\.?|часа|часът|h))"
    + `(?=$|[^${WORD}])`,
  "iu",
);
const BARE_HOUR_RE = new RegExp(`^(\\d{1,2})${RIGHT}`, "u");

interface ClockHit {
  len: number;
  hour: number;
  minute: number;
}

/** A clock time at the start of `rest`; a bare hour only when `bareHour` (behind "at"/"um"/"в"). */
function clockAt(rest: string, bareHour: boolean): ClockHit | null {
  const m = TIME_RE.exec(rest);
  if (m) {
    let hour: number;
    let minute: number;
    if (m[1] !== undefined) {
      hour = Number(m[1]);
      minute = Number(m[2] ?? 0);
      if (hour < 1 || hour > 12) return null;
      const pm = m[3].toLowerCase().startsWith("p");
      hour = (hour % 12) + (pm ? 12 : 0);
    } else if (m[4] !== undefined) {
      hour = Number(m[4]);
      minute = Number(m[5]);
    } else if (m[6] !== undefined) {
      hour = Number(m[6]);
      minute = Number(m[7]);
    } else {
      hour = Number(m[8]);
      minute = 0;
    }
    if (hour > 23 || minute > 59) return null;
    return { len: m[0].length, hour, minute };
  }
  if (bareHour) {
    const b = BARE_HOUR_RE.exec(rest);
    if (b && Number(b[1]) <= 23) return { len: b[0].length, hour: Number(b[1]), minute: 0 };
  }
  return null;
}

interface DeadlineHit {
  len: number;
  deadline: number;
  morning: boolean;
}

/** A point in time at the start of `rest`: the morning, a day with or without a time, an ISO date, or a time alone. */
function deadlineAt(rest: string, now: number, tz: string): DeadlineHit | null {
  const morning = MORNING_RE.exec(rest);
  if (morning) return { len: morning[0].length, deadline: nextMorning(now, tz), morning: true };
  const today = localParts(now, tz);
  const day = DAY_RE.exec(rest);
  if (day) {
    let len = day[0].length;
    let clock: ClockHit | null = null;
    const after = rest.slice(len);
    const conn = CONNECTOR_RE.exec(after);
    if (conn) {
      clock = clockAt(after.slice(conn[0].length), AT_WORD_RE.test(after));
      if (clock) len += conn[0].length + clock.len;
    }
    let date: { year: number; month: number; day: number };
    let defaultHour = END_OF_DAY_HOUR;
    let rollWeek = false;
    if (day[1]) {
      date = { year: today.year, month: today.month, day: today.day };
    } else if (day[2]) {
      date = addDays(today.year, today.month, today.day, 1);
      defaultHour = MORNING_HOUR;
    } else if (day[3]) {
      date = addDays(today.year, today.month, today.day, 2);
    } else if (day[4]) {
      const wd = WEEKDAYS[day[4].toLowerCase()] ?? 0;
      date = addDays(today.year, today.month, today.day, (wd - today.weekday + 7) % 7);
      rollWeek = true;
    } else {
      const [y, mo, d] = [Number(day[5]), Number(day[6]), Number(day[7])];
      const check = new Date(Date.UTC(y, mo - 1, d));
      if (mo < 1 || mo > 12 || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
      date = { year: y, month: mo, day: d };
    }
    const hour = clock?.hour ?? defaultHour;
    const minute = clock?.minute ?? 0;
    let at = zonedToUtc(date.year, date.month, date.day, hour, minute, tz);
    // "Until Friday" said on a Friday evening is next Friday, not a deadline already gone.
    if (rollWeek && at <= now) {
      const next = addDays(date.year, date.month, date.day, 7);
      at = zonedToUtc(next.year, next.month, next.day, hour, minute, tz);
    }
    return { len, deadline: at, morning: false };
  }
  const clock = clockAt(rest, false);
  if (clock) {
    let at = zonedToUtc(today.year, today.month, today.day, clock.hour, clock.minute, tz);
    if (at <= now) {
      const next = addDays(today.year, today.month, today.day, 1);
      at = zonedToUtc(next.year, next.month, next.day, clock.hour, clock.minute, tz);
    }
    return { len: clock.len, deadline: at, morning: false };
  }
  return null;
}

type CueKind = "duration" | "deadline";

interface Cue {
  lang: TextBudgetMatch["lang"];
  kind: CueKind;
  re: RegExp;
  /** The cue may be the empty string: a length standing as its own clause ("… 2 hours."). */
  clause: boolean;
}

/**
 * Cue words by language. `anywhere` cues are specific enough to stand
 * mid-sentence; `clause` cues count only where a clause opens. What a FEATURE
 * would say mid-sentence lives in `clause`: "a time limit of 30 minutes per
 * quiz", "tasks whose deadline is tomorrow", "the shop works until 18:00"
 * ("магазинът работи до 18:00") all describe the thing being built.
 */
const CUE_SOURCES: { lang: TextBudgetMatch["lang"]; kind: CueKind; anywhere: string; clause: string }[] = [
  {
    lang: "en",
    kind: "duration",
    anywhere: "you\\s+have(?:\\s+got)?|you've\\s+got|you\\s+get|you\\s+(?:can|may|should)\\s+(?:spend|take|use)|"
      + "work(?:\\s+on\\s+(?:it|this|that))?(?:\\s+for(?:\\s+the\\s+next)?)?|keep\\s+(?:working|going)(?:\\s+for(?:\\s+the\\s+next)?)?|"
      + "time\\s+budget(?:\\s+is|\\s+of)?\\s*:?|(?:finish|be\\s+done|complete\\s+it)\\s+within(?:\\s+the\\s+next)?",
    clause: "for(?:\\s+the\\s+next)?|within(?:\\s+the\\s+next)?|in\\s+the\\s+next|spend|take|continue\\s+for|"
      + "budget(?:\\s+is|\\s+of)?\\s*:?|time\\s*limit(?:\\s+is|\\s+of)?\\s*:?",
  },
  {
    lang: "en",
    kind: "deadline",
    anywhere: "(?:work|keep\\s+(?:working|going)|carry\\s+on|you\\s+have(?:\\s+got)?(?:\\s+time)?|you've\\s+got(?:\\s+time)?|you\\s+can\\s+work)"
      + "(?:\\s+on\\s+(?:it|this|that))?\\s+(?:until|till|til|up\\s+until|up\\s+to)|"
      + "(?:finish|be\\s+done|deliver|complete)(?:\\s+(?:it|this|that|everything))?\\s+by|time\\s+budget(?:\\s+is)?\\s*:?\\s*(?:until|till)",
    clause: "until|till|up\\s+until|deadline(?:\\s+is)?\\s*:?",
  },
  {
    lang: "bg",
    kind: "duration",
    anywhere: "имаш|имате|разполагаш\\s+с|разполагате\\s+с|"
      + "времеви\\s+бюджет(?:ът)?(?:\\s+е)?\\s*:?|бюджет\\s+(?:от\\s+)?време(?:\\s+е)?\\s*:?",
    clause: "за|в\\s+рамките\\s+на(?:\\s+следващите)?|през\\s+следващите|в\\s+следващите|бюджет(?:ът)?(?:\\s+е)?\\s*:?|"
      + "работи(?:те)?(?:\\s+по\\s+(?:това|задачата|нея))?(?:\\s+(?:за|в\\s+продължение\\s+на|през\\s+следващите))?",
  },
  {
    lang: "bg",
    kind: "deadline",
    anywhere: "(?:имаш|имате)(?:\\s+време)?\\s+до|(?:продължи|продължавай)(?:те)?(?:\\s+по\\s+(?:това|задачата))?\\s+до|"
      + "(?:завърши|приключи)(?:\\s+(?:го|всичко))?\\s+до",
    clause: "до|работи(?:те)?(?:\\s+по\\s+(?:това|задачата|нея))?\\s+до|краен\\s+срок(?:\\s+е)?\\s*:?",
  },
  {
    lang: "de",
    kind: "duration",
    anywhere: "du\\s+hast|ihr\\s+habt|sie\\s+haben|du\\s+bekommst|nimm\\s+dir|"
      + "arbeite(?:t)?(?:\\s+(?:daran|dran))?(?:\\s+(?:für|fuer))?(?:\\s+die\\s+(?:nächsten|naechsten))?|"
      + "zeitbudget(?:\\s+ist|\\s+von)?\\s*:?",
    clause: "(?:für|fuer)(?:\\s+die\\s+(?:nächsten|naechsten))?|innerhalb(?:\\s+von)?(?:\\s+der\\s+(?:nächsten|naechsten))?|"
      + "in\\s+den\\s+(?:nächsten|naechsten)|budget(?:\\s+ist)?\\s*:?|zeitlimit(?:\\s+ist|\\s+von)?\\s*:?",
  },
  {
    lang: "de",
    kind: "deadline",
    anywhere: "(?:arbeite(?:t)?|mach(?:e|t)?\\s+weiter|du\\s+hast(?:\\s+zeit)?|ihr\\s+habt(?:\\s+zeit)?|sie\\s+haben(?:\\s+zeit)?)(?:\\s+(?:daran|dran))?\\s+bis|"
      + "(?:fertig|erledigt)\\s+bis",
    clause: "bis|frist(?:\\s+ist)?\\s*:?|deadline(?:\\s+ist)?\\s*:?",
  },
];

const CUES: Cue[] = CUE_SOURCES.flatMap((c) => [
  { lang: c.lang, kind: c.kind, clause: false, re: new RegExp(`${LEFT}(${c.anywhere})[\\s:]+`, "giu") },
  { lang: c.lang, kind: c.kind, clause: true, re: new RegExp(`${CLAUSE}(${c.clause})[\\s:]+`, "giu") },
]);
/** A length standing as a sentence of its own: "Build the scraper. 1 day." */
const BARE_SENTENCE_RE = new RegExp(`${SENTENCE}(?=\\d)`, "gu");
const SENTENCE_END_RE = /^\s*(?:$|[.!?](?:\s|$)|[\n\r])/u;

interface Found {
  index: number;
  end: number;
  lang: TextBudgetMatch["lang"];
  duration?: number;
  deadline?: DeadlineHit;
}

/** Which language a bare length is in, by its unit word — for the record only. */
function langOfPhrase(phrase: string): TextBudgetMatch["lang"] {
  if (/[Ѐ-ӿ]/u.test(phrase)) return "bg";
  if (/stunde|minuten|tage?n?\b|halbe|anderthalb|eineinhalb/iu.test(phrase)) return "de";
  return "en";
}

/**
 * The budget a task's words state, if they state one: "you have 30 minutes",
 * "for 2 hours", "work until tomorrow morning", "until Friday 18:00", "1 day" —
 * and the same in Bulgarian ("имаш 30 минути", "работи до утре сутринта", "до
 * петък 18:00") and German ("du hast 30 Minuten", "für 2 Stunden", "arbeite bis
 * morgen früh", "bis Freitag 18 Uhr").
 *
 * Deliberately narrow: a length or a time counts only behind a cue that says
 * it is the work's budget ("you have", "work until"), or opening a clause of
 * its own ("For 2 hours, …"). "Cache results for 2 hours" is a feature, and is
 * not read as a budget. The first statement in the text wins.
 *
 * Null when the words state none. A statement this box will not take (in the
 * past, more than 14 days away, under 5 minutes) is answered with the reason,
 * so the start UI can say what it understood and why it is not used.
 */
export function parseBudgetFromText(text: string, now: Now, tz: string): TextBudgetResult | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const source = text.normalize("NFC").replace(/[’ʼ]/gu, "'");
  const at = nowMs(now);
  const zone = safeTimeZone(tz);
  let best: Found | null = null;
  const consider = (f: Found) => {
    if (!best || f.index < best.index || (f.index === best.index && f.end > best.end)) best = f;
  };
  for (const cue of CUES) {
    cue.re.lastIndex = 0;
    for (let m = cue.re.exec(source); m; m = cue.re.exec(source)) {
      const start = m.index + m[1].length;
      const restAt = m.index + m[0].length;
      const rest = source.slice(restAt);
      if (cue.kind === "duration") {
        const d = durationAt(rest, true);
        if (d) consider({ index: start, end: restAt + d.len, lang: cue.lang, duration: d.ms });
      } else {
        const d = deadlineAt(rest, at, zone);
        if (d) consider({ index: start, end: restAt + d.len, lang: cue.lang, deadline: d });
      }
      // A zero-width step cannot happen (every cue consumes a space), but a
      // global regex that did not move would spin; be certain it moves.
      if (cue.re.lastIndex === m.index) cue.re.lastIndex++;
    }
  }
  BARE_SENTENCE_RE.lastIndex = 0;
  for (let m = BARE_SENTENCE_RE.exec(source); m; m = BARE_SENTENCE_RE.exec(source)) {
    const start = m.index + m[1].length;
    const rest = source.slice(start);
    const d = durationAt(rest, false);
    if (d && SENTENCE_END_RE.test(rest.slice(d.len))) {
      consider({ index: start, end: start + d.len, lang: langOfPhrase(rest.slice(0, d.len)), duration: d.ms });
    }
    if (BARE_SENTENCE_RE.lastIndex === m.index) BARE_SENTENCE_RE.lastIndex++;
  }
  const found = best as Found | null;
  if (!found) return null;
  const match: TextBudgetMatch = { phrase: source.slice(found.index, found.end).trim(), index: found.index, lang: found.lang };
  if (found.duration !== undefined) {
    const r = durationBudget(found.duration, at, "text");
    return r.ok && r.budget ? { ok: true, budget: r.budget, match } : { ok: false, error: r.ok ? "No budget." : r.error, match };
  }
  const hit = found.deadline as DeadlineHit;
  const problem = deadlineProblem(hit.deadline, at, at);
  if (problem) return { ok: false, error: problem, match };
  const budget: TimeBudget = hit.morning
    ? { ...presetBudget("morning", at, zone, "text") }
    : { deadline: iso(hit.deadline), label: `Until ${formatLocalDeadline(hit.deadline, zone)}`, preset: "custom", source: "text", setAt: iso(at) };
  return { ok: true, budget, match };
}

// ─── Deciding ────────────────────────────────────────────────────────────────

/**
 * The budget a start works to: the explicit `budget` field (the picker, or a
 * caller's token) beats the task's words, which beat the owner's default.
 * `explicit` absent or null means "not chosen"; `"none"` means "no budget",
 * and beats the words and the default too. An explicit value that is not a
 * budget is refused (`ok: false`) — the routes answer 400 with the sentence.
 * Words that name a budget this box will not take are ignored (and reported
 * in `text`), never a refusal: the task is not a form.
 *
 * `defaultTokenCap` is the owner's existing token cap: whichever rule decided,
 * a budget over LONG_BUDGET_MS that names no spend ceiling takes it as one.
 */
export function resolveBudget(
  input: { explicit?: unknown; text?: string | null; defaultPreset?: unknown; defaultTokenCap?: number | null },
  now: Now,
  tz: string,
): BudgetResolution {
  const zone = safeTimeZone(tz);
  const cap = (b: TimeBudget): TimeBudget => withDefaultTokenCap(b, input.defaultTokenCap);
  if (input.explicit !== undefined && input.explicit !== null) {
    const r = readBudgetInput(input.explicit, now, zone);
    if (!r.ok) return r;
    return { ok: true, budget: r.budget ? cap(r.budget) : null, from: r.budget ? "picker" : "none", text: null };
  }
  const text = typeof input.text === "string" ? parseBudgetFromText(input.text, now, zone) : null;
  if (text?.ok) return { ok: true, budget: cap(text.budget), from: "text", text };
  if (isBudgetChip(input.defaultPreset)) {
    return { ok: true, budget: cap(presetBudget(input.defaultPreset, now, zone, "default")), from: "default", text };
  }
  return { ok: true, budget: null, from: "none", text };
}

/** When the budget's working time began: the later of when it was set and the picked period's start. */
function workStartMs(budget: TimeBudget): number {
  const set = Date.parse(budget.setAt);
  const start = budget.start ? Date.parse(budget.start) : NaN;
  return Number.isFinite(start) && start > set ? start : set;
}

/** The whole budget, from its start to its deadline. */
export function budgetDurationMs(budget: TimeBudget): number {
  return Math.max(0, Date.parse(budget.deadline) - workStartMs(budget));
}

/** A budget longer than 30 minutes is a coding team's, not one run's. */
export function needsTeam(budget: TimeBudget | null | undefined): boolean {
  return !!budget && budgetDurationMs(budget) > TEAM_BUDGET_THRESHOLD_MS;
}

/** Time left before the deadline, never negative. */
export function remainingMs(budget: TimeBudget, now: Now): number {
  return Math.max(0, Date.parse(budget.deadline) - nowMs(now));
}

/** Time used since the budget's work began, never negative. */
export function elapsedMs(budget: TimeBudget, now: Now): number {
  return Math.max(0, nowMs(now) - workStartMs(budget));
}

/** Is the deadline here? */
export function isBudgetSpent(budget: TimeBudget, now: Now): boolean {
  return remainingMs(budget, now) === 0;
}

/**
 * Has the budget run out — and which half? "time" once the deadline is here,
 * "cost" once `tokensUsed` (the spend so far, a team's runs summed) reaches
 * the budget's own `tokenCap`; null while both hold. When a check finds both
 * gone at once, the deadline is named: it is the budget the owner set first.
 */
export function budgetStopReason(budget: TimeBudget, now: Now, tokensUsed: number): "time" | "cost" | null {
  if (isBudgetSpent(budget, now)) return "time";
  if (typeof budget.tokenCap === "number" && Number.isFinite(tokensUsed) && tokensUsed >= budget.tokenCap) return "cost";
  return null;
}

/**
 * The safety margin before the deadline: the larger of 10 minutes and 10% of
 * the whole budget — the time kept back to commit, open or update the pull
 * request and let CI start, so the work never stops mid-write.
 */
export function safetyMarginMs(budget: TimeBudget): number {
  return Math.max(SAFETY_MARGIN_MIN_MS, Math.round(budgetDurationMs(budget) * SAFETY_MARGIN_FRACTION));
}

/** When no NEW item may start: the deadline minus the safety margin (ms since the epoch). */
export function marginCutoffMs(budget: TimeBudget): number {
  return Date.parse(budget.deadline) - safetyMarginMs(budget);
}

/**
 * May an item start now? Only before the cutoff, and only if its own estimate
 * says it finishes by then — an item that cannot is never started. With no
 * estimate, only the cutoff decides. (The margin governs starting a FURTHER
 * item; whether a run's first step starts is the caller's to decide — for a
 * budget shorter than the margin the cutoff is already behind it.)
 */
export function fitsBeforeCutoff(budget: TimeBudget, now: Now, estimateMs?: number | null): boolean {
  const at = nowMs(now);
  const cutoff = marginCutoffMs(budget);
  if (at >= cutoff) return false;
  return typeof estimateMs === "number" && Number.isFinite(estimateMs) && estimateMs > 0 ? at + estimateMs <= cutoff : true;
}

/** One English line for a log or a prompt: "1 hour, until Thu 15 Oct, 19:00 (Europe/Sofia) — 42 minutes left". */
export function describeBudget(budget: TimeBudget, now: Now, tz: string): string {
  const zone = safeTimeZone(tz);
  const left = remainingMs(budget, now);
  const until = formatLocalDeadline(budget.deadline, zone);
  const head = budget.preset === "custom" && budget.label.startsWith("Until ")
    ? budget.label
    : budget.preset === "morning" ? `${budget.label} (${until})` : `${budget.label}, until ${until}`;
  const cap = typeof budget.tokenCap === "number" ? `; at most ${budget.tokenCap} tokens` : "";
  return `${head} (${zone})${cap} — ${left > 0 ? `${formatDuration(left)} left` : "the deadline has passed"}`;
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function readIso(v: unknown): string | null {
  if (typeof v !== "string" || !ISO_UTC_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? iso(ms) : null;
}

/**
 * A stored budget read back — off a run record, a team board, a queued
 * start — or null. Strict, like every reader of a file a restore or a hand
 * edit can touch: what is not a budget this box wrote is no budget, and the
 * run behaves as one without.
 */
export function readTimeBudget(raw: unknown): TimeBudget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const deadline = readIso(b.deadline);
  const setAt = readIso(b.setAt);
  if (!deadline || !setAt) return null;
  if (!isBudgetPreset(b.preset)) return null;
  if (typeof b.source !== "string" || !(BUDGET_SOURCES as readonly string[]).includes(b.source)) return null;
  if (typeof b.label !== "string" || !b.label.trim()) return null;
  const start = b.start === undefined || b.start === null ? null : readIso(b.start);
  if (b.start !== undefined && b.start !== null && !start) return null;
  const tokenCap = b.tokenCap === undefined || b.tokenCap === null ? null : readTokenCap(b.tokenCap);
  if (b.tokenCap !== undefined && b.tokenCap !== null && tokenCap === null) return null;
  return {
    deadline,
    label: cleanLabel(b.label),
    preset: b.preset,
    source: b.source as BudgetSource,
    setAt,
    ...(start ? { start } : {}),
    ...(tokenCap !== null ? { tokenCap } : {}),
  };
}

// ─── Time records ────────────────────────────────────────────────────────────

/** The two files every run or team with a budget keeps in its artifacts folder. */
export const TIME_RECORD_JSON = "time-record.json";
export const TIME_RECORD_LOG = "time-record.log";

/**
 * What a time record line is about:
 *  - `budget`   the budget was set (or changed) — `text` says from where
 *  - `plan`     the planner's overall estimate (`estimateMs`) and scope
 *  - `estimate` one task's estimate (`taskId`, `estimateMs`)
 *  - `start` / `finish`  one task or run began / ended (`actualMs` on finish)
 *  - `skip`     something left out to fit the time, and why
 *  - `extra`    an extra item done with time to spare (checks, tests, polish)
 *  - `stop`     the work stopped (`reason`)
 *  - `note`     anything else worth keeping
 */
export const TIME_RECORD_KINDS = ["budget", "plan", "estimate", "start", "finish", "skip", "extra", "stop", "note"] as const;
export type TimeRecordKind = (typeof TIME_RECORD_KINDS)[number];

/**
 * Why the work stopped:
 *  - `done`          the work was done and no extra phase ran
 *  - `time`          the deadline (or its safety margin) came
 *  - `cost`          the budget's own spend ceiling (`tokenCap`) came first
 *  - `token_cap`     the owner's per-run token cap stopped a run first
 *  - `quota`         the provider's usage limit stopped it
 *  - `nothing_left`  the work was done early and the extra-work allowlist had
 *                    nothing valuable left — a valid outcome, not a failure
 *  - `stopped`       the owner stopped it
 *  - `failed`        it failed
 */
export const TIME_STOP_REASONS = ["done", "time", "cost", "token_cap", "quota", "nothing_left", "stopped", "failed"] as const;
export type TimeStopReason = (typeof TIME_STOP_REASONS)[number];

export interface TimeRecord {
  /** When (ISO, UTC). */
  at: string;
  kind: TimeRecordKind;
  /** One line, in English. */
  text: string;
  taskId?: string;
  runId?: string;
  /** `plan` / `estimate`: the estimate, ms. */
  estimateMs?: number;
  /** `finish`: the time it actually took, ms. */
  actualMs?: number;
  /** `stop`: why. */
  reason?: TimeStopReason;
  /** The spend so far when the line was written, in tokens — what the timeline shows next to the time. */
  tokensUsed?: number;
}

/** The JSON artifact (TIME_RECORD_JSON): the budget, what was estimated, what it took, and every record line. */
export interface TimeRecordSummary {
  budget: TimeBudget;
  /** The planner's overall estimate, or the sum of the task estimates, ms; null when none was given. */
  estimateMs: number | null;
  /** Per task, in the order first named: its estimate and what it took. */
  tasks: { taskId: string; estimateMs: number | null; actualMs: number | null }[];
  /** The first record's time, or null with none. */
  startedAt: string | null;
  /** The `stop` record's time, or null while it works. */
  finishedAt: string | null;
  /** Time used from the budget's start to the stop (or to now, while it works), ms. */
  usedMs: number;
  /** Time left at the stop (negative when it overran), or null while it works. */
  leftMs: number | null;
  stopReason: TimeStopReason | null;
  /** The budget's spend ceiling in tokens, or null for none. */
  tokenCap: number | null;
  /** The latest spend any record carried, in tokens, or null when none did. */
  tokensUsed: number | null;
  /** The extra items done with time to spare, in order. */
  extras: string[];
  /** What was left out to fit the time, in order. */
  skipped: string[];
  records: TimeRecord[];
}

const MAX_RECORD_TEXT_CHARS = 500;

/** A record line, built with its time stamped and its text kept to one bounded line. */
export function timeRecord(kind: TimeRecordKind, text: string, now: Now, extra: Omit<TimeRecord, "at" | "kind" | "text"> = {}): TimeRecord {
  return { at: iso(nowMs(now)), kind, text: cleanRecordText(text), ...extra };
}

function cleanRecordText(text: string): string {
  return String(text ?? "").replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_RECORD_TEXT_CHARS);
}

const nonNegative = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

/** A record line read back, or null — the same strictness as `readTimeBudget`. */
export function readTimeRecord(raw: unknown): TimeRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const at = readIso(r.at);
  if (!at || typeof r.kind !== "string" || !(TIME_RECORD_KINDS as readonly string[]).includes(r.kind)) return null;
  if (typeof r.text !== "string") return null;
  const out: TimeRecord = { at, kind: r.kind as TimeRecordKind, text: cleanRecordText(r.text) };
  if (typeof r.taskId === "string" && r.taskId) out.taskId = r.taskId.slice(0, 40);
  if (typeof r.runId === "string" && r.runId) out.runId = r.runId.slice(0, 40);
  const estimate = nonNegative(r.estimateMs);
  if (estimate !== undefined) out.estimateMs = estimate;
  const actual = nonNegative(r.actualMs);
  if (actual !== undefined) out.actualMs = actual;
  if (typeof r.reason === "string" && (TIME_STOP_REASONS as readonly string[]).includes(r.reason)) out.reason = r.reason as TimeStopReason;
  const tokens = nonNegative(r.tokensUsed);
  if (tokens !== undefined) out.tokensUsed = tokens;
  return out;
}

/** The JSON artifact, worked out from the budget and its record lines (in any order; they are sorted by time). */
export function summarizeTimeRecords(budget: TimeBudget, records: readonly TimeRecord[], now: Now): TimeRecordSummary {
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const tasks = new Map<string, { taskId: string; estimateMs: number | null; actualMs: number | null }>();
  const task = (id: string) => {
    let t = tasks.get(id);
    if (!t) {
      t = { taskId: id, estimateMs: null, actualMs: null };
      tasks.set(id, t);
    }
    return t;
  };
  let planEstimate: number | null = null;
  let stop: TimeRecord | null = null;
  let tokensUsed: number | null = null;
  const extras: string[] = [];
  const skipped: string[] = [];
  for (const r of sorted) {
    if (typeof r.tokensUsed === "number") tokensUsed = r.tokensUsed;
    if (r.kind === "plan" && typeof r.estimateMs === "number") planEstimate = r.estimateMs;
    if (r.kind === "estimate" && r.taskId && typeof r.estimateMs === "number") task(r.taskId).estimateMs = r.estimateMs;
    if (r.kind === "finish" && r.taskId) {
      const t = task(r.taskId);
      if (typeof r.actualMs === "number") t.actualMs = r.actualMs;
    }
    if ((r.kind === "start" || r.kind === "skip") && r.taskId) task(r.taskId);
    if (r.kind === "extra") extras.push(r.text);
    if (r.kind === "skip") skipped.push(r.text);
    if (r.kind === "stop" && !stop) stop = r;
  }
  const list = [...tasks.values()];
  const estimates = list.map((t) => t.estimateMs).filter((v): v is number => typeof v === "number");
  const estimateMs = planEstimate ?? (estimates.length ? estimates.reduce((a, b) => a + b, 0) : null);
  const stopRecord = stop as TimeRecord | null;
  const end = stopRecord ? Date.parse(stopRecord.at) : nowMs(now);
  const deadline = Date.parse(budget.deadline);
  return {
    budget,
    estimateMs,
    tasks: list,
    startedAt: sorted[0]?.at ?? null,
    finishedAt: stopRecord?.at ?? null,
    usedMs: Math.max(0, end - workStartMs(budget)),
    leftMs: stopRecord ? deadline - end : null,
    stopReason: stopRecord?.reason ?? null,
    tokenCap: typeof budget.tokenCap === "number" ? budget.tokenCap : null,
    tokensUsed,
    extras,
    skipped,
    records: sorted,
  };
}

/**
 * One line of the text log (TIME_RECORD_LOG), on the box's wall clock:
 * "2026-10-14 18:03 [estimate] t2 — ~40 minutes — build and test the scraper".
 */
export function formatTimeRecordLine(record: TimeRecord, tz: string): string {
  const zone = safeTimeZone(tz);
  const ms = Date.parse(record.at);
  const p = localParts(Number.isFinite(ms) ? ms : 0, zone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  const bits: string[] = [];
  if (record.taskId) bits.push(record.taskId);
  if (record.runId) bits.push(record.runId);
  if (typeof record.estimateMs === "number") bits.push(`~${formatDuration(record.estimateMs)}`);
  if (typeof record.actualMs === "number") bits.push(`took ${formatDuration(record.actualMs)}`);
  if (record.reason) bits.push(`reason: ${record.reason}`);
  if (typeof record.tokensUsed === "number") bits.push(`${record.tokensUsed} tokens so far`);
  if (record.text) bits.push(record.text);
  return `${stamp} [${record.kind}]${bits.length ? ` ${bits.join(" — ")}` : ""}`;
}
