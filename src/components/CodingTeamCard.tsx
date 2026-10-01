"use client";

/**
 * A coding TEAM on the project page: the multi-agent shape of the coding
 * agent (src/lib/coding-team.ts). The owner hands the team a goal; the
 * card then shows the shared board — the plan the planner posted, each
 * task's status, worker and result, the reviewer's verdict, the alerts the
 * guardrails raised — and the audit log under it, and follows the team
 * while it works. One team at a time on the box, so the form folds away
 * while one is in flight and Stop takes its place.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_BASE, BTN_SECONDARY, CARD_SURFACE, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import CodingTeamTree from "./CodingTeamTree";
import { formatDuration, timeAgo } from "./clawkeep-ui";

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

export interface TeamView {
  id: string;
  goal: string;
  projectId: string | null;
  directory: string;
  status: "planning" | "working" | "reviewing" | "done" | "failed" | "stopped";
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
  /** The one review of the merged result, when the shape asked for it. */
  finalReview?: { verdict: "accepted" | "rejected"; notes: string; at: number } | null;
  metrics?: TeamMetricsView;
  tasks: TeamTaskView[];
  log: TeamLogEntryView[];
  alerts: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Props {
  directory: string;
  projectId: string | null;
  /** Open a run's page — the planner's or a worker's. */
  onOpenRun: (runId: string) => void;
  /**
   * Ask for a team: opens the chat's Create App card on this project with
   * the team switch on, so the goal is written where every other task is
   * and the assistant carries it. Absent on a standalone page, which has no
   * chat to hand to — the card then only shows what ran.
   */
  onPlan?: () => void;
}

const POLL_MS = 5000;
const LOG_SHOWN = 30;
/** The newest team messages shown on the board itself, outside the log. */
const MESSAGES_SHOWN = 5;

