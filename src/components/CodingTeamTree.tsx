"use client";

import { useT } from "@/lib/i18n";

/**
 * The coding team as a tree, drawn once: the assistant hands a goal to the
 * Coding Agent, which fans it out to workers side by side, and every
 * worker's result converges on the reviewer. Read-only — a picture of who
 * is who, sized by the board (how many workers, how many are at work), not
 * a control.
 *
 * A deliberate sibling of CodingAgentDelegationArt and MemoryShardArt: the
 * same stroke weights, the same muted palette over the product's coral, the
 * same restraint. Where the delegation art fans OUT and the shard art
 * CONVERGES, this one does both in turn, which is what a team is. Every
 * animation lives under `@media (prefers-reduced-motion: no-preference)` in
 * globals.css (`ct-art-*`), so an owner who turned motion off gets the same
 * diagram. `aria-hidden` because the card's sentence says this in words.
 */
export interface CodingTeamTreeProps {
  /** Worker nodes drawn, 1–5; a board with more is drawn with five. */
  workers?: number;
  /** Whether a reviewer node is drawn. */
  reviewer?: boolean;
  /** How many of the workers are at work right now — those pulse faster. */
  activeWorkers?: number;
  className?: string;
}

export const MAX_TREE_WORKERS = 5;

export default function CodingTeamTree({ workers = 3, reviewer = true, activeWorkers = 0, className = "" }: CodingTeamTreeProps) {
  const { t } = useT();
  const n = Math.min(MAX_TREE_WORKERS, Math.max(1, Math.round(workers)));
  const live = Math.min(n, Math.max(0, Math.round(activeWorkers)));
  // The workers' column: evenly spread between the top and bottom margins,
  // a lone worker on the centre line.
  const top = 34;
  const bottom = 134;
  const ys = n === 1 ? [84] : Array.from({ length: n }, (_, i) => top + ((bottom - top) * i) / (n - 1));
  const mid = 84;

  return (
    <svg
      viewBox="0 0 360 150"
      className={`w-full max-w-[24rem] h-auto ${className}`}
      aria-hidden="true"
      focusable="false"
      data-testid="coding-team-tree"
      data-workers={n}
      data-reviewer={reviewer ? "true" : "false"}
      data-active={live}
    >
      {/* Column captions. */}
      {[
        { x: 40, label: t("codingAgent.team.artMain") },
        { x: 146, label: t("codingAgent.title") },
        { x: 250, label: t("codingAgent.team.artWorkers") },
        ...(reviewer ? [{ x: 330, label: t("codingAgent.artReviewer") }] : []),
      ].map((c) => (
        <text key={c.x} x={c.x} y="14" textAnchor="middle" className="fill-[var(--text-muted)]" style={{ fontSize: 10, fontWeight: 500, letterSpacing: 0.4 }}>
          {c.label}
        </text>
      ))}

      {/* The assistant: the one the owner talks to. */}
      <g className="ct-art-hub">
        <rect x="10" y={mid - 18} width="60" height="36" rx="10" fill="var(--fill-2)" stroke="var(--border-subtle)" strokeWidth="1.4" />
        <circle cx="30" cy={mid} r="3.5" fill="var(--coral-bright)" />
        <path d={`M40 ${mid - 6} h16 M40 ${mid} h12 M40 ${mid + 6} h8`} stroke="var(--text-muted)" strokeOpacity="0.8" strokeWidth="1.6" strokeLinecap="round" />
      </g>

      {/* The goal, handed to the Coding Agent. */}
      <path d={`M74 ${mid} H112`} fill="none" stroke="var(--text-muted)" strokeOpacity="0.45" strokeWidth="1.4" strokeDasharray="5 6" strokeLinecap="round" className="ct-art-flow" />

      {/* The Coding Agent: the planner, in the product's coral. */}
      <g className="ct-art-hub" style={{ animationDelay: "0.4s" }}>
        <rect x="116" y={mid - 18} width="60" height="36" rx="10" fill="var(--coral-bright)" fillOpacity="0.10" stroke="var(--coral-bright)" strokeOpacity="0.55" strokeWidth="1.5" />
        <path d={`M134 ${mid - 6} L144 ${mid} L134 ${mid + 6}`} fill="none" stroke="var(--coral-bright)" strokeOpacity="0.85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d={`M150 ${mid + 6} L156 ${mid - 6}`} fill="none" stroke="var(--coral-bright)" strokeOpacity="0.85" strokeWidth="1.8" strokeLinecap="round" />
      </g>

      {/* The workers: tasks out, results back. */}
      {ys.map((y, i) => {
        const at = i < live;
        return (
          <g key={i} data-testid="coding-team-tree-worker" data-live={at || undefined}>
            <path
              d={`M180 ${mid} C 208 ${mid}, 212 ${y}, 236 ${y}`}
              fill="none" stroke="var(--text-muted)" strokeOpacity="0.45" strokeWidth="1.4"
              strokeDasharray="5 6" strokeLinecap="round"
              className="ct-art-flow" style={{ animationDelay: `${i * 0.3}s` }}
            />
            <g className={at ? "ct-art-live" : "ct-art-node"} style={{ animationDelay: `${i * 0.3 + 0.5}s` }}>
              <rect x="238" y={y - 12} width="24" height="24" rx="7" fill="var(--fill-2)" stroke={at ? "var(--coral-bright)" : "var(--border-subtle)"} strokeOpacity={at ? 0.7 : 1} strokeWidth="1.4" />
              <circle cx="250" cy={y} r="3" fill={at ? "var(--coral-bright)" : "var(--text-muted)"} fillOpacity="0.9" />
            </g>
            {reviewer && (
              <path
                d={`M266 ${y} C 290 ${y}, 296 ${mid}, 318 ${mid}`}
                fill="none" stroke="var(--text-muted)" strokeOpacity="0.35" strokeWidth="1.3"
                strokeDasharray="4 7" strokeLinecap="round"
                className="ct-art-flow" style={{ animationDelay: `${i * 0.3 + 0.9}s` }}
              />
            )}
          </g>
        );
      })}

      {/* The reviewer: every result passes through it. */}
      {reviewer && (
        <g className="ct-art-node" style={{ animationDelay: "1.2s" }} data-testid="coding-team-tree-reviewer">
          <rect x="318" y={mid - 13} width="26" height="26" rx="8" fill="var(--fill-2)" stroke="var(--border-subtle)" strokeWidth="1.4" />
          <path d={`M325 ${mid} l4 4 l8 -8`} fill="none" stroke="var(--coral-bright)" strokeOpacity="0.9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  );
}
