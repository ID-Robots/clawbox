/**
 * The team orchestrator (src/lib/coding-team.ts) against a mocked runner:
 * planner first (read-only, its brief attached), the plan posted as the
 * planner, one worker per task in dependency order and one at a time, each
 * worker's outcome relayed on the bus in ITS name, the reviewer's rule, the
 * guardrail alerts, the stop, and a team the web server restarted under.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The paused-worker case waits out the orchestrator's real held-run poll
// (HELD_POLL_MS), which is seconds rather than milliseconds; vitest's 5 s
// default leaves nothing for a loaded runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, get DATA_DIR() { return path.join(root, "data"); } };
});

const runner = vi.hoisted(() => ({
  startRun: vi.fn(),
  waitForRun: vi.fn(),
  getRun: vi.fn(),
  stopRun: vi.fn(),
  resolveWorkingDirectory: vi.fn(),
  isCodingAgentEnabled: vi.fn(),
  getTeamDynamic: vi.fn(),
  teamSpawnSlot: vi.fn(),
}));
/** How many runs a team may have going at once: the box's own number unless a case says otherwise (read on every use, reset before each case). */
const teamSlots = vi.hoisted(() => ({ value: null as number | null }));
vi.mock("@/lib/coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-agent")>();
  return { ...actual, ...runner, get MAX_TEAM_WORKERS() { return teamSlots.value ?? actual.MAX_TEAM_WORKERS; } };
});
// A roomy box: the spawn slot reads it once a worker is starting, and the
// host's own meminfo is neither the fixture nor the same on every runner.
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
// The git plumbing, faked: a branch is "made", a worktree "added", a merge
// "done" — scripted per call so a conflict can be staged.
const plumbing = vi.hoisted(() => ({
  ensureTeamBranch: vi.fn(),
  addWorkerWorktree: vi.fn(),
  mergeWorkerBranch: vi.fn(),
  removeWorktree: vi.fn(),
  changedFiles: vi.fn(),
}));
vi.mock("@/lib/coding-team-worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-team-worktree")>();
  return { ...actual, ...plumbing };
});

type Team = typeof import("@/lib/coding-team");
let team: Team;

/** The runs the fake runner "spawns", settled by the test. */
let runs: Map<string, Record<string, unknown>>;
let starts: Array<Record<string, unknown>>;
let seq: number;
/** Worker/planner runs take the scripted `outcomes` in order; reviewer runs take `reviews`, accepting by default. */
let workerSeq: number;
let reviews: Array<{ summary?: string; status?: string; error?: string; tokensUsed?: number }>;
/** Lead runs take these in order; a lead with nothing scripted answers `{}` (the plan stands). */
let leadAnswers: Array<{ summary?: string; status?: string; error?: string; tokensUsed?: number }>;
let merges: Array<{ ok: boolean; conflict?: boolean }>;
let waitsBeforeSettle: number;
/** How many of the team's worker runs were still going when each run started — the parallelism, observed. */
let liveWorkersAtStart: Record<string, number>;

function fakeRun(input: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  const id = `run-${String(seq).padStart(8, "0")}`;
  const team = (input.team ?? null) as { role?: string } | null;
  const reviewer = team?.role === "reviewer";
  const lead = team?.role === "lead";
  liveWorkersAtStart[id] = [...runs.values()].filter((r) => r.status === "running" && (r.team as { role?: string } | null)?.role === "worker").length;
  const run = {
    id, task: input.task, directory: String(input.directory ?? "/home/clawbox/Projects/site"), projectId: null, source: input.source,
    status: "running", startedAt: Date.now(), completedAt: null, summary: null, error: null,
    filesTouched: [] as string[], permissionDenials: 0, deniedActions: [] as string[],
    team: input.team ?? null, readOnly: input.readOnly === true, extraBrief: input.extraBrief ?? null,
    outcomeAt: reviewer ? -1 : lead ? -2 : workerSeq++, waits: 0,
  };
  runs.set(id, run);
  starts.push(input);
  return run;
}

/**
 * How each run ends, keyed by the order it was started. `resumesAs` scripts
 * the owner coming back to a PAUSED run: the next look at it settles it that
 * way. Deliberately not called `then` — an object with a `then` field is a
 * thenable, and the fake runner returns these records from an async function.
 */
let outcomes: Array<Partial<{ status: string; summary: string; resultText: string; error: string; filesTouched: string[]; permissionDenials: number; deniedActions: string[]; commitError: string | null; tokensUsed: number; resumesAs: Record<string, unknown> }>>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-team-"));
  runs = new Map();
  starts = [];
  seq = 0;
  workerSeq = 0;
  outcomes = [];
  reviews = [];
  leadAnswers = [];
  merges = [];
  waitsBeforeSettle = 1;
  liveWorkersAtStart = {};
  teamSlots.value = null;
  vi.resetModules();
  vi.clearAllMocks();
  plumbing.ensureTeamBranch.mockImplementation(async (_dir: string, teamId: string) => ({ ok: true, branch: `clawbox/${teamId}`, base: "master" }));
  plumbing.addWorkerWorktree.mockImplementation(async (dir: string, teamId: string, taskId: string, attempt: number) => ({ ok: true, path: `${dir}/.clawbox/worktrees/${taskId}-${attempt}`, branch: `clawbox/${teamId}-${taskId}-${attempt}` }));
  plumbing.mergeWorkerBranch.mockImplementation(async () => {
    const next = merges.shift();
    if (!next || next.ok) return { ok: true, merged: true };
    return { ok: false, conflict: next.conflict === true, detail: next.conflict ? "CONFLICT (content): Merge conflict in index.html" : "Merging failed." };
  });
  plumbing.removeWorktree.mockResolvedValue(undefined);
  plumbing.changedFiles.mockResolvedValue([]);
  runner.isCodingAgentEnabled.mockResolvedValue(true);
  // The lead's switch: OFF, as on every box that never touched it.
  runner.getTeamDynamic.mockResolvedValue(false);
  runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/Projects/site", projectId: null });
  runner.startRun.mockImplementation(async (input: Record<string, unknown>) => fakeRun(input));
  // A wait settles the run with the next scripted outcome.
  runner.waitForRun.mockImplementation(async (id: string) => {
    const run = runs.get(id);
    if (!run) return null;
    if (run.status === "running") {
      run.waits = Number(run.waits) + 1;
      if (Number(run.waits) < waitsBeforeSettle) return run;
      const at = Number(run.outcomeAt);
      const outcome = at === -1
        ? (reviews.shift() ?? { summary: JSON.stringify({ verdict: "accepted", notes: "" }) })
        : at === -2
          ? (leadAnswers.shift() ?? { summary: "{}" })
          : (outcomes[at] ?? { status: "completed", summary: "done" });
      Object.assign(run, { status: outcome.status ?? "completed", completedAt: Date.now() }, outcome);
    } else if (run.status === "paused" && run.resumesAs) {
      // The owner came back. Only reached if the orchestrator LOOKED again —
      // a settle that took the pause as an outcome never would — so this is
      // what makes the paused case observable.
      const next = run.resumesAs as Record<string, unknown>;
      run.resumesAs = undefined;
      Object.assign(run, { status: "completed", completedAt: Date.now() }, next);
    }
    return run;
  });
  runner.getRun.mockImplementation((id: string) => runs.get(id) ?? null);
  runner.stopRun.mockImplementation((id: string) => {
    const run = runs.get(id);
    if (run) Object.assign(run, { status: "stopped", completedAt: Date.now() });
    return run;
  });
  // The real spawn slot, watched: what a lead asks it is under test below.
  const actualAgent = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  runner.teamSpawnSlot.mockImplementation(actualAgent.teamSpawnSlot);
  team = await import("@/lib/coding-team");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const PLAN = JSON.stringify([
  { task_description: "Scaffold index.html", files_hint: ["index.html"] },
  { task_description: "Wire app.js", depends_on: ["t1"], files_hint: ["app.js"] },
]);

async function finished(id: string) {
  const live = team.getTeam(id);
  // The loop runs on its own; the board on disk settles when it is done.
  // Up to twenty seconds, ten milliseconds at a time: a loaded CI runner
  // must not turn a slow settle into a wrong verdict.
  for (let i = 0; i < 2000 && !["done", "failed", "stopped"].includes(team.getTeam(id)?.status ?? ""); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return team.getTeam(id) ?? live!;
}

const PARALLEL_PLAN = JSON.stringify([
  { task_description: "Scaffold index.html", files_hint: ["index.html"] },
  { task_description: "Write styles.css", files_hint: ["styles.css"] },
  { task_description: "Wire app.js", depends_on: ["t1", "t2"], files_hint: ["app.js"] },
]);

describe("a planner that wrote prose", () => {
  it("is asked once more for the JSON array, with its first answer quoted, and the team goes on from the second", async () => {
    outcomes = [
      { summary: "## Plan\n1. Scaffold index.html\n2. Wire app.js — no array here" },
      { summary: PLAN },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const planners = starts.filter((s) => (s.team as { role: string }).role === "planner");
    expect(planners).toHaveLength(2);
    expect(planners[1]).toMatchObject({ readOnly: true });
    expect(String(planners[1].task)).toContain("was not a plan the team can read");
    expect(String(planners[1].task)).toContain("no array here");
    expect(String(planners[1].task)).toContain("ONLY the JSON plan");
    // On the record: one alert, two planner runs in the cast, the first still named.
    expect(done.alerts).toBe(1);
    expect(done.plannerRunId).toBe("run-00000001");
    expect(done.agents.planner).toBe(2);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)[0]).toMatch(/asking once more for the JSON plan \(attempt 2 of 3\)/);
  });

  it("asks a third time when the second answer is no plan either", async () => {
    // One correction was not enough on the box: a planner told to shorten a
    // 2835-character description answered 3013 the next time, and the team
    // died having posted no task at all.
    outcomes = [
      { summary: "prose" },
      { summary: "still prose" },
      { summary: PLAN },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.filter((s) => (s.team as { role: string }).role === "planner")).toHaveLength(3);
    expect(done.agents.planner).toBe(3);
    expect(done.alerts).toBe(2);
    expect(done.plannerRunId).toBe("run-00000001");
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)[1]).toMatch(/attempt 3 of 3/);
  });

  it("fails the team after the third answer is no plan either, saying why", async () => {
    outcomes = [{ summary: "prose" }, { summary: "still prose" }, { summary: "prose again" }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no JSON array/);
    expect(starts).toHaveLength(3);
  });

  it("does not spend the remaining asks on a planner run that did not finish", async () => {
    // A crashed planner is not a wording problem; re-asking it is paid noise.
    outcomes = [{ summary: "prose" }, { status: "failed", error: "planner exploded" }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/did not finish its answer/);
    expect(starts).toHaveLength(2);
  });
});

