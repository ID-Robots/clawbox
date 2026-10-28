"use client";

/**
 * The agents at work, as a chart — the FIRST thing the Coding Agent app shows
 * (the owner's brief, 2026-10-12: "when you open it we first must see the
 * agents, like a chart; more visual, less text; when we click a reviewer,
 * worker or any agent we see what it is doing at this moment").
 *
 * One node per real agent (src/lib/coding-agent-graph.ts): a team's planner
 * and the lead's turns on the root row, a lane per task with its workers (an
 * attempt is a new worker) and reviewers left to right, dependents hanging
 * under the task they wait for; or one run and the helpers it sent out. A
 * node is a role glyph, a short label, and its state twice — the colour of
 * its ring and the icon on its badge — so the chart reads without colour too.
 * The ones at work pulse (`ct-art-live`) and the edge into them flows
 * (`ct-art-flow`, stepped by CodingTeamTree's `useSteppedFlow`); both rules
 * live under `prefers-reduced-motion: no-preference`, so with motion off the
 * chart is the same chart, still.
 *
 * Every node is a BUTTON with the agent's full name and state. One of them is
 * in the tab order at a time (a roving tab stop); the arrow keys move between
 * them as they are drawn, Home and End to the first and the last. Click,
 * Enter or Space opens what that agent is doing NOW beside the chart — or
 * under it, as a sheet, in a narrow window — and the panel follows the
 * arrows while it is open. Escape closes it and gives focus back to the node.
 *
 * Nothing here polls. The chart is drawn from what its host already reads on
 * its own beat (the app's live poll, the Team card's) and redraws with it, so
 * the open panel is as fresh as the page.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useT } from "@/lib/i18n";
import { holdsResumableSession, isHeld, isLive } from "@/lib/coding-agent-status";
import {
  AGENT_STATES,
  FINAL_LANE,
  GEOMETRY,
  GEOMETRY_COMPACT,
  HELPERS_PER_ROW,
  HELPERS_PER_ROW_COMPACT,
  directionOfKey,
  isActiveState,
  layoutGraph,
  neighbourOf,
  runGraph,
  taskProgress,
  teamGraph,
  tokensByRole,
  type AgentNode,
  type AgentState,
  type GraphRun,
} from "@/lib/coding-agent-graph";
import type { RunMessage } from "@/lib/coding-run-messages";
import { CODING_PROVIDERS, CODING_PROVIDER_NAME_KEY, isCodingProvider, type CodingProvider } from "@/lib/coding-provider";
import type { TeamTaskView, TeamView } from "./CodingTeamCard";
import { useSteppedFlow } from "./CodingTeamTree";
import CodingRunTimeline, { describeStep } from "./CodingRunTimeline";
import CodingRunMessageBox from "./CodingRunMessageBox";
import { BTN_DANGER, BTN_QUIET, BTN_SECONDARY, CARD_SURFACE, INSET_SURFACE } from "./coding-agent-ui";

/** What the chart and its panel read of a run — the app's own `Run` has all of it. */
export interface DiagramRun extends GraphRun {
  task: string;
  source?: "agent" | "owner";
  startedAt: number;
  completedAt: number | null;
  numTurns?: number;
  filesTouched?: string[];
  progress?: string[];
  progressAt?: number[];
  summary?: string | null;
  error?: string | null;
  messages?: RunMessage[];
}

export type DiagramSource =
  | { kind: "team"; team: TeamView }
  | { kind: "run"; run: DiagramRun };

/**
 * Below this width (px) the panel opens under the chart, as a sheet, instead of
 * beside it — and above it too whenever the chart would not fit beside the
 * panel, so the panel never covers or squeezes the chart it describes.
 */
export const SHEET_BELOW = 640;
/** The panel's width beside the chart (21rem), and the gap between them. */
const PANEL_WIDTH = 336;
const PANEL_GAP = 16;
/** Below this width the chart is drawn closer together. */
export const COMPACT_BELOW = 520;
/** How many of an agent's newest steps the panel lists. */
export const PANEL_STEPS = 10;
/** How many changed files the panel names before it counts the rest. */
const PANEL_FILES = 6;

/**
 * Each state's colour, over the app's dark ground: the product's coral for
 * work, the board's own tones for the rest (CodingTeamCard's STATUS_TONE).
 * Every one is a 300/400 tint, legible against the near-black window.
 */
export const STATE_COLOR: Record<AgentState, string> = {
  queued: "#9ca3af",
  working: "var(--coral-bright)",
  reviewing: "#c4b5fd",
  accepted: "#34d399",
  rejected: "#fbbf24",
  failed: "#f87171",
  done: "#7dd3fc",
};

/** …and its icon, so a state never rests on colour alone. */
export const STATE_ICON: Record<AgentState, string> = {
  queued: "schedule",
  working: "progress_activity",
  reviewing: "visibility",
  accepted: "verified",
  rejected: "thumb_down",
  failed: "error",
  done: "check",
};

const ROLE_ICON: Record<AgentNode["role"], string> = {
  planner: "checklist",
  lead: "flag",
  worker: "code",
  reviewer: "rate_review",
  run: "smart_toy",
  helper: "support_agent",
};

