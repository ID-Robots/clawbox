"use client";

import { useEffect, useState } from "react";
import type { TeamActivity } from "@/lib/use-coding-agent-activity";
import type { TeamStatus } from "@/lib/coding-team-status";
import type { TeamStartStep } from "@/lib/coding-start-phase";
import { isSettledTeamStatus } from "@/lib/coding-team-status";
import { taskTitle } from "@/lib/task-title";
import { teamModelsLabel } from "@/lib/coding-model-names";
import CodingModelChip from "./CodingModelChip";

/**
 * One coding TEAM, as a card in the chat — the run card's sibling
 * (CodingAgentActivityPill.tsx), in the same family as the Create card.
 *
 * A team used to be invisible in the chat: its member runs each drew a run
 * card (five cards for a team of five) and the team itself was a toast when
 * it finished. Now the team is ONE card, live then settled, and its members
 * are hidden behind it (use-coding-agent-activity.ts hides a run whose
 * record carries `team`).
 *
 * Title row: the `groups` glyph in the team tone · the goal's first line ·
 * the status chip (queued · planning · working · reviewing · done · failed ·
 * stopped) · the chevron · Open · ×. Live body: a phase line ("Working · 2 of
 * 3 tasks") over a progress bar of tasks done. Expanded: the tasks in the
 * board's outline order with the plan's own marks (✓ ● ○ ✕), each "title —
 * state", "+N more" after TASKS_SHOWN; then the counters (agents · tokens ·
 * elapsed). Settled: "Done · 3 of 3 · PR #12" and the final review's first
 * sentence; a failed team shows why it stopped.
 *
 * Open hands the team's id to the Coding Agent app (`dispatchOpenCodingTeam`
 * through the host); the card does not know where the app lands. × is the
 * same put-away as the run card's — the host keeps the dismissed set, keyed
 * `team:<id>` in the same kv list — and a team that finished `done` leaves on
 * its own after a few seconds like a clean run, behind the same 🤖 chip.
 *
 * The expanded flag is local, like the run card's: a card lives exactly as
 * long as "this team, while the chat is open".
 */

/** The team tone: violet, the chart's planner hue, so a team reads as a team at a glance. */
const TEAM_TONE = { color: "#c4b5fd", chip: "rgba(196,181,253,0.16)" };

/** Each status word's colour on the chip and the glyph. */
const STATUS_TONE: Record<TeamStatus, string> = {
  queued: "rgba(255,255,255,0.55)",
  planning: "#c4b5fd",
  working: "#fcd34d",
  reviewing: "#93c5fd",
  done: "#86efac",
  failed: "#fca5a5",
  stopped: "#cbd5e1",
};

/** How each task state is marked — the run card's TODO_MARK vocabulary, plus a cross for a task that failed or was rejected. */
const TASK_MARK: Record<string, { glyph: string; color: string }> = {
  complete: { glyph: "✓", color: "rgba(134,239,172,0.55)" },
  in_progress: { glyph: "●", color: "#fcd34d" },
  pending: { glyph: "○", color: "rgba(255,255,255,0.35)" },
  failed: { glyph: "✕", color: "#fca5a5" },
  rejected: { glyph: "✕", color: "#fca5a5" },
};

/** Tasks drawn before the list folds into "+N more". */
const TASKS_SHOWN = 6;
/** The title's width: the goal's first line, this long. */
const TITLE_CHARS = 60;

export interface CodingTeamCardLabels extends Record<TeamStatus, string> {
  /** A "{done} of {total} tasks" template. */
  tasks: string;
  /** A "PR #{n}" template. */
  pr: string;
  /** A "{n} agents" template. */
  agents?: string;
  /** Follows a count: "46k tokens". */
  tokensWord?: string;
  /** A "+{n} more" template. */
  more?: string;
  /** The header's tooltip, by state. */
  showDetails?: string;
  hideDetails?: string;
  /** The × — "Hide this card". */
  dismiss?: string;
  /** A "Stopped: {reason}" template for a team that did not finish. */
  reason?: string;
  /** The three moving dots' accessible name — "working". */
  busy?: string;
  /** The states a task row can carry, in the owner's words. */
  taskState?: Partial<Record<string, string>>;
  /** One line per step on the way to the first worker (src/lib/coding-start-phase.ts); a missing one falls back to English. */
  startSteps?: Partial<Record<TeamStartStep, string>>;
  /** The chip of a team the box refused to start. */
  startFailed?: string;
}

/** The start steps in English, for a host from before the catalogue had them. */
const START_STEP_FALLBACK: Record<TeamStartStep, string> = {
  planner_starting: "Starting the planner",
  planning: "The planner is reading the project and splitting the goal",
  plan_ready: "Plan ready — setting up the workers",
  worker_starting: "Starting the first worker",
};