/** `n` characters of whole sentences, the last one cut mid-word. */
function prose(n: number): string {
  let text = "";
  for (let i = 1; text.length < n; i++) text += `Step ${i}: wire part ${i} of app.js, then check that it renders. `;
  return `${text.slice(0, n - 1)}z`;
}

describe("a plan with text over its bound", () => {
  it("is cut, not refused: the team goes on from the first answer, with one note on the log and no alert", async () => {
    outcomes = [
      { summary: JSON.stringify({
        shape: { parallelism: 1, review: "final", rationale: `${"One page, then its script. ".repeat(8).slice(0, 204)}z` },
        tasks: [
          { task_description: "Scaffold index.html", files_hint: ["index.html"] },
          { task_description: prose(2313), depends_on: ["t1"], files_hint: ["app.js"] },
        ],
      }) },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.filter((s) => (s.team as { role: string }).role === "planner")).toHaveLength(1);
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => e.type === "alert")).toEqual([]);
    const cut = done.tasks[1].task_description;
    expect(cut.length).toBeLessThanOrEqual(2000);
    expect(cut.endsWith("renders.")).toBe(true);
    expect(done.shape!.rationale.length).toBeLessThanOrEqual(200);
    const notes = done.log.filter((e) => e.type === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ actor: { kind: "system" }, message: `The shape's rationale was cut from 205 to ${done.shape!.rationale.length} characters. Task t2's description was cut from 2313 to ${cut.length} characters.` });
  });

  it("from the lead is cut too: the task is added, with a note and no alert", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: PLAN },
      { summary: "Built index.html.\nMISSING: favicon.ico — no task makes one.", filesTouched: ["index.html"] },
      { summary: "app", filesTouched: ["app.js"] },
      { summary: "favicon", filesTouched: ["favicon.ico"] },
    ];
    leadAnswers = [{ summary: JSON.stringify({ add: [{ task_description: prose(2110), depends_on: ["t1"], files_hint: ["favicon.ico"] }], note: "t1 found no favicon" }) }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.tasks[2]).toMatchObject({ task_id: "t3", origin: "lead", status: "complete" });
    const cut = done.tasks[2].task_description;
    expect(cut.length).toBeLessThanOrEqual(2000);
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([`Task t3's description was cut from 2110 to ${cut.length} characters.`]);
  });
});

describe("a worker whose commit failed", () => {
  it("is rejected with the reason and offered once more, and its branch is never merged", async () => {
    outcomes = [
      { summary: PARALLEL_PLAN },
      // Started in this order: t1 and t2 side by side, t1 once more, then t3 (which waits for both).
      { summary: "index done", filesTouched: ["index.html"], commitError: "fatal: cannot change to '/x/worktrees/t1-1': No such file or directory" },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "index done for real", filesTouched: ["index.html"] },
      { summary: "app wired", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const t1 = done.tasks.find((t) => t.task_id === "t1")!;
    expect(t1.attempts).toBe(2);
    expect(done.log.some((e) => e.type === "review" && /NOT COMMITTED: fatal: cannot change to/.test(e.message) && /could not be committed/.test(e.message))).toBe(true);
    expect(done.log.some((e) => e.type === "alert" && /Commit failed for t1/.test(e.message))).toBe(true);
    // The first attempt's branch was never merged; the second's was.
    const merges = plumbing.mergeWorkerBranch.mock.calls.map((c) => c[1]);
    expect(merges).not.toContain("clawbox/team-00000001-t1-1");
    expect(merges.filter((b) => /-t1-2$/.test(b))).toHaveLength(1);
  });
});

describe("a worker in the project itself whose commit failed", () => {
  it("is rejected with the reason too — no worktree, no merge, still not counted done", async () => {
    // No team branch: the code-project shape, workers one at a time in the folder.
    runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/clawbox/data/code-projects/site", projectId: "site" });
    outcomes = [
      { summary: PARALLEL_PLAN },
      { summary: "index done", filesTouched: ["index.html"], commitError: "fatal: index.lock exists" },
      { summary: "index done for real", filesTouched: ["index.html"] },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "app wired", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", projectId: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.tasks.find((t) => t.task_id === "t1")!.attempts).toBe(2);
    expect(done.log.some((e) => e.type === "review" && /NOT COMMITTED: fatal: index.lock exists/.test(e.message))).toBe(true);
    // The alert is what the card counts and what MAX_ALERTS adds up.
    expect(done.alerts).toBe(1);
    expect(done.log.some((e) => e.type === "alert" && /Commit failed for t1 \(run-\w+\): fatal: index.lock exists/.test(e.message))).toBe(true);
    expect(plumbing.mergeWorkerBranch).not.toHaveBeenCalled();
  });
});

describe("a worker the owner PAUSED", () => {
  it("is waited for, not settled: the resumed run's own result is the task's, and its worktree survives the pause", async () => {
    // Measured on the box (team-zf2uwq1n, 2026-09-06): the orchestrator took
    // "no process" for "finished", so a pause posted `The run ended paused.`
    // as t1's result, failed the task and the team, and removed the worktree
    // — while the run itself stayed resumable and its page still offered
    // Resume, into a folder that was gone.
    outcomes = [
      { summary: PLAN },
      { status: "paused", resumesAs: { summary: "index done", filesTouched: ["index.html"] } },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const t1 = done.tasks.find((t) => t.task_id === "t1")!;
    expect(t1).toMatchObject({ status: "complete", result: "index done", attempts: 1 });
    expect(JSON.stringify(done.log)).not.toContain("The run ended paused");
    // The worktree was still there to merge when the task was finally decided.
    expect(plumbing.mergeWorkerBranch.mock.calls.map((c) => c[1]).filter((b: string) => /-t1-1$/.test(b))).toHaveLength(1);
    // …and t2, which depends on t1, ran.
    expect(done.tasks.find((t) => t.task_id === "t2")).toMatchObject({ status: "complete" });
  });
});

describe("a stop that lands while a worker is being made", () => {
  it("starts no worker and gives the worktree back", async () => {
    outcomes = [{ summary: PARALLEL_PLAN }];
    let boardId = "";
    // The owner stops the team while the first worker's worktree is being added.
    plumbing.addWorkerWorktree.mockImplementationOnce(async (dir: string, teamId: string, taskId: string, attempt: number) => {
      team.stopTeam(boardId);
      return { ok: true, path: `${dir}/.clawbox/worktrees/${taskId}-${attempt}`, branch: `clawbox/${teamId}-${taskId}-${attempt}` };
    });
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    boardId = board.id;
    const done = await finished(board.id);
    expect(done.status).toBe("stopped");
    expect(starts.filter((s) => (s.team as { role: string }).role === "worker")).toHaveLength(0);
    expect(plumbing.removeWorktree).toHaveBeenCalledWith("/home/clawbox/Projects/site", "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1");
  });
});

describe("many agents at once", () => {
  it("starts every task whose dependencies are done side by side, each in its own worktree, and merges each home", async () => {
    // A worker settles on its third wait, so two of them overlap.
    waitsBeforeSettle = 3;
    outcomes = [
      { summary: PARALLEL_PLAN },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "app wired", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const workers = starts.filter((s) => (s.team as { role: string }).role === "worker");
    expect(workers.map((w) => (w.team as { taskId: string }).taskId)).toEqual(["t1", "t2", "t3"]);
    // t2 started while t1 was still going; t3 only once both were merged.
    const workerIds = Object.entries(liveWorkersAtStart).filter(([id]) => runs.get(id)?.team && (runs.get(id)!.team as { role: string }).role === "worker");
    expect(workerIds.map(([, n]) => n)).toEqual([0, 1, 0]);
    expect(workers.map((w) => w.directory)).toEqual([
      "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1",
      "/home/clawbox/Projects/site/.clawbox/worktrees/t2-1",
      "/home/clawbox/Projects/site/.clawbox/worktrees/t3-1",
    ]);
    expect(plumbing.mergeWorkerBranch).toHaveBeenCalledTimes(3);
    expect(done.agents).toEqual({ planner: 1, workers: 3, reviewers: 3, leads: 0, total: 7 });
  });

  it("keeps a code project's workers in place and one at a time — no team branch there", async () => {
    runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/clawbox/data/code-projects/site", projectId: "site" });
    waitsBeforeSettle = 3;
    outcomes = [{ summary: PARALLEL_PLAN }, { summary: "a" }, { summary: "b" }, { summary: "c" }];
    const board = await team.startTeam({ goal: "Build it", projectId: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.branch).toBeNull();
    expect(plumbing.ensureTeamBranch).not.toHaveBeenCalled();
    expect(plumbing.addWorkerWorktree).not.toHaveBeenCalled();
    const workers = starts.filter((s) => (s.team as { role: string }).role === "worker");
    expect(workers.every((w) => w.projectId === "site" && w.directory === "/home/clawbox/clawbox/data/code-projects/site")).toBe(true);
    // In place, the project IS the worker's folder: nothing to point at.
    expect(workers.some((w) => String(w.task).includes("Your folder:"))).toBe(false);
    expect(Object.values(liveWorkersAtStart).every((n) => n === 0)).toBe(true);
  });

  it("fails a task whose branch conflicts on the way home, names the conflict, and offers the task once more from the merged state", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "first try", filesTouched: ["index.html"] },
      { summary: "second try", filesTouched: ["index.html"] },
      { summary: "app", filesTouched: ["app.js"] },
    ];
    merges = [{ ok: false, conflict: true }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const t1 = done.tasks[0];
    expect(t1.attempts).toBe(2);
    expect(t1.status).toBe("complete");
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts[0]).toMatch(/Merge conflict for t1 \(run-00000002\)/);
    // The conflict is a rejection, on the record, and the next worker is told.
    const reviewsLogged = done.log.filter((e) => e.type === "review").map((e) => e.message);
    expect(reviewsLogged[0]).toMatch(/rejected.*MERGE CONFLICT/);
    const retry = starts.find((s) => (s.team as { role: string; taskId: string }).role === "worker" && (s.team as { taskId: string }).taskId === "t1" && String(s.task).includes("previous attempt"));
    expect(String(retry?.task)).toContain("A previous attempt was rejected: MERGE CONFLICT");
    // Worktree 2 for the second attempt; the reviewer ran only for the merged attempt.
    expect(plumbing.addWorkerWorktree).toHaveBeenCalledWith("/home/clawbox/Projects/site", board.id, "t1", 2);
    expect(starts.filter((s) => (s.team as { role: string }).role === "reviewer")).toHaveLength(2);
  });
});

describe("the review loop", () => {
  it("re-posts a task the reviewer rejected, with the reviewer's notes in the next worker's brief, and records the reviewer", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "index without a title", filesTouched: ["index.html"] },
      { summary: "index with a title", filesTouched: ["index.html"] },
      { summary: "app", filesTouched: ["app.js"] },
    ];
    reviews = [{ summary: JSON.stringify({ verdict: "rejected", notes: "index.html has no <title>." }) }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const t1 = done.tasks[0];
    expect(t1.attempts).toBe(2);
    expect(t1.review).toMatchObject({ verdict: "accepted" });
    expect(t1.reviewRunId).toBe("run-00000005");
    const reviewsLogged = done.log.filter((e) => e.type === "review").map((e) => e.message);
    expect(reviewsLogged[0]).toMatch(/rejected.*no <title>/);
    const secondTry = starts.find((s) => (s.team as { taskId: string; role: string }).taskId === "t1" && (s.team as { role: string }).role === "worker" && String(s.task).includes("previous attempt"));
    expect(String(secondTry?.task)).toContain("A previous attempt was rejected: index.html has no <title>.");
    expect(done.agents).toEqual({ planner: 1, workers: 3, reviewers: 3, leads: 0, total: 7 });
  });

  it("accepts by rule, with an alert, when the reviewer gives no verdict or does not finish", async () => {
    outcomes = [{ summary: PLAN }, { summary: "a", filesTouched: ["index.html"] }, { summary: "b", filesTouched: ["app.js"] }];
    reviews = [{ summary: "Looks fine to me!" }, { status: "failed", error: "boom" }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.tasks.map((t) => t.review?.verdict)).toEqual(["accepted", "accepted"]);
    expect(done.tasks.map((t) => t.review?.notes)).toEqual([
      expect.stringContaining("Accepted by rule"),
      expect.stringContaining("Accepted by rule"),
    ]);
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts).toEqual([
      expect.stringMatching(/reviewer of t1 gave no verdict/),
      expect.stringMatching(/reviewer of t2 \(run-00000005\) ended failed/),
    ]);
    expect(done.alerts).toBe(2);
  });
});

