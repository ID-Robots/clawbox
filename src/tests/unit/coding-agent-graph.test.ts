/**
 * The agent chart's model (src/lib/coding-agent-graph.ts): who is drawn, in
 * which state, where, and where an arrow key goes — from board fixtures the
 * shape GET coding-agent/team answers.
 */
import { describe, expect, it } from "vitest";
import {
  GEOMETRY,
  GEOMETRY_COMPACT,
  HELPERS_PER_ROW,
  directionOfKey,
  isActiveState,
  layoutGraph,
  neighbourOf,
  runGraph,
  stateOfRunStatus,
  taskProgress,
  teamGraph,
  tokensByRole,
  type AgentGraph,
  type GraphLayout,
  type GraphRunInfo,
  type GraphTeam,
} from "@/lib/coding-agent-graph";
import type { CodingRunStatus } from "@/lib/coding-agent-status";

type Task = GraphTeam["tasks"][number];
const task = (task_id: string, status: Task["status"], over: Partial<Task> = {}): Task => ({
  task_id, status, assigned_to: null, depends_on: [], review: null, reviewRunId: null, attempts: 0, ...over,
});

/**
 * Eight tasks — the planner's ceiling — with retries, a dependency chain, a
 * task waiting on two, one failed, one retired, one queued for a slot.
 */
const EIGHT: GraphTeam = {
  id: "team-eight001",
  status: "working",
  plannerRunId: "run-p0000001",
  runs: [
    { id: "run-p0000001", role: "planner", taskId: null, tokens: 12_000 },
    { id: "run-w1000001", role: "worker", taskId: "t1", tokens: 40_000 },
    { id: "run-r1000001", role: "reviewer", taskId: "t1", tokens: 5_000 },
    { id: "run-w2a00001", role: "worker", taskId: "t2", tokens: 30_000 },
    { id: "run-r2a00001", role: "reviewer", taskId: "t2", tokens: 4_000 },
    { id: "run-l1000001", role: "lead", taskId: "t1", tokens: 3_000 },
    { id: "run-w2b00001", role: "worker", taskId: "t2" },
    { id: "run-w3000001", role: "worker", taskId: "t3", tokens: 20_000 },
    { id: "run-r3000001", role: "reviewer", taskId: "t3" },
    { id: "run-w5000001", role: "worker", taskId: "t5", tokens: 1_000 },
    { id: "run-w7000001", role: "worker", taskId: "t7" },
  ],
  tasks: [
    task("t1", "complete", { assigned_to: "run-w1000001", review: { verdict: "accepted" }, reviewRunId: "run-r1000001", attempts: 1 }),
    task("t2", "in_progress", { assigned_to: "run-w2b00001", depends_on: ["t1"], attempts: 2 }),
    task("t3", "complete", { assigned_to: "run-w3000001", depends_on: ["t1"], attempts: 1 }),
    task("t4", "pending", { depends_on: ["t2", "t3"] }),
    task("t5", "failed", { assigned_to: "run-w5000001", attempts: 2 }),
    task("t6", "pending", { depends_on: ["t5"] }),
    task("t7", "in_progress", { assigned_to: "run-w7000001", attempts: 1 }),
    task("t8", "retired", { depends_on: ["t7"] }),
  ],
  shape: { review: "each" },
  finalReview: null,
};

const STATUS: Record<string, CodingRunStatus> = {
  "run-p0000001": "completed",
  "run-w1000001": "completed",
  "run-r1000001": "completed",
  "run-w2a00001": "completed",
  "run-r2a00001": "completed",
  "run-l1000001": "completed",
  "run-w2b00001": "running",
  "run-w3000001": "completed",
  "run-r3000001": "running",
  "run-w5000001": "failed",
  "run-w7000001": "queued",
};
const runOf = (id: string): GraphRunInfo | undefined => (STATUS[id] ? { id, status: STATUS[id], tokensUsed: id === "run-w2b00001" ? 9_000 : undefined } : undefined);

