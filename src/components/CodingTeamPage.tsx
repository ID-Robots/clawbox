"use client";

/**
 * A coding TEAM's own page (the 2026-10-30 redesign's step 5): the
 * multi-agent shape of the coding agent (src/lib/coding-team.ts) as ONE
 * column — how it stands, the goal, how far along, Stop, the real chart of
 * its agents (CodingAgentDiagram: click a worker, see what it is doing right
 * now — the 2026-10-12 ruling, kept), the tasks in outline order with their
 * worker's and reviewer's state, the pull request, the result, and a closed
 * Details fold for the branch, the planner, the log and the advice. It
 * replaced the project page's Team tab and its card (CodingTeamCard.tsx),
 * whose empty state was a drawing of the shape a team takes — the owner's
 * "the old team chart is a fake image".
 *
 * No inputs: a team is asked for in the chat (the Create card with the team
 * switch on), and the assistant reads its inbox and messages through
 * `coding_team_status`. The page reads nothing on a clock of its own — the
 * app's live poll carries the team list — and asks the box for one thing by
 * id: a board the list lacks, or the whole copy of a settled board the list
 * sent slim (its log and its tasks' text), once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { isLive } from "@/lib/coding-agent-status";
import { renderText } from "@/lib/chat-markdown";
import { MAX_TEAM_CI_ROUNDS } from "@/lib/coding-ci-limits";
import { taskProgress, teamGraph } from "@/lib/coding-agent-graph";
import type { CodingProvider } from "@/lib/coding-provider";
import type { ModelRole } from "@/lib/coding-role-models";
import { BTN_BASE, BTN_DANGER, BTN_SECONDARY, CARD_SURFACE, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import CodingAgentDiagram, { DiagramDetails, type DiagramRun } from "./CodingAgentDiagram";
import CodingTaskDialog from "./CodingTaskDialog";
import CodingModelChip, { TeamModelChip } from "./CodingModelChip";
import { codingModelName, memberModelFields, runModelId, teamMemberModels } from "@/lib/coding-model-names";
import { timeAgo } from "./clawkeep-ui";

export interface TeamTaskView {
  task_id: string;
  task_description: string;
  assigned_to: string | null;
  status: "pending" | "in_progress" | "complete" | "failed" | "rejected" | "retired";
  result: string | null;
  depends_on: string[];
  review: { verdict: "accepted" | "rejected"; notes: string; at: number } | null;
  attempts: number;
  /** The reviewer run that ruled on the current attempt. */
  reviewRunId?: string | null;
  /** Who put it on the board: the plan, or the lead while the team ran. Absent from an older server. */
  origin?: "plan" | "lead";
  /** Why it is back to pending: a dependency it started on was reopened (coding-team-board.ts holdTask). Absent from an older server. */
  hold?: { dependency: string; reason: string; at: number } | null;
  /** How many of its attempts were held, re-offered for red CI, or re-offered after the team stopped a worker past its budget, rather than judged. Absent from an older server. */
  holds?: number;
  ciReoffers?: number;
  budgetReoffers?: number;
}

/** One run's part in the team — the board's cast list (coding-team-board.ts TeamRunRef). */
export interface TeamRunView {
  id: string;
  role: "planner" | "worker" | "reviewer" | "lead";
  taskId: string | null;
  /** Tokens the run spent, once it settled. */
  tokens?: number;
  /** The account it started on, the model there (null where the plan decides)
   *  and the role that choice was made for. Absent from an older server. */
  provider?: CodingProvider | null;
  model?: string | null;
  modelRole?: ModelRole | null;
}

/**
 * The dependencies a pending task still waits for: every one not yet ACCEPTED
 * (or retired) — the server's own gate (`readyTasks`), said on the page so a
 * task sitting pending behind a finished-but-unreviewed one says why.
 */
export function waitingFor(task: TeamTaskView, tasks: readonly TeamTaskView[]): string[] {
  if (task.status !== "pending") return [];
  return task.depends_on.filter((d) => {
    const dep = tasks.find((x) => x.task_id === d);
    return !dep || (dep.status !== "retired" && !(dep.status === "complete" && dep.review?.verdict === "accepted"));
  });
}

/** The team's figures, as the server works them out from the board. */
export interface TeamMetricsView {
  plannerRuns: number;
  workerRuns: number;
  reviewerRuns: number;
  leadRuns: number;
  tasksPlanned: number;
  tasksAdded: number;
  tasksRetired: number;
  tasksAcceptedFirstTry: number;
  tasksRejected: number;
  tokensUsed: number;
  /** The same tokens by the role that spent them. Absent from an older server. */
  tokensByRole?: { planner: number; worker: number; reviewer: number; lead: number };
  /** The same tokens by the account that paid for them — a team's roles may
   *  run on different ones. Absent from an older server; an account no run
   *  used may be absent too. */
  tokensByProvider?: Partial<Record<CodingProvider, number>>;
  wallMs: number;
}