/**
 * Bench, 2026-09-22: 5 of 6 teams lost a review because the reviewer could
 * not start at a busy moment — "Accepted by rule: the reviewer could not
 * start", one alert each — and one team was failed at MAX_ALERTS with two of
 * those and one real alert, every deliverable verified on disk.
 */
describe("a reviewer that has to wait for room", () => {
  const reviewerOf = (taskId: string) => (call: unknown[]) => {
    const who = call[0] as { role: string; taskId: string | null };
    return who.role === "reviewer" && who.taskId === taskId;
  };

  it("waits when the slot says wait, asks again, and the task is reviewed — no rule acceptance, no alert", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    let refused = 0;
    runner.teamSpawnSlot.mockImplementation(async (who: { role: string; taskId: string | null }) => {
      if (who.role === "reviewer" && who.taskId === "t1" && refused === 0) {
        refused += 1;
        return { ok: false, wait: true, reason: "Not enough free memory for another run beside the 2 going (900 MB free, 1200 MB needed)." };
      }
      return { ok: true };
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // Asked twice for t1's reviewer: refused, then room.
    expect(runner.teamSpawnSlot.mock.calls.filter(reviewerOf("t1"))).toHaveLength(2);
    expect(starts.filter((s) => (s.team as { role: string }).role === "reviewer").map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t2"]);
    expect(done.tasks.map((t) => t.reviewRunId)).toEqual(["run-00000003", "run-00000005"]);
    expect(done.tasks.every((t) => t.review?.verdict === "accepted" && !/Accepted by rule/.test(t.review.notes))).toBe(true);
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => e.type === "alert")).toEqual([]);
  });

  it("counts a sibling worker whose worktree is still being added, and asks again once that launch has landed", async () => {
    // t1 and t2 side by side; t2's worktree is held until t1's reviewer has
    // asked for a slot, so that ask lands while t2's launch is only reserved.
    outcomes = [
      { summary: PARALLEL_PLAN },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "app wired", filesTouched: ["app.js"] },
    ];
    let releaseT2!: () => void;
    const t2Held = new Promise<void>((resolve) => { releaseT2 = resolve; });
    plumbing.addWorkerWorktree.mockImplementation(async (dir: string, teamId: string, taskId: string, attempt: number) => {
      if (taskId === "t2") await t2Held;
      return { ok: true, path: `${dir}/.clawbox/worktrees/${taskId}-${attempt}`, branch: `clawbox/${teamId}-${taskId}-${attempt}` };
    });
    const t1ReviewerAsks: number[] = [];
    runner.teamSpawnSlot.mockImplementation(async (who: { role: string; taskId: string | null }, starting?: number) => {
      if (who.role !== "reviewer" || who.taskId !== "t1") return { ok: true };
      t1ReviewerAsks.push(starting ?? 0);
      releaseT2();
      // What the real guard answers on a box with room for one run only.
      return (starting ?? 0) >= 1
        ? { ok: false, wait: true, reason: `Not enough free memory for another run beside the ${starting} going (900 MB free, 1200 MB needed).` }
        : { ok: true };
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // The first ask counted t2's reserved launch; the next, after t2's run
    // was live (the real slot counts that one as a run), no reservation.
    expect(t1ReviewerAsks).toEqual([1, 0]);
    expect(runner.teamSpawnSlot).toHaveBeenCalledWith({ id: board.id, role: "worker", taskId: "t2" }, 1);
    expect(done.tasks.map((t) => t.review?.verdict)).toEqual(["accepted", "accepted", "accepted"]);
    expect(done.tasks.every((t) => t.reviewRunId !== null && !/Accepted by rule/.test(t.review?.notes ?? ""))).toBe(true);
    expect(done.alerts).toBe(0);
  });

  it("waits too when the spawn itself refuses for room — the look and the spawn raced", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    let thrown = 0;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      if ((input.team as { role: string }).role === "reviewer" && thrown === 0) {
        thrown += 1;
        throw new CodingAgentError("busy", "The team already has 3 runs going.", true);
      }
      return fakeRun(input);
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(thrown).toBe(1);
    expect(starts.filter((s) => (s.team as { role: string }).role === "reviewer")).toHaveLength(2);
    expect(done.tasks.every((t) => t.reviewRunId !== null && !/Accepted by rule/.test(t.review?.notes ?? ""))).toBe(true);
    expect(done.alerts).toBe(0);
  });

  it("takes a refusal that cannot clear as no reviewer — accepted by rule, alerted — but never lets those alerts fail the team", async () => {
    // One real alert (the planner's re-ask) and three "no reviewer": four on
    // the board, one counted, and the team's verified work stands.
    outcomes = [
      { summary: "Here is my plan, in prose." },
      { summary: PARALLEL_PLAN },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "app wired", filesTouched: ["app.js"] },
    ];
    runner.teamSpawnSlot.mockImplementation(async (who: { role: string }) => who.role === "reviewer"
      ? { ok: false, wait: false, reason: "A coding run is already in progress (run-zzzzzzzz). Wait for it or stop it first." }
      : { ok: true });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.error).toBeNull();
    expect(done.alerts).toBe(4);
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts.filter((m) => /No reviewer for t\d: A coding run is already in progress \(run-zzzzzzzz\)/.test(m))).toHaveLength(3);
    // Asked once each: a stranger's run is not waited on.
    expect(runner.teamSpawnSlot.mock.calls.filter((c) => (c[0] as { role: string }).role === "reviewer")).toHaveLength(3);
    expect(starts.filter((s) => (s.team as { role: string }).role === "reviewer")).toHaveLength(0);
    expect(done.tasks.map((t) => t.review?.notes)).toEqual(Array(3).fill("Accepted by rule: the reviewer could not start."));
  });

  it("still takes the switch turned off as no reviewer, not a wait", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      if ((input.team as { role: string }).role === "reviewer") throw new CodingAgentError("disabled", "The coding agent is switched off.");
      return fakeRun(input);
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(runner.startRun.mock.calls.filter((c) => (c[0] as { team: { role: string } }).team.role === "reviewer")).toHaveLength(2);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([
      expect.stringMatching(/No reviewer for t1: The coding agent is switched off/),
      expect.stringMatching(/No reviewer for t2: The coding agent is switched off/),
    ]);
  });
});

