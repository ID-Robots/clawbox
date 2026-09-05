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
  /** The run is still going: the newest step is the one happening now. */
  live: boolean;
  testId?: string;
}

export default function CodingRunTimeline({ lines, live, testId = "coding-agent-run-activity" }: Props) {
  const { t } = useT();
  if (lines.length === 0) return null;
  const label = (step: ProgressDescription) => (step.labelKey ? t(STEP_KEY[step.labelKey]) : step.label);
  const detail = (step: ProgressDescription) =>
    step.counts ? `${step.counts.done}/${step.counts.total} ${t("codingAgent.chatDone")}` : step.detail;
  return (
    <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid={testId} data-live={live || undefined}>
      <p className={SECTION_LABEL}>
        {t("codingAgent.timelineTitle")}
        <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">{lines.length}</span>
        {live && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />}
      </p>
      {/* Oldest first, the newest at the bottom where a live run adds to it;
          capped in height so a long run stays a card, and scrolled to its end
          so the step happening now is the one on screen. */}
      <ol className="mt-2 flex flex-col gap-1 max-h-80 overflow-y-auto" data-testid={`${testId}-steps`}>
        {lines.map((line, i) => {
          const step = describeProgressLine(line);
          const current = live && i === lines.length - 1;
          return (
            <li key={`${i}:${line}`} className="flex min-w-0" data-kind={step.kind} aria-current={current ? "step" : undefined}>
              <span
                title={step.kind === "text" ? line : undefined}
                className={`inline-flex items-center gap-1 max-w-full rounded-md px-1.5 py-px text-[11px] leading-4 ${TONE[step.kind]} ${current ? "ring-1 ring-amber-400/40" : ""}`}
              >
                <span className="material-symbols-rounded shrink-0" style={{ fontSize: 13 }} aria-hidden="true">{step.icon}</span>
                <span className="truncate">{label(step)}</span>
                {detail(step) && <span className="opacity-75 truncate">{detail(step)}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
