"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useT } from "@/lib/i18n";
import {
  BUDGET_PRESET_CHIPS,
  DAY_MS,
  END_OF_DAY_HOUR,
  HOUR_MS,
  MAX_BUDGET_MS,
  MIN_BUDGET_MS,
  MIN_BUDGET_TOKEN_CAP,
  MINUTE_MS,
  customBudget,
  formatLocalDeadline,
  isBudgetChip,
  needsTeam,
  parseIsoInstant,
  presetBudget,
  safeTimeZone,
  type BudgetChip,
  type TimeBudget,
} from "@/lib/coding-time-budget";

/**
 * The time-budget picker of the Create App card: how long the run or team the
 * card asks for may work.
 *
 * It starts nothing itself. It turns the owner's pick into the TOKEN the run
 * and team routes read (parseBudgetToken: "1h", "morning", "none", an end
 * time, a "start/end" period) and an optional spend ceiling; the card puts
 * both in the message it hands the chat (budgetPromptLine in ui-events), and
 * the assistant passes them to coding_agent_run / coding_team_run.
 *
 * Every time it shows is the BOX's: the deadline preview is worked out with
 * the same functions the routes store a budget with (presetBudget,
 * customBudget), in the zone GET /setup-api/coding-agent/status answers —
 * never the browser's — and a calendar end is sent as a wall-clock time with
 * no offset, which the routes read on the box's clock. So the preview and the
 * stored deadline cannot disagree.
 *
 * Nothing picked means no budget line at all: the start then resolves one
 * exactly as before the picker existed (the task's words, the owner's default).
 */

/** What the owner picked: a chip, an explicit "no limit", or a period from the calendar. */
export type BudgetPick =
  | { kind: "chip"; chip: BudgetChip }
  | { kind: "none" }
  /** `end` and `start` are box wall-clock times, "YYYY-MM-DDTHH:MM", with no offset. */
  | { kind: "custom"; end: string; start: string | null };

export interface BudgetPickerValue {
  /** Null: nothing picked — the start decides as it always did. */
  pick: BudgetPick | null;
  /** The spend ceiling as typed; "" for none. */
  tokenCap: string;
}

export const EMPTY_BUDGET_PICK: BudgetPickerValue = { pick: null, tokenCap: "" };

/** Why a calendar period is not a budget the box takes — the routes' own rules (customBudget). */
export type BudgetPickProblem = "past" | "tooFar" | "tooShort" | "startAfterEnd" | "unreadable";

/** What the host needs: the token and ceiling to send, or why the pick cannot be sent yet. */
export interface BudgetPickerOutcome {
  /** The `budget` token, or null when nothing was picked. */
  token: string | null;
  tokenCap: number | null;
  error: BudgetPickProblem | "tokenCap" | null;
}

export const NO_BUDGET_OUTCOME: BudgetPickerOutcome = { token: null, tokenCap: null, error: null };

/** The largest ceiling the picker takes — the MCP tools' own bound. */
const MAX_TOKEN_CAP = 1_000_000_000;
/** How often the preview's "in 1 hour" and the period checks are refreshed. */
const TICK_MS = 30_000;
/** Below this, a difference between the browser's clock and the box's is rounding, not skew. */
const SKEW_THRESHOLD_MS = 90_000;

/** The token the routes read for a pick. */
export function budgetPickToken(pick: BudgetPick): string {
  if (pick.kind === "chip") return pick.chip;
  if (pick.kind === "none") return "none";
  return pick.start ? `${pick.start}/${pick.end}` : pick.end;
}

/**
 * Why a calendar period would be refused, or null when the box takes it —
 * the checks customBudget makes, in the same order, so the picker never
 * offers what the route answers 400 for.
 */
