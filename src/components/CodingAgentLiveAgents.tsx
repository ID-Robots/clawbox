"use client";

/**
 * The agents, first: what the Coding Agent home opens on, and what a run's
 * page opens on (the owner's brief, 2026-10-12 — "diagram first, then you can
 * see more").
 *
 * Home draws one chart per team at work and one per run at work outside a
 * team; with nothing at work, the newest team or run that was, so the window
 * never opens on a blank. A run's page draws its TEAM when it belongs to one —
 * the run marked on it — and itself with its helpers when it does not.
 *
 * It reads nothing on a clock of its own: the boards and the runs are the
 * app's (its live poll reads the team list beside the runs), and a team the
 * list no longer carries is asked for by id only when the app's data moves on.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { isLive, type CodingRunStatus } from "@/lib/coding-agent-status";
import CodingAgentDiagram, { DiagramFigures, type DiagramRun } from "./CodingAgentDiagram";
import CodingAgentDelegationArt from "./CodingAgentDelegationArt";
import { TEAM_STATUS_TONE, isTeamActive, type TeamView } from "./CodingTeamCard";
import { RUN_TONE } from "./RunProgressBar";
import { BTN_QUIET, CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";

/** A run as the home chart reads it: the diagram's run, and the team it belongs to. */
export interface LiveRun extends DiagramRun {
  team?: { id: string; role: "planner" | "worker" | "reviewer" | "lead"; taskId: string | null } | null;
}

/** The catalogue key of a run's status word — `gave_up` is camelCased there. */
export function runStatusKey(status: CodingRunStatus): string {
  return status === "gave_up" ? "codingAgent.statusGaveUp" : `codingAgent.status${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

/**
 * A team's board: the app's copy when its list has it, else asked of the box
 * by id — once, and again whenever `refreshKey` (the app's runs) moves on.
 */
export function useTeamBoard(teamId: string | null, known: TeamView | null, refreshKey: unknown): TeamView | null {
  const [fetched, setFetched] = useState<{ id: string; team: TeamView } | null>(null);
  const missing = teamId !== null && !known;
  useEffect(() => {
    if (!missing || !teamId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/setup-api/coding-agent/team?id=${encodeURIComponent(teamId)}`, { cache: "no-store" });
        const data = await res.json().catch(() => null) as { team?: TeamView } | null;
        if (!cancelled && res.ok && data?.team) setFetched({ id: teamId, team: data.team });
      } catch {
        // The run's own chart stands in until the board can be read.
      }
    })();
    return () => { cancelled = true; };
  }, [missing, teamId, refreshKey]);
  if (!teamId) return null;
  return known ?? (fetched?.id === teamId ? fetched.team : null);
}

const chipClass = "shrink-0 text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5";

/** A chart's heading row: what it is of, how it stands, and the way to its page. */
function ChartHeader({ icon, chip, title, action, onAction, testId }: { icon: string; chip: ReactNode; title: string; action: string; onAction?: () => void; testId?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="material-symbols-rounded shrink-0 text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">{icon}</span>
      {chip}
      <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]" title={title}>{title}</p>
      {onAction && (
        <button type="button" onClick={onAction} className={`${BTN_QUIET} !px-2`} data-testid={testId}>
          {action}
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">chevron_right</span>
        </button>
      )}
    </div>
  );
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}

/**
 * The chart atop a run's page: its team, with this run marked, or — solo, or
 * while the board cannot be read — the run and the helpers it sent out.
 */
export function RunAgentsDiagram({ run, teams, runOf, onOpenRun, onChanged, refreshKey }: {
  run: LiveRun;
  teams: TeamView[];
  runOf: (id: string) => DiagramRun | undefined;
  onOpenRun: (id: string) => void;
  onChanged?: () => void;
  refreshKey?: unknown;
}) {
  const known = run.team ? teams.find((x) => x.id === run.team!.id) ?? null : null;
  const board = useTeamBoard(run.team?.id ?? null, known, refreshKey);
  if (run.team && board) {
    return (
      <CodingAgentDiagram
        source={{ kind: "team", team: board }}
        runOf={runOf}
        current={run.id}
        onOpenRun={onOpenRun}
        onChanged={onChanged}
        refreshKey={refreshKey}
        testId="coding-agent-run-diagram"
        className="mt-3"
      />
    );
  }
  // No figure chips over a solo run's chart: the page's rail holds its
  // tiles, and the same four numbers sat twice on one screen. A team chart
  // keeps its task and role bars, which the rail does not draw.
  return (
    <CodingAgentDiagram
      source={{ kind: "run", run }}
      current={run.id}
      onOpenRun={onOpenRun}
      onChanged={onChanged}
      refreshKey={refreshKey}
      figures={false}
      testId="coding-agent-run-diagram"
      className="mt-3"
    />
  );
}

