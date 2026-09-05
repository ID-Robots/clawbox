"use client";

import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";

/**
 * The coding team as a tree, drawn once: the assistant hands a goal to the
 * Coding Agent, which asks a planner for the tasks, fans them out to workers
 * side by side, and every worker's result passes a reviewer. Read-only — a
 * picture of who is who, sized by the board (how many workers, how many
 * reviewers, which of them are at work right now), so the nodes it draws are
 * the agents the card counts: planner + workers + reviewers.
 *
 * A deliberate sibling of CodingAgentDelegationArt and MemoryShardArt: the
 * same stroke weights, the same muted palette over the product's coral, the
 * same restraint. Every animation lives under `@media
 * (prefers-reduced-motion: no-preference)` in globals.css (`ct-art-*`), so an
 * owner who turned motion off gets the same diagram. `aria-hidden` because
 * the card's sentence says this in words.
 */
export interface CodingTeamTreeProps {
  /** Worker nodes drawn, 1–5; a board with more is drawn with five. */
  workers?: number;
  /** How many of the workers are at work right now — those pulse in coral. */
  activeWorkers?: number;
  /** Reviewer nodes drawn, 0–5. */
  reviewers?: number;
  /** How many reviewers are deciding right now. */
  activeReviewers?: number;
  /** The planner is reading the folder right now. */
  plannerActive?: boolean;
  className?: string;
}

export const MAX_TREE_WORKERS = 5;
export const MAX_TREE_REVIEWERS = 5;

/** `n` points spread evenly between `top` and `bottom`; one point on the middle line. */
function spread(n: number, top: number, bottom: number, mid: number): number[] {
  if (n <= 1) return n === 1 ? [mid] : [];
  return Array.from({ length: n }, (_, i) => top + ((bottom - top) * i) / (n - 1));
}