describe("a team that works", () => {
  it("plans read-only, then runs one worker per task in order, relays each outcome in the worker's name, and finishes done", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "Built index.html; open it.", filesTouched: ["index.html"] },
      { summary: "Wired app.js.", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build the invoice app", directory: "site", source: "agent" });
    expect(board.status).toBe("planning");
    const done = await finished(board.id);

    expect(done.status).toBe("done");
    expect(done.plannerRunId).toBe("run-00000001");
    // The planner: read-only, the goal as its task, the planner brief.
    expect(starts[0]).toMatchObject({ task: "Build the invoice app", readOnly: true, team: { id: board.id, role: "planner", taskId: null } });
    expect(String(starts[0].extraBrief)).toContain("ONLY a JSON object");
    // Each worker in its own worktree off the team branch, with the team's
    // context around its own task; t2 waits for t1; after each, a REVIEWER
    // (read-only, in the main checkout) rules on the merged work.
    expect(done.branch).toBe(`clawbox/${board.id}`);
    expect(done.base).toBe("master");
    expect(starts).toHaveLength(5);
    expect(starts[1]).toMatchObject({ team: { role: "worker", taskId: "t1" }, directory: `/home/clawbox/Projects/site/.clawbox/worktrees/t1-1`, projectId: null });
    expect(String(starts[1].task)).toContain("Your task (t1 of 2): Scaffold index.html");
    expect(String(starts[1].task)).toContain("Team goal: Build the invoice app");
    // Its own folder named, so the hint's paths are read there and not in the project.
    expect(String(starts[1].task)).toContain("Your folder: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1");
    expect(starts[2]).toMatchObject({ team: { role: "reviewer", taskId: "t1" }, readOnly: true, directory: "/home/clawbox/Projects/site" });
    expect(String(starts[2].task)).toContain("Review task t1: Scaffold index.html");
    expect(String(starts[2].task)).toContain("Built index.html; open it.");
    expect(String(starts[2].extraBrief)).toContain("ONLY a JSON object");
    expect(starts[3]).toMatchObject({ team: { role: "worker", taskId: "t2" }, directory: `/home/clawbox/Projects/site/.clawbox/worktrees/t2-1` });
    // The board's digest, not a quote of finished results: every other task, one line each.
    expect(String(starts[3].task)).toContain("The team's board — every other task, then the latest alerts and messages:\nt1 [complete] — Scaffold index.html → Built index.html; open it.");
    expect(String(starts[3].task)).not.toContain("t2 [");
    expect(String(starts[3].extraBrief)).toContain("ONE WORKER");
    expect(starts[1].readOnly).toBeUndefined();
    expect(plumbing.mergeWorkerBranch).toHaveBeenCalledTimes(2);
    expect(plumbing.removeWorktree).toHaveBeenCalledTimes(2);

    expect(done.tasks.map((t) => [t.task_id, t.status, t.assigned_to, t.review?.verdict, t.reviewRunId])).toEqual([
      ["t1", "complete", "run-00000002", "accepted", "run-00000003"],
      ["t2", "complete", "run-00000004", "accepted", "run-00000005"],
    ]);
    // Who worked: the figure the card shows.
    expect(done.agents).toEqual({ planner: 1, workers: 2, reviewers: 2, leads: 0, total: 5 });
    expect(done.runs).toEqual([
      { id: "run-00000001", role: "planner", taskId: null },
      { id: "run-00000002", role: "worker", taskId: "t1" },
      { id: "run-00000003", role: "reviewer", taskId: "t1" },
      { id: "run-00000004", role: "worker", taskId: "t2" },
      { id: "run-00000005", role: "reviewer", taskId: "t2" },
    ]);
    // The audit trail names who said what.
    const who = done.log.map((e) => `${e.actor.kind === "worker" ? `worker:${e.actor.id}` : e.actor.kind}/${e.type}`);
    // Started by the assistant (source "agent"): created by the system on
    // its behalf; an owner's team would read "owner/team_created".
    expect(who).toEqual([
      "system/team_created",
      "planner/task", "planner/task", "system/team_status",
      "system/task", "worker:run-00000002/status_update", "worker:run-00000002/result", "worker:run-00000002/status_update", "reviewer/review",
      "system/task", "worker:run-00000004/status_update", "worker:run-00000004/result", "worker:run-00000004/status_update", "reviewer/review",
      "system/team_status",
    ]);
    expect(done.alerts).toBe(0);
    expect(team.activeTeamId()).toBeNull();
    // On disk, the same.
    expect(JSON.parse(fs.readFileSync(path.join(root, "data", "coding-team", `${board.id}.json`), "utf8")).status).toBe("done");
  });

  it("raises an alert when a worker is refused an action or strays, rejects that task once, and stops the team at MAX_ALERTS", async () => {
    outcomes = [
      { summary: PLAN },
      // t1: strayed AND refused → two alerts, rejected, re-posted.
      { summary: "did stuff", filesTouched: ["index.html", "secrets.env"], permissionDenials: 1, deniedActions: ["Bash: curl x"] },
      // t1 again: refused again → third alert → the team stops.
      { summary: "did more", filesTouched: ["index.html"], permissionDenials: 2, deniedActions: ["Bash: sudo", "Bash: rm"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/after 3 alerts/);
    expect(done.alerts).toBe(3);
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts[0]).toMatch(/refused 1 action\(s\): Bash: curl x/);
    expect(alerts[1]).toMatch(/outside its task: secrets\.env/);
    expect(alerts[2]).toMatch(/refused 2 action/);
    const t1 = done.tasks[0];
    expect(t1.attempts).toBe(2);
    expect(t1.review?.verdict).toBe("rejected");
    expect(starts).toHaveLength(3);
    expect(String(starts[2].task)).toContain("A previous attempt was rejected");
  });

  // Bench, 2026-09-22/23: a worker in its worktree globbed or read the project
  // path, or ran a `ps`, was refused by design — and the alert rejected merged,
  // correct work and failed teams on the alert ceiling.
  it("notes a worker refused only read-only actions — no alert, and the task goes on to its reviewer as if clean", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "index done", filesTouched: ["index.html"], permissionDenials: 2, deniedActions: ["Glob: /home/clawbox/Projects/site", "Read: /home/clawbox/Projects/site/index.html"] },
      { summary: "app done", filesTouched: ["app.js"], permissionDenials: 1, deniedActions: ["Bash: ps -eo pid,cmd | grep '[s]erver\\.py' || echo none"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => e.type === "alert")).toEqual([]);
    const notes = done.log.filter((e) => e.type === "note");
    expect(notes.map((e) => [e.actor.kind, e.task_id, e.message])).toEqual([
      ["system", "t1", "Worker run-00000002 was refused 2 read-only action(s) outside its folder: Glob: /home/clawbox/Projects/site; Read: /home/clawbox/Projects/site/index.html"],
      ["system", "t2", "Worker run-00000004 was refused 1 read-only action(s) outside its folder: Bash: ps -eo pid,cmd | grep '[s]erver\\.py' || echo none"],
    ]);
    // Reviewed and accepted on the first attempt: nothing redone.
    expect(starts.map((s) => (s.team as { role: string }).role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
    expect(done.tasks.map((t) => [t.status, t.attempts, t.review?.verdict])).toEqual([["complete", 1, "accepted"], ["complete", 1, "accepted"]]);
    expect(done.metrics).toMatchObject({ readOnlyRefusals: 3, tasksRejected: 0, tasksAcceptedFirstTry: 2 });
  });

  it("keeps the alert and the rejection when one refusal was a write, or when the run did not keep every refusal", async () => {
    outcomes = [
      { summary: PLAN },
      // t1: two reads and a write → an alert, rejected by the rule, offered once more.
      { summary: "index done", filesTouched: ["index.html"], permissionDenials: 3, deniedActions: ["Read: /home/clawbox/Projects/site/index.html", "Glob: /home/clawbox/Projects/site", "Write: /home/clawbox/Projects/site/index.html"] },
      // t1 again: seven refusals, five on the record, all reads — the two
      // not kept may have been writes: an alert, and rejected for good.
      { summary: "index done", filesTouched: ["index.html"], permissionDenials: 7, deniedActions: ["Read: a", "Read: b", "Read: c", "Read: d", "Read: e"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.alerts).toBe(2);
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts[0]).toMatch(/Worker run-00000002 was refused 3 action\(s\): Read: .*; Glob: .*; Write: \/home\/clawbox\/Projects\/site\/index\.html/);
    expect(alerts[1]).toMatch(/Worker run-00000003 was refused 7 action\(s\)/);
    expect(done.log.filter((e) => e.type === "note")).toEqual([]);
    expect(done.tasks[0]).toMatchObject({ status: "rejected", attempts: 2, rejections: 2, review: { verdict: "rejected", notes: expect.stringMatching(/refused an action/) } });
    // The rule ruled both times: no reviewer ran.
    expect(starts.map((s) => (s.team as { role: string }).role)).toEqual(["planner", "worker", "worker"]);
    expect(done.metrics.readOnlyRefusals).toBe(0);
  });

  // Bench, 2026-09-23: a worker wrote its deliverable, then was refused a check
  // script in /tmp — twice — and the rule rejected merged, correct work.
  it("notes a worker refused only writes outside its folders — no alert, and the task stays clean", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "index done", filesTouched: ["index.html"], permissionDenials: 1, deniedActions: ["Write: /tmp/t2_check_contacts.py"] },
      { summary: "app done", filesTouched: ["app.js"], permissionDenials: 2, deniedActions: ["Bash: cat > /tmp/check.py << 'EOF'", "Read: /home/clawbox/Projects/site/index.html"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.alerts).toBe(0);
    const notes = done.log.filter((e) => e.type === "note");
    expect(notes.map((e) => [e.actor.kind, e.task_id, e.message])).toEqual([
      ["system", "t1", "Worker run-00000002 was refused 1 action(s) that changed nothing — reads, or writes outside its folder: Write: /tmp/t2_check_contacts.py"],
      ["system", "t2", "Worker run-00000004 was refused 2 action(s) that changed nothing — reads, or writes outside its folder: Bash: cat > /tmp/check.py << 'EOF'; Read: /home/clawbox/Projects/site/index.html"],
    ]);
    expect(starts.map((s) => (s.team as { role: string }).role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
    expect(done.tasks.map((t) => [t.status, t.attempts, t.review?.verdict])).toEqual([["complete", 1, "accepted"], ["complete", 1, "accepted"]]);
    expect(done.metrics).toMatchObject({ readOnlyRefusals: 3, tasksRejected: 0, tasksAcceptedFirstTry: 2 });
  });

  it("keeps the alert and the rejection for a refused write inside the worker's worktree", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "index done", filesTouched: ["index.html"], permissionDenials: 1, deniedActions: ["Write: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1/index.html"] },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.alerts).toBe(1);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([
      "ALERT: Worker run-00000002 was refused 1 action(s): Write: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1/index.html",
    ]);
    expect(done.log.filter((e) => e.type === "note")).toEqual([]);
    expect(done.log.find((e) => e.type === "review")?.message).toMatch(/Task t1 rejected: The worker was refused an action/);
    // Offered once more, from a fresh worktree; the rule ruled the first time, so no reviewer ran for it.
    expect(starts.map((s) => (s.team as { role: string }).role)).toEqual(["planner", "worker", "worker", "reviewer", "worker", "reviewer"]);
    expect(done.tasks[0]).toMatchObject({ status: "complete", attempts: 2, rejections: 1 });
    expect(done.metrics.readOnlyRefusals).toBe(0);
  });

  it("fails the team when a worker fails and its dependants can never run, naming both", async () => {
    outcomes = [{ summary: PLAN }, { status: "failed", error: "Stopped at the cost ceiling" }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "agent" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Tasks t1 failed; t2 never ran.");
    expect(done.tasks[0]).toMatchObject({ status: "failed", result: "Stopped at the cost ceiling", review: null });
    expect(starts).toHaveLength(2);
  });

  it("fails the team, with the reason, when the planner answers no plan every time — and never starts a worker", async () => {
    outcomes = [{ summary: "I think we should refactor everything." }, { summary: "Still prose, sorry." }, { summary: "Prose once more." }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "agent" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no JSON array/);
    // The planner and its two corrections; no worker, and no fourth ask.
    expect(starts).toHaveLength(3);
    expect(starts.every((s) => (s.team as { role: string }).role === "planner")).toBe(true);
    expect(done.tasks).toEqual([]);
  });
});

