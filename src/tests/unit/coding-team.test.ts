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
}));
vi.mock("@/lib/coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-agent")>();
  return { ...actual, ...runner };
});
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
let reviews: Array<{ summary?: string; status?: string; error?: string }>;
let merges: Array<{ ok: boolean; conflict?: boolean }>;
let waitsBeforeSettle: number;
/** How many of the team's worker runs were still going when each run started — the parallelism, observed. */
let liveWorkersAtStart: Record<string, number>;

function fakeRun(input: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  const id = `run-${String(seq).padStart(8, "0")}`;
  const team = (input.team ?? null) as { role?: string } | null;
  const reviewer = team?.role === "reviewer";
  liveWorkersAtStart[id] = [...runs.values()].filter((r) => r.status === "running" && (r.team as { role?: string } | null)?.role === "worker").length;
  const run = {
    id, task: input.task, directory: String(input.directory ?? "/home/clawbox/Projects/site"), projectId: null, source: input.source,
    status: "running", startedAt: Date.now(), completedAt: null, summary: null, error: null,
    filesTouched: [] as string[], permissionDenials: 0, deniedActions: [] as string[],
    team: input.team ?? null, readOnly: input.readOnly === true, extraBrief: input.extraBrief ?? null,
    outcomeAt: reviewer ? -1 : workerSeq++, waits: 0,
  };
  runs.set(id, run);
  starts.push(input);
  return run;
}

/** How each run ends, keyed by the order it was started. */
let outcomes: Array<Partial<{ status: string; summary: string; error: string; filesTouched: string[]; permissionDenials: number; deniedActions: string[] }>>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-team-"));
  runs = new Map();
  starts = [];
  seq = 0;
  workerSeq = 0;
  outcomes = [];
  reviews = [];
  merges = [];
  waitsBeforeSettle = 1;
  liveWorkersAtStart = {};
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
  runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/Projects/site", projectId: null });
  runner.startRun.mockImplementation(async (input: Record<string, unknown>) => fakeRun(input));
  // A wait settles the run with the next scripted outcome.
  runner.waitForRun.mockImplementation(async (id: string) => {
    const run = runs.get(id);
    if (!run) return null;
    if (run.status === "running") {
      run.waits = Number(run.waits) + 1;
      if (Number(run.waits) < waitsBeforeSettle) return run;
      const reviewer = Number(run.outcomeAt) < 0;
      const outcome = reviewer
        ? (reviews.shift() ?? { summary: JSON.stringify({ verdict: "accepted", notes: "" }) })
        : (outcomes[Number(run.outcomeAt)] ?? { status: "completed", summary: "done" });
      Object.assign(run, { status: outcome.status ?? "completed", completedAt: Date.now() }, outcome);
    }
    return run;
  });
  runner.getRun.mockImplementation((id: string) => runs.get(id) ?? null);
  runner.stopRun.mockImplementation((id: string) => {
    const run = runs.get(id);
    if (run) Object.assign(run, { status: "stopped", completedAt: Date.now() });
    return run;
  });
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
    expect(String(planners[1].task)).toContain("ONLY the JSON array");
    // On the record: one alert, two planner runs in the cast, the first still named.
    expect(done.alerts).toBe(1);
    expect(done.plannerRunId).toBe("run-00000001");
    expect(done.agents.planner).toBe(2);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)[0]).toMatch(/asking once more/);
  });

  it("fails the team when the second answer is no plan either, saying why", async () => {
    outcomes = [{ summary: "prose" }, { summary: "still prose" }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no JSON array/);
    expect(starts).toHaveLength(2);
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
    expect(done.agents).toEqual({ planner: 1, workers: 3, reviewers: 3, total: 7 });
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
    expect(done.agents).toEqual({ planner: 1, workers: 3, reviewers: 3, total: 7 });
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
    expect(String(starts[0].extraBrief)).toContain("ONLY a JSON array");
    // Each worker in its own worktree off the team branch, with the team's
    // context around its own task; t2 waits for t1; after each, a REVIEWER
    // (read-only, in the main checkout) rules on the merged work.
    expect(done.branch).toBe(`clawbox/${board.id}`);
    expect(done.base).toBe("master");
    expect(starts).toHaveLength(5);
    expect(starts[1]).toMatchObject({ team: { role: "worker", taskId: "t1" }, directory: `/home/clawbox/Projects/site/.clawbox/worktrees/t1-1`, projectId: null });
    expect(String(starts[1].task)).toContain("Your task (t1 of 2): Scaffold index.html");
    expect(String(starts[1].task)).toContain("Team goal: Build the invoice app");
    expect(starts[2]).toMatchObject({ team: { role: "reviewer", taskId: "t1" }, readOnly: true, directory: "/home/clawbox/Projects/site" });
    expect(String(starts[2].task)).toContain("Review task t1: Scaffold index.html");
    expect(String(starts[2].task)).toContain("Built index.html; open it.");
    expect(String(starts[2].extraBrief)).toContain("ONLY a JSON object");
    expect(starts[3]).toMatchObject({ team: { role: "worker", taskId: "t2" }, directory: `/home/clawbox/Projects/site/.clawbox/worktrees/t2-1` });
    expect(String(starts[3].task)).toContain("Already done by teammates:\n- t1: Built index.html; open it.");
    expect(String(starts[3].extraBrief)).toContain("ONE WORKER");
    expect(starts[1].readOnly).toBeUndefined();
    expect(plumbing.mergeWorkerBranch).toHaveBeenCalledTimes(2);
    expect(plumbing.removeWorktree).toHaveBeenCalledTimes(2);

    expect(done.tasks.map((t) => [t.task_id, t.status, t.assigned_to, t.review?.verdict, t.reviewRunId])).toEqual([
      ["t1", "complete", "run-00000002", "accepted", "run-00000003"],
      ["t2", "complete", "run-00000004", "accepted", "run-00000005"],
    ]);
    // Who worked: the figure the card shows.
    expect(done.agents).toEqual({ planner: 1, workers: 2, reviewers: 2, total: 5 });
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

  it("fails the team when a worker fails and its dependants can never run, naming both", async () => {
    outcomes = [{ summary: PLAN }, { status: "failed", error: "Stopped at the cost ceiling" }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "agent" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Tasks t1 failed; t2 never ran.");
    expect(done.tasks[0]).toMatchObject({ status: "failed", result: "Stopped at the cost ceiling", review: null });
    expect(starts).toHaveLength(2);
  });

  it("fails the team, with the reason, when the planner answers no plan twice — and never starts a worker", async () => {
    outcomes = [{ summary: "I think we should refactor everything." }, { summary: "Still prose, sorry." }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "agent" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no JSON array/);
    // The planner, and the planner asked once more; no worker.
    expect(starts).toHaveLength(2);
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
  it("names files outside a task's hint, folders included, and nothing when there is no hint", () => {
    expect(team.outsideHint(["src/a.js", "src/lib/b.js", "README.md"], ["src"])).toEqual(["README.md"]);
    expect(team.outsideHint(["./index.html"], ["index.html"])).toEqual([]);
    expect(team.outsideHint(["anything"], [])).toEqual([]);
  });
});