export function customPickProblem(end: string, start: string | null, now: number, tz: string): BudgetPickProblem | null {
  const zone = safeTimeZone(tz);
  const endMs = parseIsoInstant(end, zone);
  if (endMs === null) return "unreadable";
  let startMs: number | null = null;
  if (start) {
    startMs = parseIsoInstant(start, zone);
    if (startMs === null) return "unreadable";
    if (startMs >= endMs) return "startAfterEnd";
  }
  if (endMs <= now) return "past";
  if (endMs - now > MAX_BUDGET_MS) return "tooFar";
  if (endMs - Math.max(now, startMs ?? now) < MIN_BUDGET_MS) return "tooShort";
  return null;
}

/** A typed ceiling: null for none, the number, or "invalid" (not whole, under the floor, absurd). */
export function readTokenCapInput(raw: string): number | null | "invalid" {
  // Digit grouping as people type it: "500 000", "500,000", "500.000", "500'000".
  const digits = raw.replace(/[\s,._'’]/g, "");
  if (!digits) return null;
  if (!/^\d{1,10}$/.test(digits)) return "invalid";
  const n = Number(digits);
  return n >= MIN_BUDGET_TOKEN_CAP && n <= MAX_TOKEN_CAP ? n : "invalid";
}

/** The host's view of a pick at `now`, in the box's zone. */
export function budgetPickerOutcome(value: BudgetPickerValue, now: number, tz: string): BudgetPickerOutcome {
  const pick = value.pick;
  if (!pick) return NO_BUDGET_OUTCOME;
  if (pick.kind === "none") return { token: "none", tokenCap: null, error: null };
  const problem = pick.kind === "custom" ? customPickProblem(pick.end, pick.start, now, tz) : null;
  const cap = readTokenCapInput(value.tokenCap);
  return {
    token: budgetPickToken(pick),
    tokenCap: cap === "invalid" ? null : cap,
    error: problem ?? (cap === "invalid" ? "tokenCap" : null),
  };
}

/** The budget a pick comes to at `now` — what the route would store — or null (none, or a period it refuses). */
export function previewPickBudget(pick: BudgetPick | null, now: number, tz: string): TimeBudget | null {
  if (!pick || pick.kind === "none") return null;
  if (pick.kind === "chip") return presetBudget(pick.chip, now, tz);
  const r = customBudget(pick.end, now, pick.start, { tz });
  return r.ok ? r.budget : null;
}

// ─── The box's wall clock ────────────────────────────────────────────────────

interface Ymd {
  year: number;
  month: number;
  day: number;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** The date and time on the box's wall clock at `ms`. */
function boxWall(ms: number, tz: string): Ymd & { hour: number; minute: number } {
  let f = wallFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    wallFormatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(ms)) p[part.type] = part.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

/** A calendar date `n` days on — dates only, no zone. */
function addDays(d: Ymd, n: number): Ymd {
  const x = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
}

const ymdNum = (d: Ymd): number => d.year * 10_000 + d.month * 100 + d.day;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const localIso = (d: Ymd, time: string): string => `${d.year}-${pad2(d.month)}-${pad2(d.day)}T${time}`;
/** Monday-first: 0 = Monday … 6 = Sunday. */
const weekdayIndex = (d: Ymd): number => (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;

function splitLocalIso(s: string): { date: Ymd; time: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(s);
  return m ? { date: { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, time: m[4] } : null;
}

/** Where the calendar opens: today at 18:00 on the box, or tomorrow when that is less than an hour away. */
function defaultEnd(now: number, tz: string): { date: Ymd; time: string } {
  const wall = boxWall(now, tz);
  const today = { year: wall.year, month: wall.month, day: wall.day };
  const time = `${pad2(END_OF_DAY_HOUR)}:00`;
  const at = parseIsoInstant(localIso(today, time), tz);
  return { date: at !== null && at - now >= HOUR_MS ? today : addDays(today, 1), time };
}

/** A start's first suggestion: the next quarter hour on the box's clock. */
function defaultStart(now: number, tz: string): string {
  const quarter = 15 * MINUTE_MS;
  const wall = boxWall(Math.ceil(now / quarter) * quarter, tz);
  return localIso(wall, `${pad2(wall.hour)}:${pad2(wall.minute)}`);
}

// ─── Words, in the UI's language and the box's zone ─────────────────────────

/** "Thu 15 Oct, 18:00" on the box's clock — the stored label's own words in English, the locale's elsewhere. */
function formatDeadline(ms: number, tz: string, locale: string): string {
  if (locale === "en") return formatLocalDeadline(ms, tz);
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(ms);
  } catch {
    return formatLocalDeadline(ms, tz);
  }
}

/** "in 45 minutes", "in 6 hours", "in 3 days" — rounded to the unit that reads naturally. */
function formatRelative(ms: number, locale: string): string {
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
    const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
    if (minutes < 90) return rtf.format(minutes, "minute");
    const hours = Math.round(ms / HOUR_MS);
    if (hours < 36) return rtf.format(hours, "hour");
    return rtf.format(Math.round(ms / DAY_MS), "day");
  } catch {
    return "";
  }
}

/** A date with no time and no zone, in the UI's language. */
function formatDate(d: Ymd, locale: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(Date.UTC(d.year, d.month - 1, d.day));
  } catch {
    return new Intl.DateTimeFormat("en", { ...opts, timeZone: "UTC" }).format(Date.UTC(d.year, d.month - 1, d.day));
  }
}

// ─── The component ───────────────────────────────────────────────────────────

const CHIP_LABEL: Record<BudgetChip, string> = {
  "30m": "codingAgent.budgetPickerChip30m",
  "1h": "codingAgent.budgetPickerChip1h",
  morning: "codingAgent.budgetPickerChipMorning",
  "1d": "codingAgent.budgetPickerChip1d",
};

const PROBLEM_KEY: Record<BudgetPickProblem | "tokenCap", string> = {
  past: "codingAgent.budgetPickerErrorPast",
  tooFar: "codingAgent.budgetPickerErrorTooFar",
  tooShort: "codingAgent.budgetPickerErrorTooShort",
  startAfterEnd: "codingAgent.budgetPickerErrorStartAfterEnd",
  unreadable: "codingAgent.budgetPickerErrorUnreadable",
  tokenCap: "codingAgent.budgetPickerErrorTokenCap",
};

/** The radio group's options, in order: the four chips, no limit, and the calendar. */
type BudgetOption = BudgetChip | "none" | "pick";
const OPTIONS: readonly BudgetOption[] = [...BUDGET_PRESET_CHIPS, "none", "pick"];

/**
 * 44 px on a phone and under any coarse pointer; a desktop mouse gets the
 * card's denser 36 px.
 */
const TOUCH = "min-h-11 sm:pointer-fine:min-h-9";

const CHIP =
  `${TOUCH} inline-flex items-center rounded-full border px-3.5 text-sm transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)]/50`;
const CHIP_ON = "border-[var(--coral-bright)]/70 bg-[var(--coral-bright)]/15 text-[var(--text-primary)] font-medium";
const CHIP_OFF = "border-white/[0.10] bg-black/25 text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)]";

const FIELD =
  `${TOUCH} w-full rounded-lg bg-black/25 border border-white/[0.10] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 outline-none transition-colors [color-scheme:dark] focus:border-[var(--coral-bright)]/60 focus:ring-1 focus:ring-[var(--coral-bright)]/25`;

const LABEL = "block text-xs font-medium text-[var(--text-secondary)]";

const ICON_BUTTON =
  "inline-flex h-11 w-11 sm:pointer-fine:h-9 sm:pointer-fine:w-9 items-center justify-center rounded-lg text-lg text-[var(--text-secondary)] hover:bg-white/[0.06] disabled:opacity-30 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)]/50";

interface Draft {
  date: Ymd;
  time: string;
  startOn: boolean;
  start: string;
}

export interface CodingBudgetPickerProps {
  /** Called with the pick's outcome whenever it changes — and when a picked period goes stale. */
  onChange: (outcome: BudgetPickerOutcome) => void;
  /** The card asks for a coding team anyway: no "over 30 minutes starts a team" hint. */
  team?: boolean;
  /**
   * The box's IANA zone when the HOST reads the coding status — null while
   * its read is out (UTC meanwhile). Absent: the picker reads the status
   * route itself. A host that already reads it passes it on, so opening the
   * card costs no second read (ChatPopup's "+" gate counts them).
   */
  timeZone?: string | null;
  /** The owner's default budget off the host's read (a chip id), or null for none. Only read with `timeZone`. */
  defaultBudget?: string | null;
  initialValue?: BudgetPickerValue;
  className?: string;
}

export default function CodingBudgetPicker({
  onChange,
  team = false,
  timeZone,
  defaultBudget,
  initialValue = EMPTY_BUDGET_PICK,
  className = "",
}: CodingBudgetPickerProps) {
  const { t, locale } = useT();
  const uid = useId();
  const labelId = `${uid}-label`;
  const dialogId = `${uid}-dialog`;
  const titleId = `${uid}-title`;
  const capId = `${uid}-cap`;
  const capHintId = `${uid}-cap-hint`;
  const timeId = `${uid}-time`;
  const startId = `${uid}-start`;

  const [value, setValue] = useState<BudgetPickerValue>(initialValue);
  // The box's zone and its default budget: the host's, or the status route's.
  // UTC until one answers (and when none can): a deadline is still a deadline.
  const hosted = timeZone !== undefined;
  const [fetchedZone, setFetchedZone] = useState<string | null>(null);
  const zone = safeTimeZone((hosted ? timeZone : fetchedZone) ?? "UTC");
  const [fetchedDefault, setFetchedDefault] = useState<BudgetChip | null>(null);
  const defaultChip = hosted ? (isBudgetChip(defaultBudget) ? defaultBudget : null) : fetchedDefault;
  // The box's clock, not the browser's: the status answer's Date header says
  // how far apart they are, and a phone a few minutes off would otherwise
  // call a valid end "past". (The routes check the deadline again on the box.)
  const [skew, setSkew] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const now = clock + skew;

  useEffect(() => {
    if (hosted) return;
    let active = true;
    fetch("/setup-api/coding-agent/status", { cache: "no-store" })
      .then(async (res) => {
        const serverNow = Date.parse(res.headers.get("date") ?? "");
        const data: unknown = res.ok ? await res.json() : null;
        if (!active) return;
        if (Number.isFinite(serverNow) && Math.abs(serverNow - Date.now()) > SKEW_THRESHOLD_MS) setSkew(serverNow - Date.now());
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const s = data as { timeZone?: unknown; defaultTimeBudget?: unknown };
          if (typeof s.timeZone === "string") setFetchedZone(s.timeZone);
          if (isBudgetChip(s.defaultTimeBudget)) setFetchedDefault(s.defaultTimeBudget);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [hosted]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Tell the host — only when what it would send changes.
  const outcome = useMemo(() => budgetPickerOutcome(value, now, zone), [value, now, zone]);
  const sent = useRef(JSON.stringify(NO_BUDGET_OUTCOME));
  useEffect(() => {
    const key = JSON.stringify(outcome);
    if (key === sent.current) return;
    sent.current = key;
    onChange(outcome);
  }, [outcome, onChange]);

  // ── The calendar popover ──
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ year: number; month: number }>({ year: 1970, month: 1 });
  const [draft, setDraft] = useState<Draft>({ date: { year: 1970, month: 1, day: 1 }, time: "18:00", startOn: false, start: "" });
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const pickRef = useRef<HTMLButtonElement | null>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Set when the selected day should take focus at the next render: on open,
  // and when the arrow keys move it.
  const focusDay = useRef(false);

  const wallNow = boxWall(now, zone);
  const firstDay: Ymd = { year: wallNow.year, month: wallNow.month, day: wallNow.day };
  const lastWall = boxWall(now + MAX_BUDGET_MS, zone);
  const lastDay: Ymd = { year: lastWall.year, month: lastWall.month, day: lastWall.day };

  const openPopover = () => {
    const current = value.pick?.kind === "custom" ? value.pick : null;
    const end = (current && splitLocalIso(current.end)) || defaultEnd(now, zone);
    setDraft({
      date: end.date,
      time: end.time,
      startOn: !!current?.start,
      start: current?.start ?? defaultStart(now, zone),
    });
    setView({ year: end.date.year, month: end.date.month });
    focusDay.current = true;
    setOpen(true);
  };

  const closePopover = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) pickRef.current?.focus();
  };

  useEffect(() => {
    if (!open || !focusDay.current) return;
    focusDay.current = false;
    popoverRef.current?.querySelector<HTMLButtonElement>('[data-selected-day="true"]')?.focus();
  }, [open, draft.date, view]);

  // A click anywhere but the popover and its chip puts it away, unapplied.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || popoverRef.current?.contains(target) || pickRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const draftEnd = localIso(draft.date, draft.time);
  const draftStart = draft.startOn ? draft.start : null;
  const draftProblem: BudgetPickProblem | null = /^\d{2}:\d{2}$/.test(draft.time) && (!draft.startOn || draft.start)
    ? customPickProblem(draftEnd, draftStart, now, zone)
    : "unreadable";
  const draftEndMs = draftProblem ? null : parseIsoInstant(draftEnd, zone);

  const apply = () => {
    if (draftProblem) return;
    setValue((v) => ({ ...v, pick: { kind: "custom", end: draftEnd, start: draftStart } }));
    closePopover(true);
  };

  const moveDay = (delta: number) => {
    const next = addDays(draft.date, delta);
    const clamped = ymdNum(next) < ymdNum(firstDay) ? firstDay : ymdNum(next) > ymdNum(lastDay) ? lastDay : next;
    setDraft((d) => ({ ...d, date: clamped }));
    setView({ year: clamped.year, month: clamped.month });
    focusDay.current = true;
  };

  const onDayKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in delta) {
      e.preventDefault();
      moveDay(delta[e.key]);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveDay(-weekdayIndex(draft.date));
    } else if (e.key === "End") {
      e.preventDefault();
      moveDay(6 - weekdayIndex(draft.date));
    }
  };

  const onDialogKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Enter in a field applies the period — it must not submit the card's form.
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      apply();
    }
  };

  // Escape puts the popover away and stops there: the card closes on an
  // Escape that reaches the document, and the chat on one that reaches the
  // window — one key, one layer.
  const onRootKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    e.stopPropagation();
    closePopover(true);
  };

  // ── The chips ──
  const checked: BudgetOption | null = !value.pick
    ? null
    : value.pick.kind === "chip" ? value.pick.chip : value.pick.kind === "none" ? "none" : "pick";

  const choose = (option: BudgetOption) => {
    if (option === "pick") {
      if (open) closePopover(false);
      else openPopover();
      return;
    }
    setOpen(false);
    setValue((v) => ({ ...v, pick: option === "none" ? { kind: "none" } : { kind: "chip", chip: option } }));
  };

  // Arrow keys move along the group and check what they land on (the radio
  // pattern) — except the calendar chip, which they only focus: opening a
  // dialog is for Enter, Space or a click.
  const onChipKey = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next: number | null = null;
    if (e.key in step) next = (index + step[e.key] + OPTIONS.length) % OPTIONS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = OPTIONS.length - 1;
    if (next === null) return;
    e.preventDefault();
    chipRefs.current[next]?.focus();
    if (OPTIONS[next] !== "pick") choose(OPTIONS[next]);
  };

  const optionLabel = (option: BudgetOption): string => {
    if (option === "none") return t("codingAgent.budgetPickerNone");
    if (option === "pick") {
      if (value.pick?.kind !== "custom") return t("codingAgent.budgetPickerPick");
      const endMs = parseIsoInstant(value.pick.end, zone);
      return endMs === null ? t("codingAgent.budgetPickerPick") : t("codingAgent.budgetPickerUntil", { time: formatDeadline(endMs, zone, locale) });
    }
    return t(CHIP_LABEL[option]);
  };

  const clear = () => {
    setOpen(false);
    setValue(EMPTY_BUDGET_PICK);
    chipRefs.current[0]?.focus();
  };

  // ── What it comes to ──
  const preview = previewPickBudget(value.pick, now, zone);
  const previewEnd = preview ? Date.parse(preview.deadline) : null;
  const previewStart = preview?.start ? Date.parse(preview.start) : null;
  const pickProblem = outcome.error && outcome.error !== "tokenCap" ? outcome.error : null;
  const capProblem = outcome.error === "tokenCap";
  const showCap = value.pick?.kind === "chip" || value.pick?.kind === "custom";
  const problemText = (p: BudgetPickProblem | "tokenCap") =>
    t(PROBLEM_KEY[p], { days: MAX_BUDGET_MS / DAY_MS, minutes: MIN_BUDGET_MS / MINUTE_MS, min: MIN_BUDGET_TOKEN_CAP.toLocaleString(locale) });

  // ── The month grid ──
  const monthFirst: Ymd = { year: view.year, month: view.month, day: 1 };
  const daysInMonth = new Date(Date.UTC(view.year, view.month, 0)).getUTCDate();
  const lead = weekdayIndex(monthFirst);
  const canPrev = view.year * 12 + view.month > firstDay.year * 12 + firstDay.month;
  const canNext = view.year * 12 + view.month < lastDay.year * 12 + lastDay.month;
  const shiftView = (n: number) => {
    const m = view.year * 12 + (view.month - 1) + n;
    setView({ year: Math.floor(m / 12), month: (m % 12) + 1 });
  };
  const selectedInView = draft.date.year === view.year && draft.date.month === view.month;
  // 2024-01-01 was a Monday: the week's day names, Monday first, in the UI's language.
  const weekdays = Array.from({ length: 7 }, (_, i) => formatDate({ year: 2024, month: 1, day: 1 + i }, locale, { weekday: "short" }));
  const monthLabel = formatDate(monthFirst, locale, { month: "long", year: "numeric" });
  // The one day Tab lands on: the chosen one, else the first that can be chosen.
  const firstEnabled = (() => {
    for (let day = 1; day <= daysInMonth; day++) {
      const n = ymdNum({ year: view.year, month: view.month, day });
      if (n >= ymdNum(firstDay) && n <= ymdNum(lastDay)) return day;
    }
    return 1;
  })();
  const tabDay = selectedInView ? draft.date.day : firstEnabled;

  return (
    <div className={`space-y-2 ${className}`} data-testid="coding-budget-picker" onKeyDown={onRootKey}>
      <div className="flex items-center justify-between gap-2">
        <p id={labelId} className={LABEL}>{t("codingAgent.budgetPickerLabel")}</p>
        {value.pick && (
          <button
            type="button"
            onClick={clear}
            data-testid="coding-budget-clear"
            className={`${TOUCH} -my-2 px-2 text-[11px] text-[var(--text-muted)] underline-offset-2 hover:underline hover:text-[var(--text-secondary)] rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)]/50`}
          >
            {t("codingAgent.budgetPickerClear")}
          </button>
        )}
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2" data-testid="coding-budget-chips">
        {OPTIONS.map((option, index) => {
          const isChecked = checked === option;
          const tabbable = checked === null ? index === 0 : isChecked;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={isChecked}
              tabIndex={tabbable ? 0 : -1}
              ref={(el) => {
                chipRefs.current[index] = el;
                if (option === "pick") pickRef.current = el;
              }}
              onClick={() => choose(option)}
              onKeyDown={(e) => onChipKey(e, index)}
              data-testid={`coding-budget-chip-${option}`}
              {...(option === "pick" ? { "aria-haspopup": "dialog" as const, "aria-expanded": open, "aria-controls": open ? dialogId : undefined } : {})}
              className={`${CHIP} ${isChecked || (option === "pick" && open) ? CHIP_ON : CHIP_OFF}`}
            >
              {optionLabel(option)}
            </button>
          );
        })}
      </div>

      {open && (
        <div
          ref={popoverRef}
          id={dialogId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          onKeyDown={onDialogKey}
          data-testid="coding-budget-popover"
          // On a phone it reaches into the card's own padding: at 320 px the
          // card leaves 258 px, and the day grid wants every pixel of width
          // for its touch targets (about 40 × 44 px there, instead of 34).
          className="-mx-4 max-w-[24rem] p-1 sm:mx-0 sm:max-w-[22rem] sm:p-2 rounded-xl border border-white/[0.12] bg-[var(--bg-elevated)] shadow-xl shadow-black/40 space-y-2"
        >
          <p id={titleId} className="px-1 pt-1 text-xs font-semibold text-[var(--text-primary)]">{t("codingAgent.budgetPickerDialogTitle")}</p>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => shiftView(-1)}
              disabled={!canPrev}
              aria-label={t("codingAgent.budgetPickerPrevMonth")}
              data-testid="coding-budget-prev-month"
              className={ICON_BUTTON}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <p className="text-sm font-medium text-[var(--text-primary)] capitalize" aria-live="polite" data-testid="coding-budget-month">{monthLabel}</p>
            <button
              type="button"
              onClick={() => shiftView(1)}
              disabled={!canNext}
              aria-label={t("codingAgent.budgetPickerNextMonth")}
              data-testid="coding-budget-next-month"
              className={ICON_BUTTON}
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>
          <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]" aria-hidden="true">
            {weekdays.map((name, i) => <span key={i} className="py-1">{name}</span>)}
          </div>
          <div className="grid grid-cols-7" role="group" aria-label={monthLabel} data-testid="coding-budget-days">
            {Array.from({ length: lead }, (_, i) => <span key={`lead-${i}`} aria-hidden="true" />)}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const date: Ymd = { year: view.year, month: view.month, day: i + 1 };
              const n = ymdNum(date);
              const enabled = n >= ymdNum(firstDay) && n <= ymdNum(lastDay);
              const selected = selectedInView && draft.date.day === date.day;
              const today = n === ymdNum(firstDay);
              return (
                <button
                  key={date.day}
                  type="button"
                  disabled={!enabled}
                  tabIndex={date.day === tabDay ? 0 : -1}
                  aria-pressed={selected}
                  aria-current={today ? "date" : undefined}
                  aria-label={formatDate(date, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                  data-selected-day={selected ? "true" : undefined}
                  data-testid={`coding-budget-day-${localIso(date, "").slice(0, 10)}`}
                  onClick={() => { setDraft((d) => ({ ...d, date })); }}
                  onKeyDown={onDayKey}
                  className={`${TOUCH} w-full rounded-lg text-sm tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)]/60 ${
                    selected
                      ? "bg-[var(--coral-bright)] text-black font-semibold"
                      : enabled
                        ? `text-[var(--text-primary)] hover:bg-white/[0.08] cursor-pointer ${today ? "ring-1 ring-inset ring-white/25" : ""}`
                        : "text-[var(--text-muted)]/35 cursor-not-allowed"
                  }`}
                >
                  {date.day}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-1 gap-2 px-1">
            <label htmlFor={timeId} className={LABEL}>
              {t("codingAgent.budgetPickerTimeLabel")}
              <input
                id={timeId}
                type="time"
                step={60}
                required
                value={draft.time}
                onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))}
                data-testid="coding-budget-time"
                className={`${FIELD} mt-1.5`}
              />
            </label>
            <label className={`${TOUCH} flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none`}>
              <input
                type="checkbox"
                checked={draft.startOn}
                onChange={(e) => setDraft((d) => ({ ...d, startOn: e.target.checked }))}
                data-testid="coding-budget-start-toggle"
                className="h-4 w-4 accent-[var(--coral-bright)]"
              />
              {t("codingAgent.budgetPickerStartToggle")}
            </label>
            {draft.startOn && (
              <label htmlFor={startId} className={LABEL}>
                {t("codingAgent.budgetPickerStartLabel")}
                <input
                  id={startId}
                  type="datetime-local"
                  step={60}
                  value={draft.start}
                  min={localIso(firstDay, `${pad2(wallNow.hour)}:${pad2(wallNow.minute)}`)}
                  max={draftEnd}
                  onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
                  data-testid="coding-budget-start"
                  className={`${FIELD} mt-1.5`}
                />
              </label>
            )}
          </div>
          <p className="px-1 text-[11px] min-h-4" aria-live="polite" data-testid="coding-budget-draft-preview">
            {draftProblem
              ? <span className="text-amber-400">{problemText(draftProblem)}</span>
              : draftEndMs !== null && (
                <span className="text-[var(--text-secondary)]">
                  {t("codingAgent.budgetPickerEnds", { time: formatDeadline(draftEndMs, zone, locale), relative: formatRelative(draftEndMs - now, locale) })}
                </span>
              )}
          </p>
          <div className="flex items-center justify-end gap-2 px-1 pb-1">
            <button
              type="button"
              onClick={() => closePopover(true)}
              data-testid="coding-budget-cancel"
              className={`${TOUCH} px-3 rounded-lg border border-white/10 text-xs text-[var(--text-muted)] hover:bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)]/50`}
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={draftProblem !== null}
              data-testid="coding-budget-apply"
              className={`${TOUCH} px-3.5 rounded-lg bg-[var(--coral-bright)] text-xs font-medium text-black hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-white/60`}
            >
              {t("codingAgent.budgetPickerApply")}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1 text-[11px]" aria-live="polite" data-testid="coding-budget-preview">
        {!value.pick && (
          <p className="text-[var(--text-muted)]">
            {defaultChip
              ? t("codingAgent.budgetPickerNotSetDefault", { budget: t(CHIP_LABEL[defaultChip]) })
              : t("codingAgent.budgetPickerNotSet")}
          </p>
        )}
        {value.pick?.kind === "none" && <p className="text-[var(--text-muted)]">{t("codingAgent.budgetPickerNoLimitHint")}</p>}
        {pickProblem && <p className="text-amber-400" role="alert">{problemText(pickProblem)}</p>}
        {previewEnd !== null && (
          <>
            {previewStart !== null && previewStart > now && (
              <p className="text-[var(--text-secondary)]">{t("codingAgent.budgetPickerStarts", { time: formatDeadline(previewStart, zone, locale) })}</p>
            )}
            <p className="text-[var(--text-secondary)]" data-testid="coding-budget-deadline">
              {t("codingAgent.budgetPickerEnds", { time: formatDeadline(previewEnd, zone, locale), relative: formatRelative(previewEnd - now, locale) })}
            </p>
            <p className="text-[var(--text-muted)]" data-testid="coding-budget-zone">{t("codingAgent.budgetPickerZone", { zone })}</p>
            {!team && preview && needsTeam(preview) && (
              <p className="text-[var(--text-muted)]" data-testid="coding-budget-team-hint">{t("codingAgent.budgetPickerTeamHint")}</p>
            )}
          </>
        )}
      </div>

      {showCap && (
        <div>
          <label htmlFor={capId} className={LABEL}>{t("codingAgent.budgetPickerTokenCapLabel")}</label>
          <input
            id={capId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={value.tokenCap}
            onChange={(e) => setValue((v) => ({ ...v, tokenCap: e.target.value }))}
            placeholder={t("codingAgent.budgetPickerTokenCapPlaceholder")}
            aria-invalid={capProblem || undefined}
            aria-describedby={capHintId}
            data-testid="coding-budget-token-cap"
            className={`${FIELD} mt-1.5`}
          />
          <p id={capHintId} className={`mt-1 text-[11px] ${capProblem ? "text-amber-400" : "text-[var(--text-muted)]"}`}>
            {capProblem ? problemText("tokenCap") : t("codingAgent.budgetPickerTokenCapHint")}
          </p>
        </div>
      )}
    </div>
  );
}
