/**
 * A three-task plan, end to end through startTeam with the runner mocked —
 * the regression test for one failed team: its planner could not read the
 * project (D1), so it planned blind and hedged with a catch-all task over
 * every file the other tasks owned, which folded the team into one run in
 * silence (D2), and that one run's settle accepted a task whose named files
 * were never written (D3).
 *
 * The orchestrator, the board and the planner's brief are the real ones; the
 * runner, the git plumbing, GitHub and the notices are faked as in
 * coding-team.test.ts. The project is a real folder, so what a run writes is
 * on disk where the team looks for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
/** The team's project: a real folder under `root`. */
let project: string;
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
  suiteSandbox: vi.fn(),
  teamRoleModelMap: vi.fn(),
  getMaxParallelRuns: vi.fn(),
}));
vi.mock("@/lib/coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-agent")>();
  return { ...actual, ...runner };
});
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/coding-run-cpu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-run-cpu")>();
  return { ...actual, onBatteryPower: vi.fn(async () => false) };
});
const plumbing = vi.hoisted(() => ({
  ensureTeamBranch: vi.fn(),
  addWorkerWorktree: vi.fn(),
  mergeWorkerBranch: vi.fn(),
  removeWorktree: vi.fn(),
  changedFiles: vi.fn(),
  harvestWorktree: vi.fn(),
  committableFiles: vi.fn(),
}));
vi.mock("@/lib/coding-team-worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-team-worktree")>();
  return { ...actual, ...plumbing };
});
const github = vi.hoisted(() => ({
  openPullRequest: vi.fn(),
  readPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  markPullRequestReady: vi.fn(),
  pushBranch: vi.fn(),
  readReviewSnapshot: vi.fn(),
  readFailedCheckLogs: vi.fn(),
}));
vi.mock("@/lib/coding-pr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-pr")>();
  return { ...actual, openPullRequest: github.openPullRequest, readPullRequest: github.readPullRequest, mergePullRequest: github.mergePullRequest, markPullRequestReady: github.markPullRequestReady };
});
vi.mock("@/lib/coding-agent-notify", () => ({
  announceCodingAgent: vi.fn(async () => undefined),
  announceCodingTeam: vi.fn(async () => undefined),
  announceAnthropicLimit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/harness", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/harness")>()), getActiveHarness: vi.fn(async () => "openclaw" as const) }));
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()), gatewayWsChatSendMain: vi.fn(async () => ({ sessionKey: "main" })) }));
vi.mock("@/lib/coding-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-review")>();
  return { ...actual, pushBranch: github.pushBranch, readReviewSnapshot: github.readReviewSnapshot, readFailedCheckLogs: github.readFailedCheckLogs };
});

type Teams = typeof import("@/lib/coding-team");
type TeamView = import("@/lib/coding-team").TeamView;
let teams: Teams;

/** The runs the fake runner "spawns", and what each was started with. */
let runs: Map<string, Record<string, unknown>>;
let starts: Array<Record<string, unknown>>;
let seq: number;
/** Planner, worker and single runs take the scripted `outcomes` in the order they start; reviewers accept. */
let workerSeq: number;
let outcomes: Array<Partial<{ status: string; summary: string; error: string; filesTouched: string[]; writes: Record<string, string> }>>;
/** Each worker's view of the board as it started: its task's dependencies' status and verdict. */
let boardAtStart: Map<string, Array<{ task_id: string; status: string; verdict: string | null }>>;

const roleOf = (s: Record<string, unknown>) => (s.team as { role?: string } | null)?.role ?? "run";
const taskOf = (s: Record<string, unknown>) => (s.team as { taskId?: string | null } | null)?.taskId ?? null;
const plannerStarts = () => starts.filter((s) => roleOf(s) === "planner");
const workerStarts = () => starts.filter((s) => roleOf(s) === "worker");
const messages = (b: TeamView) => b.log.map((e) => e.message);
const alerts = (b: TeamView) => b.log.filter((e) => e.type === "alert").map((e) => e.message);