const stateOf = (g: AgentGraph, key: string) => g.nodes.find((n) => n.key === key)?.state;

describe("stateOfRunStatus", () => {
  it("reads a run's own status as a node's state", () => {
    expect(stateOfRunStatus("running")).toBe("working");
    for (const s of ["queued", "draft", "paused"] as const) expect(stateOfRunStatus(s)).toBe("queued");
    expect(stateOfRunStatus("completed")).toBe("done");
    for (const s of ["failed", "stopped", "gave_up"] as const) expect(stateOfRunStatus(s)).toBe("failed");
  });

  it("calls only working and reviewing active", () => {
    expect(["working", "reviewing"].every((s) => isActiveState(s as never))).toBe(true);
    expect(["queued", "accepted", "rejected", "failed", "done"].some((s) => isActiveState(s as never))).toBe(false);
  });
});

describe("teamGraph — one node per real agent", () => {
  const g = teamGraph(EIGHT, runOf);

  it("puts the planner on the root row, a lane per task in outline order, a lead turn in the lane it came after", () => {
    expect(g.root.map((n) => [n.key, n.role])).toEqual([["run-p0000001", "planner"]]);
    expect(g.nodes.filter((n) => n.taskId === "t1").map((n) => [n.key, n.role, n.step])).toEqual([
      ["run-w1000001", "worker", 0], ["run-r1000001", "reviewer", 1], ["run-l1000001", "lead", 2],
    ]);
    expect(g.edges).toContainEqual({ from: "run-r1000001", to: "run-l1000001", kind: "lead" });
    // Depth first in plan order: a dependent hangs under the task it waits for last.
    expect(g.lanes.map((l) => [l.taskId, l.depth, l.parent])).toEqual([
      ["t1", 0, null], ["t2", 1, "lane:t1"], ["t3", 1, "lane:t1"], ["t4", 2, "lane:t3"],
      ["t5", 0, null], ["t6", 1, "lane:t5"], ["t7", 0, null], ["t8", 1, "lane:t7"],
    ]);
    // Every agent on the cast list is a node, once; tasks no worker has taken are placeholders.
    const real = g.nodes.filter((n) => !n.placeholder).map((n) => n.key).sort();
    expect(real).toEqual(EIGHT.runs!.map((r) => r.id).sort());
    expect(g.nodes.filter((n) => n.placeholder).map((n) => n.key)).toEqual(["task:t4", "task:t6", "task:t8"]);
  });

  it("numbers a task's attempts and chains each worker to its reviewer and the retry after it", () => {
    const t2 = g.nodes.filter((n) => n.taskId === "t2").map((n) => [n.key, n.role, n.attempt, n.step]);
    expect(t2).toEqual([
      ["run-w2a00001", "worker", 1, 0],
      ["run-r2a00001", "reviewer", 1, 1],
      ["run-w2b00001", "worker", 2, 2],
    ]);
    const kinds = (from: string) => g.edges.filter((e) => e.from === from).map((e) => [e.to, e.kind]);
    expect(kinds("lane:t2")).toEqual([["run-w2a00001", "assign"], ["lane:t4", "depends"]]);
    expect(kinds("run-w2a00001")).toEqual([["run-r2a00001", "review"]]);
    expect(kinds("run-r2a00001")).toEqual([["run-w2b00001", "retry"]]);
    expect(kinds("run-p0000001")).toEqual([["lane:t1", "plan"], ["lane:t5", "plan"], ["lane:t7", "plan"]]);
  });

  it("draws every dependency: the outline branch for the last one, an arc for the rest", () => {
    const deps = g.edges.filter((e) => e.kind === "depends").map((e) => [e.from, e.to, e.extra === true]);
    expect(deps).toEqual([
      ["lane:t1", "lane:t2", false],
      ["lane:t1", "lane:t3", false],
      ["lane:t3", "lane:t4", false],
      ["lane:t2", "lane:t4", true],
      ["lane:t5", "lane:t6", false],
      ["lane:t7", "lane:t8", false],
    ]);
  });

  it("maps each agent to its state from its run and the board", () => {
    expect(stateOf(g, "run-p0000001")).toBe("done");
    expect(stateOf(g, "run-l1000001")).toBe("done");
    expect(stateOf(g, "run-w1000001")).toBe("accepted");
    expect(stateOf(g, "run-r1000001")).toBe("accepted");
    // The first attempt was superseded by a rejection; its reviewer said so.
    expect(stateOf(g, "run-w2a00001")).toBe("rejected");
    expect(stateOf(g, "run-r2a00001")).toBe("rejected");
    expect(stateOf(g, "run-w2b00001")).toBe("working");
    // Complete, its reviewer at work: both are reviewing.
    expect(stateOf(g, "run-w3000001")).toBe("reviewing");
    expect(stateOf(g, "run-r3000001")).toBe("reviewing");
    expect(stateOf(g, "task:t4")).toBe("queued");
    expect(stateOf(g, "run-w5000001")).toBe("failed");
    expect(stateOf(g, "task:t6")).toBe("queued");
    expect(stateOf(g, "run-w7000001")).toBe("queued");
    expect(stateOf(g, "task:t8")).toBe("done");
  });

  it("reads the board alone when it has no run records", () => {
    const bare = teamGraph(EIGHT);
    expect(stateOf(bare, "run-w2b00001")).toBe("working");
    expect(stateOf(bare, "run-w3000001")).toBe("reviewing");
    expect(stateOf(bare, "run-r1000001")).toBe("accepted");
  });

  it("does not call an earlier attempt rejected when the task was ever held or re-offered for CI", () => {
    const held = teamGraph({ ...EIGHT, tasks: EIGHT.tasks.map((x) => (x.task_id === "t2" ? { ...x, holds: 1 } : x)) }, runOf);
    expect(stateOf(held, "run-w2a00001")).toBe("done");
    expect(stateOf(held, "run-r2a00001")).toBe("done");
  });

  it("shows the next attempt a re-offered task waits for, and the final review in a lane of its own", () => {
    const team: GraphTeam = {
      ...EIGHT,
      runs: [...EIGHT.runs!, { id: "run-fin00001", role: "reviewer", taskId: null }],
      tasks: EIGHT.tasks.map((x) => (x.task_id === "t5" ? { ...x, status: "pending" as const } : x)),
      finalReview: { verdict: "rejected" },
    };
    const g2 = teamGraph(team, runOf);
    const next = g2.nodes.find((n) => n.key === "task:t5:next");
    expect(next).toMatchObject({ placeholder: true, attempt: 2, state: "queued" });
    expect(g2.edges).toContainEqual({ from: "run-w5000001", to: "task:t5:next", kind: "retry" });
    const finalLane = g2.lanes[g2.lanes.length - 1];
    expect(finalLane.kind).toBe("final");
    expect(stateOf(g2, "run-fin00001")).toBe("rejected");
  });

  it("falls back to the task's own worker and reviewer for a board from before the cast list", () => {
    const old = teamGraph({ ...EIGHT, runs: undefined }, runOf);
    expect(old.root.map((n) => n.key)).toEqual(["run-p0000001"]);
    expect(old.nodes.filter((n) => n.taskId === "t1").map((n) => n.key)).toEqual(["run-w1000001", "run-r1000001"]);
  });

  it("keeps a lead turn that names no task on the board on the root row, beside the planner", () => {
    const g2 = teamGraph({ ...EIGHT, runs: [...EIGHT.runs!, { id: "run-l9000001", role: "lead", taskId: null }] }, runOf);
    expect(g2.root.map((n) => n.key)).toEqual(["run-p0000001", "run-l9000001"]);
    expect(g2.edges).toContainEqual({ from: "run-p0000001", to: "run-l9000001", kind: "lead" });
  });

  it("draws a queued team's planner as a placeholder and survives a dependency cycle", () => {
    const q = teamGraph({ ...EIGHT, status: "queued", plannerRunId: null, runs: [], tasks: [task("a", "pending", { depends_on: ["b"] }), task("b", "pending", { depends_on: ["a"] })] });
    expect(q.root[0]).toMatchObject({ role: "planner", placeholder: true, state: "queued" });
    expect(q.lanes.map((l) => l.taskId).sort()).toEqual(["a", "b"]);
  });

  it("says the planner is working while the team plans", () => {
    const planning = teamGraph({ ...EIGHT, status: "planning", runs: [], tasks: [] });
    expect(planning.nodes).toHaveLength(1);
    expect(planning.root[0]).toMatchObject({ key: "run-p0000001", state: "working" });
  });
});