export default function CodingTeamTree({ workers = 3, activeWorkers = 0, reviewers = 1, activeReviewers = 0, plannerActive = false, className = "" }: CodingTeamTreeProps) {
  const { t } = useT();
  const w = Math.min(MAX_TREE_WORKERS, Math.max(1, Math.round(workers)));
  const r = Math.min(MAX_TREE_REVIEWERS, Math.max(0, Math.round(reviewers)));
  const liveW = Math.min(w, Math.max(0, Math.round(activeWorkers)));
  const liveR = Math.min(r, Math.max(0, Math.round(activeReviewers)));
  const mid = 100;
  const wys = spread(w, 40, 160, mid);
  const rys = spread(r, 40, 160, mid);
  // Five columns: assistant, Coding Agent, planner, workers, reviewers.
  const X = { assistant: 40, agent: 130, planner: 220, workers: 310, reviewers: 400 };
  const node = (cx: number, cy: number, live: boolean, extra?: ReactNode) => (
    <g className={live ? "ct-art-live" : "ct-art-node"} data-live={live || undefined}>
      <rect x={cx - 12} y={cy - 12} width="24" height="24" rx="7" fill="var(--fill-2)" stroke={live ? "var(--coral-bright)" : "var(--border-subtle)"} strokeOpacity={live ? 0.7 : 1} strokeWidth="1.4" />
      {extra ?? <circle cx={cx} cy={cy} r="3" fill={live ? "var(--coral-bright)" : "var(--text-muted)"} fillOpacity="0.9" />}
    </g>
  );

  return (
    <svg
      viewBox="0 0 440 180"
      className={`w-full max-w-[30rem] h-auto ${className}`}
      aria-hidden="true"
      focusable="false"
      data-testid="coding-team-tree"
      data-workers={w}
      data-reviewers={r}
      data-active={liveW}
      data-active-reviewers={liveR}
      data-planner-active={plannerActive || undefined}
    >
      {/* Column captions, with the count the card states. */}
      {[
        { x: X.assistant, label: t("codingAgent.team.artMain") },
        { x: X.agent, label: t("codingAgent.title") },
        { x: X.planner, label: `${t("codingAgent.team.artPlanner")} · 1` },
        { x: X.workers, label: `${t("codingAgent.team.artWorkers")} · ${w}` },
        { x: X.reviewers, label: `${t("codingAgent.team.artReviewers")} · ${r}` },
      ].map((c) => (
        <text key={c.x} x={c.x} y="14" textAnchor="middle" className="fill-[var(--text-muted)]" style={{ fontSize: 10, fontWeight: 500, letterSpacing: 0.4 }}>
          {c.label}
        </text>
      ))}

      {/* The assistant: the one the owner talks to. */}
      <g className="ct-art-hub">
        <rect x={X.assistant - 30} y={mid - 18} width="60" height="36" rx="10" fill="var(--fill-2)" stroke="var(--border-subtle)" strokeWidth="1.4" />
        <circle cx={X.assistant - 10} cy={mid} r="3.5" fill="var(--coral-bright)" />
        <path d={`M${X.assistant} ${mid - 6} h16 M${X.assistant} ${mid} h12 M${X.assistant} ${mid + 6} h8`} stroke="var(--text-muted)" strokeOpacity="0.8" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      <path d={`M${X.assistant + 34} ${mid} H${X.agent - 34}`} fill="none" stroke="var(--text-muted)" strokeOpacity="0.45" strokeWidth="1.4" strokeDasharray="5 6" strokeLinecap="round" className="ct-art-flow" />

      {/* The Coding Agent: the orchestrator, in the product's coral. */}
      <g className="ct-art-hub" style={{ animationDelay: "0.4s" }}>
        <rect x={X.agent - 30} y={mid - 18} width="60" height="36" rx="10" fill="var(--coral-bright)" fillOpacity="0.10" stroke="var(--coral-bright)" strokeOpacity="0.55" strokeWidth="1.5" />
        <path d={`M${X.agent - 12} ${mid - 6} L${X.agent - 2} ${mid} L${X.agent - 12} ${mid + 6}`} fill="none" stroke="var(--coral-bright)" strokeOpacity="0.85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d={`M${X.agent + 4} ${mid + 6} L${X.agent + 10} ${mid - 6}`} fill="none" stroke="var(--coral-bright)" strokeOpacity="0.85" strokeWidth="1.8" strokeLinecap="round" />
      </g>
      <path d={`M${X.agent + 34} ${mid} H${X.planner - 16}`} fill="none" stroke="var(--text-muted)" strokeOpacity="0.45" strokeWidth="1.4" strokeDasharray="5 6" strokeLinecap="round" className="ct-art-flow" style={{ animationDelay: "0.2s" }} />

      {/* The planner: reads the folder, answers the tasks. */}
      <g data-testid="coding-team-tree-planner">
        {node(X.planner, mid, plannerActive, (
          <path d={`M${X.planner - 5} ${mid - 4} h10 M${X.planner - 5} ${mid} h10 M${X.planner - 5} ${mid + 4} h6`} stroke={plannerActive ? "var(--coral-bright)" : "var(--text-muted)"} strokeOpacity="0.9" strokeWidth="1.5" strokeLinecap="round" />
        ))}
      </g>

      {/* The workers: tasks out from the planner, results on to the reviewers. */}
      {wys.map((y, i) => {
        const at = i < liveW;
        return (
          <g key={`w${i}`} data-testid="coding-team-tree-worker" data-live={at || undefined}>
            <path
              d={`M${X.planner + 14} ${mid} C ${X.planner + 50} ${mid}, ${X.workers - 50} ${y}, ${X.workers - 14} ${y}`}
              fill="none" stroke="var(--text-muted)" strokeOpacity="0.45" strokeWidth="1.4"
              strokeDasharray="5 6" strokeLinecap="round"
              className="ct-art-flow" style={{ animationDelay: `${i * 0.3}s` }}
            />
            {node(X.workers, y, at)}
          </g>
        );
      })}

      {/* Every worker's result passes a reviewer: the results converge on the
          column and fan to each reviewer, since which one took which task
          is the board's to say. */}
      {r > 0 && wys.map((y, i) => (
        <path
          key={`wr${i}`}
          d={`M${X.workers + 14} ${y} C ${X.workers + 40} ${y}, ${X.reviewers - 60} ${mid}, ${X.reviewers - 36} ${mid}`}
          fill="none" stroke="var(--text-muted)" strokeOpacity="0.35" strokeWidth="1.3"
          strokeDasharray="4 7" strokeLinecap="round"
          className="ct-art-flow" style={{ animationDelay: `${i * 0.3 + 0.9}s` }}
        />
      ))}
      {rys.map((y, i) => {
        const at = i < liveR;
        return (
          <g key={`r${i}`} data-testid="coding-team-tree-reviewer" data-live={at || undefined}>
            <path
              d={`M${X.reviewers - 36} ${mid} C ${X.reviewers - 28} ${mid}, ${X.reviewers - 26} ${y}, ${X.reviewers - 14} ${y}`}
              fill="none" stroke="var(--text-muted)" strokeOpacity="0.35" strokeWidth="1.3"
              strokeDasharray="4 7" strokeLinecap="round"
              className="ct-art-flow" style={{ animationDelay: `${i * 0.3 + 1.2}s` }}
            />
            {node(X.reviewers, y, at, (
              <path d={`M${X.reviewers - 5} ${y} l4 4 l8 -8`} fill="none" stroke="var(--coral-bright)" strokeOpacity="0.9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            ))}
          </g>
        );
      })}
    </svg>
  );
}