/** The width an element is drawn at, followed as the window is resized; 0 until measured. */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** "12s" / "3m 4s" / "2h 5m" — the run page's own way of saying how long. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${total % 60}s`;
}

/** 1.3M, 48k, 950 — the runs list's way of writing tokens. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.max(0, Math.round(n)));
}

/**
 * A team's tokens by the account that paid for them, largest first — the
 * split beside the split by role, since a team's roles may run on different
 * accounts.
 *
 * Summed from the cast list the way the role split is (a settled run's own
 * count, else the live figure the host has), so the two splits add up to the
 * same total; the server's own tally where no run on the list says which
 * account it was on. Empty where nothing says — a board from before the field.
 */
export function tokensByProvider(team: Pick<TeamView, "runs" | "metrics">, runOf: (id: string) => { tokensUsed?: number } | undefined = () => undefined): [CodingProvider, number][] {
  const out = new Map<CodingProvider, number>();
  const known = (team.runs ?? []).filter((r) => r.provider && isCodingProvider(r.provider));
  if (known.length > 0) {
    for (const r of known) {
      const n = Math.max(0, r.tokens ?? runOf(r.id)?.tokensUsed ?? 0);
      if (n > 0) out.set(r.provider!, (out.get(r.provider!) ?? 0) + n);
    }
  } else {
    const tally = team.metrics?.tokensByProvider ?? {};
    for (const p of CODING_PROVIDERS) {
      const n = tally[p];
      if (typeof n === "number" && n > 0) out.set(p, n);
    }
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

/** A task id short enough for its chip; the whole id is in the chip's title. */
function chipText(id: string): string {
  return id.length > 6 ? `${id.slice(0, 5)}…` : id;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** A node's short label — under its circle. */
function shortLabel(t: Translate, n: AgentNode): string {
  switch (n.role) {
    case "planner": return t("codingAgent.diagram.short.planner");
    case "lead": return t("codingAgent.diagram.short.lead");
    case "reviewer": return n.taskId === null && n.lane >= 0 ? t("codingAgent.diagram.short.final") : t("codingAgent.diagram.short.reviewer");
    case "run": return t("codingAgent.diagram.short.run");
    case "helper": return n.helper?.type ?? t("codingAgent.diagram.short.helper");
    default:
      if (n.placeholder) return t("codingAgent.diagram.short.next");
      return n.attempt > 1 ? t("codingAgent.diagram.short.workerAttempt", { n: n.attempt }) : t("codingAgent.diagram.short.worker");
  }
}

/** A node's full name — its button's name and its panel's title. */
export function fullName(t: Translate, n: AgentNode, run?: Pick<DiagramRun, "task"> | null): string {
  const task = n.taskId ?? "";
  switch (n.role) {
    case "planner": return t("codingAgent.team.rolePlanner");
    case "lead": return t("codingAgent.team.roleLead", { task });
    case "reviewer":
      if (n.taskId === null) return n.lane >= 0 ? t("codingAgent.team.finalReview") : t("codingAgent.diagram.name.review", { task: run?.task ? firstLine(run.task) : "" });
      return n.attempt > 1
        ? t("codingAgent.diagram.name.attempt", { name: t("codingAgent.team.roleReviewer", { task }), n: n.attempt })
        : t("codingAgent.team.roleReviewer", { task });
    case "run": return t("codingAgent.diagram.name.run", { task: run?.task ? firstLine(run.task) : "" });
    case "helper": return t("codingAgent.diagram.name.helper", { type: n.helper?.type ?? "" });
    default:
      if (n.placeholder) return t("codingAgent.diagram.name.next", { task });
      return n.attempt > 1
        ? t("codingAgent.diagram.name.attempt", { name: t("codingAgent.team.roleWorker", { task }), n: n.attempt })
        : t("codingAgent.team.roleWorker", { task });
  }
}

function firstLine(text: string, max = 80): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}


/**
 * The run behind a node: the host's copy when it has one, else asked of the
 * box once — and again whenever the host's data moves on (`refreshKey`), never
 * on a clock of its own.
 */
function useRunRecord(runId: string | null, supplied: DiagramRun | undefined, refreshKey: unknown): { run: DiagramRun | null; loading: boolean } {
  const [fetched, setFetched] = useState<{ id: string; run: DiagramRun | null; gone?: boolean } | null>(null);
  // Nothing more to learn: the run has settled, or the box said it has no
  // such run (404) — asking again on every read of the host would only
  // repeat the answer. A failed read is asked again.
  const settledId = fetched && (fetched.gone || (fetched.run && !isHeld(fetched.run.status))) ? fetched.id : null;
  useEffect(() => {
    if (!runId || supplied || settledId === runId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/setup-api/coding-agent/runs?id=${encodeURIComponent(runId)}`, { cache: "no-store" });
        const data = await res.json().catch(() => null) as { run?: DiagramRun } | null;
        if (!cancelled) setFetched({ id: runId, run: res.ok && data?.run ? data.run : null, gone: res.status === 404 });
      } catch {
        if (!cancelled) setFetched({ id: runId, run: null });
      }
    })();
    return () => { cancelled = true; };
  }, [runId, supplied, refreshKey, settledId]);
  if (!runId) return { run: null, loading: false };
  if (supplied) return { run: supplied, loading: false };
  if (fetched?.id === runId) return { run: fetched.run, loading: false };
  return { run: null, loading: true };
}

/** A clock that moves once a second while `on`, for the panel's elapsed time. */
function useSecondTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

interface Props {
  source: DiagramSource;
  /** The app's copy of a run, by id — what a node's state and its panel read first. */
  runOf?: (id: string) => DiagramRun | undefined;
  onOpenRun: (id: string) => void;
  /** A message was sent or a stop asked for: the host reads again. */
  onChanged?: () => void;
  /** The run whose page this is: marked, and opened first. */
  current?: string | null;
  /** The node whose panel is open from the start. */
  initialSelected?: string | null;
  /** Changes whenever the host's data does — a panel that had to ask the box for its run asks again. */
  refreshKey?: unknown;
  /** A heading row of the host's, drawn above the chips. */
  header?: ReactNode;
  /** Inside a card of the host's already: no card of its own. */
  bare?: boolean;
  testId?: string;
  className?: string;
}

export default function CodingAgentDiagram({ source, runOf, onOpenRun, onChanged, current = null, initialSelected = null, refreshKey, header, bare = false, testId = "coding-agent-diagram", className = "" }: Props) {
  const { t } = useT();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  useSteppedFlow(svg);
  const width = useMeasuredWidth(wrap);
  const compact = width > 0 && width < COMPACT_BELOW;

  const lookup = useCallback(
    (id: string): DiagramRun | undefined => (source.kind === "run" && source.run.id === id ? source.run : runOf?.(id)),
    [source, runOf],
  );
  const graph = useMemo(
    () => (source.kind === "team" ? teamGraph(source.team, lookup) : runGraph(source.run, { perRow: compact ? HELPERS_PER_ROW_COMPACT : HELPERS_PER_ROW })),
    [source, lookup, compact],
  );
  const layout = useMemo(() => layoutGraph(graph, compact ? GEOMETRY_COMPACT : GEOMETRY), [graph, compact]);
  // The card's own padding (2rem across) is inside the measured width.
  const room = width - (bare ? 0 : 32) - PANEL_WIDTH - PANEL_GAP;
  const sheet = width > 0 && (width < SHEET_BELOW || room < layout.width);
  const has = useCallback((key: string | null): key is string => key !== null && graph.nodes.some((n) => n.key === key), [graph]);

  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // A node that left the chart (a cleared run) closes its panel.
  const open = has(selected) ? selected : null;
  const tabStop = has(focusKey) ? focusKey : open ?? (has(current) ? current : graph.nodes[0]?.key ?? null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const panelId = `coding-agent-node-panel-${uid}`;
  const hintId = `coding-agent-diagram-hint-${uid}`;
  const arrowId = `coding-agent-diagram-arrow-${uid}`;

  const focusNode = (key: string) => {
    setFocusKey(key);
    buttons.current.get(key)?.focus();
  };
  const close = () => {
    const was = open;
    setSelected(null);
    if (was) focusNode(was);
  };
  const onNodeKey = (e: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setSelected(null);
      return;
    }
    const dir = directionOfKey(e.key);
    if (!dir) return;
    e.preventDefault();
    const next = neighbourOf(layout, key, dir);
    if (!next) return;
    focusNode(next);
    // With a panel open it follows the arrows: the owner is reading agents one after another.
    if (open) setSelected(next);
  };

  const g = layout.geometry;
  const R = g.radius;
  const node = open ? graph.nodes.find((n) => n.key === open) ?? null : null;
  const team = source.kind === "team" ? source.team : null;
  const counts = AGENT_STATES.map((s) => ({ s, n: graph.nodes.filter((x) => x.state === s).length })).filter((x) => x.n > 0);
  const name = team ? firstLine(team.goal, 60) : source.kind === "run" ? firstLine(source.run.task, 60) : "";

  return (
    <div ref={wrap} className={`${bare ? "" : `${CARD_SURFACE} px-4 py-3`} ${className}`} data-testid={testId} data-shape={graph.shape} data-layout={sheet ? "sheet" : "beside"}>
      {header}
      <DiagramFigures source={source} lookup={lookup} />
      {/* What the colours mean, counted: the chart's own summary, and the words
          a state is never left without. */}
      <ul className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]" aria-label={t("codingAgent.diagram.legend")} data-testid={`${testId}-legend`}>
        {counts.map(({ s, n }) => (
          <li key={s} className="inline-flex items-center gap-1" data-state={s}>
            <span className="material-symbols-rounded" style={{ fontSize: 13, color: STATE_COLOR[s] }} aria-hidden="true">{STATE_ICON[s]}</span>
            <span>{t(`codingAgent.diagram.state.${s}`)}</span>
            <span className="font-semibold text-[var(--text-primary)]">{n}</span>
          </li>
        ))}
      </ul>
      <div className={sheet ? "mt-3 flex flex-col gap-3" : "mt-3 flex items-start gap-4"}>
        <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain pb-1">
          <div
            role="group"
            aria-label={t("codingAgent.diagram.label", { name })}
            aria-describedby={hintId}
            className="relative mx-auto"
            style={{ width: layout.width, height: layout.height }}
            data-testid={`${testId}-graph`}
          >
            <svg ref={svg} width={layout.width} height={layout.height} className="absolute inset-0 overflow-visible" aria-hidden="true" focusable="false">
              <defs>
                <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 L8 4 L0 8 z" fill="#a78bfa" fillOpacity="0.85" />
                </marker>
              </defs>
              {layout.trunks.map((d, i) => (
                <path key={`trunk${i}`} d={d} fill="none" stroke="var(--text-muted)" strokeOpacity="0.3" strokeWidth="1.4" strokeLinecap="round" />
              ))}
              {layout.edges.map((e, i) => {
                const depends = e.kind === "depends";
                const muted = e.kind === "lead" || e.kind === "retry";
                return (
                  <path
                    key={`${e.from}>${e.to}`}
                    d={e.d}
                    fill="none"
                    stroke={e.active ? "var(--coral-bright)" : depends ? "#a78bfa" : e.kind === "retry" ? "#fbbf24" : "var(--text-muted)"}
                    strokeOpacity={e.active ? 0.8 : depends ? 0.7 : muted ? 0.55 : 0.45}
                    strokeWidth={e.active ? 1.6 : 1.4}
                    strokeDasharray={e.active ? "5 6" : depends && e.extra ? "4 4" : muted ? "3 5" : undefined}
                    strokeLinecap="round"
                    markerEnd={depends ? `url(#${arrowId})` : undefined}
                    className={e.active ? "ct-art-flow" : undefined}
                    style={e.active ? { animationDelay: `${(i % 5) * 0.3}s` } : undefined}
                    data-kind={e.kind}
                    data-active={e.active || undefined}
                  />
                );
              })}
              {/* A task's chip: where its lane starts, its id on it. */}
              {graph.lanes.filter((l) => l.kind !== "helpers").map((l) => {
                const p = layout.lanes[l.key];
                const final = l.key === FINAL_LANE;
                return (
                  <g key={l.key}>
                    <title>{final ? t("codingAgent.team.finalReview") : t("codingAgent.diagram.lane", { task: l.taskId ?? "" })}</title>
                    <rect x={p.x} y={p.y - g.chipHeight / 2} width={g.chipWidth} height={g.chipHeight} rx="6" fill="var(--fill-2)" stroke="var(--border-subtle)" strokeWidth="1.2" />
                    <text x={p.x + g.chipWidth / 2} y={p.y + 3.5} textAnchor="middle" className="fill-[var(--text-secondary)]" style={{ fontSize: 10, fontWeight: 600, fontFamily: final ? undefined : "var(--font-mono, ui-monospace, monospace)" }}>
                      {final ? "∑" : chipText(l.taskId ?? "")}
                    </text>
                  </g>
                );
              })}
            </svg>
            {graph.nodes.map((n) => {
              const p = layout.nodes[n.key];
              const color = STATE_COLOR[n.state];
              const live = isActiveState(n.state);
              const isOpen = n.key === open;
              const isCurrent = n.key === current;
              const run = n.runId ? lookup(n.runId) : n.role === "run" && source.kind === "run" ? source.run : undefined;
              const label = shortLabel(t, n);
              const named = [label, fullName(t, n, run), t(`codingAgent.diagram.state.${n.state}`), isCurrent ? t("codingAgent.diagram.name.thisRun") : null].filter(Boolean).join(" — ");
              return (
                <button
                  key={n.key}
                  ref={(el) => { if (el) buttons.current.set(n.key, el); else buttons.current.delete(n.key); }}
                  type="button"
                  tabIndex={n.key === tabStop ? 0 : -1}
                  aria-label={named}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? panelId : undefined}
                  title={named}
                  onClick={() => { setFocusKey(n.key); setSelected((s) => (s === n.key ? null : n.key)); }}
                  onKeyDown={(e) => onNodeKey(e, n.key)}
                  onFocus={() => setFocusKey(n.key)}
                  className="group absolute flex flex-col items-center gap-1.5 rounded-xl outline-none cursor-pointer"
                  style={{ left: p.x - g.labelWidth / 2, top: p.y - R, width: g.labelWidth }}
                  data-testid="coding-agent-node"
                  data-key={n.key}
                  data-role={n.role}
                  data-state={n.state}
                  data-task={n.taskId ?? undefined}
                  data-attempt={n.attempt || undefined}
                  data-active={live || undefined}
                  data-selected={isOpen || undefined}
                  data-current={isCurrent || undefined}
                  data-placeholder={n.placeholder || undefined}
                >
                  <span
                    className={`relative grid place-items-center rounded-full transition-shadow group-hover:brightness-125 group-focus-visible:ring-2 group-focus-visible:ring-[var(--coral-ring)] group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-black ${isOpen ? "ring-2 ring-[var(--coral-ring)] ring-offset-2 ring-offset-black" : ""}`}
                    style={{
                      width: R * 2,
                      height: R * 2,
                      background: n.state === "working" ? "color-mix(in srgb, var(--coral-bright) 14%, var(--fill-2))" : "var(--fill-2)",
                      border: `${n.placeholder ? "1.5px dashed" : "1.6px solid"} ${color}`,
                      opacity: n.placeholder ? 0.75 : 1,
                    }}
                  >
                    {/* The pulse: a ring that breathes while the agent works. */}
                    {live && <span className="ct-art-live absolute -inset-[3px] rounded-full border" style={{ borderColor: color, opacity: 0.55 }} aria-hidden="true" />}
                    {/* This page's own run: a second, dashed ring. */}
                    {isCurrent && <span className="absolute -inset-[5px] rounded-full border border-dashed border-white/50" aria-hidden="true" />}
                    <span className="material-symbols-rounded" style={{ fontSize: R, color: n.placeholder ? "var(--text-muted)" : "var(--text-primary)" }} aria-hidden="true">{ROLE_ICON[n.role]}</span>
                    <span
                      className="absolute -right-1 -bottom-1 grid place-items-center rounded-full border border-black/60"
                      style={{ width: 15, height: 15, background: color }}
                      aria-hidden="true"
                      data-testid="coding-agent-node-state"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 11, color: "#0b0b0f", fontWeight: 700 }}>{STATE_ICON[n.state]}</span>
                    </span>
                  </span>
                  <span className={`max-w-full truncate text-[10px] leading-3 font-medium ${isOpen ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`} aria-hidden="true">{label}</span>
                </button>
              );
            })}
          </div>
          <p id={hintId} className="sr-only">{t("codingAgent.diagram.hint")}</p>
        </div>
        {node && (
          <AgentPanel
            key={node.key}
            id={panelId}
            node={node}
            team={team}
            supplied={node.runId ? lookup(node.runId) : undefined}
            parentRun={node.parentRunId ? lookup(node.parentRunId) : undefined}
            // What moves when the data does — never the source object itself,
            // which a host builds afresh on every render.
            refreshKey={refreshKey ?? (source.kind === "team" ? source.team.updatedAt : `${source.run.status}:${source.run.progress?.length ?? 0}`)}
            isCurrent={node.key === current}
            current={current}
            sheet={sheet}
            onClose={close}
            onOpenRun={onOpenRun}
            onChanged={onChanged}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Is there a turn count to show for this run yet?
 *
 * The count is the CLI's own and arrives with its final result event (see the
 * note at `numTurns` in coding-agent.ts: a live per-event count was tried and
 * does not reproduce it). So a run that is still working carries 0, and the
 * chip said "0 turns" beside "5 files changed · 109k tokens" for the whole
 * length of the run. No number is the true answer until there is one; a run
 * that was resumed keeps the turns of the segments it has already finished.
 */
function turnsKnown(run: DiagramRun): boolean {
  return (run.numTurns ?? 0) > 0 || !isLive(run.status);
}

/** The chart's figures as chips and bars: how far the tasks are, what each role spent, how long it has been. Exported for the home's plain row of a lone run. */
export function DiagramFigures({ source, lookup }: { source: DiagramSource; lookup: (id: string) => DiagramRun | undefined }) {
  const { t } = useT();
  // A live run's clock moves between the host's reads.
  const now = useSecondTicker(source.kind === "run" && isLive(source.run.status));
  const chip = "inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]";
  const icon = (name: string) => <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 13 }} aria-hidden="true">{name}</span>;
  if (source.kind === "run") {
    const run = source.run;
    const helpers = (run.subagents?.length ?? 0) + (run.activeSubagents?.length ?? 0);
    const end = run.completedAt ?? (isLive(run.status) ? now : null);
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="coding-agent-diagram-figures">
        {turnsKnown(run) && <span className={chip} data-testid="coding-agent-diagram-turns">{icon("swap_vert")}{t("codingAgent.diagram.turns", { n: run.numTurns ?? 0 })}</span>}
        <span className={chip}>{icon("description")}{t("codingAgent.diagram.files", { n: run.filesTouched?.length ?? 0 })}</span>
        {(run.tokensUsed ?? 0) > 0 && <span className={chip}>{icon("data_usage")}{t("codingAgent.team.metricTokens", { n: compactCount(run.tokensUsed ?? 0) })}</span>}
        {end !== null && <span className={chip}>{icon("timer")}{clock(end - run.startedAt)}</span>}
        {helpers > 0 && <span className={chip}>{icon("support_agent")}{t("codingAgent.diagram.helpers", { n: helpers })}</span>}
      </div>
    );
  }
  const team = source.team;
  const p = taskProgress(team);
  const inProgress = team.tasks.filter((x) => x.status === "in_progress").length;
  const total = Math.max(1, p.total);
  const tokens = tokensByRole(team, lookup);
  const tokenSum = tokens.planner + tokens.workers + tokens.reviewers;
  const wall = team.metrics?.wallMs ?? Math.max(0, team.updatedAt - team.createdAt);
  const split = t("codingAgent.diagram.tokensSplit", { planner: compactCount(tokens.planner), workers: compactCount(tokens.workers), reviewers: compactCount(tokens.reviewers) });
  const byProvider = tokensByProvider(team, lookup);
  const providerSplit = byProvider.map(([p, n]) => `${t(CODING_PROVIDER_NAME_KEY[p])} ${compactCount(n)}`).join(" · ");
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="coding-agent-diagram-figures">
      {p.total > 0 && (
        <span className="inline-flex items-center gap-2 text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-diagram-tasks">
          {icon("task_alt")}
          <span>{t("codingAgent.diagram.tasks", { done: p.done, total: p.total })}</span>
          <span
            className="flex h-1.5 w-28 overflow-hidden rounded-full bg-white/[0.08]"
            role="meter"
            aria-label={t("codingAgent.diagram.tasks", { done: p.done, total: p.total })}
            aria-valuemin={0}
            aria-valuemax={p.total}
            aria-valuenow={p.done}
          >
            <span style={{ width: `${(p.accepted / total) * 100}%`, background: STATE_COLOR.accepted }} />
            <span style={{ width: `${((p.done - p.accepted) / total) * 100}%`, background: STATE_COLOR.done }} />
            <span style={{ width: `${(inProgress / total) * 100}%`, background: STATE_COLOR.working, opacity: 0.8 }} />
          </span>
        </span>
      )}
      {tokenSum > 0 && (
        <span className="inline-flex items-center gap-2 text-[11px] text-[var(--text-secondary)]" title={split} data-testid="coding-agent-diagram-tokens">
          {icon("data_usage")}
          <span>{t("codingAgent.team.metricTokens", { n: compactCount(tokenSum) })}</span>
          <span className="flex h-1.5 w-24 overflow-hidden rounded-full bg-white/[0.08]" role="img" aria-label={split}>
            <span style={{ width: `${(tokens.planner / tokenSum) * 100}%`, background: "var(--coral-bright)" }} />
            <span style={{ width: `${(tokens.workers / tokenSum) * 100}%`, background: "#fbbf24" }} />
            <span style={{ width: `${(tokens.reviewers / tokenSum) * 100}%`, background: STATE_COLOR.reviewing }} />
          </span>
        </span>
      )}
      {byProvider.length > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-diagram-provider-tokens">
          {icon("account_balance_wallet")}
          {t("codingAgent.team.tokensByProvider", { split: providerSplit })}
        </span>
      )}
      {wall > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-diagram-wall">
          {icon("timer")}{t("codingAgent.team.metricTime", { time: clock(wall) })}
        </span>
      )}
    </div>
  );
}

