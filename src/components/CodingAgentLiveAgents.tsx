"use client";

/**
 * Home's **Now** section — what the Coding Agent opens on (the owner's brief,
 * 2026-10-12: "when you open it we first must see the agents, like a chart").
 *
 * Since the 2026-10-30 redesign the chart is drawn ONLY where there are agents
 * to draw: a team at work is a card with the real chart, compact, sized to
 * its content (the same CodingAgentDiagram the Team page draws large; one
 * rendering per card, never two); a solo run that sent helpers out is the
 * same kind of card; a solo run WITHOUT helpers is a plain row — one node is
 * no chart (the owner: "the space in the run diagram is almost all empty").
 * Queued teams and runs are rows with their place in line. With nothing at
 * work, the newest thing that was is one row. With nothing ever run, one
 * sentence and the way to the chat — the delegation drawing that stood here
 * (CodingAgentDelegationArt) went with the fake team chart: "a decorative
 * picture of agents" was the same objection.
 *
 * Every card and row taps through to its page (the Team page, the run's
 * page); the chart's own nodes keep their click (the agent's panel). It reads
 * nothing on a clock of its own: the boards and the runs are the app's.
 *
 * A start on its way is a row before it is a run (src/lib/coding-start-phase.ts):
 * "Starting…", the step it is on, its id and its clock — from the moment the
 * request reached the box, not from when its record was written; a start the
 * box refused stays a row with the reason for a while. A team on its way to
 * its first worker names its step under its heading the same way.
 */

