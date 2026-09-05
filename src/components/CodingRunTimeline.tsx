"use client";

/**
 * A run's steps as a timeline — the chat card's "Live work" list, on the
 * run's own page above the summary. Each progress line the runner recorded
 * becomes a chip of the same kind the chat draws: a tool the run called, a
 * file it wrote or read, a command it ran, or a line of its own words. The
 * words for a step come from the same `codingAgent.chat*` strings the chat
 * uses, so the two surfaces never disagree about what "Screenshot" is
 * called.
 *
 * Lives beside the chat card rather than inside it: the card is inline
 * styles for a floating panel, this is a card in the app's own vocabulary.
 */

import { useEffect, useRef } from "react";
import { useState } from "react";
import { describeProgressLine, type ProgressDescription, type ProgressLabelKey } from "@/lib/coding-agent-progress";
import { useT } from "@/lib/i18n";
import { CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";

/** The chat's word for each kind of step — one key per ProgressLabelKey. */
const STEP_KEY: Record<ProgressLabelKey, string> = {
  screenshot: "codingAgent.chatScreenshot",
  lookingAtPage: "codingAgent.chatLookingAtPage",
  openingPage: "codingAgent.chatOpeningPage",
  drivingPage: "codingAgent.chatDrivingPage",
  closingPage: "codingAgent.chatClosingPage",
  write: "codingAgent.chatWrite",
  edit: "codingAgent.chatEdit",
  read: "codingAgent.chatRead",
  plan: "codingAgent.chatPlan",
};

/** The chat card's chip tones, as the app's classes. */
const TONE: Record<ProgressDescription["kind"], string> = {
  tool: "bg-sky-400/[0.14] text-sky-200",
  file: "bg-emerald-400/[0.12] text-emerald-200",
  command: "bg-black/40 text-white/75 font-mono",
  text: "bg-transparent text-[var(--text-muted)] !px-0",
};

interface Props {
  /** The runner's progress lines, oldest first. */
  lines: string[];
  /** When each line happened, one for one with `lines`; empty when the record predates the times. */
  times?: number[];
  /** When the run started, for the "+3m 12s" beside a step's clock time. */
  startedAt?: number;
  /** The run is still going: the newest step is the one happening now. */
  live: boolean;
  /** While live: the chat card's "Coding agent working" line — the dots, the tokens, the clock. */
  working?: { label: string; busy: string; tokens?: string; duration?: string };
  /** Inside another card (the live card's Timeline tab): no card of its own. */
  embedded?: boolean;
  testId?: string;
}

/** "+3m 12s" — a step's distance from the run's start. */
function sinceStart(at: number, startedAt: number): string {
  const sec = Math.max(0, Math.round((at - startedAt) / 1000));
  if (sec < 60) return `+${sec}s`;
  const m = Math.floor(sec / 60);
  return `+${m}m ${sec - m * 60}s`;
}

export default function CodingRunTimeline({ lines, times = [], startedAt, live, working, embedded = false, testId = "coding-agent-run-activity" }: Props) {
  const { t } = useT();
  const list = useRef<HTMLOListElement>(null);
  // Steps the owner opened: the whole line, its clock time and its kind,
  // where the row shows a chip. Keyed by index and line so a re-render
  // with new lines keeps the ones already open.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  // A live run adds to the bottom: keep the newest step on screen.
  useEffect(() => {
    if (live && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [live, lines.length]);
  if (lines.length === 0 && !working) return null;
  const timed = times.length === lines.length;
  // The clock time and how far into the run — beside every step, and in
  // full when a step is opened.
  const clockOf = (i: number) => (timed ? new Date(times[i]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null);
  const when = (i: number) => {
    if (!timed) return null;
    const clock = clockOf(i)!;
    return startedAt ? `${clock} · ${sinceStart(times[i], startedAt)}` : clock;
  };
  const label = (step: ProgressDescription) => (step.labelKey ? t(STEP_KEY[step.labelKey]) : step.label);
  const detail = (step: ProgressDescription) =>
    step.counts ? `${step.counts.done}/${step.counts.total} ${t("codingAgent.chatDone")}` : step.detail;
  return (
    <div className={embedded ? "" : `mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid={testId} data-live={live || undefined}>
      <p className={SECTION_LABEL}>
        {t("codingAgent.timelineTitle")}
        <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">{lines.length}</span>
        {live && working && (
          // The chat card's own sign of life, with the same figures beside it.
          <span className="ml-auto normal-case tracking-normal font-normal text-[11px] text-amber-300 inline-flex items-center gap-2" data-testid="coding-agent-run-working">
            <span className="inline-flex items-center gap-1.5">
              {working.label}
              <span className="coding-agent-working" role="img" aria-label={working.busy} title={working.busy}>
                <span className="coding-agent-working-dot" />
                <span className="coding-agent-working-dot" style={{ animationDelay: "0.15s" }} />
                <span className="coding-agent-working-dot" style={{ animationDelay: "0.3s" }} />
              </span>
            </span>
            {working.tokens && <span className="text-[var(--text-muted)]">· {working.tokens}</span>}
            {working.duration && <span className="text-[var(--text-muted)]">· {working.duration}</span>}
          </span>
        )}
        {live && !working && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />}
      </p>
      {/* Oldest first, the newest at the bottom where a live run adds to it;
          capped in height so a long run stays a card, and scrolled to its end
          so the step happening now is the one on screen. */}
      <ol ref={list} className="mt-2 flex flex-col gap-1 max-h-80 overflow-y-auto" data-testid={`${testId}-steps`}>
        {lines.map((line, i) => {
          const step = describeProgressLine(line);
          const current = live && i === lines.length - 1;
          const key = `${i}:${line}`;
          const expanded = open.has(key);
          // Drawn in full — the whole line, wrapped — when it is the step
          // happening now or the owner opened it; otherwise a chip on one line.
          const full = current || expanded;
          return (
            <li
              key={key}
              className="flex flex-col min-w-0"
              data-kind={step.kind}
              data-at={timed ? times[i] : undefined}
              data-expanded={expanded || undefined}
              aria-current={current ? "step" : undefined}
            >
              <button
                type="button"
                onClick={() => toggle(key)}
                aria-expanded={expanded}
                title={when(i) ?? undefined}
                className="flex items-center gap-2 min-w-0 w-full text-left rounded-md hover:bg-white/[0.04]"
                data-testid={`${testId}-step`}
              >
                <span
                  className={`inline-flex ${full ? "items-start" : "items-center"} gap-1 max-w-full rounded-md px-1.5 py-px text-[11px] leading-4 ${TONE[step.kind]} ${current ? "ring-1 ring-amber-400/40" : ""}`}
                >
                  <span className="material-symbols-rounded shrink-0" style={{ fontSize: 13 }} aria-hidden="true">{step.icon}</span>
                  <span className={full ? "whitespace-normal break-words" : "truncate"}>{full && step.kind === "text" ? line : label(step)}</span>
                  {detail(step) && <span className={`opacity-75 ${full ? "whitespace-normal break-all" : "truncate"}`}>{detail(step)}</span>}
                </span>
                {timed && startedAt && (
                  // Always on: when a step happened is part of the step.
                  <time
                    dateTime={new Date(times[i]).toISOString()}
                    className="ml-auto shrink-0 font-mono text-[10px] text-[var(--text-muted)] pr-1"
                    data-testid={`${testId}-time`}
                  >
                    {sinceStart(times[i], startedAt)}
                  </time>
                )}
              </button>
              {expanded && (
                <dl className="mt-1 mb-1 ml-6 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-detail`}>
                  {timed && (
                    <>
                      <dt className="text-[var(--text-muted)]">{t("codingAgent.stepWhen")}</dt>
                      <dd className="font-mono">{when(i)}</dd>
                    </>
                  )}
                  <dt className="text-[var(--text-muted)]">{t("codingAgent.stepKind")}</dt>
                  <dd>{t(`codingAgent.stepKind.${step.kind}`)}</dd>
                  <dt className="text-[var(--text-muted)]">{t("codingAgent.stepLine")}</dt>
                  <dd className="font-mono whitespace-pre-wrap break-all">{line}</dd>
                </dl>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
