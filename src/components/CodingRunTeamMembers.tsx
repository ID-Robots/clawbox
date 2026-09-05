"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { isLive, isSettled, type CodingRunStatus } from "@/lib/coding-agent-status";

/** What the members list needs of a run: its status, from the app's own list. */
export interface MemberRun {
  id: string;
  status: CodingRunStatus;
}

interface BoardRun {
  id: string;
  role: "planner" | "worker" | "reviewer";
  taskId: string | null;
}

/**
 * The other members of the team a run belongs to — planner, workers,
 * reviewers — each with whether it is at work or done, read from the team's
 * board (its cast list) and the app's run list (their status). Polled while
 * this run is live, because teammates start and settle beside it; read once
 * when it has settled.
 */
export default function CodingRunTeamMembers({ teamId, runId, runs, live, onOpenRun, pollMs = 5000 }: {
  teamId: string;
  /** The run whose page this is: named among the members, not linked. */
  runId: string;
  runs: MemberRun[];
  live: boolean;
  onOpenRun: (id: string) => void;
  /** How often the board is re-read while the run is live. */
  pollMs?: number;
}) {
  const { t } = useT();
  const [members, setMembers] = useState<BoardRun[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Reads can overlap when one is slow: only the newest one's answer
    // lands, so an older reply cannot put back what a newer one replaced.
    let newest = 0;
    const read = async () => {
      const mine = ++newest;
      try {
        const res = await fetch(`/setup-api/coding-agent/team?id=${encodeURIComponent(teamId)}`, { cache: "no-store" });
        const data = await res.json().catch(() => null) as { team?: { runs?: BoardRun[] } } | null;
        if (!cancelled && mine === newest && res.ok && Array.isArray(data?.team?.runs)) setMembers(data!.team!.runs!);
      } catch {
        // The chips stay as they were.
      }
    };
    void read();
    if (!live) return () => { cancelled = true; };
    const id = setInterval(() => void read(), pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [teamId, live, pollMs]);
  if (!members || members.length === 0) return null;
  const statusOf = (id: string) => runs.find((r) => r.id === id)?.status ?? null;
  const roleLabel = (m: BoardRun) => m.role === "planner"
    ? t("codingAgent.team.rolePlanner")
    : m.role === "reviewer"
      ? t("codingAgent.team.roleReviewer", { task: m.taskId ?? "" })
      : t("codingAgent.team.roleWorker", { task: m.taskId ?? "" });
  const working = members.filter((m) => { const s = statusOf(m.id); return s !== null && isLive(s); }).length;
  return (
    <div className="mt-3" data-testid="coding-agent-run-team-members" data-working={working}>
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
        {t("codingAgent.teamMembersTitle")}
        <span className="normal-case tracking-normal text-[var(--text-secondary)]">{t("codingAgent.agentsWorking", { n: working })} · {t("codingAgent.agentsFinished", { n: members.length - working })}</span>
      </p>
      <ul className="mt-1.5 space-y-1">
        {members.map((m) => {
          const status = statusOf(m.id);
          const at = status !== null && isLive(status);
          const done = status !== null && isSettled(status);
          const me = m.id === runId;
          return (
            <li key={m.id} className="flex items-center gap-2 text-[11px]" data-testid="coding-agent-team-member" data-role={m.role} data-live={at || undefined} data-me={me || undefined}>
              <span className={`material-symbols-rounded shrink-0 ${at ? "text-amber-400 animate-pulse" : done ? "text-emerald-400/80" : "text-[var(--text-muted)]"}`} style={{ fontSize: 13 }} aria-hidden="true">{at ? "sync" : done ? "check_circle" : "schedule"}</span>
              <span className={`font-medium shrink-0 ${at ? "text-amber-200" : "text-[var(--text-primary)]"}`}>{roleLabel(m)}</span>
              {me ? (
                <span className="font-mono text-[var(--text-muted)]">{m.id}</span>
              ) : (
                <button type="button" onClick={() => onOpenRun(m.id)} className="font-mono text-[var(--text-muted)] underline decoration-white/20 hover:text-white">{m.id}</button>
              )}
              {status && <span className="ml-auto shrink-0 text-[var(--text-muted)]">{t(`codingAgent.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
