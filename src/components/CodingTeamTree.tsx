"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useT } from "@/lib/i18n";

/**
 * The coding team as a tree, drawn once: the assistant hands a goal to the
 * Coding Agent, which asks a planner for the tasks, fans them out to workers
 * side by side, and every worker's result passes a reviewer. Read-only — a
 * picture of who is who, sized by the board (how many workers, how many
 * reviewers, which of them are at work right now), so the nodes it draws are
 * the agents the card counts: planner + workers + reviewers, and the lead
 * under the planner once a team with the lead's switch on has used it.
 *
 * A deliberate sibling of CodingAgentDelegationArt and MemoryShardArt: the
 * same stroke weights, the same muted palette over the product's coral, the
 * same restraint. Every animation lives under `@media
 * (prefers-reduced-motion: no-preference)` in globals.css (`ct-art-*`), so an
 * owner who turned motion off gets the same diagram. `aria-hidden` because
 * the card's sentence says this in words.
 *
 * The connectors' flowing dashes are PAUSED in the stylesheet and stepped here
 * (useSteppedFlow, FLOW_FPS); the nodes' breathing is opacity and runs on the
 * compositor untouched.
 */
export interface CodingTeamTreeProps {
  /**
   * Worker nodes drawn, 1–5; a board with more is drawn with five. In the
   * "run" shape these are the run's OWN helpers, and none is a fair answer —
   * a run that sent nobody out draws no fan.
   */
  workers?: number;
  /** How many of the workers are at work right now — those pulse in coral. */
  activeWorkers?: number;
  /** Reviewer nodes drawn, 0–5. Ignored in the "run" shape. */
  reviewers?: number;
  /** How many reviewers are deciding right now. */
  activeReviewers?: number;
  /** The planner is reading the folder right now. Ignored in the "run" shape. */
  plannerActive?: boolean;
  /**
   * How many turns the team's LEAD took (the planner back after a worker
   * settled, with the owner's switch on). None draws no lead: a team
   * without the switch looks exactly as it always did. Ignored in the "run" shape.
   */
  leads?: number;
  /** The lead is deciding right now. */
  leadActive?: boolean;
  /**
   * What the picture is OF.
   *
   * "team" — the board: the assistant hands a goal to the Coding Agent, which
   * asks a planner for the tasks, fans them out to workers, and every result
   * passes a reviewer.
   *
   * "run" — one run: the assistant, the Coding Agent, and the helpers that run
   * sent out itself. The same strokes, the same nodes, three columns instead
   * of five, so a solo run's page is not a page with the picture missing.
   */
  shape?: "team" | "run";
  className?: string;
}

export const MAX_TREE_WORKERS = 5;
export const MAX_TREE_REVIEWERS = 5;

/**
 * How often the connectors' dashes move. `ct-art-flow` animates
 * stroke-dashoffset, which the compositor cannot run: left running, it had the
 * browser recalculate style and repaint the whole drawing 60 times a second
 * for as long as a run's page or a project's Team tab was open — a run that
 * finished hours ago included, and a window sitting behind others. So the
 * animations run paused and a timer steps them, the way the mascot's resting
 * animations are stepped (AMBIENT_FPS in Mascot.tsx, the same rate). The dash
 * travels ~15 px a second at the drawing's full width, so a step is about one
 * pixel: the flow reads the same.
 */
export const FLOW_FPS = 15;

/** The connectors' animation (globals.css), the one this file steps. */
const FLOW_ANIMATION = "ct-art-flow";

/**
 * Step the `ct-art-flow` connectors to the time since the drawing mounted,
 * FLOW_FPS times a second. Nothing while the desktop is hidden or the drawing
 * is scrolled out of view, since a step there would repaint what nobody can
 * see; the next step after it comes back lands where a running animation would
 * have been. A paused animation costs nothing between steps. Under reduced
 * motion there are no flow animations to step.
 *
 * The animations are looked up once per commit (a render can add or drop a
 * connector), not per step, and a step only WRITES: reading a CSS animation's
 * state flushes style, and a read between two writes made every step a style
 * recalc per connector — measured at 209 recalcs a second, worse than the 60
 * this replaces. Writes alone are one recalc per step.
 */