const STATUS_TONE: Record<TeamView["status"], string> = {
  planning: "text-sky-300 border-sky-400/40",
  working: "text-amber-400 border-amber-400/40",
  reviewing: "text-violet-300 border-violet-400/40",
  done: "text-emerald-400 border-emerald-400/40",
  failed: "text-red-300 border-red-400/40",
  stopped: "text-[var(--text-muted)] border-white/20",
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

function isActive(status: TeamView["status"]): boolean {
  return status === "planning" || status === "working" || status === "reviewing";
}

/** Compact token counts, the way the runs list writes them: 1.3M, 48k, 950. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.max(0, Math.round(n)));
}

export default function CodingTeamCard({ directory, projectId, onOpenRun, onPlan }: Props) {
  const { t } = useT();
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  // One token per read: a response that started for the previous project
  // (or before an unmount) must not paint over the current one — and one
  // per SCOPE (the project this card is on), so a Start or a Stop that was
  // still in flight when the scope changed neither paints nor invalidates
  // the new scope's reads. The page remounts the card per project, so the
  // scope guard is belt and braces; it costs nothing to be sure.
  const request = useRef(0);
  const scope = useRef(0);

  const load = useCallback(async () => {
    const mine = ++request.current;
    try {
      const res = await fetch("/setup-api/coding-agent/team", { cache: "no-store" });
      const data = await res.json().catch(() => null) as { teams?: TeamView[] } | null;
      if (!res.ok || !data?.teams) return;
      if (mine !== request.current) return;
      setTeams(data.teams.filter((x) => (projectId ? x.projectId === projectId : x.directory === directory)));
    } catch {
      /* the card simply shows what it last read */
    }
  }, [directory, projectId]);

  useEffect(() => {
    scope.current++;
    // The first read of the board happens here: the card has no other
    // moment to ask, and the answer is one render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { request.current++; scope.current++; };
  }, [load]);

  const team = teams[0] ?? null;
  const active = team ? isActive(team.status) : false;

  // Follow a team while it works.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  const stop = async () => {
    if (!team) return;
    const startedIn = scope.current;
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
      if (startedIn !== scope.current) return;
      request.current++;
      setTeams((prev) => prev.map((x) => (x.id === data.team!.id ? data.team! : x)));
    } catch (err) {
      if (startedIn === scope.current) setError(err instanceof Error ? err.message : t("codingAgent.team.stopFailed"));
    } finally {
      setBusy(false);
    }
  };

  const done = team ? team.tasks.filter((x) => x.status === "complete").length : 0;
  // A retired task will never be done — the lead decided the goal does not
  // need it — so it is not in the count either: a finished team with one
  // retired read "3 of 4 tasks done" beside its Done badge.
  const counted = team ? team.tasks.filter((x) => x.status !== "retired").length : 0;
  const messages = team ? team.log.map((e) => ({ e, m: teamMessageOf(e) })).filter((x): x is { e: TeamLogEntryView; m: TeamMessageView } => x.m !== null) : [];
  const inbox = messages.filter(({ m }) => m.to === "lead");

  /** One team message: who, to whom, and the words — whole, since the board is where the lead reads them. */
  const messageLine = (e: TeamLogEntryView, m: TeamMessageView) => (
    <>
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
    </>
  );

  return (
    <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-team-card">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">groups</span>
        <p className={`${SECTION_LABEL} !mb-0`}>{t("codingAgent.team.title")}</p>
        {team && (
          <span
            className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${STATUS_TONE[team.status]}`}
            data-testid="coding-team-status"
          >
            {t(`codingAgent.team.status.${team.status}`)}
          </span>
        )}
        {team && team.tasks.length > 0 && (
          <span className="text-[11px] text-[var(--text-muted)]" data-testid="coding-team-progress">
            {t("codingAgent.team.progress", { done, total: counted })}
          </span>
        )}
        {team && team.alerts > 0 && (
          <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-amber-400 border-amber-400/40" data-testid="coding-team-alerts">
            {t("codingAgent.team.alerts", { n: team.alerts })}
          </span>
        )}
        {teams.length > 1 && <span className="text-[11px] text-[var(--text-muted)]">· {t("codingAgent.team.earlier", { n: teams.length - 1 })}</span>}
        {active && (
          <button type="button" onClick={() => void stop()} disabled={busy} data-testid="coding-team-stop" className={`${BTN_SECONDARY} ml-auto`}>
            {t("codingAgent.team.stop")}
          </button>
        )}
      </div>
      {/* The team as a tree — who hands to whom — sized by the board: the
          planner, as many workers and reviewers as have worked here, the
          ones at work pulsing; the sentence beneath it. With no team yet
          it shows the shape a team takes. */}
      <div className="mt-2 flex flex-col items-center gap-2">
        <CodingTeamTree
          workers={team?.agents && team.agents.workers > 0 ? team.agents.workers : 3}
          activeWorkers={team ? team.tasks.filter((x) => x.status === "in_progress").length : 0}
          reviewers={team?.agents ? team.agents.reviewers : 1}
          activeReviewers={team && active ? team.tasks.filter((x) => x.status === "complete" && !x.review).length + (team.status === "reviewing" ? 1 : 0) : 0}
          plannerActive={team?.status === "planning"}
          leads={team?.agents?.leads ?? 0}
          className="shrink-0"
        />
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed text-center max-w-[40rem]">{t("codingAgent.team.help")}</p>
      </div>
      {/* Who worked, and where: the owner asked to see how many agents a
          run had. Planner, workers (an attempt is a new worker), reviewers,
          and the lead's turns when it had any. */}
      {team && team.agents && team.agents.total > 0 && (
        <p className="mt-1.5 text-[11px] text-[var(--text-secondary)]" data-testid="coding-team-agents">
          <span className="material-symbols-rounded align-[-2px] mr-1" style={{ fontSize: 14 }} aria-hidden="true">smart_toy</span>
          {(team.agents.leads ?? 0) > 0
            ? t("codingAgent.team.agentsWithLead", { total: team.agents.total, planner: team.agents.planner, workers: team.agents.workers, reviewers: team.agents.reviewers, leads: team.agents.leads ?? 0 })
            : t("codingAgent.team.agents", { total: team.agents.total, planner: team.agents.planner, workers: team.agents.workers, reviewers: team.agents.reviewers })}
          {team.branch && (
            <span className="text-[var(--text-muted)]"> · {t("codingAgent.team.branch", { branch: team.branch, base: team.base ?? "" })}</span>
          )}
        </p>
      )}
      {/* The shape the planner chose for this goal — how many side by side,
          how the work is reviewed, and why — and whether the lead may change
          the plan while the team runs. A team shaped by default says nothing. */}
      {team && (team.shape || team.dynamic) && (
        <p className="mt-1 text-[11px] text-[var(--text-secondary)] flex items-center gap-1.5 flex-wrap" data-testid="coding-team-shape">
          <span className="material-symbols-rounded align-[-2px]" style={{ fontSize: 14 }} aria-hidden="true">account_tree</span>
          {team.shape && (
            <span>
              {t("codingAgent.team.shape", { n: team.shape.parallelism })} · {t(`codingAgent.team.reviewMode.${team.shape.review}`)}
              {team.shape.rationale && <span className="text-[var(--text-muted)]"> — {team.shape.rationale}</span>}
            </span>
          )}
          {team.dynamic && (
            <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-violet-300 border-violet-400/40" data-testid="coding-team-dynamic">
              {t("codingAgent.team.leadOn")}
            </span>
          )}
        </p>
      )}
      {/* The team's figures: what it cost and how well its shape fitted the
          goal — the same numbers the status tool and the bench read. */}
      {team && team.metrics && (team.metrics.workerRuns > 0 || !active) && (
        <p className="mt-1 text-[11px] text-[var(--text-muted)] flex items-center gap-x-2 gap-y-0.5 flex-wrap" data-testid="coding-team-metrics" title={t("codingAgent.team.metricsTitle")}>
          <span className="material-symbols-rounded align-[-2px]" style={{ fontSize: 14 }} aria-hidden="true">monitoring</span>
          <span data-testid="coding-team-metric-tokens">{t("codingAgent.team.metricTokens", { n: compactTokens(team.metrics.tokensUsed) })}</span>
          <span>· {t("codingAgent.team.metricTime", { time: formatDuration(team.metrics.wallMs) })}</span>
          <span data-testid="coding-team-metric-first-try">· {t("codingAgent.team.metricFirstTry", { n: team.metrics.tasksAcceptedFirstTry, total: team.metrics.tasksPlanned + team.metrics.tasksAdded - team.metrics.tasksRetired })}</span>
          {team.metrics.tasksRejected > 0 && <span>· {t("codingAgent.team.metricRejected", { n: team.metrics.tasksRejected })}</span>}
          {team.metrics.tasksAdded > 0 && <span>· {t("codingAgent.team.metricAdded", { n: team.metrics.tasksAdded })}</span>}
          {team.metrics.tasksRetired > 0 && <span>· {t("codingAgent.team.metricRetired", { n: team.metrics.tasksRetired })}</span>}
        </p>
      )}

      {/* Asking for a team happens in the chat, the way every other task
          does: the Create App card, on this project, with the team switch
          on. A textarea here was a second composer for one conversation, and
          a goal typed into it never reached the assistant's memory. */}
      {!active && onPlan && (
        <div className="mt-2 flex items-center gap-2" data-testid="coding-team-form">
          <button type="button" onClick={onPlan} data-testid="coding-team-plan" className={BTN_SECONDARY}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">forum</span>
            {t("codingAgent.team.plan")}
          </button>
          {error && <span className="text-[11px] text-red-300" role="alert" data-testid="coding-team-error">{error}</span>}
        </div>
      )}
      {active && error && <p className="mt-2 text-[11px] text-red-300" role="alert" data-testid="coding-team-error">{error}</p>}

      {/* The board. */}
      {team && (
        <div className="mt-3" data-testid="coding-team-board" data-team-id={team.id}>
          <p className="text-xs text-[var(--text-secondary)] break-words">{team.goal}</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)] flex items-center gap-1 flex-wrap">
            <span className="font-mono">{team.id}</span>
            <span>· {timeAgo(team.createdAt, t)}</span>
            {team.plannerRunId && (
              <button type="button" onClick={() => onOpenRun(team.plannerRunId!)} data-testid="coding-team-planner" className="underline decoration-white/20 hover:text-white">
                {t("codingAgent.team.plannerRun")}
              </button>
            )}
          </p>
          {team.error && (
            <p className="mt-2 text-[11px] text-red-300 break-words" data-testid="coding-team-reason">{team.error}</p>
          )}
          {team.finalReview && (
            <p className="mt-2 text-[11px] break-words" data-testid="coding-team-final-review" data-verdict={team.finalReview.verdict}>
              <span className="text-[var(--text-secondary)]">{t("codingAgent.team.finalReview")}: </span>
              <span className={`font-semibold uppercase tracking-wider text-[10px] ${team.finalReview.verdict === "accepted" ? "text-emerald-400" : "text-red-300"}`}>
                {t(`codingAgent.team.review.${team.finalReview.verdict}`)}
              </span>
              {team.finalReview.notes && <span className={team.finalReview.verdict === "accepted" ? "text-[var(--text-muted)]" : "text-red-300"}> — {team.finalReview.notes}</span>}
            </p>
          )}
          {team.tasks.length === 0 && isActive(team.status) && (
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t("codingAgent.team.planning")}</p>
          )}
          {team.tasks.length > 0 && (
            <ul className="mt-2 space-y-1.5" data-testid="coding-team-tasks">
              {team.tasks.map((task) => (
                <li key={task.task_id} className={`${INSET_SURFACE} px-3 py-2`} data-testid={`coding-team-task-${task.task_id}`} data-status={task.status}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] text-[var(--text-muted)]">{task.task_id}</span>
                    <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${TASK_TONE[task.status] ?? TASK_TONE.pending}`}>
                      {t(`codingAgent.team.task.${TASK_KEY[task.status] ?? task.status}`)}
                    </span>
                    {task.origin === "lead" && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-300" data-testid={`coding-team-added-${task.task_id}`}>
                        {t("codingAgent.team.addedByLead")}
                      </span>
                    )}
                    {task.review && (
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${task.review.verdict === "accepted" ? "text-emerald-400" : "text-red-300"}`}>
                        {t(`codingAgent.team.review.${task.review.verdict}`)}
                      </span>
                    )}
                    {task.depends_on.length > 0 && (
                      <span className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.team.after", { ids: task.depends_on.join(", ") })}</span>
                    )}
                    {task.assigned_to && (
                      <button type="button" onClick={() => onOpenRun(task.assigned_to!)} data-testid={`coding-team-worker-${task.task_id}`} title={t("codingAgent.team.roleWorker", { task: task.task_id })} aria-label={`${t("codingAgent.team.roleWorker", { task: task.task_id })} · ${task.assigned_to}`} className="ml-auto text-[11px] font-mono text-[var(--text-muted)] underline decoration-white/20 hover:text-white">
                        {task.assigned_to}
                      </button>
                    )}
                    {task.reviewRunId && (
                      <button type="button" onClick={() => onOpenRun(task.reviewRunId!)} data-testid={`coding-team-reviewer-${task.task_id}`} title={t("codingAgent.team.roleReviewer", { task: task.task_id })} aria-label={`${t("codingAgent.team.roleReviewer", { task: task.task_id })} · ${task.reviewRunId}`} className="text-[11px] font-mono text-[var(--text-muted)] underline decoration-white/20 hover:text-white">
                        <span className="material-symbols-rounded align-[-2px] mr-0.5" style={{ fontSize: 12 }} aria-hidden="true">rate_review</span>{task.reviewRunId}
                      </button>
                    )}
                  </div>
                  <p className={`mt-1 text-xs break-words ${task.status === "retired" ? "text-[var(--text-muted)] line-through decoration-white/30" : "text-[var(--text-primary)]"}`}>{task.task_description}</p>
                  {task.result && (
                    <p className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-24 overflow-y-auto">{task.result}</p>
                  )}
                  {task.review?.notes && task.review.verdict === "rejected" && (
                    <p className="mt-1 text-[11px] text-red-300 break-words">{task.review.notes}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* What was put to the lead, on its own: a task a worker says is
              wrong for the goal, a blocker — the lines the owner acts on. */}
          {inbox.length > 0 && (
            <div className="mt-2" data-testid="coding-team-inbox">
              <p className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.team.inboxTitle", { n: inbox.length })}</p>
              <ul className="mt-1 space-y-0.5 text-[11px] text-amber-200/90">
                {inbox.slice(-MESSAGES_SHOWN).map(({ e, m }, i) => (
                  <li key={`${e.ts}-${i}`} className="break-words" data-testid="coding-team-inbox-message">
                    <span className="text-[var(--text-secondary)]">{m.role} {m.from}</span>
                    {e.task_id && <span> · {e.task_id}</span>}
                    {" · "}
                    <span className="whitespace-pre-wrap text-[var(--text-primary)]">{m.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* What the team's runs said — to each other, to the lead, to the
              assistant. On the board itself and not only in the log, because
              a message to the lead is a worker asking and the board is the
              only answer it gets. */}
          {messages.length > 0 && (
            <div className="mt-2" data-testid="coding-team-messages">
              <p className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.team.messagesTitle", { n: messages.length })}</p>
              <ul className="mt-1 space-y-0.5 text-[11px] text-sky-200/90">
                {messages.slice(-MESSAGES_SHOWN).map(({ e, m }, i) => (
                  <li key={`${e.ts}-${i}`} className="break-words" data-testid="coding-team-message" data-to={m.to} data-delivered={m.delivered ? "true" : "false"}>
                    {messageLine(e, m)}
                  </li>
                ))}
              </ul>
            </div>
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
                if (m) return <li key={i} className="break-words text-sky-200/90">{messageLine(e, m)}</li>;
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
      )}
    </div>
  );
}