function fakeRun(input: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  const id = `run-${String(seq).padStart(8, "0")}`;
  const role = roleOf(input);
  const run = {
    id, task: input.task, directory: String(input.directory ?? project), projectId: null, source: input.source,
    status: "running", startedAt: Date.now(), completedAt: null, summary: null, error: null,
    filesTouched: [] as string[], permissionDenials: 0, deniedActions: [] as string[],
    team: input.team ?? null, readOnly: input.readOnly === true, extraBrief: input.extraBrief ?? null,
    outcomeAt: role === "reviewer" ? -1 : role === "lead" ? -2 : workerSeq++,
  };
  if (role === "worker") {
    const teamId = (input.team as { id: string }).id;
    boardAtStart.set(String(taskOf(input)), (teams.getTeam(teamId)?.tasks ?? []).map((t) => ({ task_id: t.task_id, status: t.status, verdict: t.review?.verdict ?? null })));
  }
  runs.set(id, run);
  starts.push(input);
  return run;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-team-blind-"));
  project = path.join(root, "Projects", "widgets");
  fs.mkdirSync(project, { recursive: true });
  runs = new Map();
  starts = [];
  seq = 0;
  workerSeq = 0;
  outcomes = [];
  boardAtStart = new Map();
  vi.resetModules();
  vi.clearAllMocks();
  plumbing.ensureTeamBranch.mockImplementation(async (_dir: string, teamId: string) => ({ ok: true, branch: `clawbox/${teamId}`, base: "main" }));
  plumbing.addWorkerWorktree.mockImplementation(async (dir: string, teamId: string, taskId: string, attempt: number) => ({ ok: true, path: `${dir}/.clawbox/worktrees/${taskId}-${attempt}`, branch: `clawbox/${teamId}-${taskId}-${attempt}` }));
  plumbing.mergeWorkerBranch.mockResolvedValue({ ok: true, merged: true });
  plumbing.removeWorktree.mockResolvedValue(undefined);
  plumbing.changedFiles.mockImplementation(async (_dir: string, branch: string) => committedOn(branch));
  plumbing.harvestWorktree.mockResolvedValue({ ok: true, files: [] });
  plumbing.committableFiles.mockImplementation(async (_wt: string, files: string[]) => files);
  runner.isCodingAgentEnabled.mockResolvedValue(true);
  runner.getTeamDynamic.mockResolvedValue(false);
  // The project is a real folder: what a run writes there is what the team finds.
  runner.resolveWorkingDirectory.mockImplementation(async () => ({ directory: project, projectId: null }));
  runner.teamRoleModelMap.mockImplementation(async () => {
    const role = { provider: "clawbox-ai" as const, model: null, effort: "high" as const, auto: true, ready: true, problems: [], relativeCost: null };
    return { planner: role, worker: role, reviewer: role };
  });
  runner.getMaxParallelRuns.mockResolvedValue(16);
  runner.suiteSandbox.mockResolvedValue({ bin: "/usr/bin/env", args: [], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root } });
  runner.startRun.mockImplementation(async (input: Record<string, unknown>) => fakeRun(input));
  runner.waitForRun.mockImplementation(async (id: string) => {
    const run = runs.get(id);
    if (!run || run.status !== "running") return run ?? null;
    const at = Number(run.outcomeAt);
    const outcome = at === -1
      ? { summary: JSON.stringify({ verdict: "accepted", notes: "" }) }
      : at === -2
        ? { summary: "{}" }
        : (outcomes[at] ?? { status: "completed", summary: "done" });
    Object.assign(run, { status: outcome.status ?? "completed", completedAt: Date.now() }, outcome);
    // What the run wrote, in its folder, as the settle finds it.
    for (const [file, content] of Object.entries((outcome as { writes?: Record<string, string> }).writes ?? {})) {
      const at = path.join(String(run.directory), file);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, content);
    }
    return run;
  });
  runner.getRun.mockImplementation((id: string) => runs.get(id) ?? null);
  runner.stopRun.mockImplementation((id: string) => {
    const run = runs.get(id);
    if (run) Object.assign(run, { status: "stopped", completedAt: Date.now() });
    return run;
  });
  const actualAgent = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  runner.teamSpawnSlot.mockImplementation(actualAgent.teamSpawnSlot);
  teams = await import("@/lib/coding-team");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** What the runner committed on a worker's branch: the files its run touched, else the files its task named. */
function committedOn(branch: string): string[] {
  const m = /^clawbox\/(team-[a-z0-9]{8})-(t\d+)-(\d+)$/.exec(branch);
  if (!m) return [];
  const [, teamId, taskId, attempt] = m;
  const run = [...runs.values()].find((r) => String(r.directory).endsWith(`/.clawbox/worktrees/${taskId}-${attempt}`));
  const touched = (run?.filesTouched as string[] | undefined) ?? [];
  if (touched.length) return touched;
  return teams.getTeam(teamId)?.tasks.find((t) => t.task_id === taskId)?.files_hint ?? [];
}

