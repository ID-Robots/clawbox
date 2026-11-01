/**
 * The agents behind a coding team or a coding run, as the graph the Coding
 * Agent app draws first (CodingAgentDiagram.tsx — the owner's brief,
 * 2026-10-12: "when you open it we first must see the agents, like a chart").
 *
 * One node per REAL agent: the planner, every turn the lead took, every
 * worker (an attempt is a new worker, the board's own count), every reviewer,
 * and — for one run — the run and the helpers it sent out. A task no worker
 * has taken yet is drawn too, as a queued placeholder, because the plan is
 * half of what a team is and an empty lane says nothing.
 *
 * Three steps, each pure and each tested on its own:
 *
 *   teamGraph / runGraph — who, in which lane, in which state, joined how
 *   layoutGraph          — where: an outline, the planner at the root, each
 *                          task a lane, dependents hanging under the task
 *                          they wait for, a lane's agents left to right
 *   neighbourOf          — which node an arrow key moves to
 *
 * Pure on purpose: no fs, no React. `coding-team-board.ts` is the board's own
 * module but it reads the disk, so the shapes here are STRUCTURAL — the app's
 * `TeamView` and `Run` satisfy them as they are.
 */

import type { CodingRunStatus } from "./coding-agent-status";

export type AgentRole = "planner" | "lead" | "worker" | "reviewer" | "run" | "helper";

