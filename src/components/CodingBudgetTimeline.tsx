"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  marginCutoffMs,
  readTimeBudget,
  readTimeRecord,
  safeTimeZone,
  TIME_STOP_REASONS,
  type TimeBudget,
  type TimeRecord,
  type TimeStopReason,
} from "@/lib/coding-time-budget";
import { formatDeadline } from "./CodingBudgetPicker";
import { CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";

/**
 * A budgeted run's or team's time, on its page: the budget bar (elapsed,
 * remaining, the deadline, the safety margin), the estimate markers, the spend
 * beside the time, and the checkpoints its time record holds — the record the
 * server keeps (src/lib/coding-time-record.ts) and the routes answer with as
 * `timeRecord` beside `timeBudget`.
 *
 * Read defensively: both come off the wire and a record written by an older
 * box may lack fields. Times are on the box's clock and shown in the box's
 * zone (the owner's, as the Coding Agent status answers it), like the picker
 * that set the budget. Nothing is drawn for a run or team without a budget.
 */

/** How often a live bar moves on. */
const TICK_MS = 15_000;
/** The most checkpoint rows drawn; the rest are in the time record file. */
const MAX_ROWS = 60;

const STOP_KEY: Record<TimeStopReason, string> = {
  done: "codingAgent.budgetTimelineStopDone",
  time: "codingAgent.budgetTimelineStopTime",
  cost: "codingAgent.budgetTimelineStopCost",
  token_cap: "codingAgent.budgetTimelineStopTokenCap",
  quota: "codingAgent.budgetTimelineStopQuota",
  nothing_left: "codingAgent.budgetTimelineStopNothingLeft",
  stopped: "codingAgent.budgetTimelineStopStopped",
  failed: "codingAgent.budgetTimelineStopFailed",
};

const STOP_TONE: Record<TimeStopReason, string> = {
  done: "text-emerald-300 border-emerald-400/40",
  nothing_left: "text-emerald-300 border-emerald-400/40",
  time: "text-amber-300 border-amber-400/40",
  cost: "text-amber-300 border-amber-400/40",
  token_cap: "text-amber-300 border-amber-400/40",
  quota: "text-sky-300 border-sky-400/40",
  stopped: "text-slate-300 border-slate-400/40",
  failed: "text-red-300 border-red-400/40",
};

/** The bar's fill once the work stopped, in the status chip's own colours: green done, amber the box's stop, and so on. */
const STOP_FILL: Record<TimeStopReason, string> = {
  done: "#86efac",
  nothing_left: "#86efac",
  time: "#fcd34d",
  cost: "#fcd34d",
  token_cap: "#fcd34d",
  quota: "#93c5fd",
  stopped: "#cbd5e1",
  failed: "#fca5a5",
};

/** The dot a record line leaves on the bar, by what it is. */
const MARK_TONE: Partial<Record<keyof typeof KIND_KEY, string>> = {
  checkpoint: "bg-sky-300",
  finish: "bg-sky-300",
  margin: "bg-amber-300",
  skip: "bg-amber-400",
  extra: "bg-emerald-400",
  stop: "bg-white",
};

const KIND_KEY: Record<TimeRecord["kind"] | "checkpoint" | "margin", string> = {
  budget: "codingAgent.budgetTimelineKindBudget",
  plan: "codingAgent.budgetTimelineKindPlan",
  estimate: "codingAgent.budgetTimelineKindEstimate",
  start: "codingAgent.budgetTimelineKindStart",
  finish: "codingAgent.budgetTimelineKindFinish",
  skip: "codingAgent.budgetTimelineKindSkip",
  extra: "codingAgent.budgetTimelineKindExtra",
  stop: "codingAgent.budgetTimelineKindStop",
  note: "codingAgent.budgetTimelineKindNote",
  checkpoint: "codingAgent.budgetTimelineKindCheckpoint",
  margin: "codingAgent.budgetTimelineKindMargin",
};

/** What a record line is, as the timeline names it: its kind, or one of the two notes the server writes on a schedule. */
function rowKind(r: TimeRecord): keyof typeof KIND_KEY {
  if (r.kind === "note" && r.text.startsWith("Checkpoint:")) return "checkpoint";
  if (r.kind === "note" && r.text.startsWith("Safety margin:")) return "margin";
  return r.kind;
}

/** The parts of a time record summary the timeline draws, read off the wire. */
export interface BudgetTimelineData {
  budget: TimeBudget;
  estimateMs: number | null;
  tasks: { taskId: string; estimateMs: number | null; actualMs: number | null }[];
  finishedAt: number | null;
  stopReason: TimeStopReason | null;
  tokensUsed: number | null;
  tokenCap: number | null;
  extras: string[];
  skipped: string[];
  records: TimeRecord[];
  omittedRecords: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** The budget and its record as the timeline reads them — null when there is no budget it can read. */
export function readBudgetTimeline(budget: unknown, record: unknown): BudgetTimelineData | null {
  const b = readTimeBudget(budget) ?? readTimeBudget((record as { budget?: unknown } | null)?.budget);
  if (!b) return null;
  const r = record && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>) : {};
  const finished = typeof r.finishedAt === "string" ? Date.parse(r.finishedAt) : NaN;
  const stop = typeof r.stopReason === "string" && (TIME_STOP_REASONS as readonly string[]).includes(r.stopReason) ? (r.stopReason as TimeStopReason) : null;
  const tasks = Array.isArray(r.tasks)
    ? r.tasks.flatMap((t) => {
      if (!t || typeof t !== "object") return [];
      const o = t as Record<string, unknown>;
      return typeof o.taskId === "string" ? [{ taskId: o.taskId, estimateMs: num(o.estimateMs), actualMs: num(o.actualMs) }] : [];
    })
    : [];
  return {
    budget: b,
    estimateMs: num(r.estimateMs),
    tasks,
    finishedAt: Number.isFinite(finished) ? finished : null,
    stopReason: stop,
    tokensUsed: num(r.tokensUsed),
    tokenCap: num(r.tokenCap) ?? (typeof b.tokenCap === "number" ? b.tokenCap : null),
    extras: strings(r.extras),
    skipped: strings(r.skipped),
    records: Array.isArray(r.records) ? r.records.map(readTimeRecord).filter((x): x is TimeRecord => x !== null) : [],
    omittedRecords: num(r.omittedRecords) ?? 0,
  };
}

/** When the budget's work began: the later of when it was set and the start it names. */
function workStart(b: TimeBudget): number {
  const set = Date.parse(b.setAt);
  const start = b.start ? Date.parse(b.start) : NaN;
  return Number.isFinite(start) && start > set ? start : set;
}

/** "3 min", "1 h 20 min", "2 d 4 h" — in the UI's language, with the units Intl knows. */
export function formatSpan(ms: number, locale: string): string {
  const unit = (n: number, u: "minute" | "hour" | "day") => {
    try {
      return new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short" }).format(n);
    } catch {
      return `${n} ${u === "minute" ? "min" : u === "hour" ? "h" : "d"}`;
    }
  };
  const total = Math.max(0, Math.round(ms / MINUTE_MS));
  if (total < 60) return unit(total, "minute");
  if (ms < DAY_MS) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${unit(h, "hour")} ${unit(m, "minute")}` : unit(h, "hour");
  }
  const d = Math.floor(ms / DAY_MS);
  const h = Math.floor((ms - d * DAY_MS) / HOUR_MS);
  return h ? `${unit(d, "day")} ${unit(h, "hour")}` : unit(d, "day");
}

/** A share of the bar, 0–100. */
const pct = (at: number, start: number, end: number): number => (end > start ? Math.min(100, Math.max(0, ((at - start) / (end - start)) * 100)) : 100);

export interface CodingBudgetTimelineProps {
  /** The run's or team's `timeBudget`, as the route answers it. */
  budget: unknown;
  /** Its `timeRecord`, as the route answers it — absent before the first line is written. */
  record?: unknown;
  /** Still working: the bar moves on with the clock. */
  live: boolean;
  /** The box's zone off the Coding Agent status; the browser's own while there is none. */
  timeZone?: string | null;
  /** The spend so far when the record has none yet (a live run's own counter). */
  tokensUsed?: number | null;
  testId?: string;
  className?: string;
}

export default function CodingBudgetTimeline({ budget, record, live, timeZone, tokensUsed, testId = "coding-budget-timeline", className = "" }: CodingBudgetTimelineProps) {
  const { t, locale } = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [live]);

  const data = readBudgetTimeline(budget, record);
  if (!data) return null;
  const zone = safeTimeZone(timeZone ?? (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"));
  const b = data.budget;
  const start = workStart(b);
  const deadline = Date.parse(b.deadline);
  const cutoff = marginCutoffMs(b);
  const end = data.finishedAt ?? (live ? now : Math.min(now, deadline));
  const elapsed = Math.max(0, end - start);
  const total = Math.max(0, deadline - start);
  const left = deadline - end;
  const span = (ms: number) => formatSpan(ms, locale);
  const at = (ms: number) => formatDeadline(ms, zone, locale);
  const label = b.preset === "custom" ? b.label : t({ "30m": "codingAgent.budgetPickerChip30m", "1h": "codingAgent.budgetPickerChip1h", morning: "codingAgent.budgetPickerChipMorning", "1d": "codingAgent.budgetPickerChip1d" }[b.preset]);
  const spent = data.tokensUsed ?? (typeof tokensUsed === "number" && Number.isFinite(tokensUsed) ? tokensUsed : null);
  const fmtNum = (n: number) => n.toLocaleString(locale);

  // Estimate markers: the whole work's, and — for a plan of several — where
  // each task's estimate ends when they are laid end to end, most important first.
  const estimated = data.tasks.filter((x) => typeof x.estimateMs === "number" && x.estimateMs > 0);
  let running = 0;
  const taskMarks = estimated.length > 1
    ? estimated.map((x) => {
      running += x.estimateMs as number;
      return { id: x.taskId, at: start + running, est: x.estimateMs as number };
    })
    : [];
  const estimateAt = data.estimateMs ? start + data.estimateMs : null;
  const marks = data.records.filter((r) => {
    const k = rowKind(r);
    return k === "checkpoint" || k === "margin" || k === "extra" || k === "skip" || k === "stop" || k === "finish";
  });

  const tookMs = estimated.reduce((sum, x) => sum + (x.actualMs ?? 0), 0);
  const pairedEst = estimated.filter((x) => x.actualMs !== null).reduce((sum, x) => sum + (x.estimateMs as number), 0);
  const estimateLine = estimated.length && pairedEst > 0
    ? t("codingAgent.budgetTimelineEstimateTook", { est: span(pairedEst), took: span(tookMs) })
    : data.estimateMs
      ? (data.finishedAt
        ? t("codingAgent.budgetTimelineEstimateTook", { est: span(data.estimateMs), took: span(elapsed) })
        : t("codingAgent.budgetTimelineEstimateOnly", { est: span(data.estimateMs) }))
      : null;

  const rows = data.records.slice(-MAX_ROWS);
  const omitted = data.omittedRecords + (data.records.length - rows.length);
  const fill = data.stopReason ? STOP_FILL[data.stopReason] : "#fcd34d";
  // What the marks on the bar are, for the kinds this bar shows: a tooltip
  // alone leaves a phone, and anyone not hovering, guessing.
  const markKinds = [...new Set(marks.map(rowKind))].filter((k) => k !== "margin" && MARK_TONE[k]);

  return (
    <section className={`mt-3 ${CARD_SURFACE} px-4 py-3 ${className}`} data-testid={testId} aria-label={t("codingAgent.budgetTimelineTitle")}>
      <div className="flex flex-wrap items-center gap-2">
        <p className={SECTION_LABEL}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">timer</span>
          {t("codingAgent.budgetTimelineTitle")}
        </p>
        <span className="text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-label`}>{label}</span>
        {(data.stopReason || live) && (
          <span
            className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none ${data.stopReason ? STOP_TONE[data.stopReason] : "text-amber-300 border-amber-400/40"}`}
            data-testid={`${testId}-status`}
          >
            {data.stopReason ? t(STOP_KEY[data.stopReason]) : t("codingAgent.budgetTimelineWorking")}
          </span>
        )}
      </div>

      {/* The bar: the work's start on the left, the deadline on the right, the
          safety margin shaded at its end; markers above for the estimates, below
          for what the record noted on the way. */}
      <div className="relative mt-4 mb-3" data-testid={`${testId}-bar`}>
        <div
          className="relative h-2 rounded-full bg-white/10 overflow-hidden"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct(end, start, deadline))}
          aria-valuetext={t("codingAgent.budgetTimelineBarLabel", { elapsed: span(elapsed), total: span(total) })}
        >
          <div
            className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,rgba(251,191,36,0.28)_0_4px,transparent_4px_8px)]"
            style={{ left: `${pct(cutoff, start, deadline)}%` }}
            title={t("codingAgent.budgetTimelineMargin", { time: at(cutoff) })}
            data-testid={`${testId}-margin`}
          />
          <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out" style={{ width: `${pct(end, start, deadline)}%`, background: fill }} data-testid={`${testId}-fill`} />
        </div>
        {estimateAt !== null && (
          <span
            className="absolute -top-1.5 h-5 w-0.5 -translate-x-1/2 rounded bg-white/80"
            style={{ left: `${pct(estimateAt, start, deadline)}%` }}
            title={`${t("codingAgent.budgetTimelineEstimate")}: ${span(data.estimateMs ?? 0)}`}
            data-testid={`${testId}-estimate`}
          />
        )}
        {taskMarks.map((m) => (
          <span
            key={m.id}
            className="absolute -top-1 h-1.5 w-px -translate-x-1/2 bg-white/50"
            style={{ left: `${pct(m.at, start, deadline)}%` }}
            title={t("codingAgent.budgetTimelineTaskEstimate", { task: m.id, est: span(m.est) })}
            data-testid={`${testId}-task-estimate`}
          />
        ))}
        {marks.map((r, i) => {
          const k = rowKind(r);
          const tone = MARK_TONE[k] ?? "bg-sky-300";
          return (
            <span
              key={`${r.at}-${i}`}
              className={`absolute top-3 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${tone}`}
              style={{ left: `${pct(Date.parse(r.at), start, deadline)}%` }}
              title={`${t(KIND_KEY[k])} · ${at(Date.parse(r.at))}`}
              data-testid={`${testId}-mark`}
            />
          );
        })}
      </div>
      <ul className="-mt-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)]" data-testid={`${testId}-legend`}>
        {estimateAt !== null && (
          <li className="inline-flex items-center gap-1"><span className="h-2.5 w-0.5 rounded bg-white/80" aria-hidden="true" />{t("codingAgent.budgetTimelineEstimate")}</li>
        )}
        <li className="inline-flex items-center gap-1">
          <span className="h-2 w-3 rounded-sm bg-[repeating-linear-gradient(135deg,rgba(251,191,36,0.45)_0_2px,transparent_2px_4px)]" aria-hidden="true" />
          {t("codingAgent.budgetTimelineKindMargin")}
        </li>
        {markKinds.map((k) => (
          <li key={k} className="inline-flex items-center gap-1"><span className={`h-1.5 w-1.5 rounded-full ${MARK_TONE[k]}`} aria-hidden="true" />{t(KIND_KEY[k])}</li>
        ))}
      </ul>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 text-[11px]" data-testid={`${testId}-figures`}>
        <div className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.budgetTimelineElapsed")}</dt>
          <dd className="text-[var(--text-primary)] tabular-nums" data-testid={`${testId}-elapsed`}>{span(elapsed)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{left >= 0 ? t("codingAgent.budgetTimelineRemaining") : t("codingAgent.budgetTimelineOverrun")}</dt>
          <dd className={`tabular-nums ${left >= 0 ? "text-[var(--text-primary)]" : "text-amber-300"}`} data-testid={`${testId}-remaining`}>{span(Math.abs(left))}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.budgetTimelineDeadline")}</dt>
          <dd className="text-[var(--text-primary)]" data-testid={`${testId}-deadline`}>{at(deadline)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.budgetTimelineSpend")}</dt>
          <dd className="text-[var(--text-primary)] tabular-nums" data-testid={`${testId}-spend`}>
            {spent === null
              ? "—"
              : data.tokenCap !== null
                ? t("codingAgent.budgetTimelineTokensOf", { n: fmtNum(spent), cap: fmtNum(data.tokenCap) })
                : t("codingAgent.budgetTimelineTokens", { n: fmtNum(spent) })}
          </dd>
          {spent !== null && data.tokenCap !== null && data.tokenCap > 0 && (
            <div className="mt-1 h-[3px] rounded bg-white/10 overflow-hidden" aria-hidden="true">
              <div className="h-full rounded" style={{ width: `${Math.min(100, (spent / data.tokenCap) * 100)}%`, background: spent >= data.tokenCap ? "#fca5a5" : "#a5b4fc" }} />
            </div>
          )}
        </div>
      </dl>
      <p className="mt-2 text-[10px] text-[var(--text-muted)]" data-testid={`${testId}-zone`}>
        {t("codingAgent.budgetTimelineMargin", { time: at(cutoff) })} · {zone}
      </p>

      {estimateLine && <p className="mt-1 text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-accuracy`}>{estimateLine}</p>}
      {data.extras.length > 0 && (
        <div className="mt-2" data-testid={`${testId}-extras`}>
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.budgetTimelineExtras")}</p>
          <ul className="mt-0.5 space-y-0.5 text-[11px] text-[var(--text-secondary)]">
            {data.extras.map((x, i) => <li key={i} className="break-words">· {x}</li>)}
          </ul>
        </div>
      )}
      {data.skipped.length > 0 && (
        <div className="mt-2" data-testid={`${testId}-skipped`}>
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.budgetTimelineSkipped")}</p>
          <ul className="mt-0.5 space-y-0.5 text-[11px] text-[var(--text-secondary)]">
            {data.skipped.map((x, i) => <li key={i} className="break-words">· {x}</li>)}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <details className="group mt-2" data-testid={`${testId}-checkpoints`}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] [&::-webkit-details-marker]:hidden">
            <span className="material-symbols-rounded transition-transform group-open:rotate-90" style={{ fontSize: 14 }} aria-hidden="true">chevron_right</span>
            {t("codingAgent.budgetTimelineCheckpoints", { n: rows.length })}
          </summary>
          <ol className="mt-1.5 space-y-1">
            {rows.map((r, i) => {
              const when = Date.parse(r.at);
              const k = rowKind(r);
              const rest = deadline - when;
              return (
                <li key={`${r.at}-${i}`} className="grid grid-cols-[auto_1fr] gap-x-2 text-[11px]" data-testid={`${testId}-row`}>
                  <time dateTime={r.at} className="font-mono text-[10px] text-[var(--text-muted)] pt-px">{at(when)}</time>
                  <div className="min-w-0">
                    <span className="mr-1.5 rounded bg-white/[0.06] px-1 py-px text-[10px] font-semibold text-[var(--text-secondary)]">{t(KIND_KEY[k])}</span>
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {rest >= 0
                        ? t("codingAgent.budgetTimelineUsedLeft", { used: span(Math.max(0, when - start)), left: span(rest) })
                        : t("codingAgent.budgetTimelinePastDeadline", { used: span(Math.max(0, when - start)) })}
                    </span>
                    <p className="text-[var(--text-secondary)] break-words">
                      {r.taskId ? <span className="font-mono text-[10px] text-[var(--text-muted)]">{r.taskId} · </span> : null}
                      {r.text}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          {omitted > 0 && <p className="mt-1 text-[10px] text-[var(--text-muted)]">{t("codingAgent.budgetTimelineOmitted", { n: omitted })}</p>}
        </details>
      )}
    </section>
  );
}
