"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isCodingRunStatus, type CodingRunStatus } from "@/lib/coding-agent-status";

/**
 * The coding runs this conversation has seen, and what became of them.
 *
 * WHY THE TOOL PILLS ARE NOT ENOUGH
 *
 * `coding_agent_run` returns as soon as the device has SPAWNED the run — the
 * route answers 202 in milliseconds, by design, because an MCP call must not
 * hold a connection open for twenty minutes. So the chat's tool pill goes
 * "🔧 coding agent run" → "✓" within a second, while the actual work carries
 * on. The pill is telling the truth about the tool call and the wrong thing
 * about the box.
 *
 * WHY A BADGE STAYS AFTER THE RUN ENDS
 *
 * The first version of this dropped the badge the moment the run finished, and
 * on a real box that made it nearly invisible: measured runs here take 9-15
 * seconds, so it appeared and vanished while the owner was still reading the
 * agent's previous message. A delegated run is a thing that HAPPENED in this
 * conversation — the same class of fact as the tool-summary chips, which stay
 * attached to their message — so the badge stays too, and changes tone to
 * report the outcome.
 *
 * WHAT IT ADOPTS, AND WHAT IT LEAVES ALONE
 *
 * Only runs that belong to THIS conversation: one that is in flight right now,
 * or one that started around the time the chat opened (see RECENT_MS).
 * Yesterday's finished runs are history and belong in the Coding Agent app,
 * not in today's transcript.
 *
 * WHY IT COSTS ALMOST NOTHING
 *
 * No steady-state timer. It probes once when the chat opens, again whenever
 * `nudge()` is called (which the chat does the moment a coding-agent tool call
 * goes past), and polls only while a run is actually in flight. An idle box is
 * asked once per chat open and then left alone.
 */

export type { CodingRunStatus };
export type CodingTodoStatus = "pending" | "in_progress" | "completed";

/** One item of the run's own plan — see CodingRun.todos in coding-agent.ts. */
export interface CodingTodo {
  content: string;
  status: CodingTodoStatus;
  activeForm?: string;
}

export interface CodingAgentActivity {
  id: string;
  projectId: string | null;
  task: string;
  startedAt: number;
  completedAt: number | null;
  status: CodingRunStatus;
  source: "agent" | "owner";
  /**
   * How the run is spending its effort, live off the same record the Coding
   * Agent app reads. `subagentsActive`/`activeSubagents` exist only while the
   * run is in flight (the server zeroes them when it settles); the totals and
   * the per-type breakdown are cumulative and survive the finish.
   */
  subagentsTotal: number;
  subagentsActive: number;
  subagentsByType: Record<string, number>;
  tokensUsed: number;
  /** Reasoning tokens so far; 0 on a record from before the runner counted them. */
  thinkingTokens: number;
  filesTouched: number;
  /** Agent turns — counted live, then pinned by the final result event. */
  numTurns: number;
  /**
   * The run's newest progress lines, oldest first, at most PROGRESS_SHOWN:
   * the last one is "what it is doing right now", the rest are the card's
   * live-work panel. The runner keeps more on the record; the card has no
   * room for them, so they are cut here rather than held in every badge.
   */
  progress: string[];
  /**
   * The newest screenshots the run saved, oldest first, by file name — the
   * card turns a name into its served URL with artifactUrl(). Images only:
   * the card thumbnails nothing else, so nothing else is kept.
   */
  screenshots: string[];
  /**
   * The run's plan, as it last wrote it with TodoWrite: what it means to do,
   * what it is on now, what is done. Empty for a run that never planned. The
   * runner already caps and trims it; this only refuses a shape it cannot
   * draw.
   */
  todos: CodingTodo[];
}

interface RunPayload {
  id: string;
  projectId: string | null;
  task: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  source: string;
  subagentsTotal?: number;
  subagentsActive?: number;
  subagentsByType?: Record<string, number>;
  tokensUsed?: number;
  thinkingTokens?: number;
  filesTouched?: string[];
  numTurns?: number;
  progress?: string[];
  todos?: unknown;
  artifacts?: { name?: unknown; kind?: unknown }[];
}

const TODO_STATUSES: readonly CodingTodoStatus[] = ["pending", "in_progress", "completed"];
/** The runner's own cap, repeated so a hand-edited record cannot flood a card. */
const TODOS_KEPT = 20;

function toTodos(raw: unknown): CodingTodo[] {
  if (!Array.isArray(raw)) return [];
  const todos: CodingTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof t.content !== "string" || !t.content) continue;
    const status = (TODO_STATUSES as readonly unknown[]).includes(t.status) ? t.status as CodingTodoStatus : "pending";
    const activeForm = typeof t.activeForm === "string" && t.activeForm ? t.activeForm : undefined;
    todos.push(activeForm ? { content: t.content, status, activeForm } : { content: t.content, status });
    if (todos.length >= TODOS_KEPT) break;
  }
  return todos;
}

/** How often to re-ask while a run is actually in flight. */
const POLL_MS = 5_000;
/** Enough to catch a run even if a couple of others finished meanwhile. */
const LOOK_BACK = 5;
/** Progress lines a card lists when expanded. */
const PROGRESS_SHOWN = 8;
/** Screenshots a card thumbnails; the Coding Agent app shows the whole folder. */
const SCREENSHOTS_SHOWN = 3;