describe("runGraph — a run and its helpers", () => {
  const run = {
    id: "run-solo0001",
    status: "running" as const,
    activeSubagents: [{ type: "Explore", description: "Map src", startedAt: 30 }],
    subagents: [
      { type: "general-purpose", description: "Write tests", startedAt: 10, endedAt: 20, refused: false },
      { type: "Plan", description: "Refused workflow", startedAt: 20, endedAt: 21, refused: true },
    ],
  };

  it("draws the run, then every helper oldest first, a few to a row", () => {
    const g = runGraph(run);
    expect(g.shape).toBe("run");
    expect(g.nodes.map((n) => [n.role, n.state, n.helper?.type ?? null])).toEqual([
      ["run", "working", null],
      ["helper", "done", "general-purpose"],
      ["helper", "rejected", "Plan"],
      ["helper", "working", "Explore"],
    ]);
    // The same key whether the helper is out or back, so a selection survives.
    expect(g.nodes[3].key).toBe("helper:run-solo0001:Explore:30");
    const many = runGraph({ ...run, subagents: Array.from({ length: 9 }, (_, i) => ({ type: "x", description: "", startedAt: i, endedAt: i + 1, refused: false })) });
    expect(many.lanes).toHaveLength(Math.ceil(10 / HELPERS_PER_ROW));
    expect(runGraph(run, { perRow: 1 }).lanes).toHaveLength(3);
  });

  it("is one node for a run that sent nobody out, and a review pass wears the reviewer's glyph", () => {
    expect(runGraph({ id: "run-alone001", status: "completed" }).nodes).toHaveLength(1);
    expect(runGraph({ id: "run-rev00001", status: "completed", reviewOf: "run-solo0001" }).root[0].role).toBe("reviewer");
  });
});