async function finished(id: string): Promise<TeamView> {
  const live = teams.getTeam(id);
  for (let i = 0; i < 2000 && !["done", "failed", "stopped"].includes(teams.getTeam(id)?.status ?? ""); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return teams.getTeam(id) ?? live!;
}

/** The values after one flag of an argv, up to the next flag. */
function flag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  }
  return out;
}

const GOAL = "Build the widget library: the alpha and beta modules, then wire them together.";
const MAP = (files: string[]) => ({ files, entry_points: [], test_commands: [], gotchas: [] });
type PlannedTask = { task_description: string; depends_on?: string[]; files_hint: string[] };
const answer = (files: string[], tasks: PlannedTask[]) => JSON.stringify({ repo_map: MAP(files), tasks });

const ALPHA = { task_description: "Write the alpha module", files_hint: ["src/alpha.ts"] };
const BETA = { task_description: "Write the beta module", files_hint: ["src/beta.ts"] };
/** The blind planner's hedge: a task naming every file the others own. */
const catchAll = (dependsOn: string[]): PlannedTask => ({ task_description: "Integrate everything", depends_on: dependsOn, files_hint: ["src/alpha.ts", "src/beta.ts"] });

/** The plan the failed team got: every repo-map entry "source not inspected", t3 the union of t1 and t2. */
const BLIND_PLAN = answer(
  ["src/alpha.ts — source not inspected", "src/beta.ts — source not inspected", "src/index.ts — source not inspected"],
  [ALPHA, BETA, catchAll(["t1", "t2"])],
);
/** The plan of a planner that read the project: three tasks, no file named twice. */
const READ_PLAN = answer(
  ["src/alpha.ts — the alpha module", "src/beta.ts — the beta module", "docs/usage.md — how to use both"],
  [ALPHA, BETA, { task_description: "Document how alpha and beta work together", depends_on: ["t1", "t2"], files_hint: ["docs/usage.md"] }],
);
const WORK = [
  { summary: "alpha done", filesTouched: ["src/alpha.ts"] },
  { summary: "beta done", filesTouched: ["src/beta.ts"] },
  { summary: "third task done", filesTouched: ["docs/usage.md"] },
];