describe("the gates", () => {
  it("refuses while the switch is off, an empty goal, and a second team at once", async () => {
    runner.isCodingAgentEnabled.mockResolvedValueOnce(false);
    await expect(team.startTeam({ goal: "g", source: "agent" })).rejects.toMatchObject({ kind: "disabled" });
    await expect(team.startTeam({ goal: "   ", source: "agent" })).rejects.toMatchObject({ kind: "invalid" });
    // One in flight: the planner never settles until we say so.
    let release: () => void = () => {};
    runner.waitForRun.mockImplementationOnce(() => new Promise((r) => { release = () => r(runs.get("run-00000001")); }));
    const first = await team.startTeam({ goal: "g", source: "agent" });
    expect(team.activeTeamId()).toBe(first.id);
    await expect(team.startTeam({ goal: "another", source: "agent" })).rejects.toMatchObject({ kind: "busy" });
    outcomes = [{ summary: "nope" }];
    Object.assign(runs.get("run-00000001")!, { status: "completed", summary: "nope" });
    release();
    await finished(first.id);
    expect(runner.resolveWorkingDirectory).toHaveBeenCalledWith({ projectId: null, directory: null });
  });

  it("stops the worker in flight when the owner stops the team", async () => {
    outcomes = [{ summary: PLAN }];
    let release: () => void = () => {};
    runner.waitForRun.mockImplementation(async (id: string) => {
      const run = runs.get(id)!;
      if (id === "run-00000001") { Object.assign(run, { status: "completed", summary: PLAN }); return run; }
      // The worker: held until the test lets go, still running.
      await new Promise<void>((r) => { release = r; });
      return runs.get(id);
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    for (let i = 0; i < 100 && !runs.has("run-00000002"); i++) await new Promise((r) => setTimeout(r, 5));
    const stopped = team.stopTeam(board.id);
    expect(stopped.status).toBe("stopped");
    expect(runner.stopRun).toHaveBeenCalledWith("run-00000002");
    release();
    const done = await finished(board.id);
    expect(done.status).toBe("stopped");
    expect(team.activeTeamId()).toBeNull();
  });

  it("settles a team the web server restarted under as failed, on the next read", async () => {
    const { createBoard, saveBoard } = await import("@/lib/coding-team-board");
    const orphan = createBoard({ goal: "g", projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    orphan.status = "working";
    saveBoard(orphan);
    expect(team.getTeam(orphan.id)).toEqual(expect.objectContaining({ status: "failed", error: expect.stringMatching(/restarted/) }));
    expect(team.listTeams().map((b) => b.id)).toEqual([orphan.id]);
    expect(team.getTeam("team-nope")).toBeNull();
    expect(team.getTeam("../x")).toBeNull();
  });
});

describe("the words", () => {
  // Bench, 2026-09-22: a worker in a worktree read its hinted styles.css at
  // `<project>/styles.css`, was refused, and the refusal was an alert.
  it("names a worker's own folder when it has a worktree — before the files, every path relative to it — and nothing in place", async () => {
    const { createBoard, postTask } = await import("@/lib/coding-team-board");
    const board = createBoard({ goal: "Build the site", projectId: null, directory: "/home/clawbox/Projects/site", source: "owner" }, { kind: "owner" });
    const task = postTask(board, { kind: "planner" }, { task_description: "Write styles.css", files_hint: ["styles.css"] });
    const folder = "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1";
    const text = team.workerTask(board, task, folder);
    // The task line stays first: it is the run's commit subject.
    expect(text.split("\n")[0]).toBe("Your task (t1 of 1): Write styles.css");
    expect(text).toContain(`Your folder: ${folder} — your own working copy of the project. Every path in this task, the files below included, is relative to it`);
    expect(text).toContain("never in /home/clawbox/Projects/site itself");
    expect(text.indexOf("Your folder:")).toBeLessThan(text.indexOf("Files this task is expected to touch: styles.css"));
    // The hint itself stays relative — what outsideHint matches against.
    expect(text).not.toContain(`${folder}/styles.css`);
    expect(team.workerTask(board, task)).not.toContain("Your folder:");
    expect(team.workerTask(board, task, board.directory)).not.toContain("Your folder:");
  });

  it("keeps the worker's folder when a long goal pushes the task text past its cut", async () => {
    const { createBoard, postTask, MAX_GOAL_CHARS } = await import("@/lib/coding-team-board");
    const { MAX_TASK_CHARS } = await import("@/lib/coding-agent");
    // A goal at the limit a team accepts, and a long task under it.
    const board = createBoard({ goal: "g".repeat(MAX_GOAL_CHARS), projectId: null, directory: "/home/clawbox/Projects/site", source: "owner" }, { kind: "owner" });
    const task = postTask(board, { kind: "planner" }, { task_description: "d".repeat(1_500), files_hint: ["styles.css"] });
    const text = team.workerTask(board, task, "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1");
    expect(text.length).toBe(MAX_TASK_CHARS);
    expect(text).toContain("Your folder: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1");
  });

  it("names files outside a task's hint, folders included, and nothing when there is no hint", () => {
    expect(team.outsideHint(["src/a.js", "src/lib/b.js", "README.md"], ["src"])).toEqual(["README.md"]);
    expect(team.outsideHint(["./index.html"], ["index.html"])).toEqual([]);
    expect(team.outsideHint(["anything"], [])).toEqual([]);
  });

  // team-6rgz8cyx and team-5oxkp7a9 (2026-09-06): every alert of both runs was
  // __pycache__/calc.cpython-310.pyc, written by CPython importing the very
  // file the task named. Three of those hit the alert ceiling and killed runs
  // whose work the reviewer had already accepted.
  it("does not call a generated artifact a stray file", () => {
    expect(team.outsideHint(["calc.py", "__pycache__/calc.cpython-310.pyc"], ["calc.py"])).toEqual([]);
    expect(team.outsideHint(["src/a.py", "src/__pycache__/a.cpython-311.pyc"], ["src/a.py"])).toEqual([]);
    expect(team.outsideHint(["node_modules/x/index.js", ".DS_Store", "app.tsbuildinfo"], ["src"])).toEqual([]);
  });

  it("still names a real file the task was not given", () => {
    expect(team.outsideHint(["calc.py", "secrets.env"], ["calc.py"])).toEqual(["secrets.env"]);
    // dist/ is generated too, but a task can be asked to produce it, so it
    // is deliberately NOT ignorable: dropping it would lose the work.
    expect(team.outsideHint(["dist/bundle.js"], ["src"])).toEqual(["dist/bundle.js"]);
  });
});


it("dispatches the full machine result, never its clipped display summary", async () => {
  const resultText = JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ task_description: String(i).repeat(1800), depends_on: [] })));
  outcomes = [{ summary: resultText.slice(0, 6000), resultText }];
  const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
  const done = await finished(board.id);
  expect(done.status).toBe("done");
  expect(done.tasks).toHaveLength(4);
  expect(starts.filter((s) => (s.team as { role: string }).role === "planner")).toHaveLength(1);
});