import type { MouseEvent, ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { isLive, type CodingRunStatus } from "@/lib/coding-agent-status";
import { runRecordStartStep, teamStartStep, type CodingStartView, type RunCardStartStep, type TeamStartStep } from "@/lib/coding-start-phase";
import { taskProgress } from "@/lib/coding-agent-graph";
import CodingAgentDiagram, { DiagramFigures, type DiagramRun } from "./CodingAgentDiagram";
import { describeStep } from "./CodingRunTimeline";
import { TEAM_STATUS_TONE, isTeamActive, type TeamView } from "./CodingTeamPage";
import { RUN_TONE } from "./RunProgressBar";
import { BTN_PRIMARY_WIDE, CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";

/** A run as home reads it: the diagram's run, the team it belongs to, its place in the queue. */
export interface LiveRun extends DiagramRun {
  team?: { id: string; role: "planner" | "worker" | "reviewer" | "lead"; taskId: string | null } | null;
  queued?: { position?: number } | null;
}

/** The catalogue key of a run's status word — `gave_up` is camelCased there. */
export function runStatusKey(status: CodingRunStatus): string {
  return status === "gave_up" ? "codingAgent.statusGaveUp" : `codingAgent.status${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

const chipClass = "shrink-0 text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 inline-flex items-center gap-1.5";

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}

/** Whether a run sent any helper out — the one case a solo run draws a chart for. */
export function runHasHelpers(run: Pick<LiveRun, "subagents" | "activeSubagents">): boolean {
  return (run.subagents?.length ?? 0) > 0 || (run.activeSubagents?.length ?? 0) > 0;
}

/**
 * The run page's **Helpers** chart: the run and the helpers it sent out.
 * NOTHING for a run without helpers (2026-10-30): a one-node chart in a
 * full-width card was the owner's "the space in the run diagram is almost all
 * empty", and the page's status, Now line and figures already say everything
 * that node did. Nothing for a team member either: its team's chart is on the
 * Team page, which the member's team chip opens (until step 5 the member's
 * page drew its team here). Bare and without the legend: the host's block is
 * the card, and three nodes with their icons need no key.
 */
export function RunAgentsDiagram({ run, onOpenRun, onChanged, refreshKey }: {
  run: LiveRun;
  onOpenRun: (id: string) => void;
  onChanged?: () => void;
  refreshKey?: unknown;
}) {
  const { t } = useT();
  if (!runHasHelpers(run)) return null;
  // No figure chips over the chart: the page's figure tiles hold those
  // numbers, and the same four sat twice on one screen.
  return (
    <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-run-helpers" data-kind="run">
      <p className={SECTION_LABEL}>{t("codingAgent.statHelpers")}</p>
      <CodingAgentDiagram
        source={{ kind: "run", run }}
        current={run.id}
        onOpenRun={onOpenRun}
        onChanged={onChanged}
        refreshKey={refreshKey}
        figures={false}
        legend={false}
        bare
        testId="coding-agent-run-diagram"
        className="mt-2"
      />
    </div>
  );
}

/**
 * A card's or a row's heading: the whole of it is the way to the page — a
 * 44-px button across the card — with the glyph, the status, the title and a
 * chevron. `extra` sits between the title and the chevron (a task count).
 */
function Heading({ icon, chip, title, extra, onOpen, testId }: { icon: string; chip: ReactNode; title: string; extra?: ReactNode; onOpen: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={testId}
      className="flex w-full min-w-0 items-center gap-2 min-h-[44px] @md:min-h-[36px] text-left rounded-lg -mx-1 px-1 hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)] cursor-pointer"
    >
      <span className="material-symbols-rounded shrink-0 text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">{icon}</span>
      {chip}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]" title={title}>{title}</span>
      {extra}
      <span className="material-symbols-rounded shrink-0 text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">chevron_right</span>
    </button>
  );
}

function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

export default function CodingAgentLiveAgents({ runs, teams, starts = [], now, onOpenRun, onOpenTeam, onAsk, onChanged, refreshKey }: {
  runs: LiveRun[];
  teams: TeamView[];
  /** The runs list's `starting`: starts on their way, and the ones the box refused. */
  starts?: CodingStartView[];
  /** The app's clock, for a start's elapsed time; without it the rows show none. */
  now?: number;
  onOpenRun: (id: string) => void;
  /** Open a team's own page. */
  onOpenTeam: (team: TeamView) => void;
  /** The way to the chat when nothing has ever run — absent on `/app/coding`, where no desktop listens. */
  onAsk?: () => void;
  onChanged?: () => void;
  refreshKey?: unknown;
}) {
  const { t } = useT();
  const runOf = (id: string) => runs.find((r) => r.id === id);
  // A run a team spawned is drawn in its team's chart, never twice.
  const inTeam = new Set<string>();
  for (const team of teams) for (const r of team.runs ?? []) inTeam.add(r.id);
  const solo = (r: LiveRun) => !r.team && !inTeam.has(r.id);
  const liveTeams = teams.filter((x) => isTeamActive(x.status));
  const liveRuns = runs.filter((r) => isLive(r.status) && solo(r));
  const queuedTeams = teams.filter((x) => x.status === "queued").sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const queuedRuns = runs.filter((r) => r.status === "queued" && solo(r)).sort((a, b) => (a.queued?.position ?? 0) - (b.queued?.position ?? 0));
  // A start whose record is listed is the record's row.
  const listed = new Set(runs.map((r) => r.id));
  const shownStarts = starts.filter((x) => !listed.has(x.id));
  const startsOnWay = shownStarts.filter((x) => x.failedAt === null);
  const startsFailed = shownStarts.filter((x) => x.failedAt !== null);
  const atWork = liveTeams.length + liveRuns.length + startsOnWay.length;
  const waiting = queuedTeams.length + queuedRuns.length;

  // Nothing at work: the newest thing that was, as one row.
  let latest: { kind: "team"; team: TeamView } | { kind: "run"; run: LiveRun } | null = null;
  if (atWork === 0) {
    const lastTeam = [...teams].filter((x) => x.status !== "queued").sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const lastRun = [...runs].filter((r) => solo(r) && r.status !== "draft" && r.status !== "queued").sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))[0] ?? null;
    if (lastTeam && (!lastRun || lastTeam.updatedAt >= (lastRun.completedAt ?? lastRun.startedAt))) latest = { kind: "team", team: lastTeam };
    else if (lastRun) latest = { kind: "run", run: lastRun };
  }

  const teamChip = (team: TeamView) => (
    <span className={`${chipClass} ${TEAM_STATUS_TONE[team.status] ?? TEAM_STATUS_TONE.stopped} ${isTeamActive(team.status) ? "coding-agent-pulse" : ""}`}>
      {isTeamActive(team.status) && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />}
      {t(`codingAgent.team.status.${team.status}`)}
    </span>
  );
  const runChip = (run: LiveRun) => (
    <span className={`${chipClass} ${RUN_TONE[run.status]?.chip ?? ""} ${run.status === "running" ? "coding-agent-pulse" : ""}`}>
      {run.status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />}
      {t(runStatusKey(run.status))}
    </span>
  );
  const tasksCount = (team: TeamView) => {
    const p = taskProgress(team);
    return p.total > 0 ? <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{t("codingAgent.teamTasksDone", { done: p.accepted, total: p.total })}</span> : null;
  };
  // Literal keys, one per step: the catalogue sweep reads them where they are used.
  const runStepWord: Record<RunCardStartStep, string> = {
    checking: t("codingAgent.start.step.checking"),
    worktree: t("codingAgent.start.step.worktree"),
    launching: t("codingAgent.start.step.launching"),
    agent: t("codingAgent.start.step.agent"),
  };
  const teamStepWord: Record<TeamStartStep, string> = {
    planner_starting: t("codingAgent.start.team.plannerStarting"),
    planning: t("codingAgent.start.team.planning"),
    plan_ready: t("codingAgent.start.team.planReady"),
    worker_starting: t("codingAgent.start.team.workerStarting"),
  };
  /** The step line: what it is waiting on, the id it goes by, and how long it has been. */
  const stepLine = (testId: string, step: string, id: string, since: number | null) => (
    <p className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[11px] text-[var(--text-muted)]" data-testid={testId}>
      <span className="truncate">{step}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0 font-mono text-[10.5px]" data-testid={`${testId}-id`}>{id}</span>
      {since !== null && now !== undefined && (
        <>
          <span aria-hidden="true">·</span>
          <span className="shrink-0" aria-hidden="true">{elapsed(since, now)}</span>
        </>
      )}
    </p>
  );
  /** The card's whole surface opens the page; a control on it keeps its own meaning. */
  const cardOpen = (open: () => void) => (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    open();
  };

  /** A team at work: its heading, and the real chart, compact. */
  const teamCard = (team: TeamView) => (
    <div key={team.id} className={`mt-2 ${CARD_SURFACE} px-3 py-2 cursor-pointer`} data-testid={`coding-agent-live-team-${team.id}`} data-kind="team" data-shape="team" onClick={cardOpen(() => onOpenTeam(team))}>
      <Heading icon="groups" chip={teamChip(team)} title={firstLine(team.goal)} extra={tasksCount(team)} onOpen={() => onOpenTeam(team)} testId={`coding-agent-live-open-team-${team.id}`} />
      {(() => {
        const step = teamStartStep(team);
        return step ? stepLine(`coding-agent-live-team-step-${team.id}`, teamStepWord[step], team.id, team.createdAt) : null;
      })()}
      <CodingAgentDiagram
        source={{ kind: "team", team }}
        runOf={runOf}
        onOpenRun={onOpenRun}
        onChanged={onChanged}
        refreshKey={refreshKey}
        compact
        bare
        figures={false}
        legend={false}
        testId={`coding-agent-live-chart-${team.id}`}
        className="mt-1"
      />
    </div>
  );
  /** A solo run that sent helpers out: the same card, its own chart. */
  const runCard = (run: LiveRun) => (
    <div key={run.id} className={`mt-2 ${CARD_SURFACE} px-3 py-2 cursor-pointer`} data-testid={`coding-agent-live-run-${run.id}`} data-kind="run" data-shape="run" onClick={cardOpen(() => onOpenRun(run.id))}>
      <Heading icon="smart_toy" chip={runChip(run)} title={firstLine(run.task)} onOpen={() => onOpenRun(run.id)} testId={`coding-agent-live-open-run-${run.id}`} />
      <CodingAgentDiagram
        source={{ kind: "run", run }}
        onOpenRun={onOpenRun}
        onChanged={onChanged}
        refreshKey={refreshKey}
        compact
        bare
        figures={false}
        legend={false}
        testId={`coding-agent-live-chart-${run.id}`}
        className="mt-1"
      />
    </div>
  );
  /** A run without helpers — at work or the newest that was: a plain row, its Now line while it works, its figures. */
  const runRow = (run: LiveRun) => {
    const steps = run.progress ?? [];
    const last = run.status === "running" && steps.length > 0 ? steps[steps.length - 1] : null;
    const startStep = runRecordStartStep(run);
    return (
      <div key={run.id} className={`mt-2 ${CARD_SURFACE} px-3 py-2 cursor-pointer`} data-testid={`coding-agent-live-run-${run.id}`} data-plain="true" onClick={cardOpen(() => onOpenRun(run.id))}>
        <Heading icon="smart_toy" chip={runChip(run)} title={firstLine(run.task)} onOpen={() => onOpenRun(run.id)} testId={`coding-agent-live-open-run-${run.id}`} />
        {last && (
          <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]" data-testid={`coding-agent-live-now-${run.id}`}>
            {t("codingAgent.rowNow", { step: describeStep(t, last).label })}
          </p>
        )}
        {startStep && stepLine(`coding-agent-live-run-step-${run.id}`, runStepWord[startStep], run.id, run.startedAt)}
        <DiagramFigures source={{ kind: "run", run }} lookup={runOf} />
      </div>
    );
  };
  /** The newest settled team: one row — the chart is on its page. */
  const teamRow = (team: TeamView) => (
    <div key={team.id} className={`mt-2 ${CARD_SURFACE} px-3 py-2 cursor-pointer`} data-testid={`coding-agent-live-team-${team.id}`} data-kind="team" data-plain="true" onClick={cardOpen(() => onOpenTeam(team))}>
      <Heading icon="groups" chip={teamChip(team)} title={firstLine(team.goal)} extra={tasksCount(team)} onOpen={() => onOpenTeam(team)} testId={`coding-agent-live-open-team-${team.id}`} />
    </div>
  );
  /** Something waiting its turn: the same row, with its place in line. */
  const queuedChip = (position: number | undefined) => (
    <span className={`${chipClass} ${TEAM_STATUS_TONE.queued}`}>
      {t("codingAgent.team.status.queued")}
      {position ? <span className="normal-case tracking-normal font-normal">· {t("codingAgent.team.queuePosition", { n: position })}</span> : null}
    </span>
  );
  const queuedTeamRow = (team: TeamView) => (
    <div key={team.id} className={`mt-2 ${CARD_SURFACE} px-3 py-2 cursor-pointer`} data-testid={`coding-agent-live-team-${team.id}`} data-kind="team" data-queued="true" onClick={cardOpen(() => onOpenTeam(team))}>
      <Heading icon="groups" chip={queuedChip(team.queuePosition)} title={firstLine(team.goal)} onOpen={() => onOpenTeam(team)} testId={`coding-agent-live-open-team-${team.id}`} />
    </div>
  );
  const queuedRunRow = (run: LiveRun) => (
    <div key={run.id} className={`mt-2 ${CARD_SURFACE} px-3 py-2 cursor-pointer`} data-testid={`coding-agent-live-run-${run.id}`} data-queued="true" onClick={cardOpen(() => onOpenRun(run.id))}>
      <Heading icon="smart_toy" chip={queuedChip(run.queued?.position)} title={firstLine(run.task)} onOpen={() => onOpenRun(run.id)} testId={`coding-agent-live-open-run-${run.id}`} />
    </div>
  );

  /** A start before its record: "Starting…" and its step — or, refused, the reason. */
  const startRow = (start: CodingStartView) => {
    const failed = start.failedAt !== null;
    const tone = failed ? RUN_TONE.failed : RUN_TONE.running;
    return (
      <div
        key={`start-${start.id}`}
        className={`mt-2 ${CARD_SURFACE} px-3 py-2`}
        data-testid={`coding-agent-live-start-${start.id}`}
        data-kind={start.kind}
        data-step={failed ? "failed" : start.step}
      >
        <div className="flex min-h-[36px] min-w-0 items-center gap-2">
          <span className="material-symbols-rounded shrink-0 text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">{start.kind === "team" ? "groups" : "smart_toy"}</span>
          <span className={`${chipClass} ${tone?.chip ?? ""} ${failed ? "" : "coding-agent-pulse"}`}>
            {!failed && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />}
            {t(failed ? "codingAgent.start.failed" : "codingAgent.start.starting")}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]" title={start.task}>{firstLine(start.task) || start.projectId || start.id}</span>
        </div>
        {failed
          ? <p className="mt-0.5 text-[11px] text-[var(--danger,#fca5a5)]" data-testid={`coding-agent-live-start-error-${start.id}`}>{start.error}</p>
          : stepLine(`coding-agent-live-start-step-${start.id}`, runStepWord[start.step], start.id, start.requestedAt)}
      </div>
    );
  };

  const label = atWork > 0 ? t("codingAgent.diagram.liveTitle") : latest ? t("codingAgent.diagram.latestTitle") : t("codingAgent.agentsTitle");
  return (
    <section className="mt-3" data-testid="coding-agent-live-agents" data-live={atWork} data-queued={waiting || undefined} aria-label={label}>
      <p className={SECTION_LABEL}>
        <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{atWork > 0 ? "bolt" : "history"}</span>
        {label}
        {atWork > 0 && <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">{atWork}</span>}
      </p>
      {startsOnWay.map(startRow)}
      {startsFailed.map(startRow)}
      {liveTeams.map(teamCard)}
      {liveRuns.map((run) => (runHasHelpers(run) ? runCard(run) : runRow(run)))}
      {queuedTeams.map(queuedTeamRow)}
      {queuedRuns.map(queuedRunRow)}
      {latest?.kind === "team" && teamRow(latest.team)}
      {latest?.kind === "run" && runRow(latest.run)}
      {atWork === 0 && waiting === 0 && !latest && startsFailed.length === 0 && (
        <div className={`mt-2 ${CARD_SURFACE} flex flex-col items-center gap-3 px-4 py-5`} data-testid="coding-agent-live-empty">
          <p className="max-w-[36rem] text-center text-[13px] leading-relaxed text-[var(--text-secondary)]">{t("codingAgent.nothingRunYet")}</p>
          {onAsk && (
            <button type="button" onClick={onAsk} data-testid="coding-agent-live-ask" className={BTN_PRIMARY_WIDE}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">chat</span>
              {t("codingAgent.askInChat")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