/** Every node's footprint — its circle with the rings drawn around it (5 px), and the label under it (6 px gap, 12 px tall). */
function boxes(layout: GraphLayout) {
  const g = layout.geometry;
  return Object.entries(layout.nodes).map(([key, p]) => ({ key, x0: p.x - g.labelWidth / 2, x1: p.x + g.labelWidth / 2, y0: p.y - g.radius - 5, y1: p.y + g.radius + 18 }));
}

describe("layoutGraph — nothing overlaps, however many tasks and attempts", () => {
  for (const [name, geometry] of [["wide", GEOMETRY], ["compact", GEOMETRY_COMPACT]] as const) {
    it(`places eight tasks with their attempts without overlap (${name})`, () => {
      const layout = layoutGraph(teamGraph(EIGHT, runOf), geometry);
      const b = boxes(layout);
      for (let i = 0; i < b.length; i++) {
        for (let j = i + 1; j < b.length; j++) {
          const overlap = b[i].x0 < b[j].x1 && b[j].x0 < b[i].x1 && b[i].y0 < b[j].y1 && b[j].y0 < b[i].y1;
          expect(overlap, `${b[i].key} overlaps ${b[j].key}`).toBe(false);
        }
        expect(b[i].x0).toBeGreaterThanOrEqual(0);
        expect(b[i].x1).toBeLessThanOrEqual(layout.width);
        expect(b[i].y1).toBeLessThanOrEqual(layout.height);
      }
      // A lane's chip sits left of every agent node.
      const firstColumn = Math.min(...Object.values(layout.nodes).filter((p) => p.row > 0).map((p) => p.x));
      for (const chip of Object.values(layout.lanes)) expect(chip.x + geometry.chipWidth).toBeLessThan(firstColumn - geometry.radius);
      // Nine rows (root + eight lanes), one per y.
      expect(new Set(Object.values(layout.nodes).map((p) => p.y)).size).toBe(9);
    });
  }

  it("is narrower and shorter compact, so a phone holds it", () => {
    const wide = layoutGraph(teamGraph(EIGHT, runOf), GEOMETRY);
    const compact = layoutGraph(teamGraph(EIGHT, runOf), GEOMETRY_COMPACT);
    expect(compact.width).toBeLessThan(wide.width);
    expect(compact.height).toBeLessThan(wide.height);
    expect(compact.width).toBeLessThanOrEqual(360);
  });

  it("draws an edge for every graph edge, flowing into the agents at work", () => {
    const g = teamGraph(EIGHT, runOf);
    const layout = layoutGraph(g);
    expect(layout.edges).toHaveLength(g.edges.length);
    for (const e of layout.edges) expect(e.d).toMatch(/^M[\d.]+ [\d.]+ /);
    const active = layout.edges.filter((e) => e.active).map((e) => e.to).sort();
    expect(active).toEqual(["run-r3000001", "run-w2b00001", "run-w3000001"]);
    // The extra dependency is an arc, not a straight branch.
    expect(layout.edges.find((e) => e.extra)?.d).toContain(" C");
  });
});

