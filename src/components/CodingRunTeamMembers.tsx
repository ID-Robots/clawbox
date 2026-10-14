"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { isLive, isSettled, type CodingRunStatus } from "@/lib/coding-agent-status";
import { CODING_PROVIDER_NAME_KEY, isCodingProvider, type CodingProvider } from "@/lib/coding-provider";
import type { ModelRole } from "@/lib/coding-role-models";
import { codingModelName } from "@/lib/coding-model-names";
import { setVisibleInterval } from "@/lib/visible-interval";
import CodingTeamTree from "./CodingTeamTree";
import CodingAgentRosterRow from "./CodingAgentRosterRow";

/** What the members list needs of a run: its status, from the app's own list. */
export interface MemberRun {
  id: string;
  status: CodingRunStatus;
}

export interface BoardRun {
  id: string;
  role: "planner" | "worker" | "reviewer" | "lead";
  taskId: string | null;
  /** The account the run started on, the model there (null where the plan
   *  decides) and the role that choice was made for (coding-team-board.ts
   *  TeamRunRef). Absent on a board written before they were kept, and the
   *  row then says nothing about its model. */
  provider?: CodingProvider | null;
  model?: string | null;
  modelRole?: ModelRole | null;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * "Opus 5.5 on Anthropic" — what a teammate runs on, on its row. Its role is
 * already the row's name, so it is only added where the model was chosen for
 * a different one: a worker on a task the plan marked bulk.
 */
export function memberModelLine(t: Translate, m: Pick<BoardRun, "provider" | "model" | "modelRole">): string | undefined {
  if (!m.provider || !isCodingProvider(m.provider)) return undefined;
  const params = {
    model: m.model ? codingModelName(m.model) : t("codingAgent.roleModelPlanDecides"),
    provider: t(CODING_PROVIDER_NAME_KEY[m.provider]),
  };
  return m.modelRole === "bulk"
    ? t("codingAgent.memberModelRole", { ...params, role: t("codingAgent.modelRole.bulk") })
    : t("codingAgent.memberModel", params);
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
export default function CodingRunTeamMembers({ teamId, runId, runs, live, onOpenRun, whileUnknown, pollMs = 5000, tree = true, cast }: {
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
  /**
   * Draw the board's tree above the rows. The run page's agent chart draws
   * the team itself now (CodingAgentDiagram), and this list sits under it in
   * Details, so the page passes false rather than draw the team twice.
   */
  tree?: boolean;
  /**
   * The board's cast list when the host has already read it — then this card
   * reads nothing of its own. Absent (or null while the host has none), the
   * card reads the board itself, as it always did.
   */
  cast?: BoardRun[] | null;
}) {
  const { t } = useT();
  const [fetched, setMembers] = useState<BoardRun[] | null>(null);
  const given = cast ?? null;
  const members = given ?? fetched;
  useEffect(() => {
    if (given) return;
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
    // Not while nobody can see the page: the visible edge reads it again.
    const stop = setVisibleInterval(() => void read(), pollMs);
    return () => { cancelled = true; stop(); };
  }, [teamId, live, pollMs, given]);
  if (!members || members.length === 0) return <>{whileUnknown}</>;
  const statusOf = (id: string) => runs.find((r) => r.id === id)?.status ?? null;
  const roleLabel = (m: BoardRun) => m.role === "planner"
    ? t("codingAgent.team.rolePlanner")
    : m.role === "reviewer"
      ? t("codingAgent.team.roleReviewer", { task: m.taskId ?? "" })
      : m.role === "lead"
        ? t("codingAgent.team.roleLead", { task: m.taskId ?? "" })
        : t("codingAgent.team.roleWorker", { task: m.taskId ?? "" });
  const isAt = (id: string) => { const s = statusOf(id); return s !== null && isLive(s); };
  const working = members.filter((m) => isAt(m.id)).length;
  const others = members.filter((m) => m.id !== runId);
  const of = (role: BoardRun["role"]) => members.filter((m) => m.role === role);
  return (
    <div className="mt-2" data-testid="coding-agent-run-team-members" data-working={working}>
      {/* The board, in the Team tab's own drawing — sized by THIS team, so a
          node lights up as a teammate picks its task up. */}
      {tree && <div className="flex justify-center">
        <CodingTeamTree
          workers={of("worker").length}
          activeWorkers={of("worker").filter((m) => isAt(m.id)).length}
          reviewers={of("reviewer").length}
          activeReviewers={of("reviewer").filter((m) => isAt(m.id)).length}
          plannerActive={of("planner").some((m) => isAt(m.id))}
          leads={of("lead").length}
          leadActive={of("lead").some((m) => isAt(m.id))}
        />
      </div>}
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
                what={memberModelLine(t, m)}
                meta={status ? t(`codingAgent.status${status.charAt(0).toUpperCase()}${status.slice(1)}`) : undefined}
                // The board records a teammate's role, its run, what it runs
                // on and whether it is at work, and that is the whole row — so
                // no panel opens on it. The run id stays a link: opening a
                // teammate's page is the one thing anyone does from here.
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