export interface TeamLogEntryView {
  ts: number;
  actor: { kind: string; id?: string };
  type: string;
  /** The task the entry is about — for a message, the sender's task. */
  task_id?: string;
  message: string;
  /** A `message` entry's payload (coding-team-board.ts TeamMessagePayload), or a `note`'s `undelivered` (UndeliveredNote); other payloads are not read here. */
  payload?: Record<string, unknown>;
}

export interface TeamView {
  id: string;
  goal: string;
  projectId: string | null;
  directory: string;
  status: "queued" | "planning" | "working" | "reviewing" | "done" | "failed" | "stopped";
  /** A queued team's place in line (1 is next). Absent from an older server, and on any other team. */
  queuePosition?: number;
  plannerRunId: string | null;
  /** The team's branch in the project and what it forked from; null when the team works in place. */
  branch?: string | null;
  base?: string | null;
  /** Who worked, counted by the server from the board's cast list. `leads` is absent from an older server. */
  agents?: { planner: number; workers: number; reviewers: number; leads?: number; total: number };
  /** The size and review the planner chose for this goal; null when it chose none (the default team). */
  shape?: { parallelism: number; review: "each" | "final" | "none"; rationale: string } | null;
  /** The lead's switch as it stood when the team started. */
  dynamic?: boolean;
  /** Why a single run would have been cheaper (coding-team-board.ts teamAdvice), or null. Absent from an older server. */
  advice?: { reason: "one_task" | "overlap"; overlap: number } | null;
  /** The plan had one task, so it ran as one ordinary run. Absent from an older server. */
  singleRun?: boolean;
  /** The planner's map of what the goal touches, handed to every worker. Absent from an older server, and before the plan. */
  repoMap?: { files: string[]; entryPoints: string[]; testCommands: string[]; gotchas: string[] } | null;
  /** The one review of the merged result, when the shape asked for it. */
  finalReview?: { verdict: "accepted" | "rejected"; notes: string; at: number } | null;
  /** The pull request the goal asked for, once the orchestrator opened it (coding-team-board.ts TeamPr). Absent from an older server. */
  pr?: {
    number: number;
    url: string;
    branch: string;
    base: string;
    phase: "checks" | "failed_checks" | "green" | "merged" | "left_open" | "failed";
    checks: { total: number; passed: number; failed: number; pending: number };
    merge: boolean;
    ciRounds: number;
    failure: { tests: string[]; checks: string[] } | null;
    detail: string | null;
  } | null;
  metrics?: TeamMetricsView;
  /** Every run that worked for the team, in the order they started — what the agent diagram draws. Absent from an older server. */
  runs?: TeamRunView[];
  tasks: TeamTaskView[];
  log: TeamLogEntryView[];
  alerts: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** A settled board the list sent with its log and its tasks' text emptied (`?slim=1`, src/lib/coding-agent-slim.ts). */
  slim?: boolean;
}

export const TEAM_STATUS_TONE: Record<TeamView["status"], string> = {
  queued: "text-indigo-300 border-indigo-300/40",
  planning: "text-sky-300 border-sky-400/40",
  working: "text-amber-400 border-amber-400/40",
  reviewing: "text-violet-300 border-violet-400/40",
  done: "text-emerald-400 border-emerald-400/40",
  failed: "text-red-300 border-red-400/40",
  stopped: "text-[var(--text-muted)] border-white/20",
};

/** At work: planning, working or reviewing — a queued team has not started, a settled one has stopped. */
export function isTeamActive(status: TeamView["status"]): boolean {
  return status === "planning" || status === "working" || status === "reviewing";
}

/** The translation key for a pull request's phase: keys are camelCase. */
const PR_PHASE_KEY: Record<NonNullable<TeamView["pr"]>["phase"], string> = {
  checks: "codingAgent.team.prPhase.checks",
  failed_checks: "codingAgent.team.prPhase.failedChecks",
  green: "codingAgent.team.prPhase.green",
  merged: "codingAgent.team.prPhase.merged",
  left_open: "codingAgent.team.prPhase.leftOpen",
  failed: "codingAgent.team.prPhase.failed",
};

const PR_PHASE_TONE: Record<NonNullable<TeamView["pr"]>["phase"], string> = {
  checks: "text-amber-400 border-amber-400/40",
  failed_checks: "text-red-300 border-red-400/40",
  green: "text-emerald-400 border-emerald-400/40",
  merged: "text-violet-300 border-violet-400/40",
  left_open: "text-sky-300 border-sky-400/40",
  failed: "text-red-300 border-red-400/40",
};

