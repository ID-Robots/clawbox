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
import { timeAgo } from "./clawkeep-ui";

export interface TeamTaskView {
  task_id: string;
  task_description: string;
  assigned_to: string | null;
  status: "pending" | "in_progress" | "complete" | "failed" | "rejected";
  result: string | null;
  depends_on: string[];
  review: { verdict: "accepted" | "rejected"; notes: string; at: number } | null;
  attempts: number;
  /** The reviewer run that ruled on the current attempt. */
  reviewRunId?: string | null;
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
  /** Who worked, counted by the server from the board's cast list. */
  agents?: { planner: number; workers: number; reviewers: number; total: number };
  tasks: TeamTaskView[];
  log: { ts: number; actor: { kind: string; id?: string }; type: string; message: string }[];
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
};

const TASK_TONE: Record<TeamTaskView["status"], string> = {
  pending: "text-[var(--text-muted)] border-white/20",
  in_progress: "text-amber-400 border-amber-400/40",
  complete: "text-emerald-400 border-emerald-400/40",
  failed: "text-red-300 border-red-400/40",
  rejected: "text-red-300 border-red-400/40",
};

function isActive(status: TeamView["status"]): boolean {
  return status === "planning" || status === "working" || status === "reviewing";
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
            {t("codingAgent.team.progress", { done, total: team.tasks.length })}
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
      <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-relaxed">{t("codingAgent.team.help")}</p>
      {/* Who worked, and where: the owner asked to see how many agents a
          run had. Planner, workers (an attempt is a new worker), reviewers. */}
      {team && team.agents && team.agents.total > 0 && (
        <p className="mt-1.5 text-[11px] text-[var(--text-secondary)]" data-testid="coding-team-agents">
          <span className="material-symbols-rounded align-[-2px] mr-1" style={{ fontSize: 14 }} aria-hidden="true">smart_toy</span>
          {t("codingAgent.team.agents", { total: team.agents.total, planner: team.agents.planner, workers: team.agents.workers, reviewers: team.agents.reviewers })}
          {team.branch && (
            <span className="text-[var(--text-muted)]"> · {t("codingAgent.team.branch", { branch: team.branch, base: team.base ?? "" })}</span>
          )}
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
          {team.tasks.length === 0 && isActive(team.status) && (
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t("codingAgent.team.planning")}</p>
          )}
          {team.tasks.length > 0 && (
            <ul className="mt-2 space-y-1.5" data-testid="coding-team-tasks">
              {team.tasks.map((task) => (
                <li key={task.task_id} className={`${INSET_SURFACE} px-3 py-2`} data-testid={`coding-team-task-${task.task_id}`} data-status={task.status}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] text-[var(--text-muted)]">{task.task_id}</span>
                    <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${TASK_TONE[task.status]}`}>
                      {t(`codingAgent.team.task.${TASK_KEY[task.status]}`)}
                    </span>
                    {task.review && (
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${task.review.verdict === "accepted" ? "text-emerald-400" : "text-red-300"}`}>
                        {t(`codingAgent.team.review.${task.review.verdict}`)}
                      </span>
                    )}
                    {task.depends_on.length > 0 && (
                      <span className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.team.after", { ids: task.depends_on.join(", ") })}</span>
                    )}
                    {task.assigned_to && (
                      <button type="button" onClick={() => onOpenRun(task.assigned_to!)} data-testid={`coding-team-worker-${task.task_id}`} title={t("codingAgent.team.roleWorker", { task: task.task_id })} className="ml-auto text-[11px] font-mono text-[var(--text-muted)] underline decoration-white/20 hover:text-white">
                        {task.assigned_to}
                      </button>
                    )}
                    {task.reviewRunId && (
                      <button type="button" onClick={() => onOpenRun(task.reviewRunId!)} data-testid={`coding-team-reviewer-${task.task_id}`} title={t("codingAgent.team.roleReviewer", { task: task.task_id })} className="text-[11px] font-mono text-[var(--text-muted)] underline decoration-white/20 hover:text-white">
                        <span className="material-symbols-rounded align-[-2px] mr-0.5" style={{ fontSize: 12 }} aria-hidden="true">rate_review</span>{task.reviewRunId}
                      </button>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-primary)] break-words">{task.task_description}</p>
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
              {team.log.slice(-LOG_SHOWN).map((e, i) => (
                <li key={i} className={`break-words ${e.type === "alert" ? "text-amber-400" : ""}`}>
                  <span className="opacity-60">{new Date(e.ts).toLocaleTimeString()}</span>{" "}
                  <span className="text-[var(--text-secondary)]">{e.actor.kind === "worker" ? `worker ${e.actor.id ?? ""}` : e.actor.kind}</span>{" "}
                  {e.message}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
