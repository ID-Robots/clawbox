"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { isLive, isSettled, type CodingRunStatus } from "@/lib/coding-agent-status";
import CodingTeamTree from "./CodingTeamTree";
import CodingAgentRosterRow from "./CodingAgentRosterRow";

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
 * The team a run belongs to, as the run's page shows it: the board drawn as
 * the same tree the Team tab draws — planner, workers, reviewers, the ones at
 * work pulsing — and under it a row per TEAMMATE, in the one row shape every
 * agent on this page wears (CodingAgentRosterRow).
 *
 * The run whose page this is is deliberately NOT in the list: the card names
 * it once, at the head of its own helpers, with its role beside it. It used to
 * appear here as well, so a team worker's page listed the same run twice, four
 * lines apart, with a different label each time.
 *
 * Polled while this run is live, because teammates start and settle beside it;
 * read once when it has settled.
 */
export default function CodingRunTeamMembers({ teamId, runId, runs, live, onOpenRun, whileUnknown, pollMs = 5000 }: {
  teamId: string;
  /** The run whose page this is: counted in the tree, left out of the list. */
  runId: string;
  runs: MemberRun[];
  live: boolean;
  onOpenRun: (id: string) => void;
  /**
   * What the card shows while the board is not there — not yet read, or a
   * team whose file has been cleared. The run page hands its own three-column
   * tree, so a run that names a team it cannot read still shows the picture of
   * itself rather than a gap where the chart was.
   */
  whileUnknown?: ReactNode;
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
  if (!members || members.length === 0) return <>{whileUnknown}</>;
  const statusOf = (id: string) => runs.find((r) => r.id === id)?.status ?? null;
  const roleLabel = (m: BoardRun) => m.role === "planner"
    ? t("codingAgent.team.rolePlanner")
    : m.role === "reviewer"
      ? t("codingAgent.team.roleReviewer", { task: m.taskId ?? "" })
      : t("codingAgent.team.roleWorker", { task: m.taskId ?? "" });
  const isAt = (id: string) => { const s = statusOf(id); return s !== null && isLive(s); };
  const working = members.filter((m) => isAt(m.id)).length;
  const others = members.filter((m) => m.id !== runId);
  const of = (role: BoardRun["role"]) => members.filter((m) => m.role === role);
  return (
    <div className="mt-2" data-testid="coding-agent-run-team-members" data-working={working}>
      {/* The board, in the Team tab's own drawing — sized by THIS team, so a
          node lights up as a teammate picks its task up. */}
      <div className="flex justify-center">
        <CodingTeamTree
          workers={of("worker").length}
          activeWorkers={of("worker").filter((m) => isAt(m.id)).length}
          reviewers={of("reviewer").length}
          activeReviewers={of("reviewer").filter((m) => isAt(m.id)).length}
          plannerActive={of("planner").some((m) => isAt(m.id))}
        />
      </div>
      <ul className="mt-2 space-y-0.5">
        {others.map((m) => {
          const status = statusOf(m.id);
          const at = status !== null && isLive(status);
          const done = status !== null && isSettled(status);
          // Settled is not the same as succeeded: a worker that FAILED wore
          // the same emerald check_circle as one that finished, beside a
          // status chip reading "Did not finish" in red. Only `completed`
          // earns the tick.
          const ok = done && status === "completed";
          return (
            <li key={m.id} className="min-w-0" data-testid="coding-agent-team-member" data-role={m.role} data-live={at || undefined} data-outcome={at ? "working" : done ? (ok ? "completed" : "unfinished") : "waiting"}>
              <CodingAgentRosterRow
                icon={at ? "sync" : ok ? "check_circle" : done ? "error" : "schedule"}
                iconClassName={at ? "text-amber-400 animate-pulse" : ok ? "text-emerald-400/80" : done ? "text-red-400/80" : "text-[var(--text-muted)]"}
                name={roleLabel(m)}
                nameClassName={at ? "text-amber-200" : "text-[var(--text-primary)]"}
                meta={status ? t(`codingAgent.status${status.charAt(0).toUpperCase()}${status.slice(1)}`) : undefined}
                // The board records a teammate's role, its run and whether it
                // is at work, and that is the whole row — so no panel opens on
                // it. The run id stays a link: opening a teammate's page is
                // the one thing anyone does from here.
                fields={[]}
                aside={<button type="button" onClick={() => onOpenRun(m.id)} className="font-mono text-[var(--text-muted)] underline decoration-white/20 hover:text-white shrink-0">{m.id}</button>}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