/** The translation key for a task status: keys are camelCase, statuses are the brief's. */
const TASK_KEY: Record<TeamTaskView["status"], string> = {
  pending: "pending",
  in_progress: "inProgress",
  complete: "complete",
  failed: "failed",
  rejected: "rejected",
  retired: "retired",
};

const TASK_TONE: Record<TeamTaskView["status"], string> = {
  pending: "text-[var(--text-muted)] border-white/20",
  in_progress: "text-amber-400 border-amber-400/40",
  complete: "text-emerald-400 border-emerald-400/40",
  failed: "text-red-300 border-red-400/40",
  rejected: "text-red-300 border-red-400/40",
  retired: "text-[var(--text-muted)] border-white/10",
};

const chip = "text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 inline-flex items-center gap-1.5";

const LOG_SHOWN = 30;
/** How long an armed Stop stays armed before it disarms itself. */
const CONFIRM_MS = 5_000;
/** The goal's first line on the page; a longer goal opens whole in the dialog. */
const GOAL_SHOWN = 160;

const RUN_ID = /^run-[a-z0-9]{8}$/;

/**
 * A team message that never reached its sibling because the sibling had
 * already finished — a `note` on the board, not an alert — or null for any
 * other entry. Only the sender and the receiver are read, both run ids.
 */
function unreachedOf(entry: TeamLogEntryView): { role: string; from: string; toRunId: string } | null {
  if (entry.type !== "note" || !entry.payload) return null;
  const u = entry.payload.undelivered as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object" || u.to !== "sibling") return null;
  if (typeof u.role !== "string" || typeof u.from !== "string" || !RUN_ID.test(u.from) || typeof u.toRunId !== "string" || !RUN_ID.test(u.toRunId)) return null;
  return { role: u.role, from: u.from, toRunId: u.toRunId };
}

/** A run of the team speaking, as the board recorded it — or null for any other entry, or a payload that is not one. */
interface TeamMessageView {
  role: string;
  from: string;
  to: "sibling" | "lead" | "owner_agent";
  toRunId: string | null;
  text: string;
  delivered: boolean;
}

function teamMessageOf(entry: TeamLogEntryView): TeamMessageView | null {
  if (entry.type !== "message" || !entry.payload) return null;
  const p = entry.payload;
  if (typeof p.from !== "string" || typeof p.text !== "string") return null;
  if (p.to !== "sibling" && p.to !== "lead" && p.to !== "owner_agent") return null;
  return {
    role: entry.actor.kind,
    from: p.from,
    to: p.to,
    toRunId: typeof p.toRunId === "string" ? p.toRunId : null,
    text: p.text,
    delivered: p.delivered !== false,
  };
}

function firstLine(text: string, max = GOAL_SHOWN): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}

/** Whether the goal says more than its first line on the page does. */
function goalHasMore(goal: string): boolean {
  const lines = goal.split("\n").filter((l) => l.trim());
  return lines.length > 1 || (lines[0]?.length ?? 0) > GOAL_SHOWN;
}

/**
 * The board this page draws: the app's copy when its list has it, read by id
 * when it does not (once, and again whenever `refreshKey` — the app's runs —
 * moves on), and a settled board the list sent slim read WHOLE once by id —
 * its log and its tasks' text never change again. Only while the page is
 * open: the list the app polls stays slim.
 */
export function useTeamBoard(teamId: string | null, known: TeamView | null, refreshKey: unknown): TeamView | null {
  const [fetched, setFetched] = useState<{ id: string; team: TeamView } | null>(null);
  // `asked` holds a slim id for as long as its read is in flight or answered;
  // a read that fails lets it go, so the next render asks again.
  const asked = useRef(new Set<string>());
  const missing = teamId !== null && !known;
  const slimId = known?.slim ? known.id : null;
  useEffect(() => {
    if (!teamId || (!missing && !slimId)) return;
    if (slimId && asked.current.has(slimId)) return;
    if (slimId) asked.current.add(slimId);
    void (async () => {
      try {
        const res = await fetch(`/setup-api/coding-agent/team?id=${encodeURIComponent(teamId)}`, { cache: "no-store" });
        const data = await res.json().catch(() => null) as { team?: TeamView } | null;
        if (!res.ok || !data?.team) {
          if (slimId) asked.current.delete(slimId);
          return;
        }
        // Keyed by id, no cleanup flag: a late answer can only fill in its
        // own board, and a flag that dropped it left Strict Mode's first
        // read, and the board, slim.
        setFetched({ id: teamId, team: data.team });
      } catch {
        if (slimId) asked.current.delete(slimId);
      }
    })();
  }, [teamId, missing, slimId, refreshKey]);
  if (!teamId) return null;
  if (known && !known.slim) return known;
  if (known && fetched?.id === teamId) return { ...known, log: fetched.team.log, tasks: fetched.team.tasks, slim: false };
  return known ?? (fetched?.id === teamId ? fetched.team : null);
}