function useSteppedFlow(rootRef: RefObject<SVGSVGElement | null>) {
  const stale = useRef(true);
  useLayoutEffect(() => { stale.current = true; });
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof root.getAnimations !== "function") return;
    let inView = true;
    let io: IntersectionObserver | null = null;
    // Wrapped: an observer that cannot be made only costs the off-screen
    // pause, never the flow.
    try {
      io = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last) inView = last.isIntersecting;
      });
      io.observe(root);
    } catch {
      io = null;
      inView = true;
    }
    // Asked per step rather than once: the owner can turn motion off while the
    // drawing is open, and then there is nothing to step.
    let reduce: MediaQueryList | null = null;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { reduce = null; }
    const started = performance.now();
    let flows: Animation[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (inView && document.visibilityState !== "hidden" && reduce?.matches !== true) {
        if (stale.current) {
          stale.current = false;
          flows = root.getAnimations({ subtree: true })
            .filter((a) => (a as CSSAnimation).animationName === FLOW_ANIMATION);
        }
        const now = performance.now() - started;
        for (const a of flows) a.currentTime = now;
      }
      timer = setTimeout(tick, 1000 / FLOW_FPS);
    };
    tick();
    return () => {
      if (timer !== null) clearTimeout(timer);
      io?.disconnect();
    };
  }, [rootRef]);
}

/** `n` points spread evenly between `top` and `bottom`; one point on the middle line. */
function spread(n: number, top: number, bottom: number, mid: number): number[] {
  if (n <= 1) return n === 1 ? [mid] : [];
  return Array.from({ length: n }, (_, i) => top + ((bottom - top) * i) / (n - 1));
}