// ─── TASK-1099: the planner's shape, the lead, the figures ───────────────────

const role = (s: Record<string, unknown>) => (s.team as { role: string }).role;
const THREE = JSON.stringify([
  { task_description: "Scaffold index.html", files_hint: ["index.html"] },
  { task_description: "Wire app.js", depends_on: ["t1"], files_hint: ["app.js"] },
  { task_description: "Write the README", depends_on: ["t1"], files_hint: ["README.md"] },
]);
const RETIRE_T3 = JSON.stringify({ retire: ["t3"], note: "t1 already wrote the README" });
/** t1's result, naming a blocker: what calls the lead after an accepted task. */
const BLOCKED_INDEX = "Built index.html.\nMISSING: a favicon — no task makes one.";
const shaped = (shape: Record<string, unknown>, plan: string) => JSON.stringify({ shape, tasks: JSON.parse(plan) });

describe("the lead (coding_team_dynamic)", () => {
  it("is never started while the switch is off — through a rejection, a retry and a failure alike", async () => {
    outcomes = [
      { summary: THREE },
      { summary: "index", filesTouched: ["index.html"] },
      { summary: "index again", filesTouched: ["index.html"] },
      { summary: "app", filesTouched: ["app.js"] },
      { status: "failed", error: "boom" },
    ];
    reviews = [{ summary: JSON.stringify({ verdict: "rejected", notes: "No <title>." }) }];
    leadAnswers = [{ summary: RETIRE_T3 }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(runner.getTeamDynamic).toHaveBeenCalledTimes(1);
    expect(runner.startRun).toHaveBeenCalled();
    expect(runner.startRun.mock.calls.filter(([input]) => (input.team as { role: string }).role === "lead")).toEqual([]);
    expect(leadAnswers).toHaveLength(1);
    expect(done.dynamic).toBe(false);
    expect(done.metrics.leadRuns).toBe(0);
    expect(done.tasks.map((t) => t.status)).not.toContain("retired");
  });

  it("retires a pending task the goal no longer needs, before anything new starts, and the team finishes without it", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: THREE },
      { summary: "Built index.html, and a README while I was at it.", filesTouched: ["index.html"] },
      { summary: "Wired app.js.", filesTouched: ["app.js"] },
    ];
    leadAnswers = [{ summary: `Having read the folder:\n${RETIRE_T3}` }];
    // t1's worker tells the lead while it works: the message is what calls the lead back.
    const wait = runner.waitForRun.getMockImplementation()!;
    let told = false;
    runner.waitForRun.mockImplementation(async (id: string, ms?: number) => {
      const run = runs.get(id);
      const who = run?.team as { id: string; role: string; taskId: string | null } | null;
      if (!told && run?.status === "running" && who?.role === "worker" && who.taskId === "t1") {
        told = true;
        await team.sendTeamMessage({ teamId: who.id, fromRunId: id, role: "worker", to: "lead", text: "I wrote README.md as well;\nt3 is not needed." });
      }
      return wait(id, ms);
    });
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.dynamic).toBe(true);
    expect(done.tasks.map((t) => [t.task_id, t.status])).toEqual([["t1", "complete"], ["t2", "complete"], ["t3", "retired"]]);
    // One lead turn, after t1 and before t2 started; after t2 nothing was left to decide.
    expect(starts.map(role)).toEqual(["planner", "worker", "reviewer", "lead", "worker", "reviewer"]);
    const lead = starts[3];
    expect(lead).toMatchObject({ readOnly: true, team: { id: board.id, role: "lead", taskId: "t1" }, directory: "/home/clawbox/Projects/site", projectId: null });
    expect(String(lead.extraBrief)).toContain("You are the LEAD");
    expect(String(lead.task)).toMatch(/^Task t1 just settled \(complete, accepted\): Scaffold index\.html/);
    expect(String(lead.task)).toContain("Built index.html, and a README");
    expect(String(lead.task)).toContain("pending now: t2, t3");
    // Its inbox: the message, whole, on one line; the turn that read it is on the board.
    expect(String(lead.task)).toContain("Messages to the lead since your last turn:\n- worker run-00000002 (task t1): I wrote README.md as well; t3 is not needed.");
    expect(done.lastLeadAt).toBeGreaterThan(0);
    // In the planner's name, with the lead's note; the cast list and the figures count it.
    expect(done.log.find((e) => e.type === "retire")).toMatchObject({ actor: { kind: "planner" }, task_id: "t3", message: "Task t3 retired by the lead: t1 already wrote the README" });
    expect(done.runs.filter((r) => r.role === "lead")).toEqual([{ id: "run-00000004", role: "lead", taskId: "t1" }]);
    expect(done.agents).toEqual({ planner: 1, workers: 2, reviewers: 2, leads: 1, total: 6 });
    expect(done.metrics).toMatchObject({ leadRuns: 1, tasksPlanned: 3, tasksAdded: 0, tasksRetired: 1, tasksAcceptedFirstTry: 2, tasksRejected: 0 });
    expect(done.alerts).toBe(0);
  });

  it("adds a task a finished one revealed; it runs like any other and is counted as the lead's", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: PLAN },
      { summary: "Built index.html.\nMISSING: favicon.ico — no task makes one.", filesTouched: ["index.html"] },
      { summary: "app", filesTouched: ["app.js"] },
      { summary: "favicon", filesTouched: ["favicon.ico"] },
    ];
    leadAnswers = [{ summary: JSON.stringify({ add: [{ task_description: "Add a favicon and link it from index.html", depends_on: ["t1"], files_hint: ["favicon.ico", "index.html"] }], note: "t1 found no favicon" }) }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.tasks[2]).toMatchObject({ task_id: "t3", origin: "lead", status: "complete", depends_on: ["t1"], files_hint: ["favicon.ico", "index.html"] });
    const worker3 = starts.find((s) => role(s) === "worker" && (s.team as { taskId: string }).taskId === "t3");
    expect(String(worker3?.task)).toMatch(/^Your task \(t3 of 3\): Add a favicon/);
    expect(done.log.some((e) => e.type === "task" && e.actor.kind === "planner" && e.message === "Task t3 added by the lead: Add a favicon and link it from index.html — t1 found no favicon")).toBe(true);
    expect(done.metrics).toMatchObject({ tasksPlanned: 2, tasksAdded: 1, tasksRetired: 0 });
    // The blocker called it; t2 and t3 settled clean and called no one.
    expect(done.metrics.leadRuns).toBe(1);
  });

  it.each([
    ["an answer that is not one", { summary: "The plan looks fine to me!" }, /^ALERT: The lead after t1 gave no usable answer: The lead's answer holds no JSON object\. The plan is unchanged\.$/],
    ["an answer past a bound", { summary: '{"retire": ["t1"]}' }, /^ALERT: The lead after t1 gave no usable answer: It retires t1, which is complete; only a pending task may be retired\. The plan is unchanged\.$/],
    ["a lead that did not finish", { status: "failed", error: "boom" }, /^ALERT: The lead after t1 \(run-00000004\) ended failed; the plan is unchanged\.$/],
  ])("takes %s as an alert, and the team goes on with the plan it had", async (_what, answer, alert) => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [{ summary: PLAN }, { summary: BLOCKED_INDEX, filesTouched: ["index.html"] }, { summary: "app", filesTouched: ["app.js"] }];
    leadAnswers = [answer];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.alerts).toBe(1);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([expect.stringMatching(alert)]);
    expect(done.tasks.map((t) => [t.task_id, t.status, t.origin])).toEqual([["t1", "complete", "plan"], ["t2", "complete", "plan"]]);
    expect(done.metrics.leadRuns).toBe(1);
    // A turn that decided nothing read nothing: the inbox is still unread.
    expect(done.lastLeadAt).toBe(0);
  });

  it.each([
    ["did not finish", { status: "failed", error: "boom" }],
    ["gave no usable answer", { summary: "The plan looks fine to me!" }],
  ])("keeps the inbox unread when the lead %s — the next turn reads the message again; a usable {} marks it read", async (_what, first) => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: JSON.stringify([
        { task_description: "Scaffold index.html", files_hint: ["index.html"] },
        { task_description: "Wire app.js", depends_on: ["t1"], files_hint: ["app.js"] },
        { task_description: "Write the README", depends_on: ["t2"], files_hint: ["README.md"] },
        { task_description: "Add a licence", depends_on: ["t3"], files_hint: ["LICENSE"] },
      ]) },
      { summary: "Built index.html.", filesTouched: ["index.html"] },
      { summary: "Wired app.js.", filesTouched: ["app.js"] },
      { summary: "Wrote the README.", filesTouched: ["README.md"] },
      { summary: "Added the licence.", filesTouched: ["LICENSE"] },
    ];
    leadAnswers = [first, { summary: "{}" }];
    // t1's worker tells the lead while it works; every task then settles clean.
    const wait = runner.waitForRun.getMockImplementation()!;
    let told = false;
    runner.waitForRun.mockImplementation(async (id: string, ms?: number) => {
      const run = runs.get(id);
      const who = run?.team as { id: string; role: string; taskId: string | null } | null;
      if (!told && run?.status === "running" && who?.role === "worker" && who.taskId === "t1") {
        told = true;
        await team.sendTeamMessage({ teamId: who.id, fromRunId: id, role: "worker", to: "lead", text: "The licence is the owner's call." });
      }
      return wait(id, ms);
    });
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.tasks.map((t) => [t.task_id, t.status])).toEqual([["t1", "complete"], ["t2", "complete"], ["t3", "complete"], ["t4", "complete"]]);
    // The message calls the lead after t1; that turn decides nothing, so the
    // same message calls it again after t2, clean as t2 is. That turn's {}
    // reads it, and t3 — clean, nothing new said — calls no one.
    expect(starts.map(role)).toEqual(["planner", "worker", "reviewer", "lead", "worker", "reviewer", "lead", "worker", "reviewer", "worker", "reviewer"]);
    const leads = starts.filter((s) => role(s) === "lead");
    expect(leads.map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t2"]);
    for (const lead of leads) {
      expect(String(lead.task)).toContain("Messages to the lead since your last turn:\n- worker run-00000002 (task t1): The licence is the owner's call.");
    }
    expect(done.metrics.leadRuns).toBe(2);
    expect(done.alerts).toBe(1);
    expect(done.lastLeadAt).toBeGreaterThan(0);
  });

  it("calls the lead back ONCE on a message it could not decide — a lead that never answers must not spend the team's alerts", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: JSON.stringify([
        { task_description: "Scaffold index.html", files_hint: ["index.html"] },
        { task_description: "Wire app.js", depends_on: ["t1"], files_hint: ["app.js"] },
        { task_description: "Write the README", depends_on: ["t2"], files_hint: ["README.md"] },
        { task_description: "Add a licence", depends_on: ["t3"], files_hint: ["LICENSE"] },
      ]) },
      { summary: "Built index.html.", filesTouched: ["index.html"] },
      { summary: "Wired app.js.", filesTouched: ["app.js"] },
      { summary: "Wrote the README.", filesTouched: ["README.md"] },
      { summary: "Added the licence.", filesTouched: ["LICENSE"] },
    ];
    // Prose, every time it is asked.
    leadAnswers = Array.from({ length: 4 }, () => ({ summary: "The plan looks fine to me!" }));
    const wait = runner.waitForRun.getMockImplementation()!;
    let told = false;
    runner.waitForRun.mockImplementation(async (id: string, ms?: number) => {
      const run = runs.get(id);
      const who = run?.team as { id: string; role: string; taskId: string | null } | null;
      if (!told && run?.status === "running" && who?.role === "worker" && who.taskId === "t1") {
        told = true;
        await team.sendTeamMessage({ teamId: who.id, fromRunId: id, role: "worker", to: "lead", text: "The licence is the owner's call." });
      }
      return wait(id, ms);
    });
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    // Once after t1, once more after t2 — then t3 and t4, clean with nothing
    // new said, call no one, and the team is not stopped at MAX_ALERTS.
    expect(done.status).toBe("done");
    expect(done.tasks.map((t) => t.status)).toEqual(["complete", "complete", "complete", "complete"]);
    expect(starts.filter((s) => role(s) === "lead").map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t2"]);
    expect(done.metrics.leadRuns).toBe(2);
    expect(done.alerts).toBe(2);
    // Never read: a lead that does run later, for a reason of its own, is still shown it.
    expect(done.lastLeadAt).toBe(0);
  });

  it("counts a worker still being started when the lead asks for a seat — it would take that worker's place otherwise", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [{ summary: PARALLEL_PLAN }, { summary: BLOCKED_INDEX, filesTouched: ["index.html"] }, { summary: "styles", filesTouched: ["styles.css"] }, { summary: "app", filesTouched: ["app.js"] }];
    // t2's worktree is still being added when t1 settles and the lead asks.
    let releaseT2: () => void = () => {};
    const t2Worktree = new Promise<void>((resolve) => { releaseT2 = resolve; });
    plumbing.addWorkerWorktree.mockImplementation(async (dir: string, teamId: string, taskId: string, attempt: number) => {
      if (taskId === "t2") await t2Worktree;
      return { ok: true, path: `${dir}/.clawbox/worktrees/${taskId}-${attempt}`, branch: `clawbox/${teamId}-${taskId}-${attempt}` };
    });
    runner.teamSpawnSlot.mockImplementation(async (who: { role: string }) => {
      if (who.role === "lead") releaseT2();
      return { ok: true };
    });
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const leadAsks = runner.teamSpawnSlot.mock.calls.filter(([who]) => (who as { role: string }).role === "lead");
    expect(leadAsks[0]).toEqual([{ id: board.id, role: "lead", taskId: "t1" }, 1]);
  });

  it("spends no run when nothing is left to decide: every task left is complete", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [{ summary: JSON.stringify([{ task_description: "Fix the typo in README.md", files_hint: ["README.md"] }]) }, { summary: "fixed", filesTouched: ["README.md"] }];
    const board = await team.startTeam({ goal: "Fix the typo", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.map(role)).toEqual(["planner", "worker", "reviewer"]);
  });

  it("spends no run on a task accepted clean — no blocker, no message to the lead — and logs nothing for the skip", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [{ summary: PLAN }, { summary: "Built index.html.", filesTouched: ["index.html"] }, { summary: "Wired app.js.", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.dynamic).toBe(true);
    // t2 was still pending after t1 — the old loop's lead turn, answering {}.
    expect(starts.map(role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
    expect(done.metrics.leadRuns).toBe(0);
    expect(done.lastLeadAt).toBe(0);
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => /\blead\b/i.test(e.message))).toEqual([]);
  });

  it("gives every worker that settled while it thought ONE further turn — not one each", async () => {
    // Four side by side, so three are still going when the first one calls the
    // lead: the box's three slots would leave only two beside it. The batch is
    // the same rule for any number.
    teamSlots.value = 4;
    runner.getTeamDynamic.mockResolvedValue(true);
    runner.teamSpawnSlot.mockResolvedValue({ ok: true });
    outcomes = [{ summary: shaped({ parallelism: 4, review: "none", rationale: "" }, JSON.stringify([
      { task_description: "Scaffold index.html", files_hint: ["index.html"] },
      { task_description: "Write styles.css", files_hint: ["styles.css"] },
      { task_description: "Write about.html", files_hint: ["about.html"] },
      { task_description: "Write the README", files_hint: ["README.md"] },
      { task_description: "Check every page links styles.css", depends_on: ["t1", "t2", "t3", "t4"], files_hint: ["index.html", "about.html"] },
    ])) }];
    // Each worker's outcome by its task, whatever order they start in.
    const byTask: Record<string, Record<string, unknown>> = {
      t1: { summary: BLOCKED_INDEX, filesTouched: ["index.html"] },
      t2: { summary: "Wrote styles.css.", filesTouched: ["styles.css"] },
      t3: { summary: "Wrote about.html.", filesTouched: ["about.html"] },
      t4: { summary: "Wrote the README.\nBLOCKED: the licence is the owner's call.", filesTouched: ["README.md"] },
      t5: { summary: "Every page links it.", filesTouched: [] },
    };
    // t2–t4 finish only once the lead after t1 has started, and that lead
    // answers only once all three are on the board.
    let leadUp: () => void = () => {};
    const leadStarted = new Promise<void>((resolve) => { leadUp = resolve; });
    const start = runner.startRun.getMockImplementation()!;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      if (role(input) === "lead") leadUp();
      return start(input);
    });
    const wait = runner.waitForRun.getMockImplementation()!;
    const onBoard = (teamId: string, ids: string[]) => ids.every((t) => team.getTeam(teamId)?.tasks.find((x) => x.task_id === t)?.review?.verdict === "accepted");
    runner.waitForRun.mockImplementation(async (id: string, ms?: number) => {
      const run = runs.get(id);
      const who = run?.team as { id: string; role: string; taskId: string } | null;
      if (run && who?.role === "worker" && run.status === "running") {
        if (["t2", "t3", "t4"].includes(who.taskId)) await leadStarted;
        return Object.assign(run, { status: "completed", completedAt: Date.now() }, byTask[who.taskId]);
      }
      if (who?.role === "lead" && who.taskId === "t1") {
        while (!onBoard(who.id, ["t2", "t3", "t4"])) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return wait(id, ms);
    });
    const board = await team.startTeam({ goal: "Build the site", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const leads = runner.startRun.mock.calls.map(([input]) => input as Record<string, unknown>).filter((input) => role(input) === "lead");
    // The lead after t1, then ONE more for t2, t3 and t4 — the old loop ran three.
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({ team: { role: "lead", taskId: "t1" } });
    const batch = String(leads[1].task);
    for (const t of ["t2", "t3", "t4"]) expect(batch).toContain(`Task ${t} just settled (complete, accepted)`);
    expect(batch).toContain("BLOCKED: the licence is the owner's call.");
    expect(batch).not.toContain("Task t1 just settled");
    expect(done.metrics.leadRuns).toBe(2);
    expect(done.tasks.map((t) => t.status)).toEqual(["complete", "complete", "complete", "complete", "complete"]);
  });

  it("reads the switch once, when the team starts", async () => {
    runner.getTeamDynamic.mockResolvedValueOnce(true).mockResolvedValue(false);
    outcomes = [{ summary: PLAN }, { summary: BLOCKED_INDEX, filesTouched: ["index.html"] }, { summary: "app", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.dynamic).toBe(true);
    expect(runner.getTeamDynamic).toHaveBeenCalledTimes(1);
    expect(starts.map(role)).toContain("lead");
  });
});