describe("D1: the planner can read the project and cannot write", () => {
  it("starts read-only in the project folder itself, and its argv approves Read, Grep, Glob and read-only git — never Bash(*), Write or Edit — and denies push, commit and the kill list", async () => {
    outcomes = [{ summary: READ_PLAN }, ...WORK];
    const board = await teams.startTeam({ goal: GOAL, directory: "widgets", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");

    const [planner] = plannerStarts();
    expect(starts[0]).toBe(planner);
    expect(planner).toMatchObject({ readOnly: true, directory: project, team: { id: board.id, role: "planner", taskId: null } });
    // The project itself, not a worktree of it, and a fresh session.
    expect(planner).not.toHaveProperty("worktree");
    expect(planner.resumeRunId).toBeUndefined();
    expect(String(planner.directory)).not.toContain("/.clawbox/worktrees/");
    expect(plumbing.addWorkerWorktree.mock.invocationCallOrder[0]).toBeGreaterThan(runner.startRun.mock.invocationCallOrder[0]);

    // The argv the real runner would spawn this planner with.
    const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
    const args = actual.buildRunArgs({
      readOnly: planner.readOnly as boolean,
      extraBrief: planner.extraBrief as string,
      effort: (planner.effort ?? undefined) as import("@/lib/coding-agent").CodingEffort | undefined,
      run: { id: done.plannerRunId!, directory: String(planner.directory), team: planner.team as import("@/lib/coding-agent").RunTeam },
    });
    const tools = flag(args, "--tools").join(",").split(",");
    expect(tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Agent", "Bash"]));
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");

    const allowed = flag(args, "--allowedTools");
    expect(allowed).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git show:*)"]));
    expect(allowed).not.toContain("Bash(*)");
    expect(allowed).not.toContain("Write");
    expect(allowed).not.toContain("Edit");
    // Every command it is approved is read-only git; git branch only as exact listings, never by prefix.
    expect(allowed).not.toContain("Bash(git branch:*)");
    for (const rule of allowed.filter((a) => a.startsWith("Bash("))) {
      expect(rule).toMatch(/^Bash\(git (?:(log|status|diff|show|rev-parse|ls-files|blame|shortlog|describe):\*|branch(?: (-a|-r|--list|--show-current|-v|-vv))?)\)$/);
    }

    const denied = flag(args, "--disallowedTools");
    expect(denied).toEqual(expect.arrayContaining(["Bash(git push:*)", "Bash(git commit:*)", ...actual.BASH_KILL_DENYLIST, ...actual.TEAM_MERGE_DENYLIST]));
  });

  it("is told to say 'source not inspected' when it could not read the project", async () => {
    const { PLANNER_BRIEF } = await import("@/lib/coding-team-planner");
    expect(PLANNER_BRIEF).toContain("source not inspected");
    outcomes = [{ summary: READ_PLAN }, ...WORK];
    const board = await teams.startTeam({ goal: GOAL, directory: "widgets", source: "owner" });
    await finished(board.id);
    expect(String(plannerStarts()[0].extraBrief)).toContain("source not inspected");
  });
});

describe("D2: a blind plan is asked again, and a catch-all task never folds the team in silence", () => {
  it("(a) asks a blind planner once more in a fresh read-only run, and runs the clean second plan as a team: t1 and t2 first, t3 after them", async () => {
    outcomes = [{ summary: BLIND_PLAN }, { summary: READ_PLAN }, ...WORK];
    const board = await teams.startTeam({ goal: GOAL, directory: "widgets", source: "owner" });
    const done = await finished(board.id);

    expect(plannerStarts()).toHaveLength(2);
    const second = plannerStarts()[1];
    expect(second).toMatchObject({ readOnly: true, directory: project, team: { id: board.id, role: "planner", taskId: null } });
    expect(second.resumeRunId).toBeUndefined();
    expect(String(second.task)).toContain(GOAL);
    expect(messages(done)).toContain("The planner's plan was written without reading the project (its repo map says \"source not inspected\" (3 of 3 entries)); asking once more in a fresh read-only run.");
    expect(done.alerts).toBe(0);

    expect(done.status).toBe("done");
    expect(done.singleRun).toBe(false);
    expect(done.repoMap?.files).toEqual(["src/alpha.ts — the alpha module", "src/beta.ts — the beta module", "docs/usage.md — how to use both"]);
    expect(workerStarts().map(taskOf)).toEqual(["t1", "t2", "t3"]);
    // t3 started only once t1 and t2 were accepted.
    expect(boardAtStart.get("t3")?.filter((t) => t.task_id !== "t3")).toEqual([
      { task_id: "t1", status: "complete", verdict: "accepted" },
      { task_id: "t2", status: "complete", verdict: "accepted" },
    ]);
    expect(done.tasks.map((t) => [t.task_id, t.status, t.review?.verdict])).toEqual([
      ["t1", "complete", "accepted"],
      ["t2", "complete", "accepted"],
      ["t3", "complete", "accepted"],
    ]);
  });

  it("(b) records exactly one alert about the planner when the second plan is blind too, and the team still runs", async () => {
    outcomes = [
      { summary: BLIND_PLAN },
      { summary: BLIND_PLAN },
      ...WORK.slice(0, 2),
      { summary: "integrated", filesTouched: ["src/alpha.ts", "src/beta.ts"] },
    ];
    const board = await teams.startTeam({ goal: GOAL, directory: "widgets", source: "owner" });
    const done = await finished(board.id);

    expect(plannerStarts()).toHaveLength(2);
    expect(plannerStarts()[1].resumeRunId).toBeUndefined();
    expect(done.alerts).toBe(1);
    expect(alerts(done)).toHaveLength(1);
    expect(alerts(done)[0]).toMatch(/^ALERT: The planner planned without reading the project twice \(its repo map says "source not inspected" \(3 of 3 entries\)\); the plan stands with that caveat\.$/);

    expect(done.status).toBe("done");
    expect(done.singleRun).toBe(false);
    expect(workerStarts().map(taskOf)).toEqual(["t1", "t2", "t3"]);
    // The catch-all waits for both: the plan's integration step, and the board says so.
    expect(messages(done)).toContain("Task t3 names every file the other tasks own; it is the integration step and runs after them, so it is left out of the overlap measure and the team runs as planned.");
    expect(done.tasks.map((t) => t.status)).toEqual(["complete", "complete", "complete"]);
  });

  it("(c) runs as one run when the catch-all t3 does not wait for the others, and the note names t3 as the reason", async () => {
    outcomes = [
      { summary: answer(["src/alpha.ts — the alpha module", "src/beta.ts — the beta module"], [ALPHA, BETA, catchAll([])]) },
      { summary: "All three done.", writes: { "src/alpha.ts": "export const alpha = 1;\n", "src/beta.ts": "export const beta = 2;\n" } },
    ];
    const board = await teams.startTeam({ goal: GOAL, directory: "widgets", source: "owner" });
    const done = await finished(board.id);

    expect(plannerStarts()).toHaveLength(1);
    expect(done.singleRun).toBe(true);
    expect(starts.map(roleOf)).toEqual(["planner", "run"]);
    expect(done.advice).toMatchObject({ reason: "overlap", catchAll: ["t3"] });
    expect(done.advice!.overlap).toBeGreaterThanOrEqual(60);
    const note = messages(done).find((m) => /run as one ordinary run/.test(m));
    expect(note).toMatch(/^100% of the files this plan's tasks name are named by another task too \(Task t3 names every file the other tasks own, and it does not wait for all of them, so it is no integration step\): /);
    expect(done.status).toBe("done");
  });
});

describe("D3: a plan run as one run judges each task on the files it names", () => {
  /** Every task names the same two shared files, and one file of its own. */
  const SHARED_PLAN = answer(
    ["src/core.ts — the shared core", "src/types.ts — the shared types"],
    [
      { task_description: "Add the first widget", files_hint: ["src/core.ts", "src/types.ts", "notes/one.md"] },
      { task_description: "Add the second widget", depends_on: ["t1"], files_hint: ["src/core.ts", "src/types.ts", "notes/two.md"] },
      { task_description: "Add the third widget", depends_on: ["t2"], files_hint: ["src/core.ts", "src/types.ts", "notes/three.md"] },
    ],
  );
  const SHARED = { "src/core.ts": "export const core = true;\n", "src/types.ts": "export type Widget = string;\n" };

  it("rejects the task whose named file was never written, accepts the others, and fails the team naming the file", async () => {
    outcomes = [
      { summary: SHARED_PLAN },
      { summary: "All three widgets done.", writes: { ...SHARED, "notes/one.md": "one\n", "notes/three.md": "three\n" } },
    ];
    const board = await teams.startTeam({ goal: GOAL, directory: "widgets", source: "owner" });
    const done = await finished(board.id);

    expect(done.singleRun).toBe(true);
    expect(starts.map(roleOf)).toEqual(["planner", "run"]);
    expect(fs.existsSync(path.join(project, "notes", "two.md"))).toBe(false);
    const [t1, t2, t3] = done.tasks;
    expect(t1).toMatchObject({ status: "complete", review: { verdict: "accepted" } });
    expect(t3).toMatchObject({ status: "complete", review: { verdict: "accepted" } });
    expect(t2).toMatchObject({ status: "rejected", review: { verdict: "rejected", notes: expect.stringMatching(/^Deliverable missing: notes\/two\.md/) } });
    expect(t2.status).not.toBe("pending");
    expect(messages(done)).toContain("Task t2 rejected: Deliverable missing: notes/two.md (missing)");
    expect(done.status).toBe("failed");
    expect(done.error).toContain("notes/two.md");
  });

  it("accepts every task when every named file was written, and the team is done", async () => {
    outcomes = [
      { summary: SHARED_PLAN },
      { summary: "All three widgets done.", writes: { ...SHARED, "notes/one.md": "one\n", "notes/two.md": "two\n", "notes/three.md": "three\n" } },
    ];
    const board = await teams.startTeam({ goal: GOAL, directory: "widgets", source: "owner" });
    const done = await finished(board.id);

    expect(done.singleRun).toBe(true);
    expect(done.status).toBe("done");
    expect(done.error ?? null).toBeNull();
    expect(done.tasks.map((t) => [t.task_id, t.status, t.review?.verdict])).toEqual([
      ["t1", "complete", "accepted"],
      ["t2", "complete", "accepted"],
      ["t3", "complete", "accepted"],
    ]);
    expect(done.tasks.every((t) => /^Ran as a single run, and the files it names are present/.test(t.review?.notes ?? ""))).toBe(true);
  });
});
