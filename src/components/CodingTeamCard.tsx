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
import { BTN_BASE, BTN_PRIMARY, BTN_SECONDARY, SECTION_LABEL } from "./coding-agent-ui";
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
}

export interface TeamView {
  id: string;
  goal: string;
  projectId: string | null;
  directory: string;
  status: "planning" | "working" | "reviewing" | "done" | "failed" | "stopped";
  plannerRunId: string | null;
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

export default function CodingTeamCard({ directory, projectId, onOpenRun }: Props) {
  const { t } = useT();
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  // One token per read: a response that started for the previous project
  // (or before an unmount) must not paint over the current one.
  const request = useRef(0);

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
    // The first read of the board happens here: the card has no other
    // moment to ask, and the answer is one render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { request.current++; };
  }, [load]);

  const team = teams[0] ?? null;
  const active = team ? isActive(team.status) : false;

  // Follow a team while it works.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  const start = async () => {
    const text = goal.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/team", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(projectId ? { goal: text, projectId } : { goal: text, directory }),
      });
      const data = await res.json().catch(() => null) as { team?: TeamView; error?: string } | null;
      if (!res.ok || !data?.team) throw new Error(data?.error ?? t("codingAgent.team.startFailed"));
      // A read that started before this write must not land on top of it.
      request.current++;
      setGoal("");
      setTeams((prev) => [data.team!, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.team.startFailed"));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!team) return;
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
      request.current++;
      setTeams((prev) => prev.map((x) => (x.id === data.team!.id ? data.team! : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.team.stopFailed"));
    } finally {
      setBusy(false);
    }
  };

  const done = team ? team.tasks.filter((x) => x.status === "complete").length : 0;

  return (
    <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-4 py-3" data-testid="coding-team-card">
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

      {/* The goal, while no team works here. */}
      {!active && (
        <div className="mt-2 flex flex-col gap-2" data-testid="coding-team-form">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder={t("codingAgent.team.goalPlaceholder")}
            aria-label={t("codingAgent.team.goalLabel")}
            data-testid="coding-team-goal"
            className="w-full rounded-lg bg-black/20 border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-white/30 resize-y"
          />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void start()} disabled={busy || !goal.trim()} data-testid="coding-team-start" className={BTN_PRIMARY}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">rocket_launch</span>
              {busy ? t("codingAgent.team.starting") : t("codingAgent.team.start")}
            </button>
            {error && <span className="text-[11px] text-red-300" role="alert" data-testid="coding-team-error">{error}</span>}
          </div>
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
                <li key={task.task_id} className="rounded-lg bg-black/20 border border-[var(--border-subtle)] px-3 py-2" data-testid={`coding-team-task-${task.task_id}`} data-status={task.status}>
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
                      <button type="button" onClick={() => onOpenRun(task.assigned_to!)} data-testid={`coding-team-worker-${task.task_id}`} className="ml-auto text-[11px] font-mono text-[var(--text-muted)] underline decoration-white/20 hover:text-white">
                        {task.assigned_to}
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