/** The run a task's row opens: the worker while it works, the reviewer while it is judged, the worker's run once done. */
export function activeRunOf(task: TeamTaskView): string | null {
  if (task.status === "in_progress") return task.assigned_to;
  if (task.status === "complete" && !task.review && task.reviewRunId) return task.reviewRunId;
  return task.assigned_to ?? task.reviewRunId ?? null;
}

interface Props {
  teamId: string;
  /** The app's copy of the team — slim for a settled one — or null when its list lacks it. */
  team: TeamView | null;
  /** The app's own copy of the runs: a node's state and its panel read a team's run from here first. */
  runs?: DiagramRun[];
  /** Open a run's page — the planner's, a worker's, a reviewer's. */
  onOpenRun: (runId: string) => void;
  /** Stop answered: the host re-reads its list, which is what this page draws. */
  onChanged: () => void;
  /** Changes whenever the host's data does. */
  refreshKey?: unknown;
}

export default function CodingTeamPage({ teamId, team: known, runs, onOpenRun, onChanged, refreshKey }: Props) {
  const { t } = useT();
  const team = useTeamBoard(teamId, known, refreshKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  // Stop is two taps, not a browser confirm(): the second tap is the
  // confirmation. The offer is taken back on its own after CONFIRM_MS and on
  // blur — an armed red button found minutes later is a mis-tap waiting to
  // happen. A timer rather than blur alone: iOS Safari does not focus a
  // button on tap.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = useCallback(() => {
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmed(false);
  }, []);
  const arm = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => { armTimer.current = null; setArmed(false); }, CONFIRM_MS);
    setArmed(true);
  };
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);

  const runOf = useCallback((id: string) => runs?.find((r) => r.id === id), [runs]);

  /** Stop the team at work, or — for a queued one — take it out of the queue: the same route, the owner's alone. */
  const stop = async () => {
    if (!team) return;
    disarm();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/team/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: team.id }),
      });
      const data = await res.json().catch(() => null) as { team?: TeamView; error?: string } | null;
      if (!res.ok || !data?.team) throw new Error(data?.error ?? t("codingAgent.team.stopFailed"));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.team.stopFailed"));
    } finally {
      setBusy(false);
    }
  };

  // The tasks in OUTLINE order — the chart's own order (coding-agent-graph.ts
  // `outline`: a task under the dependency it waits for last), with its depth
  // as an indent — so the list reads the way the chart is drawn.
  const ordered = useMemo(() => {
    if (!team) return [] as { task: TeamTaskView; depth: number }[];
    const lanes = teamGraph(team, runOf).lanes.filter((l) => l.kind === "task" && l.taskId !== null);
    const byId = new Map(team.tasks.map((x) => [x.task_id, x]));
    const out: { task: TeamTaskView; depth: number }[] = [];
    for (const lane of lanes) {
      const task = byId.get(lane.taskId!);
      if (task) { out.push({ task, depth: lane.depth }); byId.delete(lane.taskId!); }
    }
    for (const task of byId.values()) out.push({ task, depth: 0 });
    return out;
  }, [team, runOf]);

  if (!team) {
    return (
      <div className="mt-1 pb-6" data-testid="coding-agent-team-page" data-team-id={teamId} data-loading="true">
        <p className="mt-3 text-xs text-[var(--text-muted)]" data-testid="coding-team-loading">{t("codingAgent.team.loading")}</p>
      </div>
    );
  }

  const active = isTeamActive(team.status);
  const queued = team.status === "queued";
  const progress = taskProgress(team);
  const done = team.tasks.filter((x) => x.status !== "retired" && x.status === "complete" && (!x.review || x.review.verdict === "accepted")).length;
  const pct = progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;
  const title = firstLine(team.goal);
  const more = goalHasMore(team.goal);
  const meta = [
    t("codingAgent.team.startedAgo", { when: timeAgo(team.createdAt, t) }),
    team.branch ? team.branch : null,
    team.agents?.total ? t("codingAgent.chatAgents", { n: team.agents.total }) : null,
  ].filter((x): x is string => Boolean(x));

  /** "worker: Working" — the worker's state, from the task's status. */
  const workerState = (task: TeamTaskView): string => {
    switch (task.status) {
      case "in_progress": return t("codingAgent.diagram.state.working");
      case "complete": return t("codingAgent.diagram.state.done");
      case "failed": return t("codingAgent.diagram.state.failed");
      case "rejected": return t("codingAgent.diagram.state.rejected");
      case "retired": return t("codingAgent.team.task.retired");
      default: return t("codingAgent.diagram.state.queued");
    }
  };
  /** "reviewer: Accepted" — the verdict, or where the review stands; null while the task has nothing to review. */
  const reviewerState = (task: TeamTaskView): string | null => {
    if (task.review) return t(`codingAgent.team.review.${task.review.verdict}`);
    if (task.status !== "complete") return null;
    const reviewer = task.reviewRunId ? runOf(task.reviewRunId) : undefined;
    return reviewer && isLive(reviewer.status) ? t("codingAgent.diagram.state.reviewing") : t("codingAgent.team.reviewWaiting");
  };

  const stopButton = (active || queued) && (
    <button
      type="button"
      onClick={() => { if (armed) void stop(); else arm(); }}
      onBlur={disarm}
      disabled={busy}
      data-testid={queued ? "coding-team-cancel" : "coding-team-stop"}
      data-armed={armed || undefined}
      className={`${armed ? BTN_DANGER : BTN_SECONDARY} w-full @md:w-auto`}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">{queued ? "close" : "stop_circle"}</span>
      {armed
        ? t(queued ? "codingAgent.team.cancelConfirm" : "codingAgent.team.stopConfirm")
        : t(queued ? "codingAgent.team.cancel" : "codingAgent.team.stop")}
    </button>
  );

  return (
    <div className="mt-1 pb-6" data-testid="coding-agent-team-page" data-team-id={team.id} data-status={team.status}>
      {/* 1. STATUS: how the team stands, the goal, the facts. */}
      <div className={`${CARD_SURFACE} px-4 py-3`} data-testid="coding-team-head">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`${chip} ${TEAM_STATUS_TONE[team.status] ?? TEAM_STATUS_TONE.stopped} ${active ? "coding-agent-pulse" : ""}`} data-testid="coding-team-status">
            {active && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />}
            {t(`codingAgent.team.status.${team.status}`)}
          </span>
          {queued && team.queuePosition && (
            <span className="text-[11px] text-indigo-200/90" data-testid="coding-team-queue-position">
              {t("codingAgent.team.queuePosition", { n: team.queuePosition })}
            </span>
          )}
          {/* What the team runs on ("Sonnet 5 · Opus 5.5" — the owner, 2026-11-01): the workers' model first. */}
          <TeamModelChip members={teamMemberModels(team, runOf)} testId="coding-team-model" style={{ maxWidth: 200 }} />
          {team.pr && (
            <a href={team.pr.url} target="_blank" rel="noreferrer" className={`${chip} text-violet-300 border-violet-400/40 hover:bg-violet-400/10`} data-testid="coding-team-pr-chip">
              {t("codingAgent.viewPr", { n: team.pr.number })}
            </a>
          )}
        </div>
        {/* The goal: its first line, three lines at most, itself a tap target
            for the whole goal when there is more, and the 44-px button under
            it (the run page's "Show the whole task" pattern). */}
        <h2 className="mt-2 text-[15px] leading-snug font-semibold text-[var(--text-primary)] break-words" data-testid="coding-team-goal">
          {more ? (
            <button type="button" onClick={() => setGoalOpen(true)} className="text-left line-clamp-3 hover:text-white cursor-pointer" title={t("codingAgent.team.showWholeGoal")}>
              {title}
            </button>
          ) : (
            <span className="line-clamp-3">{title}</span>
          )}
        </h2>
        {more && (
          <button type="button" onClick={() => setGoalOpen(true)} data-testid="coding-team-goal-open" className={`${BTN_SECONDARY} mt-2 w-full @md:w-auto`}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">open_in_full</span>
            {t("codingAgent.team.showWholeGoal")}
          </button>
        )}
        <p className="mt-2 text-[11px] text-[var(--text-muted)] break-words" data-testid="coding-team-meta">{meta.join(" · ")}</p>
      </div>

      {/* 2. PHASE: how far along, in one line and a bar; the alerts as one amber line. */}
      <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-team-phase" data-done={done} data-total={progress.total}>
        <p className="text-xs font-semibold text-[var(--text-primary)]">
          {t(`codingAgent.team.phase.${team.status}`, { done, total: progress.total })}
        </p>
        {progress.total > 0 && (
          <div className="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden" aria-hidden="true">
            <div className="h-full rounded-full bg-violet-400/70 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        )}
        {team.tasks.length === 0 && active && (
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t("codingAgent.team.planning")}</p>
        )}
        {team.alerts > 0 && (
          <p className="mt-1.5 text-[11px] text-amber-400 flex items-center gap-1" data-testid="coding-team-alerts">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">warning</span>
            {t("codingAgent.team.alerts", { n: team.alerts })}
          </p>
        )}
      </div>

      {/* 3. CONTROLS: Stop (or Cancel for a team still in line), two taps. */}
      {stopButton && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="coding-team-actions">
          {stopButton}
          {error && <p className="text-[11px] text-red-300 break-words" role="alert" data-testid="coding-team-error">{error}</p>}
        </div>
      )}
      {!stopButton && error && <p className="mt-3 text-[11px] text-red-300 break-words" role="alert" data-testid="coding-team-error">{error}</p>}

      {/* 4. WHY IT STOPPED, right under the status on a team that failed. */}
      {team.error && (
        <div className={`mt-3 ${CARD_SURFACE} border-red-400/30 px-4 py-3`}>
          <p className={SECTION_LABEL}>{t("codingAgent.chatTeam.reason")}</p>
          <p className="mt-1 text-xs text-red-300 break-words whitespace-pre-wrap" data-testid="coding-team-reason">{team.error}</p>
        </div>
      )}

      {/* 5. THE CHART — every agent that worked here, in the state it is in,
          the ones at work pulsing; a click on one says what it is doing now.
          ONE rendering at every width: CodingAgentDiagram measures its
          container and goes compact under COMPACT_BELOW, its panel a sheet
          below under SHEET_BELOW and beside the chart above it. */}
      <CodingAgentDiagram
        source={{ kind: "team", team }}
        runOf={runOf}
        onOpenRun={onOpenRun}
        onChanged={onChanged}
        refreshKey={refreshKey ?? team.updatedAt}
        testId="coding-team-diagram"
        className="mt-3"
      />

      {/* 6. THE TASKS in outline order, a dependency's depth as an indent:
          status · title · "worker: … · reviewer: …"; a tap opens the run at
          work on it. "Waits for t2" is words, never arrows. */}
      {ordered.length > 0 && (
        <section className="mt-4" data-testid="coding-team-tasks-section">
          <h3 className={`${SECTION_LABEL} px-0.5`}>
            {t("codingAgent.team.tasksTitle")}
            <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">{progress.total}</span>
          </h3>
          <ol className="mt-2 flex flex-col gap-1.5" data-testid="coding-team-tasks">
            {ordered.map(({ task, depth }) => {
              const target = activeRunOf(task);
              const waits = waitingFor(task, team.tasks);
              const reviewer = reviewerState(task);
              // The model its worker runs on — the current attempt's.
              const workerModel = task.assigned_to
                ? runModelId(memberModelFields(team.runs?.find((r) => r.id === task.assigned_to), runOf(task.assigned_to)))
                : null;
              const second = [
                t("codingAgent.team.taskWorker", { state: workerState(task) }),
                reviewer ? t("codingAgent.team.taskReviewer", { state: reviewer }) : null,
                waits.length > 0 ? t("codingAgent.team.waitingFor", { ids: waits.join(", ") }) : null,
                task.hold ? t("codingAgent.team.held", { task: task.hold.dependency }) : null,
                task.origin === "lead" ? t("codingAgent.team.addedByLead") : null,
              ].filter((x): x is string => Boolean(x)).join(" · ");
              const body = (
                <>
                  <span className={`${chip} shrink-0 mt-0.5 ${TASK_TONE[task.status] ?? TASK_TONE.pending} ${task.status === "in_progress" ? "coding-agent-pulse" : ""}`}>
                    {t(`codingAgent.team.task.${TASK_KEY[task.status] ?? task.status}`)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-xs break-words ${task.status === "retired" ? "text-[var(--text-muted)] line-through decoration-white/30" : "text-[var(--text-primary)]"}`}>
                      <span className="font-mono text-[11px] text-[var(--text-muted)] mr-1.5">{task.task_id}</span>
                      {task.task_description ? firstLine(task.task_description, 120) : ""}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="text-[11px] text-[var(--text-muted)] break-words" data-testid={`coding-team-task-state-${task.task_id}`}>{second}</span>
                      <CodingModelChip label={workerModel ? codingModelName(workerModel) : null} title={workerModel} testId={`coding-team-task-model-${task.task_id}`} style={{ maxWidth: 140 }} />
                    </span>
                    {task.review?.notes && task.review.verdict === "rejected" && (
                      <span className="block text-[11px] text-red-300 mt-0.5 break-words">{task.review.notes}</span>
                    )}
                  </span>
                  {target && <span className="material-symbols-rounded text-[var(--text-muted)] shrink-0" style={{ fontSize: 18 }} aria-hidden="true">chevron_right</span>}
                </>
              );
              return (
                <li
                  key={task.task_id}
                  data-testid={`coding-team-task-${task.task_id}`}
                  data-status={task.status}
                  data-depth={depth}
                  data-run={target ?? undefined}
                  style={{ marginLeft: Math.min(depth, 4) * 12 }}
                >
                  {target ? (
                    <button
                      type="button"
                      onClick={() => onOpenRun(target)}
                      data-testid={`coding-team-task-open-${task.task_id}`}
                      className={`${INSET_SURFACE} w-full min-h-[56px] flex items-start gap-2.5 px-3 py-2 text-left hover:bg-black/35 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)]`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={`${INSET_SURFACE} w-full min-h-[56px] flex items-start gap-2.5 px-3 py-2`}>{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* 7. THE PULL REQUEST the goal asked for — the orchestrator's: its
          checks, the rounds its red CI sent tasks back, and how it ended. */}
      {team.pr && (
        <div className={`mt-3 ${CARD_SURFACE} px-4 py-3 text-[11px] break-words`} data-testid="coding-team-pr" data-phase={team.pr.phase}>
          <div className="flex items-center gap-2 flex-wrap">
            <a href={team.pr.url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[var(--text-primary)] underline decoration-white/20 hover:text-white">
              {t("codingAgent.team.pr", { n: team.pr.number })}
            </a>
            <span className={`${chip} ${PR_PHASE_TONE[team.pr.phase] ?? PR_PHASE_TONE.checks}`}>
              {t(PR_PHASE_KEY[team.pr.phase] ?? PR_PHASE_KEY.checks)}
            </span>
            {team.pr.checks.total > 0 && (
              <span className="text-[var(--text-muted)]">{t("codingAgent.team.prChecks", { passed: team.pr.checks.passed, total: team.pr.checks.total })}</span>
            )}
            {team.pr.ciRounds > 0 && (
              <span className="text-[var(--text-muted)]" data-testid="coding-team-ci-rounds">{t("codingAgent.team.ciRounds", { n: team.pr.ciRounds, max: MAX_TEAM_CI_ROUNDS })}</span>
            )}
            {team.pr.merge && team.pr.phase !== "merged" && (
              <span className="text-[var(--text-muted)]">· {t("codingAgent.team.mergeWhenGreen")}</span>
            )}
          </div>
          {team.pr.failure && team.pr.failure.tests.length > 0 && team.pr.phase !== "merged" && team.pr.phase !== "green" && (
            <p className="mt-1 text-red-300" data-testid="coding-team-ci-failing">{t("codingAgent.team.ciFailing", { tests: team.pr.failure.tests.slice(0, 5).join(", ") })}</p>
          )}
          {team.pr.detail && <p className="mt-1 text-[var(--text-muted)]">{team.pr.detail}</p>}
        </div>
      )}

      {/* 8. THE RESULT, once there is one: the final review, as Markdown. */}
      {team.finalReview && (
        <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-team-final-review" data-verdict={team.finalReview.verdict}>
          <p className={SECTION_LABEL}>
            {t("codingAgent.team.finalReview")}
            <span className={`${chip} ${team.finalReview.verdict === "accepted" ? "text-emerald-400 border-emerald-400/40" : "text-red-300 border-red-400/40"}`}>
              {t(`codingAgent.team.review.${team.finalReview.verdict}`)}
            </span>
          </p>
          {team.finalReview.notes && (
            <div className={`mt-2 text-xs leading-relaxed break-words ${team.finalReview.verdict === "accepted" ? "text-[var(--text-secondary)]" : "text-red-300"}`} data-testid="coding-team-final-review-notes">
              {renderText(team.finalReview.notes, t("chat.table"))}
            </div>
          )}
        </div>
      )}

      {/* 9. DETAILS, closed: the branch, the planner's run, when it was
          created, the advice on whether one run would have done, and the log
          on request. The inbox and the messages lists went with the card —
          the assistant reads them through coding_team_status. */}
      <DiagramDetails testId="coding-team-details">
        <div className={`${CARD_SURFACE} px-4 py-3 text-[11px] text-[var(--text-secondary)]`}>
          {team.branch && (
            <p data-testid="coding-team-branch">
              <span className="material-symbols-rounded align-[-2px] mr-1" style={{ fontSize: 14 }} aria-hidden="true">fork_right</span>
              {t("codingAgent.team.branch", { branch: team.branch, base: team.base ?? "" })}
            </p>
          )}
          <p className="mt-1 flex items-center gap-1 flex-wrap text-[var(--text-muted)]">
            <span data-testid="coding-team-created">{t("codingAgent.team.created", { when: timeAgo(team.createdAt, t) })}</span>
            {team.plannerRunId && (
              <>
                <span aria-hidden="true">·</span>
                <button type="button" onClick={() => onOpenRun(team.plannerRunId!)} data-testid="coding-team-planner" className="underline decoration-white/20 hover:text-white">
                  {t("codingAgent.team.plannerRun")}
                </button>
              </>
            )}
          </p>
          {/* Whether a single run would have been cheaper: a one-task plan ran as
              one run, and so did a plan whose tasks' files mostly overlap. */}
          {(team.singleRun || team.advice) && (
            <p className="mt-1.5 text-sky-200/90 flex items-start gap-1.5" data-testid="coding-team-advice" data-reason={team.singleRun ? "single_run" : team.advice?.reason}>
              <span className="material-symbols-rounded align-[-2px] shrink-0" style={{ fontSize: 14 }} aria-hidden="true">lightbulb</span>
              <span>
                {team.singleRun
                  ? team.advice?.reason === "overlap"
                    ? t("codingAgent.team.adviceOverlapRun", { n: team.advice.overlap })
                    : t("codingAgent.team.adviceSingleRun")
                  : team.advice?.reason === "one_task"
                    ? t("codingAgent.team.adviceOneTask")
                    : t("codingAgent.team.adviceOverlap", { n: team.advice?.overlap ?? 0 })}
              </span>
            </p>
          )}
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            aria-expanded={showLog}
            data-testid="coding-team-log-toggle"
            className={`${BTN_BASE} mt-2 border border-white/10 text-[var(--text-muted)] hover:bg-white/5`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{showLog ? "expand_less" : "receipt_long"}</span>
            {t("codingAgent.team.log", { n: team.log.length })}
          </button>
          {showLog && (
            <ol className="mt-2 space-y-0.5 font-mono text-[11px] text-[var(--text-muted)] max-h-64 overflow-y-auto" data-testid="coding-team-log">
              {team.log.slice(-LOG_SHOWN).map((e, i) => {
                const m = teamMessageOf(e);
                if (m) {
                  return (
                    <li key={i} className="break-words text-sky-200/90" data-testid="coding-team-log-message" data-to={m.to} data-delivered={m.delivered ? "true" : "false"}>
                      <span className="opacity-60">{new Date(e.ts).toLocaleTimeString()}</span>{" "}
                      <span className="material-symbols-rounded align-[-2px]" style={{ fontSize: 12 }} aria-hidden="true">forum</span>{" "}
                      <span className="text-[var(--text-secondary)]">{m.role} {m.from}</span>{" "}
                      <span>
                        {m.to === "sibling"
                          ? t("codingAgent.team.messageToRun", { run: m.toRunId ?? "" })
                          : m.to === "lead"
                            ? t("codingAgent.team.messageToLead")
                            : t("codingAgent.team.messageToAssistant")}
                      </span>
                      {!m.delivered && <span className="text-amber-400"> · {t("codingAgent.team.messageUndelivered")}</span>}
                      {": "}
                      <span className="whitespace-pre-wrap text-[var(--text-primary)]">{m.text}</span>
                    </li>
                  );
                }
                const u = unreachedOf(e);
                if (u) {
                  return (
                    <li key={i} className="break-words" data-testid="coding-team-log-unreached">
                      <span className="opacity-60">{new Date(e.ts).toLocaleTimeString()}</span>{" "}
                      <span className="material-symbols-rounded align-[-2px]" style={{ fontSize: 12 }} aria-hidden="true">forum</span>{" "}
                      <span className="text-[var(--text-secondary)]">{u.role} {u.from}</span>{" "}
                      {t("codingAgent.team.messageToRun", { run: u.toRunId })} · {t("codingAgent.team.messageUndelivered")}: {t("codingAgent.team.messageReceiverFinished", { run: u.toRunId })}
                    </li>
                  );
                }
                return (
                  <li key={i} className={`break-words ${e.type === "alert" ? "text-amber-400" : ""}`}>
                    <span className="opacity-60">{new Date(e.ts).toLocaleTimeString()}</span>{" "}
                    <span className="text-[var(--text-secondary)]">{e.actor.kind === "worker" ? `worker ${e.actor.id ?? ""}` : e.actor.kind}</span>{" "}
                    {e.message}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </DiagramDetails>

      {goalOpen && (
        <CodingTaskDialog
          title={title}
          task={team.goal}
          runId={team.id}
          onClose={() => setGoalOpen(false)}
        />
      )}
    </div>
  );
}