/** What one agent is doing NOW: its step, its last steps, its figures, its task and what came of it, and what you can do. */
function AgentPanel({ id, node, team, supplied, parentRun, refreshKey, isCurrent, current, sheet, onClose, onOpenRun, onChanged }: {
  id: string;
  node: AgentNode;
  team: TeamView | null;
  supplied: DiagramRun | undefined;
  parentRun: DiagramRun | undefined;
  refreshKey: unknown;
  isCurrent: boolean;
  current: string | null;
  sheet: boolean;
  onClose: () => void;
  onOpenRun: (id: string) => void;
  onChanged?: () => void;
}) {
  const { t } = useT();
  const panel = useRef<HTMLElement>(null);
  // Under the chart, the sheet may open below the fold: bring it up.
  useEffect(() => {
    if (sheet) panel.current?.scrollIntoView?.({ block: "nearest" });
  }, [sheet]);
  const { run, loading } = useRunRecord(node.runId, supplied, refreshKey);
  const [messaging, setMessaging] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  // A refused Stop says so where the owner is looking: above the buttons, and
  // brought on screen — under them, in a sheet, it sat below the fold and the
  // press looked like nothing happened.
  const stopErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (stopError) stopErrorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [stopError]);
  const live = run ? isLive(run.status) : false;
  const stoppable = run !== null && isHeld(run.status) && run.status !== "draft";
  const now = useSecondTicker(live || (node.role === "helper" && node.state === "working"));
  const task: TeamTaskView | null = node.taskId && team ? team.tasks.find((x) => x.task_id === node.taskId) ?? null : null;
  const color = STATE_COLOR[node.state];
  const helper = node.helper;

  const started = helper?.startedAt ?? run?.startedAt ?? null;
  const ended = helper ? helper.endedAt ?? (node.state === "working" ? now : null) : run ? run.completedAt ?? (live ? now : null) : null;
  const lines = run?.progress ?? [];
  const times = run?.progressAt ?? [];
  const recent = lines.slice(-PANEL_STEPS);
  const recentTimes = times.length === lines.length ? times.slice(-PANEL_STEPS) : [];
  const step = lines.length > 0 ? describeStep(t, lines[lines.length - 1]) : null;
  const files = run?.filesTouched ?? [];
  const openTarget = node.runId ?? node.parentRunId ?? null;

  const stop = async () => {
    if (!run) return;
    setStopping(true);
    setStopError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: run.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error || t("codingAgent.diagram.stopFailed"));
      }
      onChanged?.();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : t("codingAgent.diagram.stopFailed"));
    } finally {
      setStopping(false);
    }
  };

  const label = "text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]";
  // What it is doing now, in a line: its newest step, or what the board says.
  const nowLine = step
    ? <><span className="material-symbols-rounded shrink-0" style={{ fontSize: 15, color }} aria-hidden="true">{step.icon}</span><span className="min-w-0 break-words">{step.label}{step.detail ? <span className="text-[var(--text-muted)]"> · {step.detail}</span> : null}</span></>
    : helper
      ? <span className="min-w-0 break-words">{helper.description || t("codingAgent.diagram.nothingYet")}</span>
      : node.placeholder
        ? <span className="min-w-0 break-words">{t("codingAgent.diagram.notStarted")}</span>
        : node.role === "planner" && team?.status === "planning"
          ? <span className="min-w-0 break-words">{t("codingAgent.team.planning")}</span>
          : <span className="min-w-0 break-words text-[var(--text-muted)]">{loading ? t("codingAgent.diagram.loading") : node.runId && !run ? t("codingAgent.diagram.noRecord") : t("codingAgent.diagram.nothingYet")}</span>;
  const waiting = task && task.status === "pending"
    ? task.depends_on.filter((d) => {
      const dep = team?.tasks.find((x) => x.task_id === d);
      return !dep || (dep.status !== "retired" && !(dep.status === "complete" && dep.review?.verdict === "accepted"));
    })
    : [];
  const verdict = node.role === "reviewer"
    ? (node.taskId === null ? team?.finalReview ?? null : task && task.reviewRunId === node.runId ? task.review : null)
    : null;

  return (
    <section
      id={id}
      role="region"
      aria-label={fullName(t, node, run ?? parentRun)}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      ref={panel}
      className={sheet
        ? "rounded-2xl border border-white/[0.1] bg-black/30 px-4 pt-2 pb-3"
        : `w-[21rem] shrink-0 ${INSET_SURFACE} px-4 py-3`}
      data-testid="coding-agent-node-panel"
      data-key={node.key}
      data-role={node.role}
      data-state={node.state}
      data-sheet={sheet || undefined}
    >
      {sheet && <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/20" aria-hidden="true" />}
      <div className="flex items-start gap-2">
        <span className="grid shrink-0 place-items-center rounded-full" style={{ width: 30, height: 30, border: `1.6px solid ${color}`, background: "var(--fill-2)" }} aria-hidden="true">
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{ROLE_ICON[node.role]}</span>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold leading-tight text-[var(--text-primary)] break-words" data-testid="coding-agent-node-panel-title">{fullName(t, node, run ?? parentRun)}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-semibold" style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }} data-testid="coding-agent-node-panel-state">
              <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">{STATE_ICON[node.state]}</span>
              {t(`codingAgent.diagram.state.${node.state}`)}
            </span>
            {started !== null && ended !== null && (
              <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]" data-testid="coding-agent-node-panel-elapsed">
                <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 12 }} aria-hidden="true">timer</span>
                {t("codingAgent.diagram.elapsed", { time: clock(ended - started) })}
              </span>
            )}
            {isCurrent && <span className="text-[var(--text-muted)]">· {t("codingAgent.diagram.name.thisRun")}</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} className={`${BTN_QUIET} !px-1.5`} aria-label={t("codingAgent.diagram.close")} data-testid="coding-agent-node-panel-close">
          <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">close</span>
        </button>
      </div>

      {/* NOW — the one line the owner opened this for. */}
      <div className="mt-3">
        {/* Now, while it works; once it has stopped, the last thing it did —
            by its run when the panel has it, else by the node's own state,
            so a finished agent whose record is still loading is not "now". */}
        <p className={label} data-testid="coding-agent-node-panel-now-label">{t((run ? !isHeld(run.status) : node.state !== "queued" && !isActiveState(node.state)) ? "codingAgent.diagram.lastStep" : "codingAgent.diagram.now")}</p>
        <p className="mt-1 flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--text-primary)]" aria-live="polite" data-testid="coding-agent-node-panel-now">{nowLine}</p>
      </div>

      {run && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-node-panel-figures">
          {turnsKnown(run) && <span className="rounded-full bg-white/[0.05] px-2 py-0.5" data-testid="coding-agent-node-panel-turns">{t("codingAgent.diagram.turns", { n: run.numTurns ?? 0 })}</span>}
          {(run.tokensUsed ?? 0) > 0 && <span className="rounded-full bg-white/[0.05] px-2 py-0.5">{t("codingAgent.team.metricTokens", { n: compactCount(run.tokensUsed ?? 0) })}</span>}
          <span className="rounded-full bg-white/[0.05] px-2 py-0.5">{t("codingAgent.diagram.files", { n: files.length })}</span>
        </div>
      )}

      {/* Its task, and what came of it. */}
      {(task || (node.role === "planner" && team) || (node.role === "run" && run) || helper) && (
        <div className="mt-3 space-y-2 text-[12px]">
          {node.role === "planner" && team && (
            <div>
              <p className={label}>{t("codingAgent.diagram.goal")}</p>
              <p className="mt-0.5 break-words text-[var(--text-secondary)] line-clamp-4">{team.goal}</p>
              {team.tasks.length > 0 && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t("codingAgent.diagram.planned", { n: team.tasks.length })}</p>}
            </div>
          )}
          {node.role === "run" && run && (
            <div>
              <p className={label}>{t("codingAgent.diagram.task")}</p>
              <p className="mt-0.5 break-words text-[var(--text-secondary)] line-clamp-4">{run.task}</p>
            </div>
          )}
          {helper && parentRun && (
            <p className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.diagram.sentBy", { run: parentRun.id })}</p>
          )}
          {task && (
            <div data-testid="coding-agent-node-panel-task">
              <p className={label}>{t("codingAgent.diagram.task")} <span className="font-mono normal-case tracking-normal">{task.task_id}</span></p>
              <p className="mt-0.5 break-words text-[var(--text-secondary)] line-clamp-4">{task.task_description}</p>
              {waiting.length > 0 && <p className="mt-0.5 text-[11px] text-amber-200/90">{t("codingAgent.team.waitingFor", { ids: waiting.join(", ") })}</p>}
              {task.hold?.reason && <p className="mt-0.5 text-[11px] text-amber-200/90 break-words">{t("codingAgent.team.held", { task: task.hold.dependency })} — {task.hold.reason}</p>}
            </div>
          )}
          {node.role === "worker" && !node.placeholder && task?.result && task.assigned_to === node.runId && (
            <div data-testid="coding-agent-node-panel-result">
              <p className={label}>{t("codingAgent.diagram.result")}</p>
              <p className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11.5px] text-[var(--text-secondary)]">{task.result}</p>
            </div>
          )}
          {verdict && (
            <div data-testid="coding-agent-node-panel-verdict" data-verdict={verdict.verdict}>
              <p className={label}>{t("codingAgent.diagram.verdict")}</p>
              <p className="mt-0.5 text-[11.5px] break-words">
                <span className={`font-semibold ${verdict.verdict === "accepted" ? "text-emerald-400" : "text-red-300"}`}>{t(`codingAgent.team.review.${verdict.verdict}`)}</span>
                {verdict.notes && <span className="text-[var(--text-secondary)]"> — {verdict.notes}</span>}
              </p>
            </div>
          )}
          {node.role === "run" && run && (run.error || run.summary) && (
            <div>
              <p className={label}>{t("codingAgent.diagram.result")}</p>
              <p className={`mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11.5px] ${run.error ? "text-red-300" : "text-[var(--text-secondary)]"}`}>{run.error || run.summary}</p>
            </div>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-3">
          <p className={label}>{t("codingAgent.diagram.files", { n: files.length })}</p>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-node-panel-files">
            {files.slice(0, PANEL_FILES).map((f) => <li key={f} className="truncate" title={f}>{f}</li>)}
            {files.length > PANEL_FILES && <li className="font-sans text-[var(--text-muted)]">{t("codingAgent.diagram.moreFiles", { n: files.length - PANEL_FILES })}</li>}
          </ul>
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-3">
          <CodingRunTimeline lines={recent} times={recentTimes} startedAt={run?.startedAt} live={live} embedded testId="coding-agent-node-panel-steps" />
        </div>
      )}

      {stopError && <p ref={stopErrorRef} className="mt-3 text-[11px] text-red-300 break-words" role="alert" data-testid="coding-agent-node-panel-error">{stopError}</p>}
      {/* What you can do from here. */}
      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="coding-agent-node-panel-actions">
        {openTarget && openTarget !== current && (
          <button type="button" className={BTN_SECONDARY} onClick={() => onOpenRun(openTarget)} data-testid="coding-agent-node-panel-open">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
            {t("codingAgent.diagram.openRun")}
          </button>
        )}
        {run && !isCurrent && holdsResumableSession(run.status) && (
          <button type="button" className={BTN_SECONDARY} onClick={() => setMessaging((v) => !v)} aria-expanded={messaging} data-testid="coding-agent-node-panel-message">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">chat</span>
            {t("codingAgent.diagram.message")}
          </button>
        )}
        {stoppable && (
          <button type="button" className={BTN_DANGER} onClick={() => void stop()} disabled={stopping} data-testid="coding-agent-node-panel-stop">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">stop_circle</span>
            {t("codingAgent.stop")}
          </button>
        )}
      </div>
      {messaging && run && <div className="mt-2"><CodingRunMessageBox runId={run.id} messages={run.messages} onSent={onChanged} /></div>}
    </section>
  );
}

/**
 * The words that used to stand in front of the chart, folded under it: nothing
 * is lost, it is one click away. A native disclosure, so the keyboard, the
 * screen reader and find-in-page all know what it is.
 */
export function DiagramDetails({ children, testId = "coding-agent-diagram-details", defaultOpen = false, className = "mt-3" }: { children: ReactNode; testId?: string; defaultOpen?: boolean; className?: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className={`group ${className}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid={testId}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)] [&::-webkit-details-marker]:hidden" data-testid={`${testId}-toggle`}>
        <span className="material-symbols-rounded transition-transform group-open:rotate-90" style={{ fontSize: 16 }} aria-hidden="true">chevron_right</span>
        {t("codingAgent.diagram.details")}
      </summary>
      <div className="mt-1">{children}</div>
    </details>
  );
}