describe("neighbourOf — the arrow keys", () => {
  const layout = layoutGraph(teamGraph(EIGHT, runOf));

  it("moves along a row with left and right, stopping at its ends", () => {
    expect(neighbourOf(layout, "run-w2a00001", "right")).toBe("run-r2a00001");
    expect(neighbourOf(layout, "run-r2a00001", "right")).toBe("run-w2b00001");
    expect(neighbourOf(layout, "run-w2b00001", "right")).toBeNull();
    expect(neighbourOf(layout, "run-w2a00001", "left")).toBeNull();
  });

  it("moves to the nearest node of the next row with up and down", () => {
    expect(neighbourOf(layout, "run-p0000001", "down")).toBe("run-w1000001");
    expect(neighbourOf(layout, "run-w1000001", "down")).toBe("run-w2a00001");
    expect(neighbourOf(layout, "run-w2b00001", "down")).toBe("run-r3000001");
    expect(neighbourOf(layout, "run-p0000001", "up")).toBeNull();
  });

  it("goes to the first and the last with Home and End", () => {
    expect(neighbourOf(layout, "run-w5000001", "first")).toBe("run-p0000001");
    expect(neighbourOf(layout, "run-w5000001", "last")).toBe("task:t8");
  });

  it("names the keys it understands", () => {
    expect(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].map(directionOfKey)).toEqual(["left", "right", "up", "down", "first", "last"]);
    expect(directionOfKey("Enter")).toBeNull();
  });
});

describe("the chart's figures", () => {
  it("counts tasks done out of the tasks that count", () => {
    expect(taskProgress(EIGHT)).toEqual({ accepted: 1, done: 2, total: 7 });
  });

  it("adds tokens up per role, a live run's from its own record", () => {
    // planner + lead 15k; workers 40 + 30 + 9 (live) + 20 + 1; reviewers 5 + 4.
    expect(tokensByRole(EIGHT, runOf)).toEqual({ planner: 15_000, workers: 100_000, reviewers: 9_000 });
  });
});