describe("a plan whose task waits on one listed after it", () => {
  it("is asked for again — posted in order, the board could never take it, and the team would fail with no worker started", async () => {
    const forward = JSON.stringify([
      { task_description: "Wire app.js", depends_on: ["t2"], files_hint: ["app.js"] },
      { task_description: "Scaffold index.html", files_hint: ["index.html"] },
    ]);
    outcomes = [{ summary: forward }, { summary: PLAN }, { summary: "index", filesTouched: ["index.html"] }, { summary: "app", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.filter((s) => role(s) === "planner")).toHaveLength(2);
    expect(String(starts[1].task)).toContain("Task t1 depends on t2, which is listed after it");
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([expect.stringMatching(/listed after it.*attempt 2 of 3/)]);
    expect(done.tasks.map((t) => [t.task_id, t.task_description])).toEqual([["t1", "Scaffold index.html"], ["t2", "Wire app.js"]]);
  });
});

describe("the planner's shape", () => {
  it("runs independent tasks one at a time when the plan asks for parallelism 1, and puts the shape on the board", async () => {
    waitsBeforeSettle = 3;
    outcomes = [
      { summary: shaped({ parallelism: 1, review: "each", rationale: "Each step builds on the last." }, PARALLEL_PLAN) },
      { summary: "index", filesTouched: ["index.html"] },
      { summary: "styles", filesTouched: ["styles.css"] },
      { summary: "app", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.shape).toEqual({ parallelism: 1, review: "each", rationale: "Each step builds on the last." });
    const workers = Object.entries(liveWorkersAtStart).filter(([id]) => (runs.get(id)!.team as { role: string }).role === "worker");
    expect(workers.map(([, n]) => n)).toEqual([0, 0, 0]);
    expect(done.log.find((e) => e.type === "shape")).toMatchObject({ actor: { kind: "planner" }, message: "Team shaped: 1 side by side, review each — Each step builds on the last." });
  });

  it("never runs more than one worker in a code project, whatever the plan asks", async () => {
    runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/clawbox/data/code-projects/site", projectId: "site" });
    waitsBeforeSettle = 3;
    outcomes = [{ summary: shaped({ parallelism: 3, review: "each", rationale: "" }, PARALLEL_PLAN) }, { summary: "a" }, { summary: "b" }, { summary: "c" }];
    const board = await team.startTeam({ goal: "Build it", projectId: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(Object.values(liveWorkersAtStart).every((n) => n === 0)).toBe(true);
  });

  it("reviews the merged whole ONCE when the plan asks for review \"final\"", async () => {
    outcomes = [
      { summary: shaped({ parallelism: 1, review: "final", rationale: "A small change." }, PLAN) },
      { summary: "Built index.html; open it.", filesTouched: ["index.html"] },
      { summary: "Wired app.js.", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.map(role)).toEqual(["planner", "worker", "worker", "reviewer"]);
    const final = starts[3];
    expect(final).toMatchObject({ readOnly: true, team: { id: board.id, role: "reviewer", taskId: null }, directory: "/home/clawbox/Projects/site" });
    expect(String(final.extraBrief)).toContain("you review the merged result ONCE");
    expect(String(final.task)).toContain("Review the team's whole result for its goal: Build it");
    expect(String(final.task)).toContain(`on the team's branch clawbox/${board.id}, forked from master`);
    expect(String(final.task)).toContain("t2 [complete] — Wire app.js → Wired app.js.");
    // Each task passed the rule; the one reviewer ruled on the whole.
    expect(done.tasks.map((t) => t.review?.notes)).toEqual([expect.stringMatching(/final review checks the merged result/), expect.stringMatching(/final review checks the merged result/)]);
    expect(done.finalReview).toMatchObject({ verdict: "accepted" });
    expect(done.log.map((e) => e.message)).toContain("Team → reviewing");
    expect(done.runs.filter((r) => r.role === "reviewer")).toEqual([{ id: "run-00000004", role: "reviewer", taskId: null }]);
  });

  it("fails the team with the final reviewer's words when it rejects the merged work", async () => {
    outcomes = [{ summary: shaped({ parallelism: 1, review: "final", rationale: "" }, PLAN) }, { summary: "index", filesTouched: ["index.html"] }, { summary: "app", filesTouched: ["app.js"] }];
    reviews = [{ summary: JSON.stringify({ verdict: "rejected", notes: "app.js never loads the form in index.html." }) }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("The final review rejected the merged work: app.js never loads the form in index.html.");
    expect(done.finalReview).toMatchObject({ verdict: "rejected" });
  });

  it("accepts by rule, with an alert, when the final reviewer gives no verdict", async () => {
    outcomes = [{ summary: shaped({ parallelism: 1, review: "final", rationale: "" }, PLAN) }, { summary: "index", filesTouched: ["index.html"] }, { summary: "app", filesTouched: ["app.js"] }];
    reviews = [{ summary: "Looks great." }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.finalReview).toMatchObject({ verdict: "accepted", notes: expect.stringMatching(/^Accepted by rule/) });
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([expect.stringMatching(/final reviewer gave no verdict/)]);
  });

  it("trusts the rule alone when the plan asks for review \"none\" — no reviewer run at all", async () => {
    outcomes = [{ summary: shaped({ parallelism: 2, review: "none", rationale: "Trivial edits." }, PLAN) }, { summary: "index", filesTouched: ["index.html"] }, { summary: "app", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.map(role)).toEqual(["planner", "worker", "worker"]);
    expect(done.tasks.map((t) => t.review?.notes)).toEqual([expect.stringMatching(/no reviewer run/), expect.stringMatching(/no reviewer run/)]);
    expect(done.finalReview).toBeNull();
  });

  it("still rejects by rule under review \"none\": a worker that strayed is offered the task once more", async () => {
    outcomes = [
      { summary: shaped({ parallelism: 1, review: "none", rationale: "" }, PLAN) },
      { summary: "index", filesTouched: ["index.html", "secrets.env"] },
      { summary: "index again", filesTouched: ["index.html"] },
      { summary: "app", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.tasks[0]).toMatchObject({ attempts: 2, rejections: 1 });
    expect(done.metrics).toMatchObject({ tasksRejected: 1, tasksAcceptedFirstTry: 1 });
  });
});

describe("the team's figures", () => {
  it("adds up every run's tokens from its own record and stops the clock when the team settles — on the board and in the view", async () => {
    outcomes = [
      { summary: PLAN, tokensUsed: 1_000 },
      { summary: "index", filesTouched: ["index.html"], tokensUsed: 20_000 },
      { summary: "app", filesTouched: ["app.js"], tokensUsed: 30_000 },
    ];
    reviews = [
      { summary: JSON.stringify({ verdict: "rejected", notes: "No <title>." }), tokensUsed: 4_000 },
      { summary: JSON.stringify({ verdict: "accepted", notes: "" }), tokensUsed: 5_000 },
      { summary: JSON.stringify({ verdict: "accepted", notes: "" }), tokensUsed: 6_000 },
    ];
    // t1's first try is rejected: its second worker takes the third outcome, t2 the default.
    outcomes.splice(2, 0, { summary: "index with a title", filesTouched: ["index.html"], tokensUsed: 7_000 });
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.runs.map((r) => [r.role, r.tokens])).toEqual([
      ["planner", 1_000], ["worker", 20_000], ["reviewer", 4_000], ["worker", 7_000], ["reviewer", 5_000], ["worker", 30_000], ["reviewer", 6_000],
    ]);
    expect(done.metrics).toMatchObject({
      plannerRuns: 1, workerRuns: 3, reviewerRuns: 3, leadRuns: 0,
      tasksPlanned: 2, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 1, tasksRejected: 1,
      tokensUsed: 73_000,
    });
    expect(done.finishedAt).toEqual(expect.any(Number));
    expect(done.metrics.wallMs).toBe(done.finishedAt! - done.createdAt);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-team", `${board.id}.json`), "utf8"));
    expect(onDisk.metrics).toEqual(done.metrics);
  });
});

describe("the worker's brief: when to use team_message", () => {
  it("names the sibling, lead and owner triggers in that order, and still forbids progress reports and acknowledgements", () => {
    const brief = team.WORKER_BRIEF;
    // A sibling, for a contract a teammate owns — by the run id the task text lists.
    expect(brief).toContain('to="sibling"');
    expect(brief).toContain("under 'Teammates at work now'");
    expect(brief).toContain("needs a file, a name, a schema or an API shape that a teammate owns");
    expect(brief).toContain("answer it once with the exact answer");
    // The lead, for a task on the board that is wrong for the goal.
    expect(brief).toContain('to="lead"');
    expect(brief).toContain("already done, it duplicates yours, or it cannot be done as written");
    // The owner's assistant, only for the owner's decision.
    expect(brief).toMatch(/owner's assistant \(to="owner_agent"\) only for a decision only the owner can take/);
    expect(brief.indexOf('to="sibling"')).toBeLessThan(brief.indexOf('to="lead"'));
    expect(brief.indexOf('to="lead"')).toBeLessThan(brief.indexOf('to="owner_agent"'));
    expect(brief).toContain("Never send a team_message for progress reports");
    expect(brief).toContain("never to acknowledge a message a teammate sent you");
  });

  it("puts scratch files in the evidence folder only — never in /tmp, never beside the project", () => {
    expect(team.WORKER_BRIEF).toContain("Scratch files go in your evidence folder only — never in /tmp, never beside the project. A write anywhere else is refused, and a refused write counts against your task.");
  });
});