/** Every state a node can be in, in the order the legend reads. */
export const AGENT_STATES = ["queued", "working", "reviewing", "accepted", "rejected", "failed", "done"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** At work right now: the node pulses and the edge into it flows. */
export function isActiveState(state: AgentState): boolean {
  return state === "working" || state === "reviewing";
}

/** What the graph needs of a run record: the app's `Run` has it all. */
export interface GraphRunInfo {
  id: string;
  status: CodingRunStatus;
  tokensUsed?: number;
}

type TeamStatusView = "queued" | "planning" | "working" | "reviewing" | "done" | "failed" | "stopped";
type TaskStatusView = "pending" | "in_progress" | "complete" | "failed" | "rejected" | "retired";

/** What the graph needs of a board (GET coding-agent/team): `TeamView` has it all. */
export interface GraphTeam {
  id: string;
  status: TeamStatusView;
  plannerRunId: string | null;
  /**
   * The board's cast list, in the order the runs started. Absent from an older
   * server. `provider`, `model` and `modelRole` are what each member runs on
   * (coding-team-board.ts TeamRunRef), each absent on a board from before they
   * were kept — the panel's model line then says nothing.
   */
  runs?: { id: string; role: "planner" | "worker" | "reviewer" | "lead"; taskId: string | null; tokens?: number; provider?: string | null; model?: string | null; modelRole?: string | null }[];
  tasks: {
    task_id: string;
    status: TaskStatusView;
    assigned_to: string | null;
    depends_on: string[];
    review: { verdict: "accepted" | "rejected" } | null;
    reviewRunId?: string | null;
    attempts: number;
    holds?: number;
    ciReoffers?: number;
    budgetReoffers?: number;
  }[];
  shape?: { review: "each" | "final" | "none" } | null;
  finalReview?: { verdict: "accepted" | "rejected" } | null;
}

/** One helper a run sent out, as the run record keeps it. */
export interface GraphHelper {
  type: string;
  description: string;
  startedAt: number;
  endedAt?: number;
  refused?: boolean;
}

/** What the graph needs of ONE run: the app's `Run` has it all. */
export interface GraphRun extends GraphRunInfo {
  activeSubagents?: GraphHelper[];
  subagents?: GraphHelper[];
  reviewOf?: string | null;
}

export interface AgentNode {
  /**
   * Stable across polls, so a selection survives the next read: the run id;
   * `task:<id>` for a task no worker has taken; `task:<id>:next` for the
   * attempt a re-offered task waits for; `helper:<runId>:<type>:<startedAt>`
   * for a helper (the same key whether it is still out or back).
   */
  key: string;
  /** The run behind the node — none for a placeholder or a helper, which lives inside its run. */
  runId: string | null;
  role: AgentRole;
  taskId: string | null;
  /** A worker's attempt, or the attempt a reviewer ruled on; 0 for the rest. */
  attempt: number;
  state: AgentState;
  /** Not an agent yet: the worker a task is waiting for. */
  placeholder: boolean;
  /** The helper itself, for a helper node. */
  helper?: GraphHelper;
  /** The run whose helper this is, for a helper node. */
  parentRunId?: string;
  /** -1 for the root row (planner and leads, or the run), else the lane's index. */
  lane: number;
  /** Position in its row, left to right. */
  step: number;
}

export type EdgeKind = "plan" | "depends" | "assign" | "review" | "retry" | "lead" | "helper";

export interface AgentEdge {
  /** A node key, or a lane key (`lane:<taskId>`). */
  from: string;
  to: string;
  kind: EdgeKind;
  /** A dependency drawn as an arc beside the outline rather than as its branch. */
  extra?: boolean;
}

export interface AgentLane {
  key: string;
  /** The task, for a task lane; null for the final review and a run's helpers. */
  taskId: string | null;
  kind: "task" | "final" | "helpers";
  /** The lane this one hangs under: the task it waits for, or null for the root. */
  parent: string | null;
  depth: number;
}

export interface AgentGraph {
  shape: "team" | "run";
  /** The planner (or the run) first, then the lead's turns. */
  root: AgentNode[];
  lanes: AgentLane[];
  /** Every node, the root row's first. */
  nodes: AgentNode[];
  edges: AgentEdge[];
}

/** A run's own status, read as a node's state. */
export function stateOfRunStatus(status: CodingRunStatus): AgentState {
  switch (status) {
    case "running":
      return "working";
    case "queued":
    case "draft":
    case "paused":
      return "queued";
    case "completed":
      return "done";
    default:
      // failed, stopped, gave_up: it did not finish what it was given.
      return "failed";
  }
}

function teamIsLive(status: TeamStatusView): boolean {
  return status === "planning" || status === "working" || status === "reviewing";
}

export function laneKey(taskId: string): string {
  return `lane:${taskId}`;
}

export const FINAL_LANE = "lane::final";
const PLANNER_PENDING = "planner:pending";

/** The deepest a lane is indented; a longer chain of dependencies is still joined, just no further in. */
export const MAX_DEPTH = 4;

/**
 * The tasks as an outline: each task under the dependency it waits for LAST in
 * plan order (its parent), the rest of its dependencies drawn as arcs. Depth
 * first, in plan order, so a lane's children follow it — the parent's guide
 * line then runs past only its own descendants. A cycle or a dependency on a
 * task that is not on the board is never followed: such a task is a root.
 */
function outline(tasks: GraphTeam["tasks"]): { order: string[]; parent: Map<string, string | null>; depth: Map<string, number> } {
  const index = new Map(tasks.map((t, i) => [t.task_id, i]));
  const parent = new Map<string, string | null>();
  for (const t of tasks) {
    const known = t.depends_on.filter((d) => d !== t.task_id && index.has(d));
    parent.set(t.task_id, known.length > 0 ? known.reduce((a, b) => ((index.get(a) ?? 0) >= (index.get(b) ?? 0) ? a : b)) : null);
  }
  // Break cycles: a task whose parent chain comes back to itself is a root.
  for (const t of tasks) {
    const seen = new Set<string>([t.task_id]);
    let p = parent.get(t.task_id) ?? null;
    while (p) {
      if (seen.has(p)) { parent.set(t.task_id, null); break; }
      seen.add(p);
      p = parent.get(p) ?? null;
    }
  }
  const children = new Map<string | null, string[]>();
  for (const t of tasks) {
    const p = parent.get(t.task_id) ?? null;
    children.set(p, [...(children.get(p) ?? []), t.task_id]);
  }
  const order: string[] = [];
  const depth = new Map<string, number>();
  const visit = (id: string, d: number) => {
    if (depth.has(id)) return;
    depth.set(id, d);
    order.push(id);
    for (const c of children.get(id) ?? []) visit(c, d + 1);
  };
  for (const r of children.get(null) ?? []) visit(r, 0);
  // Anything a broken chain left unvisited is drawn as a root rather than lost.
  for (const t of tasks) if (!depth.has(t.task_id)) { parent.set(t.task_id, null); visit(t.task_id, 0); }
  return { order, parent, depth };
}

/**
 * The board as a graph. `runOf` answers a run's record when the app has it —
 * its status is the freshest word on whether it is at work — and the board's
 * own task status and verdict decide everything a run's status cannot.
 */
export function teamGraph(team: GraphTeam, runOf: (id: string) => GraphRunInfo | undefined = () => undefined): AgentGraph {
  const live = teamIsLive(team.status);
  const cast = team.runs ?? [];
  const nodes: AgentNode[] = [];
  const edges: AgentEdge[] = [];
  const statusOf = (id: string) => runOf(id)?.status;

  // ── The root row: the planner — and a lead turn that names no task on
  // the board. Every other lead turn sits in the lane of the task it came
  // after ("Team lead · after t2"), in the order it happened: a team with the
  // lead's switch on takes one after every worker, and a row of them all
  // would be wider than the window. ──
  const onBoard = new Set(team.tasks.map((x) => x.task_id));
  const planners = cast.filter((r) => r.role === "planner").map((r) => r.id);
  if (planners.length === 0 && team.plannerRunId) planners.push(team.plannerRunId);
  const plannerState = (id: string | null, last: boolean): AgentState => {
    const s = id ? statusOf(id) : undefined;
    if (s) return stateOfRunStatus(s);
    if (team.status === "queued") return "queued";
    if (team.status === "planning" && last) return "working";
    if (team.tasks.length > 0) return "done";
    return team.status === "failed" || team.status === "stopped" ? "failed" : last && live ? "working" : "done";
  };
  const root: AgentNode[] = [];
  if (planners.length === 0) {
    root.push({ key: PLANNER_PENDING, runId: null, role: "planner", taskId: null, attempt: 0, state: plannerState(null, true), placeholder: true, lane: -1, step: 0 });
  }
  planners.forEach((id, i) => {
    root.push({ key: id, runId: id, role: "planner", taskId: null, attempt: 0, state: plannerState(id, i === planners.length - 1), placeholder: false, lane: -1, step: root.length });
  });
  const leadState = (id: string): AgentState => {
    const s = statusOf(id);
    return s ? stateOfRunStatus(s) : "done";
  };
  for (const r of cast.filter((x) => x.role === "lead" && !(x.taskId && onBoard.has(x.taskId)))) {
    root.push({ key: r.id, runId: r.id, role: "lead", taskId: r.taskId, attempt: 0, state: leadState(r.id), placeholder: false, lane: -1, step: root.length });
  }
  for (let i = 1; i < root.length; i++) edges.push({ from: root[i - 1].key, to: root[i].key, kind: "lead" });
  nodes.push(...root);
  const rootKey = root[0].key;

  // ── One lane per task, in outline order. ──
  const { order, parent, depth } = outline(team.tasks);
  const byId = new Map(team.tasks.map((t) => [t.task_id, t]));
  const lanes: AgentLane[] = [];
  for (const taskId of order) {
    const task = byId.get(taskId)!;
    const lane = lanes.length;
    const p = parent.get(taskId) ?? null;
    lanes.push({ key: laneKey(taskId), taskId, kind: "task", parent: p ? laneKey(p) : null, depth: Math.min(MAX_DEPTH, depth.get(taskId) ?? 0) });
    edges.push(p ? { from: laneKey(p), to: laneKey(taskId), kind: "depends" } : { from: rootKey, to: laneKey(taskId), kind: "plan" });
    for (const d of new Set(task.depends_on)) {
      if (d !== p && d !== taskId && byId.has(d)) edges.push({ from: laneKey(d), to: laneKey(taskId), kind: "depends", extra: true });
    }

    // Its agents in the order they started: a worker opens an attempt, a
    // reviewer rules on the attempt before it, a lead turn looks at the plan
    // after it. A board from before the cast list still names the current
    // worker and reviewer on the task.
    let entries = cast.filter((r) => r.taskId === taskId && r.role !== "planner");
    if (entries.length === 0) {
      entries = [
        ...(task.assigned_to ? [{ id: task.assigned_to, role: "worker" as const, taskId }] : []),
        ...(task.reviewRunId ? [{ id: task.reviewRunId, role: "reviewer" as const, taskId }] : []),
      ];
    }
    // What this lane draws: a run is one node, wherever the board names it
    // twice — twice on this task, or already drawn in an earlier lane or the
    // root row. The attempts and the current attempt are counted from this
    // same list, or a duplicate would shift every attempt after it by one.
    const seen = new Set(nodes.map((n) => n.key));
    const drawn = entries.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    const workers = drawn.filter((r) => r.role === "worker").map((r) => r.id);
    const currentWorker = task.assigned_to && workers.includes(task.assigned_to) ? task.assigned_to : workers[workers.length - 1] ?? null;
    const currentAttempt = currentWorker ? workers.indexOf(currentWorker) + 1 : 0;
    // An earlier attempt was superseded by a rejection — unless the task was
    // ever held or re-offered for CI, when it may have been set aside instead.
    const earlierRejected = (task.holds ?? 0) + (task.ciReoffers ?? 0) + (task.budgetReoffers ?? 0) === 0;
    const reviewerLive = drawn.some((r) => r.role === "reviewer" && statusOf(r.id) === "running");
    const perTaskReview = !team.shape || team.shape.review === "each";

    const workerState = (id: string, attempt: number): AgentState => {
      const s = statusOf(id);
      const own = s ? stateOfRunStatus(s) : null;
      if (own === "working" || own === "queued") return own;
      if (attempt !== currentAttempt) return own === "failed" ? "failed" : earlierRejected ? "rejected" : (own ?? "done");
      switch (task.status) {
        case "complete":
          if (task.review) return task.review.verdict;
          return live && (reviewerLive || perTaskReview) ? "reviewing" : (own ?? "done");
        case "rejected":
          return "rejected";
        case "failed":
          return "failed";
        case "in_progress":
          return own ?? "working";
        case "retired":
          return "done";
        default:
          return own ?? "queued";
      }
    };
    const reviewerState = (id: string, attempt: number, last: boolean): AgentState => {
      const s = statusOf(id);
      const own = s ? stateOfRunStatus(s) : null;
      if (own === "working") return "reviewing";
      if (own === "queued") return "queued";
      const current = attempt === currentAttempt && (task.reviewRunId ? task.reviewRunId === id : last);
      if (current && task.review) return task.review.verdict;
      if (own === "failed") return "failed";
      if (attempt !== currentAttempt && earlierRejected) return "rejected";
      return own ?? "done";
    };

    let step = 0;
    let attempt = 0;
    let prev: AgentNode | null = null;
    const lastReviewer = [...drawn].reverse().find((r) => r.role === "reviewer")?.id ?? null;
    for (const r of drawn) {
      if (r.role === "worker") attempt++;
      const node: AgentNode = r.role === "worker"
        ? { key: r.id, runId: r.id, role: "worker", taskId, attempt, state: workerState(r.id, attempt), placeholder: false, lane, step: step++ }
        : r.role === "lead"
          ? { key: r.id, runId: r.id, role: "lead", taskId, attempt: 0, state: leadState(r.id), placeholder: false, lane, step: step++ }
          : { key: r.id, runId: r.id, role: "reviewer", taskId, attempt: Math.max(1, attempt), state: reviewerState(r.id, Math.max(1, attempt), r.id === lastReviewer), placeholder: false, lane, step: step++ };
      const kind: EdgeKind = node.role === "worker" ? "retry" : node.role === "lead" ? "lead" : "review";
      edges.push(prev ? { from: prev.key, to: node.key, kind } : { from: laneKey(taskId), to: node.key, kind: "assign" });
      nodes.push(node);
      prev = node;
    }
    // No worker yet — or a re-offered task waiting for its next one, while the
    // team can still give it one.
    const waiting = task.status === "pending" && (team.status === "queued" || live);
    const lastWorkerSettled = !prev || (prev.state !== "working" && prev.state !== "queued");
    if (!prev || (waiting && lastWorkerSettled)) {
      const key = prev ? `task:${taskId}:next` : `task:${taskId}`;
      const state: AgentState = task.status === "retired" ? "done" : task.status === "failed" ? "failed" : "queued";
      const node: AgentNode = { key, runId: null, role: "worker", taskId, attempt: attempt + 1, state, placeholder: true, lane, step: step++ };
      edges.push(prev ? { from: prev.key, to: key, kind: "retry" } : { from: laneKey(taskId), to: key, kind: "assign" });
      nodes.push(node);
    }
  }

  // ── The one review of the merged result, when the shape asked for it. ──
  const finals = cast.filter((r) => r.role === "reviewer" && r.taskId === null);
  if (finals.length > 0) {
    const lane = lanes.length;
    lanes.push({ key: FINAL_LANE, taskId: null, kind: "final", parent: null, depth: 0 });
    edges.push({ from: rootKey, to: FINAL_LANE, kind: "plan" });
    let prev: string | null = null;
    finals.forEach((r, i) => {
      if (nodes.some((n) => n.key === r.id)) return;
      const s = statusOf(r.id);
      const own = s ? stateOfRunStatus(s) : null;
      const last = i === finals.length - 1;
      const state: AgentState = own === "working" ? "reviewing" : own === "queued" ? "queued"
        : last && team.finalReview ? team.finalReview.verdict
          : own === "failed" ? "failed" : own ?? "done";
      nodes.push({ key: r.id, runId: r.id, role: "reviewer", taskId: null, attempt: i + 1, state, placeholder: false, lane, step: i });
      edges.push(prev ? { from: prev, to: r.id, kind: "retry" } : { from: FINAL_LANE, to: r.id, kind: "assign" });
      prev = r.id;
    });
  }

  return { shape: "team", root, lanes, nodes, edges };
}

/** A helper's key: the same while it is out and once it is back. */
export function helperKey(runId: string, h: GraphHelper): string {
  return `helper:${runId}:${h.type}:${h.startedAt}`;
}

/** How many helpers share a row of the run's drawing. */
export const HELPERS_PER_ROW = 4;
export const HELPERS_PER_ROW_COMPACT = 3;

/**
 * One run as a graph: the run, and every helper it sent out — the ones back
 * (refused ones as rejected) and the ones still out, oldest first, a few to a
 * row. A run that sent nobody out is one node.
 */
export function runGraph(run: GraphRun, opts: { perRow?: number } = {}): AgentGraph {
  const perRow = Math.max(1, opts.perRow ?? HELPERS_PER_ROW);
  const rootNode: AgentNode = { key: run.id, runId: run.id, role: run.reviewOf ? "reviewer" : "run", taskId: null, attempt: 0, state: stateOfRunStatus(run.status), placeholder: false, lane: -1, step: 0 };
  const nodes: AgentNode[] = [rootNode];
  const edges: AgentEdge[] = [];
  const lanes: AgentLane[] = [];
  const out = (run.activeSubagents ?? []).map((h) => ({ h, state: "working" as AgentState }));
  const back = (run.subagents ?? []).map((h) => ({ h, state: (h.refused ? "rejected" : "done") as AgentState }));
  const seen = new Set<string>();
  const helpers = [...back, ...out]
    .sort((a, b) => a.h.startedAt - b.h.startedAt)
    .filter(({ h }) => { const k = helperKey(run.id, h); if (seen.has(k)) return false; seen.add(k); return true; });
  helpers.forEach(({ h, state }, i) => {
    const lane = Math.floor(i / perRow);
    if (!lanes[lane]) lanes.push({ key: `lane::helpers:${lane}`, taskId: null, kind: "helpers", parent: null, depth: 0 });
    const key = helperKey(run.id, h);
    nodes.push({ key, runId: null, role: "helper", taskId: null, attempt: 0, state, placeholder: false, helper: h, parentRunId: run.id, lane, step: i % perRow });
    edges.push({ from: run.id, to: key, kind: "helper" });
  });
  return { shape: "run", root: [rootNode], lanes, nodes, edges };
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export interface Geometry {
  /**
   * A node's circle. Its label sits 6 px under it and is 12 px tall, the
   * model's short name (`modelLine`) under that, and the rings drawn around a
   * node (the pulse, "this run") reach 5 px out, so a row must be at least
   * 2 × radius + 18 + modelLine + 5 + a little apart.
   */
  radius: number;
  /**
   * The line under a node's label naming the model it runs on ("Opus 5.5" —
   * the owner, 2026-11-01). Kept for every node, named or not, so a model
   * that becomes known mid-run moves nothing.
   */
  modelLine: number;
  /** The label under a node, centred on it. */
  labelWidth: number;
  /** Between two nodes of a row. */
  step: number;
  /** Between two rows. */
  row: number;
  /** How far a dependent lane sits in from the lane it waits for. */
  indent: number;
  chipWidth: number;
  chipHeight: number;
  pad: number;
}

export const GEOMETRY: Geometry = { radius: 18, modelLine: 14, labelWidth: 80, step: 92, row: 74, indent: 26, chipWidth: 46, chipHeight: 20, pad: 12 };
/** Narrow windows: the same outline, closer together. */
export const GEOMETRY_COMPACT: Geometry = { radius: 16, modelLine: 14, labelWidth: 62, step: 70, row: 70, indent: 20, chipWidth: 40, chipHeight: 20, pad: 8 };

export interface PlacedNode {
  x: number;
  y: number;
  /** 0 for the root row, 1 + lane for a lane. */
  row: number;
}

export interface PlacedLane {
  x: number;
  y: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  extra: boolean;
  d: string;
  /** Into a node at work: drawn in coral, flowing. */
  active: boolean;
}

export interface GraphLayout {
  width: number;
  height: number;
  geometry: Geometry;
  nodes: Record<string, PlacedNode>;
  /** A task lane's chip: its left edge and centre line. */
  lanes: Record<string, PlacedLane>;
  /** The guide lines a parent hangs its lanes from — drawn, never selected. */
  trunks: string[];
  edges: PlacedEdge[];
}

/**
 * Where everything goes. The root row on top, the planner's circle at its
 * left; each lane a row under it, its chip indented by depth on the parent's
 * guide line, its agents in columns shared by every lane so attempt 1, its
 * review and attempt 2 line up down the page. Rows never share a y, and two
 * nodes of a row are a full `step` apart, so nothing can overlap however
 * many tasks and attempts there are — the drawing grows instead.
 */
export function layoutGraph(graph: AgentGraph, geometry: Geometry = GEOMETRY): GraphLayout {
  const g = geometry;
  const R = g.radius;
  const team = graph.shape === "team";
  const extraArcs = graph.edges.filter((e) => e.extra);
  // Arcs nest by span so two never run on one line.
  const laneIndex = new Map(graph.lanes.map((l, i) => [l.key, i]));
  const arcLevel = new Map<AgentEdge, number>();
  const levels: [number, number][][] = [];
  for (const e of [...extraArcs].sort((a, b) => span(a) - span(b))) {
    const [lo, hi] = ends(e);
    let lvl = levels.findIndex((taken) => taken.every(([a, b]) => hi < a || lo > b));
    if (lvl === -1) { levels.push([]); lvl = levels.length - 1; }
    levels[lvl].push([lo, hi]);
    arcLevel.set(e, lvl);
  }
  function ends(e: AgentEdge): [number, number] {
    const a = laneIndex.get(e.from) ?? 0;
    const b = laneIndex.get(e.to) ?? 0;
    return [Math.min(a, b), Math.max(a, b)];
  }
  function span(e: AgentEdge): number {
    const [a, b] = ends(e);
    return b - a;
  }
  // The arcs bulge left of the chips into the room the root's label already
  // keeps there (half a label), so they need no gutter of their own.
  const px = g.pad + g.labelWidth / 2;
  const rootY = g.pad + R;
  const rowY = (row: number) => rootY + row * g.row;
  const maxDepth = Math.max(0, ...graph.lanes.map((l) => l.depth));
  const chipLeft = (depth: number) => px + 12 + depth * g.indent;
  // The columns every lane shares. A run's helpers have no chip: they start
  // one indent in from the run's own guide line.
  const x0 = team
    ? Math.max(chipLeft(maxDepth) + g.chipWidth + 22 + R, px + g.labelWidth / 2 + 14 + g.labelWidth / 2)
    : px + g.indent + g.labelWidth / 2;
  const colX = (step: number) => x0 + step * g.step;

  const nodes: Record<string, PlacedNode> = {};
  const lanes: Record<string, PlacedLane> = {};
  let maxStep = 0;
  for (const n of graph.nodes) {
    const row = n.lane + 1;
    const x = n.lane === -1 && n.step === 0 ? px : colX(n.lane === -1 ? n.step - 1 : n.step);
    nodes[n.key] = { x, y: rowY(row), row };
    maxStep = Math.max(maxStep, n.lane === -1 ? n.step - 1 : n.step);
  }
  graph.lanes.forEach((l, i) => {
    lanes[l.key] = { x: team ? chipLeft(l.depth) : x0, y: rowY(i + 1) };
  });

  const trunks: string[] = [];
  const edges: PlacedEdge[] = [];
  const stateOf = new Map(graph.nodes.map((n) => [n.key, n.state]));
  const active = (to: string) => {
    const s = stateOf.get(to);
    return s !== undefined && isActiveState(s);
  };
  const rootNode = graph.root[0];
  const rootPos = nodes[rootNode.key];

  // The guide lines: from the root down past its lanes, and from each lane's
  // chip down past the lanes that hang under it.
  const hangers = new Map<string, number[]>();
  graph.lanes.forEach((l, i) => {
    const p = l.parent ?? rootNode.key;
    hangers.set(p, [...(hangers.get(p) ?? []), i]);
  });
  const guideX = (parent: string) => (parent === rootNode.key ? px : lanes[parent].x + 10);
  // The root's line starts under its label, never through it.
  const guideTop = (parent: string) => (parent === rootNode.key ? rootPos.y + R + 18 : lanes[parent].y + g.chipHeight / 2);
  for (const [parent, rows] of hangers) {
    if (!team && parent !== rootNode.key) continue;
    const last = rowY(Math.max(...rows) + 1);
    trunks.push(`M${guideX(parent)} ${guideTop(parent)} V${last}`);
  }

  for (const e of graph.edges) {
    let d = "";
    if (e.kind === "plan" || (e.kind === "depends" && !e.extra)) {
      const to = lanes[e.to];
      const parent = e.kind === "plan" ? rootNode.key : e.from;
      d = `M${guideX(parent)} ${to.y} H${to.x}`;
    } else if (e.kind === "depends") {
      const a = lanes[e.from];
      const b = lanes[e.to];
      const bulge = 12 + 7 * Math.min(arcLevel.get(e) ?? 0, 3);
      const left = Math.min(a.x, b.x) - bulge;
      d = `M${a.x} ${a.y} C${left} ${a.y} ${left} ${b.y} ${b.x} ${b.y}`;
    } else if (e.kind === "assign") {
      const a = lanes[e.from];
      const b = nodes[e.to];
      d = `M${a.x + (team ? g.chipWidth : 0)} ${a.y} H${b.x - R}`;
    } else if (e.kind === "helper") {
      const b = nodes[e.to];
      const a = nodes[e.from];
      // Off the run's guide line, then along the helpers' row.
      d = graph.nodes.find((n) => n.key === e.to)?.step === 0
        ? `M${a.x} ${b.y} H${b.x - R}`
        : `M${b.x - g.step + R} ${b.y} H${b.x - R}`;
    } else {
      const a = nodes[e.from];
      const b = nodes[e.to];
      d = `M${a.x + R} ${a.y} H${b.x - R}`;
    }
    edges.push({ from: e.from, to: e.to, kind: e.kind, extra: e.extra === true, d, active: active(e.to) });
  }

  const rows = graph.lanes.length + 1;
  const width = Math.ceil(Math.max(px + g.labelWidth / 2, colX(Math.max(0, maxStep)) + g.labelWidth / 2) + g.pad);
  // The last row's label is the bottom: no pad under it, the card has its own.
  const height = Math.ceil(rowY(rows - 1) + R + 18 + g.modelLine + 4);
  return { width, height, geometry: g, nodes, lanes, trunks, edges };
}

// ─── Moving between nodes ─────────────────────────────────────────────────────

export type Direction = "left" | "right" | "up" | "down" | "first" | "last";

/** The keys an arrow press understands, as the direction it moves. */
export function directionOfKey(key: string): Direction | null {
  switch (key) {
    case "ArrowLeft": return "left";
    case "ArrowRight": return "right";
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "Home": return "first";
    case "End": return "last";
    default: return null;
  }
}

/**
 * The node an arrow key moves to from `from`: left and right along its row,
 * up and down to the nearest node of the next row that has one, Home and End
 * to the first and the last node in reading order. Null at an edge — focus
 * stays where it is, the way a toolbar's does.
 */
export function neighbourOf(layout: GraphLayout, from: string, dir: Direction): string | null {
  const all = Object.entries(layout.nodes).sort(([, a], [, b]) => a.row - b.row || a.x - b.x);
  if (all.length === 0) return null;
  if (dir === "first") return all[0][0];
  if (dir === "last") return all[all.length - 1][0];
  const here = layout.nodes[from];
  if (!here) return all[0][0];
  if (dir === "left" || dir === "right") {
    const row = all.filter(([, p]) => p.row === here.row);
    const i = row.findIndex(([k]) => k === from);
    const j = dir === "left" ? i - 1 : i + 1;
    return row[j]?.[0] ?? null;
  }
  const rows = [...new Set(all.map(([, p]) => p.row))];
  const at = rows.indexOf(here.row);
  const target = rows[dir === "up" ? at - 1 : at + 1];
  if (target === undefined) return null;
  const candidates = all.filter(([, p]) => p.row === target);
  candidates.sort(([, a], [, b]) => Math.abs(a.x - here.x) - Math.abs(b.x - here.x) || a.x - b.x);
  return candidates[0]?.[0] ?? null;
}

// ─── Figures ──────────────────────────────────────────────────────────────────

/** Tasks done out of the tasks that count — a retired task never will be. */
export function taskProgress(team: Pick<GraphTeam, "tasks">): { accepted: number; done: number; total: number } {
  const counted = team.tasks.filter((t) => t.status !== "retired");
  return {
    accepted: counted.filter((t) => t.status === "complete" && t.review?.verdict === "accepted").length,
    done: counted.filter((t) => t.status === "complete").length,
    total: counted.length,
  };
}

export interface RoleTokens {
  planner: number;
  workers: number;
  reviewers: number;
}

/**
 * Tokens per role: what the board recorded for a run once it settled, or what
 * the run's own record says while it is still at work. A lead's turns are the
 * planner's, back.
 */
export function tokensByRole(team: Pick<GraphTeam, "runs">, runOf: (id: string) => GraphRunInfo | undefined = () => undefined): RoleTokens {
  const out: RoleTokens = { planner: 0, workers: 0, reviewers: 0 };
  for (const r of team.runs ?? []) {
    const n = Math.max(0, r.tokens ?? runOf(r.id)?.tokensUsed ?? 0);
    if (r.role === "worker") out.workers += n;
    else if (r.role === "reviewer") out.reviewers += n;
    else out.planner += n;
  }
  return out;
}