export default function CodingTeamTree({ workers = 3, activeWorkers = 0, reviewers = 1, activeReviewers = 0, plannerActive = false, leads = 0, leadActive = false, shape = "team", className = "" }: CodingTeamTreeProps) {
  const { t } = useT();
  const svgRef = useRef<SVGSVGElement>(null);
  useSteppedFlow(svgRef);
  const board = shape === "team";
  const w = Math.min(MAX_TREE_WORKERS, Math.max(board ? 1 : 0, Math.round(workers)));
  const r = board ? Math.min(MAX_TREE_REVIEWERS, Math.max(0, Math.round(reviewers))) : 0;
  const l = board ? Math.max(0, Math.round(leads)) : 0;
  const liveL = l > 0 && leadActive;
  const liveW = Math.min(w, Math.max(0, Math.round(activeWorkers)));
  const liveR = Math.min(r, Math.max(0, Math.round(activeReviewers)));
  // The caption counts what there IS, the columns draw what fits: a board of
  // nine workers used to be captioned "Workers · 5" because the label read the
  // capped number, so the picture quietly disagreed with the card beside it.
  const wSaid = Math.max(w, Math.round(workers));
  const rSaid = Math.max(r, board ? Math.round(reviewers) : 0);
  const mid = 100;
  const wys = spread(w, 40, 160, mid);
  const rys = spread(r, 40, 160, mid);
  // Five columns on a board — assistant, Coding Agent, planner, workers,
  // reviewers — and three for one run, spread over the same width so the two
  // shapes are the same drawing at the same weight.
  const X = board
    ? { assistant: 40, agent: 130, planner: 220, workers: 310, reviewers: 400 }
    : { assistant: 60, agent: 200, planner: 200, workers: 350, reviewers: 350 };
  // Where the fan to the workers starts: the planner hands out a board's
  // tasks, the run itself sends out its own helpers.
  const fanFrom = board ? X.planner + 14 : X.agent + 34;
  const node = (cx: number, cy: number, live: boolean, extra?: ReactNode) => (
    <g className={live ? "ct-art-live" : "ct-art-node"} data-live={live || undefined}>
      <rect x={cx - 12} y={cy - 12} width="24" height="24" rx="7" fill="var(--fill-2)" stroke={live ? "var(--coral-bright)" : "var(--border-subtle)"} strokeOpacity={live ? 0.7 : 1} strokeWidth="1.4" />
      {extra ?? <circle cx={cx} cy={cy} r="3" fill={live ? "var(--coral-bright)" : "var(--text-muted)"} fillOpacity="0.9" />}
    </g>
  );

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 440 180"
      className={`w-full max-w-[30rem] h-auto ${className}`}
      aria-hidden="true"
      focusable="false"
      data-testid="coding-team-tree"
      data-shape={shape}
      data-workers={w}
      data-reviewers={r}
      data-active={liveW}
      data-active-reviewers={liveR}
      data-planner-active={plannerActive || undefined}
      data-leads={l}
    >
      {/* Column captions, with the count the card states. */}
      {(board
        ? [
          { x: X.assistant, label: t("codingAgent.team.artMain") },
          { x: X.agent, label: t("codingAgent.title") },
          { x: X.planner, label: `${t("codingAgent.team.artPlanner")} · 1` },
          { x: X.workers, label: `${t("codingAgent.team.artWorkers")} · ${wSaid}` },
          { x: X.reviewers, label: `${t("codingAgent.team.artReviewers")} · ${rSaid}` },
        ]
        : [
          { x: X.assistant, label: t("codingAgent.team.artMain") },
          { x: X.agent, label: t("codingAgent.title") },
          ...(w > 0 ? [{ x: X.workers, label: `${t("codingAgent.statHelpers")} · ${wSaid}` }] : []),
        ]
      ).map((c) => (
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
      {board && <path d={`M${X.agent + 34} ${mid} H${X.planner - 16}`} fill="none" stroke="var(--text-muted)" strokeOpacity="0.45" strokeWidth="1.4" strokeDasharray="5 6" strokeLinecap="round" className="ct-art-flow" style={{ animationDelay: "0.2s" }} />}

      {/* The planner: reads the folder, answers the tasks. A run of its own
          has none — it IS the one handing work out. */}
      {board && (
        <g data-testid="coding-team-tree-planner">
          {node(X.planner, mid, plannerActive, (
            <path d={`M${X.planner - 5} ${mid - 4} h10 M${X.planner - 5} ${mid} h10 M${X.planner - 5} ${mid + 4} h6`} stroke={plannerActive ? "var(--coral-bright)" : "var(--text-muted)"} strokeOpacity="0.9" strokeWidth="1.5" strokeLinecap="round" />
          ))}
        </g>
      )}

      {/* The lead: the planner, back after a worker settled, looking at the
          plan again — under the planner, tied to it, with its count beneath.
          Only on a team that had lead turns. */}
      {l > 0 && (
        <g data-testid="coding-team-tree-lead" data-live={liveL || undefined}>
          <path d={`M${X.planner} ${mid + 14} V${148 - 14}`} fill="none" stroke="var(--text-muted)" strokeOpacity="0.45" strokeWidth="1.4" strokeDasharray="3 5" strokeLinecap="round" className="ct-art-flow" style={{ animationDelay: "0.6s" }} />
          {node(X.planner, 148, liveL, (
            <path d={`M${X.planner - 5} ${148 + 3} l5 -6 l5 6`} fill="none" stroke={liveL ? "var(--coral-bright)" : "var(--text-muted)"} strokeOpacity="0.9" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          <text x={X.planner} y="176" textAnchor="middle" className="fill-[var(--text-muted)]" style={{ fontSize: 10, fontWeight: 500, letterSpacing: 0.4 }}>
            {`${t("codingAgent.team.artLead")} · ${l}`}
          </text>
        </g>
      )}

      {/* The workers: tasks out from the planner, results on to the reviewers. */}
      {wys.map((y, i) => {
        const at = i < liveW;
        return (
          <g key={`w${i}`} data-testid="coding-team-tree-worker" data-live={at || undefined}>
            <path
              d={`M${fanFrom} ${mid} C ${fanFrom + 36} ${mid}, ${X.workers - 50} ${y}, ${X.workers - 14} ${y}`}
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