/** The served URL of one run artifact — cookie auth rides along like any app asset. */
export function artifactUrl(runId: string, name: string): string {
  return `/setup-api/coding-agent/artifacts?runId=${encodeURIComponent(runId)}&file=${encodeURIComponent(name)}`;
}
/** Badges kept in one conversation, oldest dropped first. */
const MAX_BADGES = 6;
/**
 * How far back a finished run still counts as "this conversation".
 *
 * Not zero: a run that ended in the seconds before the chat opened is the one
 * the owner is about to ask about, and hiding its badge would be the same
 * disappearing act this whole file exists to fix. Not unbounded either —
 * yesterday's runs are history and belong in the Coding Agent app.
 */
const RECENT_MS = 120_000;

function toActivity(r: RunPayload): CodingAgentActivity {
  return {
    id: r.id,
    projectId: r.projectId,
    task: r.task,
    startedAt: r.startedAt,
    completedAt: typeof r.completedAt === "number" ? r.completedAt : null,
    status: isCodingRunStatus(r.status) ? r.status : "completed",
    source: r.source === "owner" ? "owner" : "agent",
    subagentsTotal: typeof r.subagentsTotal === "number" ? r.subagentsTotal : 0,
    subagentsActive: typeof r.subagentsActive === "number" ? r.subagentsActive : 0,
    subagentsByType: r.subagentsByType && typeof r.subagentsByType === "object" ? r.subagentsByType : {},
    tokensUsed: typeof r.tokensUsed === "number" ? r.tokensUsed : 0,
    thinkingTokens: typeof r.thinkingTokens === "number" ? r.thinkingTokens : 0,
    filesTouched: Array.isArray(r.filesTouched) ? r.filesTouched.length : 0,
    numTurns: typeof r.numTurns === "number" ? r.numTurns : 0,
    progress: Array.isArray(r.progress)
      ? r.progress.filter((p): p is string => typeof p === "string").slice(-PROGRESS_SHOWN)
      : [],
    // The route lists a run's folder oldest first; the newest few are the
    // ones worth a thumbnail (the last screenshot is the state of the page).
    screenshots: Array.isArray(r.artifacts)
      ? r.artifacts
        .filter((a) => a && a.kind === "image" && typeof a.name === "string" && a.name)
        .map((a) => a.name as string)
        .slice(-SCREENSHOTS_SHOWN)
      : [],
    todos: toTodos(r.todos),
  };
}

/** True when the tool the chat just saw is one of the coding-agent family. */
export function isCodingAgentTool(name: string): boolean {
  return /coding_agent/i.test(name);
}

export function useCodingAgentActivity(active: boolean): {
  runs: CodingAgentActivity[];
  nudge: () => void;
} {
  const [runs, setRuns] = useState<CodingAgentActivity[]>([]);
  // Bumped by nudge(); the effect below re-runs and probes immediately.
  const [probe, setProbe] = useState(0);
  // When this conversation started caring. A run older than this belongs to a
  // previous conversation and is not adopted.
  const openedAtRef = useRef(0);

  const nudge = useCallback(() => setProbe((n) => n + 1), []);

  useEffect(() => {
    if (!active) {
      setRuns([]);
      openedAtRef.current = 0;
      return;
    }
    if (openedAtRef.current === 0) openedAtRef.current = Date.now();

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const read = async () => {
      try {
        // `artifacts=1` on EVERY poll, not only for the runs a card has
        // expanded. The route's listing is one readdir plus one stat per file
        // for each of the LOOK_BACK runs — and most runs never save anything,
        // so for them it is a single failed open. Measured against the
        // alternative (a second fetch shape, and the card's expanded state
        // plumbed up into this hook so it knows which runs to ask for), the
        // per-poll cost is a handful of syscalls every five seconds while a
        // run is in flight, and nothing at all once it is not; the plumbing
        // would be the larger cost, paid in code.
        const res = await fetch(`/setup-api/coding-agent/runs?limit=${LOOK_BACK}&artifacts=1`, { cache: "no-store" });
        if (!res.ok) throw new Error("runs");
        const data = await res.json() as { runs?: RunPayload[] };
        if (!alive) return;
        const fetched = data.runs ?? [];

        setRuns((prev) => {
          const byId = new Map(prev.map((r) => [r.id, r]));
          for (const raw of fetched) {
            const run = toActivity(raw);
            // Adopt what belongs to this conversation: in flight now, or
            // started around the time the chat opened (a 9-second run can
            // begin and end between two polls, and it still happened here).
            const mine = byId.has(run.id)
              || run.status === "running"
              || run.startedAt >= openedAtRef.current - RECENT_MS;
            if (mine) byId.set(run.id, run);
          }
          const next = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
          return next.slice(-MAX_BADGES);
        });

        // Keep asking only while there is something to ask about.
        if (fetched.some((r) => r.status === "running")) {
          timer = setTimeout(() => { void read(); }, POLL_MS);
        }
      } catch {
        // The device is the source of truth and it did not answer. Leave the
        // badges already on screen alone rather than rewriting history from a
        // failed request — and do not schedule another.
      }
    };

    void read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, probe]);

  return { runs, nudge };
}