export default function CodingAgentLiveAgents({ runs, teams, onOpenRun, openTeamFor, onChanged, refreshKey }: {
  runs: LiveRun[];
  teams: TeamView[];
  onOpenRun: (id: string) => void;
  /** How to open the project page a team works in, on its Team tab — undefined for a team whose project is not on the list. */
  openTeamFor?: (team: TeamView) => (() => void) | undefined;
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
  const waiting = teams.filter((x) => x.status === "queued");
  const atWork = liveTeams.length + liveRuns.length;

  // Nothing at work: the newest thing that was, so the chart is still the first thing here.
  let latest: { kind: "team"; team: TeamView } | { kind: "run"; run: LiveRun } | null = null;
  if (atWork === 0) {
    const lastTeam = [...teams].filter((x) => x.status !== "queued").sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const lastRun = [...runs].filter((r) => solo(r) && r.status !== "draft" && r.status !== "queued").sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))[0] ?? null;
    if (lastTeam && (!lastRun || lastTeam.updatedAt >= (lastRun.completedAt ?? lastRun.startedAt))) latest = { kind: "team", team: lastTeam };
    else if (lastRun) latest = { kind: "run", run: lastRun };
  }

  const teamChart = (team: TeamView) => (
    <CodingAgentDiagram
      key={team.id}
      source={{ kind: "team", team }}
      runOf={runOf}
      onOpenRun={onOpenRun}
      onChanged={onChanged}
      refreshKey={refreshKey}
      testId={`coding-agent-live-team-${team.id}`}
      className="mt-2"
      header={(
        <ChartHeader
          icon="groups"
          chip={<span className={`${chipClass} ${TEAM_STATUS_TONE[team.status] ?? TEAM_STATUS_TONE.stopped}`}>{t(`codingAgent.team.status.${team.status}`)}</span>}
          title={firstLine(team.goal)}
          action={t("codingAgent.diagram.openTeam")}
          onAction={openTeamFor?.(team)}
          testId={`coding-agent-live-open-team-${team.id}`}
        />
      )}
    />
  );
  /** A run that sent out no helper: one node is no chart, so the newest such run is a plain row. */
  const lone = (run: LiveRun) => (run.subagents?.length ?? 0) + (run.activeSubagents?.length ?? 0) === 0;
  const runRow = (run: LiveRun) => (
    <div key={run.id} className={`mt-2 ${CARD_SURFACE} px-3 py-2`} data-testid={`coding-agent-live-run-${run.id}`} data-plain="true">
      <ChartHeader
        icon="smart_toy"
        chip={<span className={`${chipClass} ${RUN_TONE[run.status]?.chip ?? ""}`}>{t(runStatusKey(run.status))}</span>}
        title={firstLine(run.task)}
        action={t("codingAgent.diagram.openRun")}
        onAction={() => onOpenRun(run.id)}
        testId={`coding-agent-live-open-run-${run.id}`}
      />
      <DiagramFigures source={{ kind: "run", run }} lookup={runOf} />
    </div>
  );
  const runChart = (run: LiveRun) => (
    <CodingAgentDiagram
      key={run.id}
      source={{ kind: "run", run }}
      onOpenRun={onOpenRun}
      onChanged={onChanged}
      refreshKey={refreshKey}
      testId={`coding-agent-live-run-${run.id}`}
      className="mt-2"
      header={(
        <ChartHeader
          icon="smart_toy"
          chip={<span className={`${chipClass} ${RUN_TONE[run.status]?.chip ?? ""} ${run.status === "running" ? "coding-agent-pulse" : ""}`}>{t(runStatusKey(run.status))}</span>}
          title={firstLine(run.task)}
          action={t("codingAgent.diagram.openRun")}
          onAction={() => onOpenRun(run.id)}
          testId={`coding-agent-live-open-run-${run.id}`}
        />
      )}
    />
  );

  return (
    <section className="mt-3" data-testid="coding-agent-live-agents" data-live={atWork} aria-label={atWork > 0 ? t("codingAgent.diagram.liveTitle") : t("codingAgent.diagram.latestTitle")}>
      <p className={SECTION_LABEL}>
        <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{atWork > 0 ? "bolt" : "history"}</span>
        {atWork > 0 ? t("codingAgent.diagram.liveTitle") : latest ? t("codingAgent.diagram.latestTitle") : t("codingAgent.agentsTitle")}
        {atWork > 0 && <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">{atWork}</span>}
      </p>
      {liveTeams.map(teamChart)}
      {liveRuns.map(runChart)}
      {latest?.kind === "team" && teamChart(latest.team)}
      {latest?.kind === "run" && (lone(latest.run) ? runRow(latest.run) : runChart(latest.run))}
      {waiting.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="coding-agent-live-queued">
          {waiting.map((q) => (
            <li key={q.id} className="flex min-w-0 items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <span className={`${chipClass} ${TEAM_STATUS_TONE.queued}`}>{t("codingAgent.team.status.queued")}</span>
              {q.queuePosition && <span className="shrink-0 text-indigo-200/90">{t("codingAgent.team.queuePosition", { n: q.queuePosition })}</span>}
              <span className="min-w-0 truncate">{firstLine(q.goal)}</span>
            </li>
          ))}
        </ul>
      )}
      {atWork === 0 && !latest && (
        <div className={`mt-2 ${CARD_SURFACE} flex flex-col items-center gap-2 px-4 py-4`} data-testid="coding-agent-live-empty">
          <CodingAgentDelegationArt className="opacity-80" />
          <p className="max-w-[36rem] text-center text-[12px] leading-relaxed text-[var(--text-muted)]">{t("codingAgent.diagram.empty")}</p>
        </div>
      )}
    </section>
  );
}
