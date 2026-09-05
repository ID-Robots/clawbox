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

type Team = typeof import("@/lib/coding-team");
let team: Team;

/** The runs the fake runner "spawns", settled by the test. */
let runs: Map<string, Record<string, unknown>>;
let starts: Array<Record<string, unknown>>;
let seq: number;

function fakeRun(input: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  const id = `run-${String(seq).padStart(8, "0")}`;
  const run = {
    id, task: input.task, directory: "/home/clawbox/Projects/site", projectId: null, source: input.source,
    status: "running", startedAt: Date.now(), completedAt: null, summary: null, error: null,
    filesTouched: [] as string[], permissionDenials: 0, deniedActions: [] as string[],
    team: input.team ?? null, readOnly: input.readOnly === true, extraBrief: input.extraBrief ?? null,
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
  outcomes = [];
  vi.resetModules();
  vi.clearAllMocks();
  runner.isCodingAgentEnabled.mockResolvedValue(true);
  runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/Projects/site", projectId: null });
  runner.startRun.mockImplementation(async (input: Record<string, unknown>) => fakeRun(input));
  // A wait settles the run with the next scripted outcome.
  runner.waitForRun.mockImplementation(async (id: string) => {
    const run = runs.get(id);
    if (!run) return null;
    if (run.status === "running") {
      const outcome = outcomes[Number(id.slice(4)) - 1] ?? { status: "completed", summary: "done" };
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
    // Each worker: the team's context around its own task, in order, never two at once.
    expect(starts).toHaveLength(3);
    expect(starts[1]).toMatchObject({ team: { role: "worker", taskId: "t1" } });
    expect(String(starts[1].task)).toContain("Your task (t1 of 2): Scaffold index.html");
    expect(String(starts[1].task)).toContain("Team goal: Build the invoice app");
    expect(starts[2]).toMatchObject({ team: { role: "worker", taskId: "t2" } });
    expect(String(starts[2].task)).toContain("Already done by teammates:\n- t1: Built index.html; open it.");
    expect(String(starts[2].extraBrief)).toContain("ONE WORKER");
    expect(starts[1].readOnly).toBeUndefined();

    expect(done.tasks.map((t) => [t.task_id, t.status, t.assigned_to, t.review?.verdict])).toEqual([
      ["t1", "complete", "run-00000002", "accepted"],
      ["t2", "complete", "run-00000003", "accepted"],
    ]);
    // The audit trail names who said what.
    const who = done.log.map((e) => `${e.actor.kind === "worker" ? `worker:${e.actor.id}` : e.actor.kind}/${e.type}`);
    // Started by the assistant (source "agent"): created by the system on
    // its behalf; an owner's team would read "owner/team_created".
    expect(who).toEqual([
      "system/team_created",
      "planner/task", "planner/task", "system/team_status",
      "system/task", "worker:run-00000002/status_update", "worker:run-00000002/result", "worker:run-00000002/status_update", "reviewer/review",
      "system/task", "worker:run-00000003/status_update", "worker:run-00000003/result", "worker:run-00000003/status_update", "reviewer/review",
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

  it("fails the team, with the reason, when the planner answers no plan — and never starts a worker", async () => {
    outcomes = [{ summary: "I think we should refactor everything." }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "agent" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no JSON array/);
    expect(starts).toHaveLength(1);
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