function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export default function CodingTeamActivityCard(
  { team, labels, openLabel, onOpen, onDismiss, autoHiding = false }: {
    team: TeamActivity;
    labels: CodingTeamCardLabels;
    openLabel: string;
    onOpen?: () => void;
    /** Put the card away for good; with no handler there is no ×. */
    onDismiss?: () => void;
    /** The team just finished cleanly and the chat will put this card away on its own; the card only fades. */
    autoHiding?: boolean;
  },
) {
  const settled = isSettledTeamStatus(team.status);
  const live = !settled && team.status !== "queued";
  // A queued team's clock runs too: it is time the owner is waiting.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (settled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [settled]);
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((v) => !v);

  // Refused before it had a board: its own word, not "Failed" — no work was lost.
  const startFailed = team.announced === true && team.status === "failed";
  const statusWord = startFailed ? (labels.startFailed ?? "Could not start") : labels[team.status];
  const startStep = live ? (team.startStep ?? null) : null;
  const startLine = startStep ? (labels.startSteps?.[startStep] ?? START_STEP_FALLBACK[startStep]) : null;
  const statusColor = STATUS_TONE[team.status];
  const title = taskTitle(team.goal, TITLE_CHARS) || team.projectId || statusWord;
  const took = elapsed(team.startedAt, settled ? (team.finishedAt ?? now) : now);
  const total = team.tasksTotal;
  const done = team.tasksDone;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const shownTasks = team.tasks.slice(0, TASKS_SHOWN);
  const hiddenTasks = Math.max(0, team.tasks.length - TASKS_SHOWN);

  // "Working · 2 of 3 tasks" / "Done · 3 of 3 · PR #12".
  const phaseParts: string[] = [statusWord];
  if (total > 0) phaseParts.push(labels.tasks.replaceAll("{done}", String(done)).replaceAll("{total}", String(total)));
  if (team.prNumber != null) phaseParts.push(labels.pr.replaceAll("{n}", String(team.prNumber)));

  // What the team runs on ("Sonnet 5 · Opus 5.5" — the owner, 2026-11-01):
  // the workers' model first, at most two names then "+N".
  const models = teamModelsLabel(team.agents);

  const counters: string[] = [];
  if (team.agents.length > 0 && labels.agents) counters.push(labels.agents.replaceAll("{n}", String(team.agents.length)));
  if (team.tokensUsed > 0 && labels.tokensWord) counters.push(`${tokens(team.tokensUsed)} ${labels.tokensWord}`);
  counters.push(took);

  // The settled body: the final review's first sentence, or why it stopped.
  const resultLine = startFailed
    ? team.errorLine
    : team.status === "failed" || team.status === "stopped"
    ? (team.errorLine ? (labels.reason ?? "Stopped: {reason}").replaceAll("{reason}", team.errorLine) : team.resultLine)
    : settled ? team.resultLine : null;

  return (
    <div
      data-testid="coding-team-activity"
      data-team-id={team.id}
      data-status={team.status}
      data-expanded={expanded ? "true" : "false"}
      className={autoHiding ? "coding-agent-autohide" : undefined}
      role="status"
      aria-live={live ? "polite" : "off"}
      onClick={toggle}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 12px",
        borderRadius: 14,
        background: "rgba(0,0,0,0.35)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "rgba(255,255,255,0.85)",
        fontSize: 12,
        maxWidth: "100%",
        minWidth: 220,
        alignSelf: "stretch",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          data-testid="coding-team-activity-toggle"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          title={expanded ? labels.hideDetails : labels.showDetails}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            toggle();
          }}
          style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, outlineOffset: 2 }}
        >
          <span
            className={`material-symbols-rounded${live ? " coding-agent-pulse" : ""}`}
            aria-hidden="true"
            style={{ fontSize: 18, color: TEAM_TONE.color, flexShrink: 0 }}
          >
            groups
          </span>
          <span style={{ fontWeight: 600, fontSize: 12.5, color: "rgba(255,255,255,0.9)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {title}
          </span>
          <span
            data-testid="coding-team-activity-status"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 18, padding: "0 7px", borderRadius: 9, fontSize: 11, fontWeight: 600, background: TEAM_TONE.chip, color: statusColor, flexShrink: 0 }}
          >
            {statusWord}
            {live ? (
              <span className="coding-agent-working" role="img" aria-label={labels.busy ?? "working"} title={labels.busy ?? "working"}>
                <span className="coding-agent-working-dot" />
                <span className="coding-agent-working-dot" style={{ animationDelay: "0.15s" }} />
                <span className="coding-agent-working-dot" style={{ animationDelay: "0.3s" }} />
              </span>
            ) : null}
          </span>
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>
            {expanded ? "expand_less" : "expand_more"}
          </span>
        </div>
        {onOpen ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            title={openLabel}
            aria-label={openLabel}
            data-testid="coding-team-activity-open"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 32,
              minWidth: 32,
              margin: "-6px 0",
              // The run card's Open, exactly: a thin green outline (the owner
              // wanted one Open across the cards, 2026-10-30), not the team tone.
              background: "transparent",
              border: "1px solid rgba(52,211,153,0.35)",
              borderRadius: 8,
              color: "#a7f3d0",
              cursor: "pointer",
              font: "inherit",
              fontSize: 12,
              fontWeight: 600,
              padding: "0 10px",
              flexShrink: 0,
            }}
          >
            {openLabel}
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            title={labels.dismiss ?? "Hide this card"}
            aria-label={labels.dismiss ?? "Hide this card"}
            data-testid="coding-team-activity-dismiss"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 44,
              height: 44,
              margin: "-12px -14px -12px 0",
              padding: 0,
              border: 0,
              borderRadius: 8,
              background: "transparent",
              color: "rgba(255,255,255,0.45)",
              cursor: "pointer",
              font: "inherit",
              flexShrink: 0,
            }}
          >
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>close</span>
          </button>
        ) : null}
      </div>

      <div
        data-testid="coding-team-activity-phase"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 2, color: "rgba(255,255,255,0.5)", fontSize: 11.5 }}
      >
        {team.projectId ? <span>{team.projectId}</span> : null}
        {phaseParts.map((part, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {(i > 0 || team.projectId) ? <span aria-hidden="true">·</span> : null}
            <span style={i === 0 ? { color: statusColor } : undefined}>{part}</span>
          </span>
        ))}
        {models ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            {(phaseParts.length > 0 || team.projectId) ? <span aria-hidden="true">·</span> : null}
            <CodingModelChip label={models.label} title={models.ids.join(", ")} testId="coding-team-activity-model" style={{ maxWidth: 180 }} />
          </span>
        ) : null}
        {!settled ? <span aria-hidden="true">·</span> : null}
        {!settled ? <span aria-hidden="true">{took}</span> : null}
      </div>

      {startLine ? (
        // Which step on the way to its first worker, and the id the team goes
        // by: the planner's first turn takes minutes, and an empty chart with
        // a ticking clock said nothing about what it was waiting for.
        <div
          data-testid="coding-team-activity-start"
          data-step={startStep ?? undefined}
          aria-live="off"
          title={startLine}
          style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, fontSize: 11.5, color: "rgba(255,255,255,0.75)" }}
        >
          <span aria-hidden="true" className="coding-agent-pulse" style={{ color: statusColor, flexShrink: 0 }}>●</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{startLine}</span>
          <span
            data-testid="coding-team-activity-id"
            style={{ marginLeft: "auto", flexShrink: 0, color: "rgba(255,255,255,0.4)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10.5 }}
          >
            {team.id}
          </span>
        </div>
      ) : null}

      {live && total > 0 ? (
        <div
          data-testid="coding-team-activity-progressbar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}
        >
          <div style={{ width: `${Math.round(ratio * 100)}%`, height: "100%", background: TEAM_TONE.color, transition: "width 0.4s ease" }} />
        </div>
      ) : null}

      {resultLine ? (
        <div
          data-testid="coding-team-activity-result"
          data-tone={team.status === "done" ? "result" : "danger"}
          title={resultLine}
          style={{ fontSize: 12.5, lineHeight: 1.4, color: team.status === "done" ? "rgba(255,255,255,0.8)" : "#fca5a5", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
        >
          {resultLine}
        </div>
      ) : null}

      {expanded ? (
        <div
          data-testid="coding-team-activity-details"
          aria-live="off"
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.06)", cursor: "default" }}
        >
          {shownTasks.length > 0 ? (
            <ul data-testid="coding-team-activity-tasks" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              {shownTasks.map((task) => {
                const mark = TASK_MARK[task.status] ?? TASK_MARK.pending;
                const inProgress = task.status === "in_progress";
                const state = labels.taskState?.[task.verdict ?? task.status] ?? labels.taskState?.[task.status];
                return (
                  <li
                    key={task.id}
                    data-task-id={task.id}
                    data-status={task.status}
                    aria-current={inProgress ? "step" : undefined}
                    title={task.title}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 6,
                      minWidth: 0,
                      fontSize: 11.5,
                      color: task.status === "complete" ? "rgba(255,255,255,0.45)" : inProgress ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.65)",
                    }}
                  >
                    <span aria-hidden="true" className={live && inProgress ? "coding-agent-pulse" : undefined} style={{ color: mark.color, flexShrink: 0, width: 10, textAlign: "center" }}>
                      {mark.glyph}
                    </span>
                    <span style={{ color: "rgba(255,255,255,0.45)", flexShrink: 0 }}>{task.id}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {task.title}
                      {state ? <span style={{ color: "rgba(255,255,255,0.45)" }}>{` — ${state}`}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {hiddenTasks > 0 ? (
            <div data-testid="coding-team-activity-tasks-more" style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", paddingLeft: 16 }}>
              {(labels.more ?? "+{n} more").replaceAll("{n}", String(hiddenTasks))}
            </div>
          ) : null}
          <div data-testid="coding-team-activity-counters" style={{ display: "flex", flexWrap: "wrap", columnGap: 6, rowGap: 2, color: "rgba(255,255,255,0.5)", fontSize: 11 }}>
            {counters.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {i > 0 ? <span aria-hidden="true">·</span> : null}
                {c}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
