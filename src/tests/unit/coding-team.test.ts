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
  suiteSandbox: vi.fn(),
  teamRoleModelMap: vi.fn(),
  getMaxParallelRuns: vi.fn(),
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
// Plugged in, unless a case unplugs it: the host's own charger is neither the
// fixture nor the same on every runner (a laptop on battery would serialise
// every team in this file).
const power = vi.hoisted(() => ({ onBattery: false }));
vi.mock("@/lib/coding-run-cpu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-run-cpu")>();
  return { ...actual, onBatteryPower: vi.fn(async () => power.onBattery) };
});
// The git plumbing, faked: a branch is "made", a worktree "added", a merge
// "done" — scripted per call so a conflict can be staged.
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
// GitHub, faked where the orchestrator reaches it: a team whose goal asks for
// a pull request opens, reads, pushes and merges through these. A team whose
// goal asks for none never calls them.
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
// The notices, mocked: ONE team notice per settle is what is under test, not
// the owner-notice ring or Telegram (coding-agent-notify.test.ts has those).
const notify = vi.hoisted(() => ({
  announceCodingAgent: vi.fn(async () => undefined),
  announceCodingTeam: vi.fn<(board: import("@/lib/coding-team-board").TeamBoard) => Promise<undefined>>(async () => undefined),
  announceAnthropicLimit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/coding-agent-notify", () => notify);
// The edition and the gateway link the settle's chat line goes over: an
// OpenClaw box unless a case says Hermes, and a gateway that takes the line.
const harness = vi.hoisted(() => ({ getActiveHarness: vi.fn(async () => "openclaw" as const) }));
vi.mock("@/lib/harness", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/harness")>()), ...harness }));
const gateway = vi.hoisted(() => ({ gatewayWsChatSendMain: vi.fn(async () => ({ sessionKey: "main" })) }));
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()), ...gateway }));
vi.mock("@/lib/coding-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-review")>();
  return { ...actual, pushBranch: github.pushBranch, readReviewSnapshot: github.readReviewSnapshot, readFailedCheckLogs: github.readFailedCheckLogs };
});

type Team = typeof import("@/lib/coding-team");
let team: Team;

type RoleModelMap = import("@/lib/coding-agent").TeamRoleModelMap;
type TokenBreakdown = import("@/lib/coding-agent").TokenBreakdown;
/**
 * What each role starts on, as `teamRoleModelMap` answers: every role on
 * ClawBox AI and ready — the box every case here ran on before there were
 * role models — unless a case says otherwise.
 */
function roleMap(over: { [R in keyof RoleModelMap]?: Partial<RoleModelMap[R]> } = {}): RoleModelMap {
  const base = { provider: "clawbox-ai" as const, model: null, effort: "high" as const, auto: true, ready: true, problems: [], relativeCost: null };
  const flash = { model: "deepseek-v4-flash", relativeCost: 1 };
  return {
    planner: { ...base, ...flash, ...over.planner },
    worker: { ...base, ...over.worker },
    reviewer: { ...base, ...flash, ...over.reviewer },
    bulk: { ...base, ...over.bulk },
  };
}

/** The runs the fake runner "spawns", settled by the test. */
let runs: Map<string, Record<string, unknown>>;
let starts: Array<Record<string, unknown>>;
let seq: number;
/** Worker/planner runs take the scripted `outcomes` in order; reviewer runs take `reviews`, accepting by default. */
let workerSeq: number;
let reviews: Array<{ summary?: string; status?: string; error?: string; tokensUsed?: number; tokenBreakdown?: TokenBreakdown }>;
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
let outcomes: Array<Partial<{ status: string; summary: string; resultText: string; error: string; filesTouched: string[]; permissionDenials: number; deniedActions: string[]; denials: Array<{ text: string; rule: string | null; refusal: null; worktreePath?: string; fullText?: string }>; worktreeHints: number; commitError: string | null; tokensUsed: number; tokenBreakdown: TokenBreakdown; model: string; modelsUsed: string[]; resumesAs: Record<string, unknown> }>>;

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
  power.onBattery = false;
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
  // The normal path: the runner committed the worker's work on its branch. A
  // case that stages an empty branch says so.
  plumbing.changedFiles.mockImplementation(async (_dir: string, branch: string) => committedOn(branch));
  plumbing.harvestWorktree.mockResolvedValue({ ok: true, files: [] });
  // Every file a worker says it wrote is still there and not ignored.
  plumbing.committableFiles.mockImplementation(async (_wt: string, files: string[]) => files);
  runner.isCodingAgentEnabled.mockResolvedValue(true);
  // The lead's switch: OFF, as on every box that never touched it.
  runner.getTeamDynamic.mockResolvedValue(false);
  runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/Projects/site", projectId: null });
  // Every role ready on the box's own provider: the host's readiness probe is not the fixture.
  runner.teamRoleModelMap.mockImplementation(async () => roleMap());
  // The owner's limit on runs at once: roomy, so a team's own shape is what bounds it, unless a case says otherwise.
  runner.getMaxParallelRuns.mockResolvedValue(16);
  // The project's own suite runs through `env` instead of `setpriv`, which a
  // test runner cannot use; only a case with a suite on disk ever asks.
  runner.suiteSandbox.mockResolvedValue({ bin: "/usr/bin/env", args: ["PYTHONDONTWRITEBYTECODE=1"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root } });
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

/**
 * What the runner committed on a worker's branch (`clawbox/<team>-<task>-<attempt>`):
 * the files its run touched, or — a worker that reported none — the files its
 * task named.
 */
function committedOn(branch: string): string[] {
  const m = /^clawbox\/(team-[a-z0-9]{8})-(t\d+)-(\d+)$/.exec(branch);
  if (!m) return [];
  const [, teamId, taskId, attempt] = m;
  const run = [...runs.values()].find((r) => String(r.directory).endsWith(`/.clawbox/worktrees/${taskId}-${attempt}`));
  const touched = (run?.filesTouched as string[] | undefined) ?? [];
  if (touched.length) return touched;
  return team.getTeam(teamId)?.tasks.find((t) => t.task_id === taskId)?.files_hint ?? [];
}

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
    // In the planner's own session, read-only as it was: the folder is read already.
    expect(planners[1]).toMatchObject({ readOnly: true, resumeRunId: "run-00000001" });
    expect(planners[1].directory).toBeUndefined();
    expect(String(planners[1].task)).toContain("was not a plan the team can read");
    expect(String(planners[1].task)).toContain("no array here");
    expect(String(planners[1].task)).toContain("ONLY the JSON plan");
    // On the record: one alert, two planner runs in the cast, the first still named.
    expect(done.alerts).toBe(1);
    expect(done.plannerRunId).toBe("run-00000001");
    expect(done.agents.planner).toBe(2);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)[0]).toMatch(/asking once more for the JSON plan \(attempt 2 of 3\)/);
  });

  it("asks in a fresh run when the planner's session cannot be continued, and says so on the log", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    const start = runner.startRun.getMockImplementation()!;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.resumeRunId) throw new CodingAgentError("invalid", "That run never started a Claude Code session, so it cannot be resumed. Start a new run instead.");
      return start(input);
    });
    outcomes = [{ summary: "prose" }, { summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const planners = starts.filter((s) => (s.team as { role: string }).role === "planner");
    expect(planners).toHaveLength(2);
    expect(planners[1]).toMatchObject({ readOnly: true, directory: "/home/clawbox/Projects/site" });
    expect(planners[1].resumeRunId).toBeUndefined();
    expect(String(planners[1].task)).toContain("was not a plan the team can read");
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^The planner's session \(run-00000001\) could not be continued \(That run never started a Claude Code session.*asking in a fresh run\.$/)]));
    expect(done.alerts).toBe(1);
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
    const { MAX_TASK_DESCRIPTION_CHARS } = await import("@/lib/coding-team-board");
    outcomes = [
      { summary: JSON.stringify({
        shape: { parallelism: 1, review: "final", rationale: `${"One page, then its script. ".repeat(8).slice(0, 204)}z` },
        tasks: [
          { task_description: "Scaffold index.html", files_hint: ["index.html"] },
          { task_description: prose(MAX_TASK_DESCRIPTION_CHARS + 313), depends_on: ["t1"], files_hint: ["app.js"] },
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
    expect(cut.length).toBeLessThanOrEqual(MAX_TASK_DESCRIPTION_CHARS);
    expect(cut.endsWith("renders.")).toBe(true);
    expect(done.shape!.rationale.length).toBeLessThanOrEqual(200);
    const notes = done.log.filter((e) => e.type === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ actor: { kind: "system" }, message: `The shape's rationale was cut from 205 to ${done.shape!.rationale.length} characters. Task t2's description was cut from ${MAX_TASK_DESCRIPTION_CHARS + 313} to ${cut.length} characters.` });
  });

  it("from the lead is cut too: the task is added, with a note and no alert", async () => {
    const { MAX_TASK_DESCRIPTION_CHARS } = await import("@/lib/coding-team-board");
    runner.getTeamDynamic.mockResolvedValue(true);
    // t1 rejected twice: t2 can never start, and the lead is called with the board broken.
    outcomes = [
      { summary: PLAN },
      { summary: "index", filesTouched: ["index.html"] },
      { summary: "index again", filesTouched: ["index.html"] },
      { summary: "favicon", filesTouched: ["favicon.ico"] },
    ];
    reviews = Array.from({ length: 2 }, () => ({ summary: JSON.stringify({ verdict: "rejected", notes: "No <title>." }) }));
    leadAnswers = [{ summary: JSON.stringify({ add: [{ task_description: prose(MAX_TASK_DESCRIPTION_CHARS + 110), files_hint: ["favicon.ico"] }], note: "a favicon needs no title" }) }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.tasks[2]).toMatchObject({ task_id: "t3", origin: "lead", status: "complete" });
    const cut = done.tasks[2].task_description;
    expect(cut.length).toBeLessThanOrEqual(MAX_TASK_DESCRIPTION_CHARS);
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([`Task t3's description was cut from ${MAX_TASK_DESCRIPTION_CHARS + 110} to ${cut.length} characters.`]);
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

/**
 * The bench, 2026-09-26: t1 wrote its two files in its worktree and nothing
 * reached its branch — no commit, and no commit error either. The empty
 * branch was merged, the task accepted by rule under review "final", and
 * three tasks built against a contract that was never there; the team failed
 * at the final review. And the bench again, the same evening: a read-only
 * final check whose hint named the four files it was to READ wrote nothing,
 * and was rejected NO CHANGE twice over — the team failed with every
 * deliverable verified on disk. What the worker's run WROTE decides, never
 * what its task names.
 */
describe("a worker whose branch came home empty", () => {
  const WORKTREE_T1 = "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1";
  const contractPlan = (review: string, t1Hint: string[] = ["api-contract.md", "items.json"]) => shaped({ parallelism: 2, review, rationale: "Contract first." }, JSON.stringify([
    { task_description: "Write api-contract.md and items.json", files_hint: t1Hint },
    { task_description: "Build server.py against the contract", depends_on: ["t1"], files_hint: ["server.py"] },
  ]));
  /** t1's first branch has nothing on it; every other branch has what the runner committed. */
  const emptyFirstBranch = (after: () => string[] = () => []) => plumbing.changedFiles.mockImplementation(async (_dir: string, branch: string) => (/-t1-1$/.test(branch) ? after() : committedOn(branch)));
  const logged = (done: Awaited<ReturnType<typeof finished>>, type: string) => done.log.filter((e) => e.type === type).map((e) => e.message);

  it.each([
    // Wrote both files through its shell: the runner saw none of them.
    ["through its shell", [] as string[]],
    // Wrote both with its file tools, and the runner's commit never came.
    ["with its file tools", ["api-contract.md", "items.json"]],
  ])("has what the worker left uncommitted (written %s) committed on its branch, with a note, and the task is merged and accepted", async (_how, touched) => {
    outcomes = [
      { summary: contractPlan("final") },
      { summary: "Done — both files delivered and verified.", filesTouched: touched },
      { summary: "server built", filesTouched: ["server.py"] },
    ];
    let harvested = false;
    emptyFirstBranch(() => (harvested ? ["api-contract.md", "items.json"] : []));
    plumbing.harvestWorktree.mockImplementation(async () => {
      harvested = true;
      return { ok: true, files: ["api-contract.md", "items.json"] };
    });
    const board = await team.startTeam({ goal: "API contract, then the server", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // Harvested in the worker's own worktree, in the runner's message shape.
    expect(plumbing.harvestWorktree).toHaveBeenCalledTimes(1);
    const [where, message] = plumbing.harvestWorktree.mock.calls[0] as [string, string];
    expect(where).toBe(WORKTREE_T1);
    expect(message).toMatch(/^Coding agent: Your task \(t1 of 2\)/);
    expect(message).toContain("Done — both files delivered and verified.");
    expect(message).toContain("Run: run-00000002");
    expect(logged(done, "note")).toContainEqual("Committed 2 uncommitted file(s) the worker left behind (run-00000002): api-contract.md, items.json");
    // A note, never an alert — and the branch that now has them is merged:
    // a branch with a diff is never asked what the worker wrote.
    expect(done.alerts).toBe(0);
    expect(plumbing.committableFiles).not.toHaveBeenCalled();
    expect(JSON.stringify(done.log)).not.toMatch(/NO CHANGE|changed no files/);
    expect(plumbing.mergeWorkerBranch.mock.calls.map((c) => c[1])).toContain(`clawbox/${board.id}-t1-1`);
    expect(done.tasks[0]).toMatchObject({ status: "complete", attempts: 1, rejections: 0 });
    expect(done.finalReview).toMatchObject({ verdict: "accepted" });
  });

  it.each(["final", "none", "each"])("is rejected NO CHANGE under review %s when its run wrote a file in its worktree, the worktree is clean and the branch empty — one alert, offered once more, never accepted by rule", async (review) => {
    outcomes = [
      { summary: contractPlan(review) },
      { summary: "Done — the contract is written.", filesTouched: ["api-contract.md"] },
      { summary: "Both files written and committed.", filesTouched: ["api-contract.md", "items.json"] },
      { summary: "server built", filesTouched: ["server.py"] },
    ];
    emptyFirstBranch();
    const board = await team.startTeam({ goal: "API contract, then the server", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // The harvest looked first, and found nothing; what the run wrote is still there for git to take.
    expect(plumbing.harvestWorktree).toHaveBeenCalledWith(WORKTREE_T1, expect.stringMatching(/^Coding agent: /));
    expect(plumbing.committableFiles).toHaveBeenCalledWith(WORKTREE_T1, ["api-contract.md"]);
    const t1Reviews = done.log.filter((e) => e.type === "review").map((e) => e.message);
    expect(t1Reviews[0]).toMatch(/rejected/);
    expect(t1Reviews[0]).toContain(team.NO_CHANGE);
    expect(t1Reviews[0]).not.toMatch(/Accepted by rule/);
    expect(logged(done, "alert")).toEqual(["ALERT: No change from t1 (run-00000002): its branch has no commit, though the worker wrote api-contract.md"]);
    expect(done.alerts).toBe(1);
    expect(JSON.stringify(done.log)).not.toContain("changed no files");
    // Never merged, its worktree given back, and offered once more with the reason.
    expect(plumbing.mergeWorkerBranch.mock.calls.map((c) => c[1])).not.toContain(`clawbox/${board.id}-t1-1`);
    expect(plumbing.removeWorktree).toHaveBeenCalledWith("/home/clawbox/Projects/site", WORKTREE_T1);
    expect(done.tasks[0]).toMatchObject({ status: "complete", attempts: 2, rejections: 1 });
    const retry = starts.find((s) => role(s) === "worker" && String(s.task).includes("A previous attempt was rejected"));
    expect(String(retry?.task)).toContain(`A previous attempt was rejected: ${team.NO_CHANGE}`);
  });

  it("is rejected NO CHANGE too when the task named no file but the worker says it wrote some in its worktree", async () => {
    outcomes = [
      { summary: contractPlan("final", []) },
      { summary: "Wrote the contract.", filesTouched: ["api-contract.md", "../elsewhere.txt", "__pycache__/x.pyc"] },
      { summary: "Wrote the contract, committed.", filesTouched: ["api-contract.md"] },
      { summary: "server built", filesTouched: ["server.py"] },
    ];
    emptyFirstBranch();
    const board = await team.startTeam({ goal: "API contract, then the server", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(logged(done, "alert")).toEqual(["ALERT: No change from t1 (run-00000002): its branch has no commit, though the worker wrote api-contract.md"]);
    expect(done.tasks[0]).toMatchObject({ attempts: 2, rejections: 1 });
    expect(plumbing.committableFiles).toHaveBeenCalledWith(WORKTREE_T1, ["api-contract.md"]);
  });

  const NOTHING_CHANGED = "t1 changed no files (run-00000002): its branch is empty and its run wrote nothing git could commit.";

  it.each(["final", "none", "each"])("accepts under review %s a check-only worker whose hint names the files it READS: nothing written, nothing on its branch — a note, no alert, no retry", async (review) => {
    outcomes = [
      { summary: contractPlan(review) },
      { summary: "## Final review: both artifacts PASS. No defects found. No file was rewritten.", filesTouched: [] },
      { summary: "server built", filesTouched: ["server.py"] },
    ];
    emptyFirstBranch();
    const board = await team.startTeam({ goal: "API contract, then the server", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.tasks[0].files_hint).toEqual(["api-contract.md", "items.json"]);
    expect(done.tasks[0]).toMatchObject({ status: "complete", attempts: 1, rejections: 0 });
    // The harvest still looked; with nothing written there is nothing to ask git about.
    expect(plumbing.harvestWorktree).toHaveBeenCalledWith(WORKTREE_T1, expect.stringMatching(/^Coding agent: /));
    expect(plumbing.committableFiles).not.toHaveBeenCalled();
    expect(plumbing.mergeWorkerBranch.mock.calls.map((c) => c[1])).toContain(`clawbox/${board.id}-t1-1`);
    expect(done.alerts).toBe(0);
    expect(logged(done, "alert")).toEqual([]);
    expect(logged(done, "note")).toContainEqual(NOTHING_CHANGED);
    expect(JSON.stringify(done.log)).not.toContain("NO CHANGE");
    expect(starts.filter((s) => role(s) === "worker")).toHaveLength(2);
  });

  it("accepts a check-only task whose written files git could never have taken — a scratch file it deleted, a log the project ignores", async () => {
    outcomes = [
      { summary: contractPlan("final", []) },
      { summary: "End-to-end check passed.", filesTouched: ["e2e_check.py", "e2e.log"] },
      { summary: "server built", filesTouched: ["server.py"] },
    ];
    emptyFirstBranch();
    plumbing.committableFiles.mockResolvedValueOnce([]);
    const board = await team.startTeam({ goal: "API contract, then the server", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(plumbing.committableFiles).toHaveBeenCalledWith(WORKTREE_T1, ["e2e_check.py", "e2e.log"]);
    expect(done.tasks[0]).toMatchObject({ status: "complete", attempts: 1, rejections: 0 });
    expect(done.alerts).toBe(0);
    expect(logged(done, "note")).toContainEqual(NOTHING_CHANGED);
    expect(JSON.stringify(done.log)).not.toContain("NO CHANGE");
  });

  it("keeps today's verdict for a task that only checks something: no hint, nothing touched, no diff — accepted, with a note", async () => {
    outcomes = [
      { summary: contractPlan("final", []) },
      { summary: "Checked: the site builds and every page loads.", filesTouched: [] },
      { summary: "server built", filesTouched: ["server.py"] },
    ];
    emptyFirstBranch();
    const board = await team.startTeam({ goal: "API contract, then the server", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.tasks[0]).toMatchObject({ status: "complete", attempts: 1, rejections: 0 });
    expect(done.tasks[0].review?.notes).toMatch(/Accepted by rule; the team's final review checks the merged result/);
    expect(done.alerts).toBe(0);
    expect(logged(done, "note")).toEqual([NOTHING_CHANGED]);
    expect(JSON.stringify(done.log)).not.toContain("NO CHANGE");
  });

  it("is rejected NOT COMMITTED when the harvest itself could not commit — the files are not lost silently", async () => {
    outcomes = [
      { summary: contractPlan("final") },
      { summary: "Done — both files delivered and verified.", filesTouched: [] },
      { summary: "Both files written and committed.", filesTouched: ["api-contract.md", "items.json"] },
      { summary: "server built", filesTouched: ["server.py"] },
    ];
    emptyFirstBranch();
    plumbing.harvestWorktree.mockResolvedValueOnce({ ok: false, detail: "Committing the files the worker left uncommitted failed: fatal: Unable to create index.lock" });
    const board = await team.startTeam({ goal: "API contract, then the server", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const t1Reviews = done.log.filter((e) => e.type === "review").map((e) => e.message);
    expect(t1Reviews[0]).toMatch(/rejected.*NOT COMMITTED: Committing the files the worker left uncommitted failed.*could not be committed/);
    expect(logged(done, "alert")).toEqual([expect.stringMatching(/^ALERT: Commit failed for t1 \(run-00000002\): Committing the files/)]);
    expect(plumbing.mergeWorkerBranch.mock.calls.map((c) => c[1])).not.toContain(`clawbox/${board.id}-t1-1`);
    expect(done.tasks[0]).toMatchObject({ attempts: 2, rejections: 1 });
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

describe("dependency gating: a dependent starts only on an ACCEPTED dependency", () => {
  it("does not dispatch a dependent while its dependency's reviewer is still reading it — and builds it on the accepted redo", async () => {
    // Seen live (2026-10-10): t2 finished while t1's reviewer was still at
    // work, the loop woke, found t1 "complete" and started t3 on it — and the
    // reviewer then rejected t1. t3 had been built on work that did not stand.
    outcomes = [
      { summary: JSON.stringify([
        { task_description: "Scaffold index.html", files_hint: ["index.html"] },
        { task_description: "Write styles.css", files_hint: ["styles.css"] },
        { task_description: "Wire app.js", depends_on: ["t1"], files_hint: ["app.js"] },
      ]) },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "index redone", filesTouched: ["index.html"] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    // t1's reviewer is slow — HELD for a poll — and rejects; every later review accepts.
    reviews = [
      { status: "paused", resumesAs: { summary: JSON.stringify({ verdict: "rejected", notes: "The form does not submit." }) } } as (typeof reviews)[number],
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("done");
    const order = done.log.map((e) => e.message);
    const accepted = order.findIndex((m) => m.startsWith("Task t1 accepted"));
    const t3Assigned = order.findIndex((m) => /^Task t3 assigned/.test(m));
    expect(order.findIndex((m) => m.startsWith("Task t1 rejected"))).toBeGreaterThan(-1);
    // t3 was handed out only after t1's redo was accepted — exactly once.
    expect(accepted).toBeGreaterThan(-1);
    expect(t3Assigned).toBeGreaterThan(accepted);
    expect(done.tasks.find((t) => t.task_id === "t3")).toMatchObject({ status: "complete", attempts: 1, holds: 0 });
    expect(starts.filter((s) => (s.team as { role: string; taskId: string }).role === "worker").map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t2", "t1", "t3"]);
  });

  it("holds a finished dependent the suite did not point at when its dependency is sent back, and runs it again on the new merged state", async () => {
    const dir = path.join(root, "site");
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    const MODULE = "FACTORS = {('mi', 'km'): 1.609344}\n\ndef convert(value, src, dst):\n    return round(value * FACTORS[(src, dst)], 6)\n";
    const FIXED = "FACTORS = {('mi', 'km'): 1.609344, ('km', 'mi'): 1 / 1.609344}\n\ndef convert(value, src, dst):\n    return round(value * FACTORS[(src, dst)], 6)\n";
    fs.writeFileSync(path.join(dir, "convert.py"), MODULE);
    fs.writeFileSync(path.join(dir, "tests/test_convert.py"), "import unittest\nfrom convert import convert\n\nclass TestConvert(unittest.TestCase):\n    def test_km_to_mi(self):\n        self.assertEqual(convert(1.609344, 'km', 'mi'), 1.0)\n");
    runner.resolveWorkingDirectory.mockResolvedValue({ directory: dir, projectId: null });
    outcomes = [
      { summary: shaped({ parallelism: 1, review: "each", rationale: "" }, JSON.stringify([
        { task_description: "Write the converter, convert.py", files_hint: ["convert.py"] },
        { task_description: "Document it in README.md", depends_on: ["t1"], files_hint: ["README.md"] },
      ])) },
      { summary: "Wrote convert.py.", filesTouched: ["convert.py"] },
      { summary: "Wrote the README.", filesTouched: ["README.md"] },
      { summary: "Added km → mi.", filesTouched: ["convert.py"] },
      { summary: "README checked against the new pairs.", filesTouched: ["README.md"] },
    ];
    let t1Workers = 0;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      const who = input.team as { role: string; taskId: string | null };
      if (who.role === "worker" && who.taskId === "t1" && ++t1Workers === 2) fs.writeFileSync(path.join(dir, "convert.py"), FIXED);
      return fakeRun(input);
    });
    const board = await team.startTeam({ goal: "A unit converter", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("done");
    // The traceback named convert.py: t1 went back as the suite's suspect, and
    // t2 — accepted, but built on the t1 that was sent back — was HELD: set
    // back without a rejection, its try not spent, and run again after t1.
    expect(done.tasks.map((t) => [t.task_id, t.status, t.attempts, t.rejections, t.holds])).toEqual([["t1", "complete", 2, 1, 0], ["t2", "complete", 2, 0, 1]]);
    const hold = done.log.find((e) => e.type === "hold");
    expect(hold).toMatchObject({ actor: { kind: "system" }, task_id: "t2" });
    expect(hold!.message).toMatch(/^Task t2 held: its dependency t1 was reopened \(rejected — The project's own tests fail on the merged result.*\)\. Its result is set aside; it starts again on the new merged state once t1 is accepted\.$/);
    const workers = starts.filter((s) => (s.team as { role: string }).role === "worker");
    expect(workers.map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t2", "t1", "t2"]);
    expect(String(workers[3].task)).toContain("This task was done before on top of t1, which has since been reopened");
    expect(String(workers[3].task)).toContain("What that attempt merged is already in the files");
    // A hold is not a guardrail: no alert.
    expect(done.alerts).toBe(0);
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
    // A worker settles on its sixth wait, so two of them overlap: every worker
    // asks the spawn slot first (the box is shared), and that look is long
    // enough for a worker settling on its third to be gone already.
    waitsBeforeSettle = 6;
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
    // t1's reviewer answers prose twice — the first answer and the one re-ask
    // (TASK-1323) — so t2's reviewer is the sixth run, not the fifth.
    reviews = [{ summary: "Looks fine to me!" }, { summary: "Still fine by me." }, { status: "failed", error: "boom" }];
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
      expect.stringMatching(/reviewer of t2 \(run-00000006\) ended failed/),
    ]);
    expect(done.alerts).toBe(2);
  });
});

/**
 * Bench, 2026-09-30: three "answer holds no JSON object" alerts in one bench
 * — the reviewers had reviewed, only their closing words lacked the object.
 * Such an answer is asked for once more in the reviewer's own session; only a
 * second miss is the alert, and it quotes how that answer began.
 */
describe("a reviewer that answered without a JSON verdict (TASK-1323)", () => {
  const reviewerStarts = () => starts.filter((s) => (s.team as { role: string }).role === "reviewer");

  it("is asked once more in its own session, with the short nudge, and its second answer is the verdict — a note, no alert", async () => {
    const { SHELL_REVIEWER_BRIEF, REVIEWER_NUDGE } = await import("@/lib/coding-team-reviewer");
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    reviews = [
      { summary: "I read index.html against the task.\n\nIt has the heading and the form the task asked for, and nothing else changed. Accepting." },
      { summary: JSON.stringify({ verdict: "accepted", notes: "Heading and form are there." }) },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // The first answer's reviewer, its re-ask, then t2's reviewer: ONE re-ask.
    expect(reviewerStarts().map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t1", "t2"]);
    // In the reviewer's own session — the shell one, in its checkout: not read-only, the same brief.
    expect(starts[3]).toEqual({
      task: REVIEWER_NUDGE,
      resumeRunId: "run-00000003",
      source: "owner",
      team: { id: board.id, role: "reviewer", taskId: "t1" },
      extraBrief: SHELL_REVIEWER_BRIEF,
    });
    expect(REVIEWER_NUDGE).toContain("Answer with the JSON verdict object only, nothing else");
    expect(done.tasks[0].review).toMatchObject({ verdict: "accepted", notes: "Heading and form are there." });
    // The card's reviewer link stays on the run that did the review.
    expect(done.tasks[0].reviewRunId).toBe("run-00000003");
    expect(done.runs.filter((r) => r.role === "reviewer").map((r) => [r.id, r.taskId])).toEqual([["run-00000003", "t1"], ["run-00000004", "t1"], ["run-00000006", "t2"]]);
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => e.type === "alert")).toEqual([]);
    const notes = done.log.filter((e) => e.type === "note");
    expect(notes).toEqual([expect.objectContaining({
      task_id: "t1",
      message: 'The reviewer of t1 answered without a JSON verdict; asking it once more for the verdict alone. It answered: "I read index.html against the task. It has the heading and the form the task asked for, and nothing else changed. Accepting."',
    })]);
  });

  it("raises the alert only after a second answer without the object, quoting how that answer began", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    const second = `I already gave my verdict above: the work is fine.\n${"The task is done as asked and nothing beside it broke. ".repeat(8)}`;
    reviews = [{ summary: "Reviewed; all good." }, { summary: second }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(reviewerStarts().map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t1", "t2"]);
    expect(done.tasks[0].review).toMatchObject({ verdict: "accepted", notes: "Accepted by rule: The reviewer's answer holds no JSON object." });
    const head = second.replace(/\s+/g, " ").slice(0, 199);
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts).toEqual([`ALERT: The reviewer of t1 gave no verdict: asked twice, it answered no JSON object — "${head}…"`]);
    expect(done.alerts).toBe(1);
  });

  it("says why when the re-ask itself does not finish, and never asks a third time", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    reviews = [{ summary: "" }, { status: "failed", error: "boom" }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(reviewerStarts()).toHaveLength(3);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([
      "ALERT: The reviewer of t1 gave no verdict: The reviewer answered nothing. Asked once more, it (run-00000004) ended failed.",
    ]);
    expect(done.tasks[0].review?.notes).toBe("Accepted by rule: The reviewer answered nothing.");
  });

  it("quotes the first answer in the alert when the re-ask does not finish — after what became of the re-ask, so the board's cut takes only the quote's tail", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    const first = `I read index.html against the task.\n\n${"The heading and the form are there, as the task asked. ".repeat(6)}`;
    reviews = [{ summary: first }, { status: "failed", error: "boom" }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(reviewerStarts()).toHaveLength(3);
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^ALERT: The reviewer of t1 gave no verdict: The reviewer's answer holds no JSON object\. Asked once more, it \(run-00000004\) ended failed\. It had answered: "I read index\.html against the task\. The heading and the form are there, as the task asked\. /);
    // One line of 300 characters on the board: the quote is what gives way.
    expect(alerts[0]).toHaveLength("ALERT: ".length + 300);
    expect(alerts[0].endsWith("…")).toBe(true);
    expect(done.tasks[0].review?.notes).toBe("Accepted by rule: The reviewer's answer holds no JSON object.");
    expect(done.alerts).toBe(1);
  });

  it("quotes the first answer in the alert when the re-ask could not start", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    reviews = [{ summary: "Reviewed; all good." }];
    let t1Asks = 0;
    runner.teamSpawnSlot.mockImplementation(async (who: { role: string; taskId: string | null }) => {
      if (who.role === "reviewer" && who.taskId === "t1" && ++t1Asks === 2) return { ok: false, wait: false, reason: "The coding agent is switched off." };
      return { ok: true };
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // The review ran; its re-ask never did; t2's reviewer is next.
    expect(reviewerStarts().map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t2"]);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([
      'ALERT: The reviewer of t1 gave no verdict: The reviewer\'s answer holds no JSON object. Asked once more, it could not start: The coding agent is switched off. It had answered: "Reviewed; all good."',
    ]);
    expect(done.tasks[0].review?.notes).toBe("Accepted by rule: The reviewer's answer holds no JSON object.");
  });

  it("reads a fenced ```json block after prose at once — no re-ask, no note", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    reviews = [{ summary: 'Checked index.html on a 5" phone width and the "Send" button.\n\n```json\n{"verdict": "accepted", "notes": "One nit: spacing."}\n```' }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(reviewerStarts()).toHaveLength(2);
    expect(done.tasks[0].review).toMatchObject({ verdict: "accepted", notes: "One nit: spacing." });
    expect(done.log.filter((e) => e.type === "note" || e.type === "alert")).toEqual([]);
  });

  it("does not re-ask an answer whose object is there but wrong: that is what the reviewer said", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    reviews = [{ summary: '{"verdict": "maybe", "notes": "not sure"}' }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(reviewerStarts()).toHaveLength(2);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([
      'ALERT: The reviewer of t1 gave no verdict: The reviewer\'s verdict is not accepted or rejected ("maybe").',
    ]);
  });
});

/**
 * A team refused outright beside ANY live run that was not its own — the
 * automatic review pass the box starts after every run among them — died at
 * its first second, while single runs went side by side up to the owner's
 * limit. A team shares the box now: a full box is a wait the orchestrator
 * sits out, for its planner as for its workers, and the board says so.
 */
describe("a team that shares the box", () => {
  const FULL = "This ClawBox is already starting or running 2 coding runs at once, which is all it allows; the team waits for a free slot.";
  const roleOf = (s: Record<string, unknown>) => (s.team as { role: string } | null)?.role ?? "run";
  /** The board, polled until `ready` holds for it — up to ten seconds. */
  async function boardWhen(id: string, ready: (b: NonNullable<ReturnType<Team["getTeam"]>>) => boolean) {
    for (let i = 0; i < 1000; i++) {
      const b = team.getTeam(id);
      if (b && ready(b)) return b;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the board never got there");
  }

  it("starts beside a live run that is not the team's, and every reviewer starts too — no refusal, no alert", async () => {
    // A single run going on the box, as the real spawn slot reads the runs file.
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([{
      id: "run-stranger", task: "the owner's own run", directory: "/home/clawbox/Projects/other", projectId: null, source: "owner",
      status: "running", startedAt: Date.now() - 60_000, completedAt: null, sessionId: null, model: null, summary: null, error: null,
      progress: [], filesTouched: [], commands: [], permissionDenials: [], numTurns: 0, tokensUsed: 0, team: null,
    }]));
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.map(roleOf)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
    expect(done.alerts).toBe(0);
    expect(done.tasks.every((t) => !/Accepted by rule/.test(t.review?.notes ?? ""))).toBe(true);
  });

  it("waits for a free slot for its planner — on the look and on the spawn — instead of failing, and says so on the board", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    let looks = 0;
    runner.teamSpawnSlot.mockImplementation(async (who: { role: string }) => (who.role === "planner" && ++looks === 1 ? { ok: false, wait: true, reason: FULL } : { ok: true }));
    // The look admits it the second time; the spawn then loses a race for the slot until the box frees one.
    let free = false;
    let refusedSpawns = 0;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      if (roleOf(input) === "planner" && !free) {
        refusedSpawns += 1;
        throw new CodingAgentError("busy", FULL, true);
      }
      return fakeRun(input);
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    // While it waits: planning, not failed — the wait on the board and in its log.
    const waiting = await boardWhen(board.id, () => refusedSpawns >= 1);
    expect(waiting.status).toBe("planning");
    expect(waiting.error).toBeNull();
    expect(waiting.slotWaits).toEqual([{ role: "planner", taskId: null, reason: FULL, since: expect.any(Number) }]);
    free = true;
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(looks).toBeGreaterThanOrEqual(3);
    expect(starts.filter((s) => roleOf(s) === "planner")).toHaveLength(1);
    // One note for the one wait, however many looks it took; no alert; nothing left waiting.
    expect(done.log.filter((e) => e.type === "note" && /Waiting for a free slot on the box before the planner starts/.test(e.message))).toHaveLength(1);
    expect(done.alerts).toBe(0);
    expect(done.slotWaits).toBeUndefined();
  });

  it("stops cleanly while its planner waits: stopped, no planner run, nothing failed", async () => {
    runner.teamSpawnSlot.mockResolvedValue({ ok: false, wait: true, reason: FULL });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    await boardWhen(board.id, (b) => (b.slotWaits ?? []).length > 0);
    team.stopTeam(board.id);
    const done = await finished(board.id);
    expect(done.status).toBe("stopped");
    expect(starts).toHaveLength(0);
    expect(done.slotWaits).toBeUndefined();
  });

  it("keeps no more tasks in flight than the owner's limit: a settled worker's reviewer keeps its seat, and each worker's CPU share is that limit", async () => {
    // Three independent tasks, a team shaped for three, a box set to two at once.
    runner.getMaxParallelRuns.mockResolvedValue(2);
    waitsBeforeSettle = 6;
    outcomes = [
      { summary: shaped({ parallelism: 3, review: "each", rationale: "" }, JSON.stringify([
        { task_description: "Scaffold index.html", files_hint: ["index.html"] },
        { task_description: "Write styles.css", files_hint: ["styles.css"] },
        { task_description: "Write about.html", files_hint: ["about.html"] },
      ])) },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "about done", filesTouched: ["about.html"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // The planner was told the box's width, the shape line says it, and the
    // task left waiting for a seat is said on the board — not stuck in silence.
    expect(String(starts[0].extraBrief)).toContain("This box runs at most 2 of the team's runs at once");
    expect(done.log.find((e) => e.type === "shape")?.message).toBe("Team shaped: 3 side by side (the box allows 2 at once), review each");
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toContain("Waiting for a free slot on the box before the worker of t3 starts: the box allows 2 runs at once (Settings); t3 starts when a task finishes its review");
    expect(done.slotWaits).toBeUndefined();
    const workers = starts.filter((s) => roleOf(s) === "worker");
    expect(workers).toHaveLength(3);
    // Sized for the two that can go together, not the three the shape asked for.
    expect(workers.map((w) => w.cpuShare)).toEqual([2, 2, 2]);
    // Two side by side, never a third worker beside them.
    const live = Object.entries(liveWorkersAtStart).filter(([id]) => roleOf(runs.get(id)!) === "worker").map(([, n]) => n);
    expect(Math.max(...live)).toBe(1);
    // The third task's worker went only once a task left — after its review, not into its reviewer's seat.
    const order = starts.map((s) => `${roleOf(s)}:${(s.team as { taskId: string | null }).taskId}`);
    expect(order.indexOf("worker:t3")).toBeGreaterThan(Math.min(order.indexOf("reviewer:t1"), order.indexOf("reviewer:t2")));
  });

  it("keeps a wait's moving reason on the live board without rewriting the board file on every look", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    // The memory guard's figure moves on each look, as MemAvailable does.
    let looks = 0;
    const tight = (n: number) => `Not enough free memory for another run beside the 1 going (${900 + n} MB free, 1200 MB needed).`;
    let free = false;
    runner.teamSpawnSlot.mockImplementation(async (who: { role: string }) => {
      if (who.role !== "planner" || free) return { ok: true };
      looks += 1;
      return { ok: false, wait: true, reason: tight(looks) };
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const file = path.join(root, "data", "coding-team", `${board.id}.json`);
    const live = await boardWhen(board.id, () => looks >= 3);
    // The live board — what coding_team_status reads for a team at work — has the latest reason…
    expect(live.slotWaits?.[0].reason).toBe(tight(looks));
    // …and the file, written once when the wait began, still has the first.
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { slotWaits?: Array<{ reason: string }> };
    expect(onDisk.slotWaits?.map((w) => w.reason)).toEqual([tight(1)]);
    free = true;
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.log.filter((e) => e.type === "note" && /before the planner starts/.test(e.message))).toHaveLength(1);
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as { slotWaits?: unknown }).slotWaits).toBeUndefined();
  });

  it("makes its FIRST worker wait for room too, and puts a worker the spawn refused for room back unstarted — no alert, no failed task", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    let t1Looks = 0;
    runner.teamSpawnSlot.mockImplementation(async (who: { role: string; taskId: string | null }) => (who.role === "worker" && who.taskId === "t1" && ++t1Looks === 1 ? { ok: false, wait: true, reason: FULL } : { ok: true }));
    let t1Spawns = 0;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      const who = input.team as { role: string; taskId: string | null };
      if (who.role === "worker" && who.taskId === "t1" && ++t1Spawns === 1) throw new CodingAgentError("busy", FULL, true);
      return fakeRun(input);
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // Looked at before the first worker (refused, then admitted twice: before the refused spawn and the one that ran).
    expect(t1Looks).toBe(3);
    expect(t1Spawns).toBe(2);
    expect(starts.map(roleOf)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
    // The refused spawn's worktree went back with its branch, so the next attempt is made afresh.
    expect(plumbing.removeWorktree).toHaveBeenCalledWith("/home/clawbox/Projects/site", "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1", { dropBranch: expect.stringMatching(/-t1-1$/) });
    expect(done.tasks.map((t) => [t.status, t.attempts])).toEqual([["complete", 1], ["complete", 1]]);
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => e.type === "note" && /before the worker of t1 starts/.test(e.message)).length).toBeGreaterThanOrEqual(1);
    expect(done.slotWaits).toBeUndefined();
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
      ? { ok: false, wait: false, reason: "The coding agent is switched off." }
      : { ok: true });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.error).toBeNull();
    expect(done.alerts).toBe(4);
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts.filter((m) => /No reviewer for t\d: The coding agent is switched off\./.test(m))).toHaveLength(3);
    // Asked once each: a refusal that is not a wait is not waited on.
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
    // (with a shell, in a throwaway checkout of the team's branch) rules on
    // the merged work.
    expect(done.branch).toBe(`clawbox/${board.id}`);
    expect(done.base).toBe("master");
    expect(starts).toHaveLength(5);
    expect(starts[1]).toMatchObject({ team: { role: "worker", taskId: "t1" }, directory: `/home/clawbox/Projects/site/.clawbox/worktrees/t1-1`, projectId: null });
    expect(String(starts[1].task)).toContain("Your task (t1 of 2): Scaffold index.html");
    expect(String(starts[1].task)).toContain("Team goal: Build the invoice app");
    // Its own folder named, so the hint's paths are read there and not in the project.
    expect(String(starts[1].task)).toContain("Your folder: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1");
    expect(starts[2]).toMatchObject({ team: { role: "reviewer", taskId: "t1" }, directory: "/home/clawbox/Projects/site/.clawbox/worktrees/review-t1-1", projectId: null });
    expect(starts[2].readOnly).toBeUndefined();
    expect(String(starts[2].task)).toContain("Review task t1: Scaffold index.html");
    expect(String(starts[2].task)).toContain("Built index.html; open it.");
    expect(String(starts[2].task)).toContain(`Your folder: /home/clawbox/Projects/site/.clawbox/worktrees/review-t1-1 — a throwaway checkout of the team's branch clawbox/${board.id}, forked from master. The project itself is at /home/clawbox/Projects/site;`);
    expect(String(starts[2].extraBrief)).toContain("ONLY a JSON object");
    expect(String(starts[2].extraBrief)).toContain("with a shell");
    expect(starts[3]).toMatchObject({ team: { role: "worker", taskId: "t2" }, directory: `/home/clawbox/Projects/site/.clawbox/worktrees/t2-1` });
    // The board's digest, not a quote of finished results: every other task, one line each.
    expect(String(starts[3].task)).toContain("The team's board — every other task, then the latest alerts and messages:\nt1 [complete] — Scaffold index.html → Built index.html; open it.");
    expect(String(starts[3].task)).not.toContain("t2 [");
    expect(String(starts[3].extraBrief)).toContain("ONE WORKER");
    expect(starts[1].readOnly).toBeUndefined();
    expect(plumbing.mergeWorkerBranch).toHaveBeenCalledTimes(2);
    // Two workers' worktrees and two reviewers' checkouts, each removed; the reviewer's with its branch.
    expect(plumbing.addWorkerWorktree).toHaveBeenCalledWith("/home/clawbox/Projects/site", board.id, "review-t1", 1);
    expect(plumbing.removeWorktree).toHaveBeenCalledTimes(4);
    expect(plumbing.removeWorktree).toHaveBeenCalledWith("/home/clawbox/Projects/site", "/home/clawbox/Projects/site/.clawbox/worktrees/review-t1-1", { dropBranch: `clawbox/${board.id}-review-t1-1` });

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

  // 20 of 28 live rejections were strays — a test, a helper, the CLAUDE.md
  // the goal asked for — of merged, correct work, and three teams died on the
  // alert ceiling for them: a stray is a note the reviewer reads, never a
  // rejection by rule or an alert.
  it("rejects a refused worker once and only NOTES its strays — the reviewer is told of them, and none counts toward MAX_ALERTS", async () => {
    outcomes = [
      // One worker at a time: the order of the alerts is the order of the tasks.
      { summary: shaped({ parallelism: 1, review: "each", rationale: "" }, PARALLEL_PLAN) },
      // t1: strayed AND refused → the refusal rejects it (uncounted), the stray is a note.
      { summary: "did stuff", filesTouched: ["index.html", "secrets.env"], permissionDenials: 1, deniedActions: ["Bash: curl x"] },
      // t1 again: refused again → rejected for good; t3 waits on it and never runs.
      { summary: "did more", filesTouched: ["index.html", "secrets.env"], permissionDenials: 2, deniedActions: ["Bash: sudo", "Bash: rm"] },
      // t2 strays only: a note, and its reviewer judges the file.
      { summary: "styles done", filesTouched: ["styles.css", "secrets.env"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Tasks t1 failed; t3 (waiting on t1, rejected) never ran.");
    // Two on the record, both refusals — rejections, not the team failing — and no stray among them.
    expect(done.alerts).toBe(2);
    const alerts = done.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts[0]).toMatch(/refused 1 action\(s\): Bash: curl x/);
    expect(alerts[1]).toMatch(/refused 2 action/);
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([
      "Worker run-00000002 touched files outside its task's hint: secrets.env — the reviewer judges whether they belong to the task.",
      "Worker run-00000003 touched files outside its task's hint: secrets.env — the reviewer judges whether they belong to the task.",
      "Worker run-00000004 touched files outside its task's hint: secrets.env — the reviewer judges whether they belong to the task.",
    ]);
    const t1 = done.tasks[0];
    expect(t1.attempts).toBe(2);
    expect(t1.review).toMatchObject({ verdict: "rejected", notes: "The worker was refused an action; the task is offered once more." });
    expect(String(starts[2].task)).toContain("A previous attempt was rejected");
    // t2 went to its reviewer, told which file lay outside the hint, and was accepted.
    const reviewer = starts.find((s) => role(s) === "reviewer" && (s.team as { taskId: string | null }).taskId === "t2");
    expect(String(reviewer?.task)).toContain("Files outside the task's hint");
    expect(String(reviewer?.task)).toContain("- secrets.env");
    expect(done.tasks[1]).toMatchObject({ status: "complete", attempts: 1, rejections: 0, review: { verdict: "accepted" } });
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

  it("keeps the read-only words for a refused read of /tmp — it is not a write", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "index done", filesTouched: ["index.html"], permissionDenials: 1, deniedActions: ["Bash: cat /tmp/notes.txt"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.alerts).toBe(0);
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([
      "Worker run-00000002 was refused 1 read-only action(s) outside its folder: Bash: cat /tmp/notes.txt",
    ]);
    // Only the words change: the outcome is the note's, as before.
    expect(done.metrics).toMatchObject({ readOnlyRefusals: 1, tasksRejected: 0 });
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

  // Night validation, 2026-09-23: every miss had one shape — a worker in its
  // worktree read or wrote `<project>/<file>`, was refused, and the rule
  // failed the task with every deliverable on disk. The runner now answers
  // such a refusal with a retry hint at the worktree path and marks it.
  describe("a refusal the runner answered with a retry hint at the worktree", () => {
    const P = "/home/clawbox/Projects/site";
    const W1 = `${P}/.clawbox/worktrees/t1-1`;
    const W2 = `${P}/.clawbox/worktrees/t2-1`;
    const hinted = (text: string, worktreePath: string) => ({ text, rule: null, refusal: null, worktreePath });
    const plain = (text: string) => ({ text, rule: null, refusal: null });

    it("is a note — reads and writes alike, every one counted past the kept few — and the task goes to its reviewer clean", async () => {
      const t1 = [
        hinted(`Read: ${P}/index.html`, `${W1}/index.html`),
        hinted(`Write: ${P}/index.html`, `${W1}/index.html`),
        hinted(`Glob: ${P}`, W1),
        hinted(`Edit: ${P}/index.html`, `${W1}/index.html`),
        hinted(`Read: ${P}/app.js`, `${W1}/app.js`),
      ];
      const t2 = [plain("Write: /tmp/check.py"), hinted(`Write: ${P}/app.js`, `${W2}/app.js`)];
      outcomes = [
        { summary: PLAN },
        // Seven refusals, five kept — and the runner counted all seven as hinted.
        { summary: "index done", filesTouched: ["index.html"], permissionDenials: 7, worktreeHints: 7, deniedActions: t1.map((d) => d.text), denials: t1 },
        { summary: "app done", filesTouched: ["app.js"], permissionDenials: 2, worktreeHints: 1, deniedActions: t2.map((d) => d.text), denials: t2 },
      ];
      const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
      const done = await finished(board.id);
      expect(done.status).toBe("done");
      expect(done.alerts).toBe(0);
      expect(done.log.filter((e) => e.type === "alert")).toEqual([]);
      expect(done.log.filter((e) => e.type === "note").map((e) => [e.actor.kind, e.task_id, e.message])).toEqual([
        ["system", "t1", `Worker run-00000002 was refused 7 action(s) that changed nothing — 7 aimed at the project instead of its worktree, each answered with a retry hint at the worktree path: Read: ${P}/index.html → ${W1}/index.html; Write: ${P}/index.html → ${W1}/index.html; Glob: ${P} → ${W1}`],
        ["system", "t2", `Worker run-00000004 was refused 2 action(s) that changed nothing — 1 aimed at the project instead of its worktree, each answered with a retry hint at the worktree path; the rest reads, or writes outside its folder: Write: /tmp/check.py; Write: ${P}/app.js → ${W2}/app.js`],
      ]);
      // Reviewed and accepted on the first attempt: nothing redone, nothing rejected by the rule.
      expect(starts.map((s) => (s.team as { role: string }).role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
      expect(done.tasks.map((t) => [t.status, t.attempts, t.rejections, t.review?.verdict])).toEqual([["complete", 1, 0, "accepted"], ["complete", 1, 0, "accepted"]]);
      expect(done.metrics).toMatchObject({ readOnlyRefusals: 9, tasksRejected: 0, tasksAcceptedFirstTry: 2 });
    });

    it("does not clear a refused write inside the worktree beside it: the alert and the rejection stay", async () => {
      const t1 = [hinted(`Write: ${P}/index.html`, `${W1}/index.html`), plain(`Write: ${W1}/index.html`)];
      outcomes = [
        { summary: PLAN },
        { summary: "index done", filesTouched: ["index.html"], permissionDenials: 2, worktreeHints: 1, deniedActions: t1.map((d) => d.text), denials: t1 },
        { summary: "index done", filesTouched: ["index.html"] },
        { summary: "app done", filesTouched: ["app.js"] },
      ];
      const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
      const done = await finished(board.id);
      expect(done.status).toBe("done");
      expect(done.alerts).toBe(1);
      // The refusal that decided it is named first.
      expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([
        `ALERT: Worker run-00000002 was refused 2 action(s): Write: ${W1}/index.html; Write: ${P}/index.html`,
      ]);
      expect(done.log.filter((e) => e.type === "note")).toEqual([]);
      expect(done.tasks[0]).toMatchObject({ status: "complete", attempts: 2, rejections: 1 });
      expect(starts.map((s) => (s.team as { role: string }).role)).toEqual(["planner", "worker", "worker", "reviewer", "worker", "reviewer"]);
    });

    it("keeps the alert when a refusal the run did not keep was not among the hinted ones", async () => {
      const t1 = [1, 2, 3, 4, 5].map((i) => hinted(`Read: ${P}/f${i}.html`, `${W1}/f${i}.html`));
      outcomes = [
        { summary: PLAN },
        // Seven refusals, five kept and hinted — the two not kept may have been writes.
        { summary: "index done", filesTouched: ["index.html"], permissionDenials: 7, worktreeHints: 5, deniedActions: t1.map((d) => d.text), denials: t1 },
        { summary: "index done", filesTouched: ["index.html"] },
        { summary: "app done", filesTouched: ["app.js"] },
      ];
      const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
      const done = await finished(board.id);
      expect(done.alerts).toBe(1);
      expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)[0]).toMatch(/Worker run-00000002 was refused 7 action\(s\)/);
      expect(done.log.filter((e) => e.type === "note")).toEqual([]);
      expect(done.tasks[0]).toMatchObject({ attempts: 2, rejections: 1 });
    });

    // A refused READ outside the project changed nothing, wherever it looked
    // — the harness's state included: a note, like any other look.
    it("softens a refused look into the harness's own state like any read: a note and a clean task, hinted refusals beside it or not", async () => {
      const t1 = [plain(`Read: /home/clawbox/.claude-ds/projects/-home-clawbox-Projects-site/sess-1.jsonl`), hinted(`Read: ${P}/index.html`, `${W1}/index.html`)];
      outcomes = [
        { summary: PLAN },
        { summary: "index done", filesTouched: ["index.html"], permissionDenials: 2, worktreeHints: 1, deniedActions: t1.map((d) => d.text), denials: t1 },
        // Through the shell: read-only, and still only a look at the harness's state.
        { summary: "app done", filesTouched: ["app.js"], permissionDenials: 1, deniedActions: ["Bash: cat ~/.claude/projects/-home-clawbox-Projects-site/memory/MEMORY.md"] },
      ];
      const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
      const done = await finished(board.id);
      expect(done.status).toBe("done");
      expect(done.alerts).toBe(0);
      expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([
        `Worker run-00000002 was refused 2 action(s) that changed nothing — 1 aimed at the project instead of its worktree, each answered with a retry hint at the worktree path; the rest read-only outside its folder: Read: /home/clawbox/.claude-ds/projects/-home-clawbox-Projects-site/sess-1.jsonl; Read: ${P}/index.html → ${W1}/index.html`,
        "Worker run-00000004 was refused 1 read-only action(s) outside its folder: Bash: cat ~/.claude/projects/-home-clawbox-Projects-site/memory/MEMORY.md",
      ]);
      expect(done.tasks.map((t) => [t.status, t.attempts, t.rejections, t.review?.verdict])).toEqual([["complete", 1, 0, "accepted"], ["complete", 1, 0, "accepted"]]);
      expect(done.metrics.readOnlyRefusals).toBe(3);
    });
  });

  // Bench, 2026-09-26: the harness tells a run its memory is under
  // `<state>/projects/<its folder>/`, the sandbox refuses the look, and the
  // alert rejected verified work — most of the night's second attempts.
  describe("a refused look into the run's own corner of the harness's state", () => {
    const P = "/home/clawbox/Projects/site";
    // Where a ClawBox AI run's harness keeps its state (harnessStateDir), whatever the host running this says.
    const STATE = path.join(os.homedir(), ".claude-ds");
    const slug = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");
    beforeEach(() => { vi.stubEnv("CLAUDE_DS_CONFIG_DIR", ""); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it("is a note — a listing of its project's folder, a read of its memory, from the project or its worktree — and the task stays clean", async () => {
      outcomes = [
        { summary: PLAN },
        { summary: "index done", filesTouched: ["index.html"], permissionDenials: 2, deniedActions: [`Bash: ls -la ${STATE}/projects/${slug(P)}`, `Read: ${STATE}/projects/${slug(P)}/memory/MEMORY.md`] },
        { summary: "app done", filesTouched: ["app.js"], permissionDenials: 1, deniedActions: [`Bash: ls ${STATE}/projects/${slug(`${P}/.clawbox/worktrees/t2-1`)}/memory/ 2>/dev/null || echo none`] },
      ];
      const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
      const done = await finished(board.id);
      expect(done.status).toBe("done");
      expect(done.alerts).toBe(0);
      expect(done.log.filter((e) => e.type === "note").map((e) => [e.task_id, e.message])).toEqual([
        ["t1", `Worker run-00000002 was refused 2 read-only action(s) outside its folder: Bash: ls -la ${STATE}/projects/${slug(P)}; Read: ${STATE}/projects/${slug(P)}/memory/MEMORY.md`],
        ["t2", `Worker run-00000004 was refused 1 read-only action(s) outside its folder: Bash: ls ${STATE}/projects/${slug(`${P}/.clawbox/worktrees/t2-1`)}/memory/ 2>/dev/null || echo none`],
      ]);
      expect(starts.map((s) => (s.team as { role: string }).role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
      expect(done.tasks.map((t) => [t.status, t.attempts, t.rejections, t.review?.verdict])).toEqual([["complete", 1, 0, "accepted"], ["complete", 1, 0, "accepted"]]);
      expect(done.metrics).toMatchObject({ readOnlyRefusals: 3, tasksRejected: 0, tasksAcceptedFirstTry: 2 });
    });

    it("is a note beside another project's state too — a look changed nothing — while a write to the harness's settings stays an alert", async () => {
      outcomes = [
        { summary: PLAN },
        // Its own memory, and another project's: both only looked.
        { summary: "index done", filesTouched: ["index.html"], permissionDenials: 2, deniedActions: [`Read: ${STATE}/projects/${slug(P)}/memory/MEMORY.md`, `Bash: ls ${STATE}/projects/-home-clawbox-Projects-other/memory`] },
        // A write outside every folder — but into the harness's own settings.
        { summary: "app done", filesTouched: ["app.js"], permissionDenials: 1, deniedActions: [`Write: ${STATE}/settings.json`] },
        { summary: "app done", filesTouched: ["app.js"] },
      ];
      const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
      const done = await finished(board.id);
      expect(done.status).toBe("done");
      expect(done.alerts).toBe(1);
      expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([
        `ALERT: Worker run-00000004 was refused 1 action(s): Write: ${STATE}/settings.json`,
      ]);
      expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([
        `Worker run-00000002 was refused 2 read-only action(s) outside its folder: Read: ${STATE}/projects/${slug(P)}/memory/MEMORY.md; Bash: ls ${STATE}/projects/-home-clawbox-Projects-other/memory`,
      ]);
      expect(done.tasks.map((t) => [t.status, t.attempts, t.rejections])).toEqual([["complete", 1, 0], ["complete", 2, 1]]);
      expect(done.metrics.readOnlyRefusals).toBe(2);
    });

    it("is a note for another session's transcript beside its own: a look there changed nothing either", async () => {
      outcomes = [
        { summary: PLAN },
        { summary: "index done", filesTouched: ["index.html"], permissionDenials: 1, deniedActions: [`Read: ${STATE}/projects/${slug(P)}/sess-someone-else.jsonl`] },
        { summary: "app done", filesTouched: ["app.js"] },
      ];
      const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
      const done = await finished(board.id);
      expect(done.alerts).toBe(0);
      expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([
        `Worker run-00000002 was refused 1 read-only action(s) outside its folder: Read: ${STATE}/projects/${slug(P)}/sess-someone-else.jsonl`,
      ]);
      expect(done.tasks[0]).toMatchObject({ status: "complete", attempts: 1, rejections: 0 });
    });
  });

  // Bench, 2026-09-26: a read-only probe of several statements ran past the
  // runner's display cut, and its length alone made it an alert.
  it("judges a long refused probe by its whole text: all of it only looks, a note — a record with only the cut, an alert as before", async () => {
    const P = "/home/clawbox/Projects/site";
    const probe = `Bash: M="$CLAWBOX_RUN_ARTIFACTS_DIR/mutation"; P=${P}; ls -la "$M" 2>/dev/null; head -40 "$P/index.html"; grep -n app.js "$P/index.html"; git -C "$P" status --short; diff "$P/index.html" "$M/index.html"`;
    const cut = probe.slice(0, 160);
    expect(probe.length).toBeGreaterThan(160);
    outcomes = [
      { summary: PLAN },
      { summary: "index done", filesTouched: ["index.html"], permissionDenials: 1, deniedActions: [cut], denials: [{ text: cut, fullText: probe, rule: null, refusal: null }] },
      // The same probe on a record that kept only the cut: past it, anything.
      { summary: "app done", filesTouched: ["app.js"], permissionDenials: 1, deniedActions: [cut] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // Named by the cut the owner reads.
    expect(done.log.filter((e) => e.type === "note").map((e) => [e.task_id, e.message])).toEqual([
      ["t1", `Worker run-00000002 was refused 1 read-only action(s) outside its folder: ${cut}`],
    ]);
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([`ALERT: Worker run-00000004 was refused 1 action(s): ${cut}`]);
    expect(done.tasks.map((t) => [t.task_id, t.attempts, t.rejections, t.review?.verdict])).toEqual([["t1", 1, 0, "accepted"], ["t2", 2, 1, "accepted"]]);
  });

  // Bench, 2026-09-26: a verifier wrote a page to try something, removed it,
  // committed nothing — and the file it had removed counted as straying.
  it("judges what the worker left: a file it removed before it settled is not a stray — one it left, or a deletion its branch carries, still is", async () => {
    const P = path.join(root, "site");
    runner.resolveWorkingDirectory.mockResolvedValue({ directory: P, projectId: null });
    // Each worktree on disk as its worker left it.
    const left: Record<string, string[]> = { "t1-1": ["index.html"], "t2-1": ["app.js", "notes.md"] };
    plumbing.addWorkerWorktree.mockImplementation(async (dir: string, teamId: string, taskId: string, attempt: number) => {
      const wt = path.join(dir, ".clawbox", "worktrees", `${taskId}-${attempt}`);
      fs.mkdirSync(wt, { recursive: true });
      for (const f of left[`${taskId}-${attempt}`] ?? []) fs.writeFileSync(path.join(wt, f), "x");
      return { ok: true, path: wt, branch: `clawbox/${teamId}-${taskId}-${attempt}` };
    });
    // A branch that came home empty is harvested first (TASK-1237): what the
    // worker left in its worktree goes on its branch, and only that.
    const harvested: Record<string, string[]> = {};
    plumbing.harvestWorktree.mockImplementation(async (wt: string) => {
      const key = path.basename(wt);
      harvested[key] = (left[key] ?? []).filter((f) => fs.existsSync(path.join(wt, f)));
      return { ok: true, files: harvested[key] };
    });
    // t1's first branch deleted a stylesheet the task was not given: that merges.
    plumbing.changedFiles.mockImplementation(async (_dir: string, branch: string) => {
      if (branch.endsWith("-t1-1")) return ["index.html", "old.css"];
      const key = Object.keys(harvested).find((k) => branch.endsWith(`-${k}`));
      return key ? harvested[key] : [];
    });
    outcomes = [
      { summary: PLAN },
      // Its check page is gone from the worktree; its branch deleted a stylesheet.
      { summary: "index done", filesTouched: ["index.html", "check.html"] },
      // Committed nothing, and left its notes behind: harvested, and the notes a stray.
      { summary: "app done", filesTouched: ["app.js", "notes.md"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // A stray is a note the reviewer reads, never an alert or a rejection.
    expect(done.log.filter((e) => e.type === "alert")).toEqual([]);
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([
      "Worker run-00000002 touched files outside its task's hint: old.css — the reviewer judges whether they belong to the task.",
      "Committed 2 uncommitted file(s) the worker left behind (run-00000004): app.js, notes.md",
      "Worker run-00000004 touched files outside its task's hint: notes.md — the reviewer judges whether they belong to the task.",
    ]);
    expect(starts.map(role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
    expect(String(starts[4].task)).toContain("Files outside the task's hint");
    expect(String(starts[4].task)).toContain("- notes.md");
    expect(done.tasks.map((t) => [t.task_id, t.status, t.attempts, t.rejections, t.review?.verdict])).toEqual([["t1", "complete", 1, 0, "accepted"], ["t2", "complete", 1, 0, "accepted"]]);
  });

  it("fails the team when a worker fails and its dependants can never run, naming both", async () => {
    outcomes = [{ summary: PLAN }, { status: "failed", error: "Stopped at the cost ceiling" }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "agent" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Tasks t1 failed; t2 (waiting on t1, failed) never ran.");
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

describe("the settle notice", () => {
  it("tells the owner ONCE when the team is done, and the assistant's chat on OpenClaw — a fixed line, never the error", async () => {
    outcomes = [{ summary: PLAN }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    await vi.waitFor(() => expect(notify.announceCodingTeam).toHaveBeenCalledTimes(1));
    expect(notify.announceCodingTeam.mock.calls[0][0]).toMatchObject({ id: board.id, status: "done", branch: `clawbox/${board.id}` });
    await vi.waitFor(() => expect(gateway.gatewayWsChatSendMain).toHaveBeenCalledTimes(1));
    const [line, opts] = gateway.gatewayWsChatSendMain.mock.calls[0] as unknown as [string, { idempotencyKey: string; timeoutMs: number }];
    expect(line).toBe(`[Coding team ${board.id}] finished: done — 2 of 2 tasks done, on branch clawbox/${board.id}. Read coding_team_status for the result and tell the user.`);
    expect(opts.timeoutMs).toBe(team.OWNER_AGENT_TIMEOUT_MS);
    expect(opts.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("says a failed team failed — the counts, not the reason — and a Hermes box gets no chat line", async () => {
    harness.getActiveHarness.mockResolvedValue("hermes" as never);
    outcomes = [{ summary: PLAN }, { status: "failed", error: "Stopped at the cost ceiling" }];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "agent" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    await vi.waitFor(() => expect(notify.announceCodingTeam).toHaveBeenCalledTimes(1));
    expect(notify.announceCodingTeam.mock.calls[0][0]).toMatchObject({ id: board.id, status: "failed" });
    // The chat line is OpenClaw's: Hermes gives the box no way into its chat.
    await new Promise((r) => setTimeout(r, 20));
    expect(gateway.gatewayWsChatSendMain).not.toHaveBeenCalled();
    harness.getActiveHarness.mockResolvedValue("openclaw" as never);
  });

  it("waits for the team with waitForTeam — at once when told not to wait, and answered settled once it is", async () => {
    outcomes = [{ summary: PLAN }];
    let release: () => void = () => {};
    runner.waitForRun.mockImplementation(async (id: string) => {
      const run = runs.get(id)!;
      if (id === "run-00000001") { Object.assign(run, { status: "completed", summary: PLAN }); return run; }
      await new Promise<void>((r) => { release = r; });
      Object.assign(run, { status: "completed", completedAt: Date.now(), summary: "done" });
      return run;
    });
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    for (let i = 0; i < 100 && !runs.has("run-00000002"); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await team.waitForTeam(board.id, 0))?.status).toBe("working");
    const waiting = team.waitForTeam(board.id, 5_000);
    release();
    // The worker, then its reviewer, then the next task: every run after the first is let go as it comes.
    const letGo = setInterval(() => release(), 5);
    try {
      const settled = await waiting;
      expect(settled?.status).toBe("done");
    } finally {
      clearInterval(letGo);
    }
    expect(await team.waitForTeam("team-nope0000", 1)).toBeNull();
  });
});

describe("the gates", () => {
  it("refuses while the switch is off and an empty goal, and QUEUES a second team at once", async () => {
    runner.isCodingAgentEnabled.mockResolvedValueOnce(false);
    await expect(team.startTeam({ goal: "g", source: "agent" })).rejects.toMatchObject({ kind: "disabled" });
    await expect(team.startTeam({ goal: "   ", source: "agent" })).rejects.toMatchObject({ kind: "invalid" });
    // One in flight: the planner never settles until we say so.
    let release: () => void = () => {};
    runner.waitForRun.mockImplementationOnce(() => new Promise((r) => { release = () => r(runs.get("run-00000001")); }));
    const first = await team.startTeam({ goal: "g", source: "agent" });
    expect(team.activeTeamId()).toBe(first.id);
    const second = await team.startTeam({ goal: "another", source: "agent" });
    expect(second).toMatchObject({ status: "queued", queuePosition: 1 });
    expect(team.activeTeamId()).toBe(first.id);
    // Taken out again by the owner, so this case goes on as it always did.
    expect(team.cancelQueuedTeam(second.id).status).toBe("stopped");
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
    // The owner hears of the stop once, as a team notice.
    await vi.waitFor(() => expect(notify.announceCodingTeam).toHaveBeenCalledTimes(1));
    expect(notify.announceCodingTeam.mock.calls[0][0]).toMatchObject({ id: board.id, status: "stopped" });
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
  // Bench, 2026-09-22/23: a worker in a worktree read its hinted styles.css at
  // `<project>/styles.css`, was refused, and the refusal failed the task.
  it("names a worker's worktree as its ONLY folder, before the files, and gives the files as absolute paths in it — nothing in place", async () => {
    const { createBoard, postTask } = await import("@/lib/coding-team-board");
    const board = createBoard({ goal: "Build the site", projectId: null, directory: "/home/clawbox/Projects/site", source: "owner" }, { kind: "owner" });
    const task = postTask(board, { kind: "planner" }, { task_description: "Write styles.css", files_hint: ["styles.css", "./assets/", "/home/clawbox/Projects/site/index.html"] });
    const folder = "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1";
    const text = team.workerTask(board, task, folder);
    // The task line stays first: it is the run's commit subject.
    expect(text.split("\n")[0]).toBe("Your task (t1 of 1): Write styles.css");
    expect(text).toContain(`Your folder: ${folder} — your own working copy of the project, and the ONLY folder you work in.`);
    expect(text).toContain(`Files this task is expected to touch: ${folder}/styles.css, ${folder}/assets/, ${folder}/index.html`);
    expect(text.indexOf("Your folder:")).toBeLessThan(text.indexOf("Files this task is expected to touch:"));
    // The project itself is never named to the worker: every mention of it is its worktree's.
    expect(text.split(folder).join("")).not.toContain("/home/clawbox/Projects/site");
    // The board keeps the hint as the planner wrote it — what outsideHint matches against.
    expect(task.files_hint).toEqual(["styles.css", "./assets/", "/home/clawbox/Projects/site/index.html"]);
    // In place, the project IS the worker's folder: no folder line, the hint as written.
    for (const inPlace of [team.workerTask(board, task), team.workerTask(board, task, board.directory)]) {
      expect(inPlace).not.toContain("Your folder:");
      expect(inPlace).toContain("Files this task is expected to touch: styles.css, ./assets/, /home/clawbox/Projects/site/index.html");
    }
  });

  it("says every project path a worker in a worktree reads in its own folder: the goal, its task, a rejection, the board and a sibling's worktree", async () => {
    const { createBoard, postTask, assignTask, updateStatus, submitResult, reviewTask } = await import("@/lib/coding-team-board");
    const project = "/home/clawbox/Projects/site";
    const board = createBoard({ goal: `Build the site in ${project}. Keep ${project}/README.md as is; ${project}-old is another project.`, projectId: null, directory: project, source: "owner" }, { kind: "owner" });
    const t1 = postTask(board, { kind: "planner" }, { task_description: `Scaffold ${project}/index.html` });
    const t2 = postTask(board, { kind: "planner" }, { task_description: `Style ${project}/index.html with ${project}/styles.css`, files_hint: ["styles.css"] });
    // t1 finished in ITS worktree and said so; the reviewer of t2's first attempt pointed at the project.
    assignTask(board, { kind: "system" }, t1.task_id, "run-aaaaaaaa");
    updateStatus(board, { kind: "worker", id: "run-aaaaaaaa" }, t1.task_id, "in_progress");
    submitResult(board, { kind: "worker", id: "run-aaaaaaaa" }, t1.task_id, `Wrote ${project}/.clawbox/worktrees/t1-1/index.html.`);
    updateStatus(board, { kind: "worker", id: "run-aaaaaaaa" }, t1.task_id, "complete");
    assignTask(board, { kind: "system" }, t2.task_id, "run-bbbbbbbb");
    updateStatus(board, { kind: "worker", id: "run-bbbbbbbb" }, t2.task_id, "in_progress");
    updateStatus(board, { kind: "worker", id: "run-bbbbbbbb" }, t2.task_id, "complete");
    reviewTask(board, { kind: "reviewer" }, t2.task_id, "rejected", `${project}/styles.css is empty.`);
    const row = board.tasks.find((t) => t.task_id === t2.task_id)!;
    const folder = `${project}/.clawbox/worktrees/t2-2`;
    const text = team.workerTask(board, row, folder);
    expect(text.split("\n")[0]).toBe(`Your task (t2 of 2): Style ${folder}/index.html with ${folder}/styles.css`);
    expect(text).toContain(`Team goal: Build the site in ${folder}. Keep ${folder}/README.md as is; ${project}-old is another project.`);
    expect(text).toContain(`A previous attempt was rejected: ${folder}/styles.css is empty.`);
    // The sibling's worktree is gone once merged: its file is in this worker's own copy.
    expect(text).toContain(`t1 [complete] — Scaffold ${folder}/index.html → Wrote ${folder}/index.html.`);
    // Nothing of the project's path is left but the worker's own folder — and the OTHER project's name.
    expect(text.split(folder).join("").split(`${project}-old`).join("")).not.toContain(project);
  });

  it("gives the reviewer its own checkout's paths for what a worker wrote in its worktree, gone by the time it reads", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "Built /home/clawbox/Projects/site/.clawbox/worktrees/t1-1/index.html; open it.", filesTouched: ["index.html"] },
      { summary: "Wired app.js.", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "g", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const reviewer = starts.find((s) => (s.team as { role: string }).role === "reviewer")!;
    const folder = "/home/clawbox/Projects/site/.clawbox/worktrees/review-t1-1";
    expect(reviewer.directory).toBe(folder);
    expect(String(reviewer.task)).toContain(`Built ${folder}/index.html; open it.`);
    expect(String(reviewer.task)).not.toContain("worktrees/t1-1");
    // The project's own path is named once: where its node_modules are.
    expect(String(reviewer.task).split("/home/clawbox/Projects/site/").length - 1).toBe(String(reviewer.task).split(folder).length - 1 + 1);
  });

  it("keeps the worker's folder, files hint, rejection and teammates when the goal is long: the goal is cut, down to its floor, never them", async () => {
    const { createBoard, postTask, MAX_GOAL_CHARS, MAX_TASK_DESCRIPTION_CHARS } = await import("@/lib/coding-team-board");
    const { TEAM_TASK_CHARS, MAX_TASK_CHARS } = await import("@/lib/coding-agent");
    // A goal at the limit a team accepts, and a task at ITS limit: past the typed cap by themselves.
    const board = createBoard({ goal: "g".repeat(MAX_GOAL_CHARS), projectId: null, directory: "/home/clawbox/Projects/site", source: "owner" }, { kind: "owner" });
    const task = postTask(board, { kind: "planner" }, { task_description: "d".repeat(MAX_TASK_DESCRIPTION_CHARS), files_hint: ["styles.css"] });
    const sibling = postTask(board, { kind: "planner" }, { task_description: "Wire app.js", files_hint: ["app.js"] });
    Object.assign(sibling, { status: "in_progress", assigned_to: "run-bbbbbbbb" });
    Object.assign(task, { attempts: 1, review: { verdict: "rejected", notes: `Missing: ${"n".repeat(1_900)}`, at: 1 } });
    const text = team.workerTask(board, task, "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1");
    expect(text.length).toBeGreaterThan(MAX_TASK_CHARS);
    expect(text.length).toBeLessThanOrEqual(TEAM_TASK_CHARS);
    expect(text).toContain("Your folder: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1");
    expect(text).toContain("Files this task is expected to touch: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1/styles.css");
    expect(text).toContain(`A previous attempt was rejected: Missing: ${"n".repeat(1_900)}`);
    expect(text).toContain("- run-bbbbbbbb on t2: Wire app.js");
    // The goal gave way — to no less than its floor.
    expect(text).toMatch(/Team goal: g{799,}…\n/);
    expect(text).not.toContain("g".repeat(MAX_GOAL_CHARS));
    // Room to spare: the whole goal, and the rest still there.
    const short = postTask(board, { kind: "planner" }, { task_description: "Add the footer", files_hint: ["footer.css"] });
    const whole = team.workerTask(board, short, "/home/clawbox/Projects/site/.clawbox/worktrees/t3-1");
    expect(whole).toContain(`Team goal: ${"g".repeat(MAX_GOAL_CHARS)}`);
    expect(whole).toContain("- run-bbbbbbbb on t2: Wire app.js");
  });

  it("names files outside a task's hint, folders included, and nothing when there is no hint", () => {
    expect(team.outsideHint(["src/a.js", "src/lib/b.js", "README.md"], ["src"])).toEqual(["README.md"]);
    expect(team.outsideHint(["./index.html"], ["index.html"])).toEqual([]);
    expect(team.outsideHint(["anything"], [])).toEqual([]);
  });

  // Live planners write `src/app/setup-api/**` and `**`; read as literal
  // names they matched nothing, and every file the worker touched was a stray.
  it("reads a planner's `folder/**` as the folder and `**` as anywhere", () => {
    expect(team.outsideHint(["src/app/setup-api/x/route.ts", "src/lib/y.ts"], ["src/app/setup-api/**", "src/lib/y.ts"])).toEqual([]);
    expect(team.outsideHint(["src/app/setup-api/x/route.ts", "README.md"], ["src/app/setup-api/**"])).toEqual(["README.md"]);
    expect(team.outsideHint(["anything/at/all.ts", "README.md"], ["**"])).toEqual([]);
    expect(team.outsideHint(["anything/at/all.ts"], ["src/**", "**"])).toEqual([]);
  });

  it("finds the root the harness files a project's memory under: its own `.git`, or the shared one a worktree's `.git` file points at", () => {
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
    fs.mkdirSync(path.join(repo, "sub", "deep"), { recursive: true });
    expect(team.gitCommonRoot(repo)).toBe(repo);
    expect(team.gitCommonRoot(path.join(repo, "sub", "deep"))).toBe(repo);
    // A worktree: `.git` is a file naming its gitdir, whose commondir is the shared `.git`.
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
    fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
    expect(team.gitCommonRoot(wt)).toBe(repo);
    // No repository up the tree (the temp root is not one), or a `.git` file that names nothing.
    const bare = path.join(root, "bare");
    fs.mkdirSync(bare, { recursive: true });
    expect(team.gitCommonRoot(bare)).toBe(team.gitCommonRoot(root));
    fs.writeFileSync(path.join(bare, ".git"), "not a gitdir line\n");
    expect(team.gitCommonRoot(bare)).toBeNull();
  });

  // team-6rgz8cyx and team-5oxkp7a9 (2026-09-06): every alert of both runs was
  // __pycache__/calc.cpython-310.pyc, written by CPython importing the very
  // file the task named. Three of those hit the alert ceiling and killed runs
  // whose work the reviewer had already accepted.
  it("says which files a worker wrote inside its worktree — what its run touched there, never what its task names", () => {
    const wt = "/p/.clawbox/worktrees/t1-1";
    expect(team.writtenFiles([
      "items.json", "./items.json", "docs/", `${wt}/api/contract.md`, `${wt}/`, "/tmp/scratch.txt", "../escape.md", ".", "__pycache__/c.pyc", "node_modules/x/y.js", ".clawbox/state.json",
    ], `${wt}/`)).toEqual(["items.json", "docs", "api/contract.md"]);
    // A check that wrote nothing wrote nothing, whatever files its task named to read.
    expect(team.writtenFiles([], wt)).toEqual([]);
    expect(team.writtenFiles(["/p/other/index.html", "/tmp/check.py"], wt)).toEqual([]);
  });

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

  // Bench, 2026-09-26: a verifier wrote __verify_probe.html to try the page,
  // removed it, and the probe alone rejected a correct task.
  it("does not call an obvious scratch file a stray file — but a dunder source file still is one", () => {
    expect(team.outsideHint(["index.html", "__verify_probe.html", "tmp/check.tmp", ".probe-1", "src/.probe"], ["index.html"])).toEqual([]);
    for (const f of ["__verify_probe.html", "__x", "a/b/__scratch.js", "__probe/", "check.tmp", "out/x.tmp", ".probe", ".probe-page.html"]) {
      expect(team.isScratchFile(f), f).toBe(true);
    }
    for (const f of ["__init__.py", "pkg/__main__.py", "__tests__/a.test.ts", "notes.md", "tmp.js", "probe.html", "a.tmp.js"]) {
      expect(team.isScratchFile(f), f).toBe(false);
    }
    expect(team.outsideHint(["calc.py", "pkg/__init__.py"], ["calc.py"])).toEqual(["pkg/__init__.py"]);
  });

  it("knows which touched files are gone from the folder — and says nothing when the folder itself is", () => {
    const dir = path.join(root, "wt");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "x");
    fs.writeFileSync(path.join(dir, "src", "a.js"), "x");
    // A link the worker left is there, wherever it points.
    fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "link"));
    fs.writeFileSync(path.join(dir, "file"), "x");
    expect([...team.vanishedFiles(dir, ["index.html", "src/a.js", "probe.html", "src/gone.js", "link", "file/under-a-file"])]).toEqual(["probe.html", "src/gone.js", "file/under-a-file"]);
    expect(team.vanishedFiles(path.join(root, "no-such-folder"), ["index.html"]).size).toBe(0);
    expect(team.vanishedFiles("relative/dir", ["index.html"]).size).toBe(0);
  });

  // A worker's scratch file is no stray (above), but a red suite's failure
  // that names one does not point at every task for it (TASK-1321).
  it("sends a red suite back to the tasks whose hints hold the failing files — a scratch-named file included", () => {
    type Task = Parameters<Team["suiteSuspects"]>[0][number];
    const task = (task_id: string, files_hint: string[], attempts = 1): Task =>
      ({ task_id, files_hint, attempts, status: "complete" }) as Task;
    const calc = task("t1", ["calc.py"]);
    const tests = task("t2", ["tests"]);
    const done = task("t3", ["cli.py"], 2);
    const ids = (named: string[]) => team.suiteSuspects([calc, tests, done], named).map((t) => t.task_id);
    expect(ids(["calc.py"])).toEqual(["t1"]);
    expect(ids(["tests/__probe_test.py"])).toEqual(["t2"]);
    expect(ids(["calc.py", "__probe_test.py"])).toEqual(["t1"]);
    // Named by none of them, or no attempt left for the one it names: every task with an attempt left.
    expect(ids(["__probe_test.py"])).toEqual(["t1", "t2"]);
    expect(ids(["cli.py"])).toEqual(["t1", "t2"]);
    // …unless the caller says not everyone — a suite that only ran out of time points at nobody that way.
    expect(team.suiteSuspects([calc, tests, done], ["cli.py"], { everyone: false }).map((t) => t.task_id)).toEqual([]);
    expect(team.suiteSuspects([calc, tests, done], ["calc.py"], { everyone: false }).map((t) => t.task_id)).toEqual(["t1"]);
    expect(team.outsideHint(["__probe_test.py"], ["calc.py"])).toEqual([]);
    expect(team.outsideHint(["__probe_test.py"], ["calc.py"], { scratch: false })).toEqual(["__probe_test.py"]);
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
/** t1's result, naming a blocker: what used to call the lead after an accepted task, and no longer does. */
const BLOCKED_INDEX = "Built index.html.\nMISSING: a favicon — no task makes one.";
const shaped = (shape: Record<string, unknown>, plan: string) => JSON.stringify({ shape, tasks: JSON.parse(plan) });
/** t1 rejected twice: for good, so t2 (waiting on it) can never start — the board is exhausted and not complete. */
const rejectT1Twice = () => Array.from({ length: 2 }, () => ({ summary: JSON.stringify({ verdict: "rejected", notes: "No <title>." }) }));

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

  it("runs once nothing left can start and the goal is not complete, and retires a pending task the goal no longer needs", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: THREE },
      { summary: "Built index.html, no title yet.", filesTouched: ["index.html"] },
      { summary: "Built index.html, and a README while I was at it — still no title.", filesTouched: ["index.html"] },
    ];
    reviews = rejectT1Twice();
    leadAnswers = [{ summary: `Having read the folder:\n${RETIRE_T3}` }];
    // t1's worker tells the lead while it works: the message waits for the lead's next turn.
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
    expect(done.status).toBe("failed");
    expect(done.dynamic).toBe(true);
    expect(done.tasks.map((t) => [t.task_id, t.status])).toEqual([["t1", "rejected"], ["t2", "pending"], ["t3", "retired"]]);
    // No turn after the first rejection (t1 was offered again); ONE once t1
    // was rejected for good and t2, t3 could never start.
    expect(starts.map(role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer", "lead"]);
    const lead = starts[5];
    expect(lead).toMatchObject({ readOnly: true, team: { id: board.id, role: "lead", taskId: "t1" }, directory: "/home/clawbox/Projects/site", projectId: null });
    expect(String(lead.extraBrief)).toContain("You are the LEAD");
    expect(String(lead.task)).toMatch(/^Task t1 just settled \(rejected, rejected: No <title>\.\): Scaffold index\.html/);
    expect(String(lead.task)).toContain("and a README while I was at it");
    expect(String(lead.task)).toContain("pending now: t2, t3");
    // Its inbox: the message, whole, on one line; the turn that read it is on the board.
    expect(String(lead.task)).toContain("Messages to the lead since your last turn:\n- worker run-00000002 (task t1): I wrote README.md as well; t3 is not needed.");
    expect(done.lastLeadAt).toBeGreaterThan(0);
    // In the planner's name, with the lead's note; the cast list and the figures count it.
    expect(done.log.find((e) => e.type === "retire")).toMatchObject({ actor: { kind: "planner" }, task_id: "t3", message: "Task t3 retired by the lead: t1 already wrote the README" });
    expect(done.runs.filter((r) => r.role === "lead")).toEqual([{ id: "run-00000006", role: "lead", taskId: "t1" }]);
    expect(done.agents).toEqual({ planner: 1, workers: 2, reviewers: 2, leads: 1, total: 6 });
    expect(done.metrics).toMatchObject({ leadRuns: 1, tasksPlanned: 3, tasksAdded: 0, tasksRetired: 1, tasksAcceptedFirstTry: 0, tasksRejected: 1 });
    expect(done.error).toBe("Tasks t1 failed; t2 (waiting on t1, rejected) never ran.");
  });

  it("adds a task when the chain broke; it runs like any other and is counted as the lead's", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: PLAN },
      { summary: "Built index.html.", filesTouched: ["index.html"] },
      { summary: "Built index.html again.", filesTouched: ["index.html"] },
      { summary: "favicon", filesTouched: ["favicon.ico"] },
    ];
    reviews = rejectT1Twice();
    leadAnswers = [{ summary: JSON.stringify({ add: [{ task_description: "Add a favicon; index.html is t1's", files_hint: ["favicon.ico"] }], note: "the favicon needs no title" }) }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.tasks[2]).toMatchObject({ task_id: "t3", origin: "lead", status: "complete", depends_on: [], files_hint: ["favicon.ico"] });
    const worker3 = starts.find((s) => role(s) === "worker" && (s.team as { taskId: string }).taskId === "t3");
    expect(String(worker3?.task)).toMatch(/^Your task \(t3 of 3\): Add a favicon/);
    expect(done.log.some((e) => e.type === "task" && e.actor.kind === "planner" && e.message === "Task t3 added by the lead: Add a favicon; index.html is t1's — the favicon needs no title")).toBe(true);
    expect(done.metrics).toMatchObject({ tasksPlanned: 2, tasksAdded: 1, tasksRetired: 0 });
    // The broken chain called it once; t3, settled clean with the board still broken, called it once more — and it stood.
    expect(done.metrics.leadRuns).toBe(2);
  });

  it.each([
    ["an answer that is not one", { summary: "The plan looks fine to me!" }, /^ALERT: The lead after t1 gave no usable answer: The lead's answer holds no JSON object\. The plan is unchanged\.$/],
    ["an answer past a bound", { summary: '{"retire": ["t1"]}' }, /^ALERT: The lead after t1 gave no usable answer: It retires t1, which is rejected; only a pending task may be retired\. The plan is unchanged\.$/],
    ["a lead that did not finish", { status: "failed", error: "boom" }, /^ALERT: The lead after t1 \(run-00000006\) ended failed; the plan is unchanged\.$/],
  ])("takes %s as an alert, and the team ends with the plan it had", async (_what, answer, alert) => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [{ summary: PLAN }, { summary: "index", filesTouched: ["index.html"] }, { summary: "index again", filesTouched: ["index.html"] }];
    reviews = rejectT1Twice();
    leadAnswers = [answer];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([expect.stringMatching(alert)]);
    expect(done.tasks.map((t) => [t.task_id, t.status, t.origin])).toEqual([["t1", "rejected", "plan"], ["t2", "pending", "plan"]]);
    expect(done.metrics.leadRuns).toBe(1);
    // A turn that decided nothing read nothing: the inbox is still unread.
    expect(done.lastLeadAt).toBe(0);
  });

  it("marks the inbox read on a usable answer: the next turn is not shown the message again", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: PLAN },
      { summary: "Built index.html.", filesTouched: ["index.html"] },
      { summary: "Built index.html again.", filesTouched: ["index.html"] },
      { summary: "Added the licence.", filesTouched: ["LICENSE"] },
    ];
    reviews = rejectT1Twice();
    leadAnswers = [{ summary: JSON.stringify({ add: [{ task_description: "Add a licence", files_hint: ["LICENSE"] }], note: "asked for" }) }, { summary: "{}" }];
    // t1's worker tells the lead while it works.
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
    expect(done.status).toBe("failed");
    expect(done.tasks.map((t) => [t.task_id, t.status])).toEqual([["t1", "rejected"], ["t2", "pending"], ["t3", "complete"]]);
    // The broken chain calls the lead after t1's last try; its add reads the
    // inbox. t3 settles clean on a board still broken: one more turn, shown no message.
    expect(starts.map(role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer", "lead", "worker", "reviewer", "lead"]);
    const leads = starts.filter((s) => role(s) === "lead");
    expect(leads.map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t3"]);
    expect(String(leads[0].task)).toContain("Messages to the lead since your last turn:\n- worker run-00000002 (task t1): The licence is the owner's call.");
    expect(String(leads[1].task)).toContain("Messages to the lead since your last turn: (none)");
    expect(done.metrics.leadRuns).toBe(2);
    expect(done.alerts).toBe(0);
    expect(done.lastLeadAt).toBeGreaterThan(0);
  });

  it("is not called by a message, a blocker or a rejection with a try left — the work goes on, and the message waits for its next turn", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [
      { summary: THREE },
      { summary: "Built index.html, no title.", filesTouched: ["index.html"] },
      { summary: BLOCKED_INDEX, filesTouched: ["index.html"] },
      { summary: "Wired app.js.", filesTouched: ["app.js"] },
      { summary: "Wrote the README.", filesTouched: ["README.md"] },
    ];
    reviews = [{ summary: JSON.stringify({ verdict: "rejected", notes: "No <title>." }) }];
    leadAnswers = [{ summary: RETIRE_T3 }];
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
    expect(done.tasks.map((t) => t.status)).toEqual(["complete", "complete", "complete"]);
    // t2 and t3 go side by side once t1 is in: four workers and their reviewers, no lead among them.
    expect(starts.map(role).sort()).toEqual([...Array<string>(4).fill("reviewer"), "planner", ...Array<string>(4).fill("worker")].sort());
    expect(done.metrics.leadRuns).toBe(0);
    expect(leadAnswers).toHaveLength(1);
    // The message is on the board for the lead's next turn, whenever that is; nobody answers it.
    expect(done.log.find((e) => e.type === "message")).toMatchObject({ payload: { to: "lead", text: "The licence is the owner's call." } });
    expect(done.lastLeadAt).toBe(0);
    expect(done.alerts).toBe(0);
  });

  it("spends no run when nothing is left to decide: every task left is complete", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    outcomes = [{ summary: JSON.stringify([{ task_description: "Fix the typo in README.md", files_hint: ["README.md"] }]) }, { summary: "fixed", filesTouched: ["README.md"] }];
    const board = await team.startTeam({ goal: "Fix the typo", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    // A one-task plan is one ordinary run (no team role): no reviewer, no lead.
    expect(starts.map((s) => (s.team as { role: string } | null)?.role ?? "run")).toEqual(["planner", "run"]);
    expect(done.metrics.leadRuns).toBe(0);
  });

  it("spends no run on a task accepted clean, and logs nothing for the skip", async () => {
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

  it("gives every task that settled since its last look ONE turn, the batch named — not a turn each", async () => {
    // Four side by side; t1 is rejected for good while the others finish, so the
    // board is exhausted and broken only once all of them are in.
    teamSlots.value = 4;
    runner.getTeamDynamic.mockResolvedValue(true);
    runner.teamSpawnSlot.mockResolvedValue({ ok: true });
    outcomes = [{ summary: shaped({ parallelism: 4, review: "each", rationale: "" }, JSON.stringify([
      { task_description: "Scaffold index.html", files_hint: ["index.html"] },
      { task_description: "Write styles.css", files_hint: ["styles.css"] },
      { task_description: "Write about.html", files_hint: ["about.html"] },
      { task_description: "Write the README", files_hint: ["README.md"] },
      // One page named, not both: a plan whose tasks mostly name the same files runs as one run.
      { task_description: "Check every page links styles.css", depends_on: ["t1", "t2", "t3", "t4"], files_hint: ["index.html"] },
    ])) }];
    // Each worker's outcome by its task, whatever order they start in; t1's reviewer rejects it each time, the others' accept.
    const byTask: Record<string, Record<string, unknown>> = {
      t1: { summary: "index", filesTouched: ["index.html"] },
      t2: { summary: "Wrote styles.css.", filesTouched: ["styles.css"] },
      t3: { summary: "Wrote about.html.", filesTouched: ["about.html"] },
      t4: { summary: "Wrote the README.", filesTouched: ["README.md"] },
    };
    const verdictFor = (taskId: string) => JSON.stringify(taskId === "t1" ? { verdict: "rejected", notes: "No <title>." } : { verdict: "accepted", notes: "" });
    // t2–t4 finish only once t1's second worker is up.
    let secondT1: () => void = () => {};
    const secondT1Up = new Promise<void>((resolve) => { secondT1 = resolve; });
    let t1Starts = 0;
    const start = runner.startRun.getMockImplementation()!;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      if (role(input) === "worker" && (input.team as { taskId: string }).taskId === "t1" && ++t1Starts === 2) secondT1();
      return start(input);
    });
    const wait = runner.waitForRun.getMockImplementation()!;
    runner.waitForRun.mockImplementation(async (id: string, ms?: number) => {
      const run = runs.get(id);
      const who = run?.team as { id: string; role: string; taskId: string } | null;
      if (run && who?.role === "worker" && run.status === "running") {
        if (["t2", "t3", "t4"].includes(who.taskId)) await secondT1Up;
        return Object.assign(run, { status: "completed", completedAt: Date.now() }, byTask[who.taskId]);
      }
      if (run && who?.role === "reviewer" && run.status === "running") {
        return Object.assign(run, { status: "completed", completedAt: Date.now(), summary: verdictFor(who.taskId) });
      }
      return wait(id, ms);
    });
    const board = await team.startTeam({ goal: "Build the site", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    const leads = runner.startRun.mock.calls.map(([input]) => input as Record<string, unknown>).filter((input) => role(input) === "lead");
    // ONE turn, once nothing could start — not one after each of the five
    // settles — with the board as it stands: t5 is what is left to decide on.
    expect(leads).toHaveLength(1);
    const batch = String(leads[0].task);
    expect(batch).toMatch(/Task t[1-4] just settled \((rejected|complete)/);
    expect(batch).toContain("pending now: t5");
    expect(done.metrics.leadRuns).toBe(1);
    expect(done.alerts).toBe(0);
    expect(done.tasks.map((t) => t.status)).toEqual(["rejected", "complete", "complete", "complete", "pending"]);
  });

  it("reads the switch once, when the team starts", async () => {
    runner.getTeamDynamic.mockResolvedValueOnce(true).mockResolvedValue(false);
    outcomes = [{ summary: PLAN }, { summary: "index", filesTouched: ["index.html"] }, { summary: "index again", filesTouched: ["index.html"] }];
    reviews = rejectT1Twice();
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
    // No verdict in the answer nor in the one re-ask (TASK-1323).
    reviews = [{ summary: "Looks great." }, { summary: "Still looks great." }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.finalReview).toMatchObject({ verdict: "accepted", notes: expect.stringMatching(/^Accepted by rule/) });
    expect(done.log.filter((e) => e.type === "alert").map((e) => e.message)).toEqual([expect.stringMatching(/final reviewer gave no verdict/)]);
  });

  it("asks the final reviewer once more, in its own session, when its answer holds no JSON object (TASK-1323)", async () => {
    const { FINAL_REVIEWER_BRIEF, REVIEWER_NUDGE } = await import("@/lib/coding-team-reviewer");
    outcomes = [{ summary: shaped({ parallelism: 1, review: "final", rationale: "" }, PLAN) }, { summary: "index", filesTouched: ["index.html"] }, { summary: "app", filesTouched: ["app.js"] }];
    reviews = [{ summary: "The goal is met: index.html and app.js work together." }, { summary: 'Sorry.\n{"verdict": "rejected", "notes": "app.js never loads the form."}' }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(starts.map(role)).toEqual(["planner", "worker", "worker", "reviewer", "reviewer"]);
    expect(starts[4]).toEqual({ task: REVIEWER_NUDGE, resumeRunId: "run-00000004", source: "owner", team: { id: board.id, role: "reviewer", taskId: null }, readOnly: true, extraBrief: FINAL_REVIEWER_BRIEF });
    expect(done.finalReview).toMatchObject({ verdict: "rejected", notes: "app.js never loads the form." });
    expect(done.status).toBe("failed");
    expect(done.log.filter((e) => e.type === "alert")).toEqual([]);
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([
      'The final reviewer answered without a JSON verdict; asking it once more for the verdict alone. It answered: "The goal is met: index.html and app.js work together."',
    ]);
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

  it("still rejects by rule under review \"none\" for a refused write — a stray alone is a note and the task is accepted", async () => {
    outcomes = [
      { summary: shaped({ parallelism: 1, review: "none", rationale: "" }, PLAN) },
      { summary: "index", filesTouched: ["index.html", "secrets.env"], permissionDenials: 1, deniedActions: ["Write: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1/secrets.env"] },
      { summary: "index again", filesTouched: ["index.html", "secrets.env"] },
      { summary: "app", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.tasks[0]).toMatchObject({ attempts: 2, rejections: 1, review: { verdict: "accepted" } });
    expect(done.log.filter((e) => e.type === "note").map((e) => e.message)).toEqual([
      "Worker run-00000002 touched files outside its task's hint: secrets.env — the reviewer judges whether they belong to the task.",
      "Worker run-00000003 touched files outside its task's hint: secrets.env — the reviewer judges whether they belong to the task.",
    ]);
    expect(done.metrics).toMatchObject({ tasksRejected: 1, tasksAcceptedFirstTry: 1 });
  });
});

describe("the project's own tests on the merged result (TASK-1321)", () => {
  // The bench's team-cli-tool, cut down: a converter CLI and a unittest suite
  // for its pairs. The CLI prints the right number and exits 1 — the suite's
  // failure is the one the team signed off over: "AssertionError: 1 != 0 : 1.609344".
  const CLI = [
    "import sys",
    "FACTORS = {('mi', 'km'): 1.609344, ('km', 'mi'): 1 / 1.609344}",
    "value, src, dst = float(sys.argv[1]), sys.argv[2], sys.argv[3]",
    "print(round(value * FACTORS[(src, dst)], 6))",
    "sys.exit(1)",
    "",
  ].join("\n");
  const CLI_TESTS = [
    "import subprocess, sys, unittest",
    "",
    "def convert(*args):",
    "    return subprocess.run([sys.executable, 'convert.py', *args], capture_output=True, text=True)",
    "",
    "class TestConvert(unittest.TestCase):",
    "    def test_mi_to_km(self):",
    "        out = convert('1', 'mi', 'km')",
    "        self.assertEqual(out.returncode, 0, out.stdout.strip())",
    "",
    "    def test_km_to_mi_prints(self):",
    "        self.assertEqual(convert('1.609344', 'km', 'mi').stdout.strip(), '1.0')",
    "",
  ].join("\n");
  // The same pairs as a module: one pair missing, so the failure's traceback
  // runs through convert.py as well as through the test.
  const MODULE = "FACTORS = {('mi', 'km'): 1.609344}\n\ndef convert(value, src, dst):\n    return round(value * FACTORS[(src, dst)], 6)\n";
  const MODULE_FIXED = "FACTORS = {('mi', 'km'): 1.609344, ('km', 'mi'): 1 / 1.609344}\n\ndef convert(value, src, dst):\n    return round(value * FACTORS[(src, dst)], 6)\n";
  const MODULE_TESTS = [
    "import unittest",
    "from convert import convert",
    "",
    "class TestConvert(unittest.TestCase):",
    "    def test_mi_to_km(self):",
    "        self.assertEqual(convert(1, 'mi', 'km'), 1.609344)",
    "",
    "    def test_km_to_mi(self):",
    "        self.assertEqual(convert(1.609344, 'km', 'mi'), 1.0)",
    "",
  ].join("\n");
  const SUITE_PLAN = JSON.stringify([
    { task_description: "Write the converter, convert.py", files_hint: ["convert.py"] },
    { task_description: "Test every pair in tests/test_convert.py", depends_on: ["t1"], files_hint: ["tests/test_convert.py"] },
  ]);

  /** The merged result on disk: the team's folder, with what its workers left there. */
  function project(files: Record<string, string>): string {
    const dir = path.join(root, "site");
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    runner.resolveWorkingDirectory.mockResolvedValue({ directory: dir, projectId: null });
    return dir;
  }
  const notes = (done: { log: Array<{ type: string; message: string }> }) => done.log.filter((e) => e.type === "note").map((e) => e.message);

  it("is not done while the suite is red: the rejection names the failing test, the task it points at is offered once more, and a suite still red fails the team", async () => {
    project({ "convert.py": CLI, "tests/test_convert.py": CLI_TESTS });
    outcomes = [
      // The evidence's shape: workers accepted by rule, one final review over the merged whole.
      { summary: shaped({ parallelism: 1, review: "final", rationale: "A small tool." }, SUITE_PLAN) },
      { summary: "Wrote convert.py.", filesTouched: ["convert.py"] },
      { summary: "Wrote the tests.", filesTouched: ["tests/test_convert.py"] },
      { summary: "Looked again; the tests are right.", filesTouched: ["tests/test_convert.py"] },
    ];
    const board = await team.startTeam({ goal: "A unit converter CLI with a test for every pair", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("failed");
    expect(done.error).toContain("The project's own tests fail on the merged result: python3 -m unittest discover -s tests — Ran 2 tests, FAILED (failures=1)");
    expect(done.error).toContain("Failing: test_convert.TestConvert.test_mi_to_km");
    expect(done.error).toContain("AssertionError: 1 != 0 : 1.609344");
    // The failure named tests/test_convert.py, so t2 went back — once — with the
    // failing test in the words its next worker read first; no final reviewer
    // was spent on a red tree.
    expect(starts.map(role)).toEqual(["planner", "worker", "worker", "worker"]);
    expect(starts[3].team).toMatchObject({ role: "worker", taskId: "t2" });
    const retry = String(starts[3].task);
    expect(retry).toContain("A previous attempt was rejected: The project's own tests fail on the merged result");
    expect(retry).toContain("Failing: test_convert.TestConvert.test_mi_to_km");
    expect(retry).toContain("First failure: AssertionError: 1 != 0 : 1.609344");
    expect(retry).toContain("run `python3 -m unittest discover -s tests` yourself");
    expect(done.tasks.map((t) => [t.task_id, t.attempts, t.rejections])).toEqual([["t1", 1, 0], ["t2", 2, 1]]);
    expect(done.log.find((e) => e.type === "review" && e.message.startsWith("Task t2 rejected"))).toMatchObject({ actor: { kind: "reviewer" } });
    expect(notes(done)).toEqual([
      expect.stringMatching(/^The project's own tests fail on the merged result: .*test_mi_to_km\. Offered once more: t2\.$/),
      expect.stringMatching(/^The project's own tests fail on the merged result: .*test_mi_to_km\.$/),
    ]);
    expect(done.finalReview).toBeNull();
    // A red suite is a rejection, never an alert toward the team's ceiling.
    expect(done.alerts).toBe(0);
  });

  it("finishes once the re-attempt turns the suite green — whatever the review shape", async () => {
    const dir = project({ "convert.py": MODULE, "tests/test_convert.py": MODULE_TESTS });
    outcomes = [
      { summary: SUITE_PLAN },
      { summary: "Wrote convert.py.", filesTouched: ["convert.py"] },
      { summary: "Wrote the tests.", filesTouched: ["tests/test_convert.py"] },
      { summary: "Added km → mi.", filesTouched: ["convert.py"] },
      { summary: "The tests stand.", filesTouched: ["tests/test_convert.py"] },
    ];
    // t1's second worker is the one that fixes the module.
    let t1Workers = 0;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      const who = input.team as { role: string; taskId: string | null };
      if (who.role === "worker" && who.taskId === "t1" && ++t1Workers === 2) fs.writeFileSync(path.join(dir, "convert.py"), MODULE_FIXED);
      return fakeRun(input);
    });
    const board = await team.startTeam({ goal: "A unit converter", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("done");
    // The KeyError's traceback ran through both files: both tasks went back, in
    // dependency order, each reviewed as any task is.
    expect(starts.map(role)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer", "worker", "reviewer", "worker", "reviewer"]);
    expect(done.tasks.map((t) => [t.task_id, t.status, t.attempts, t.rejections])).toEqual([["t1", "complete", 2, 1], ["t2", "complete", 2, 1]]);
    expect(String(starts[5].task)).toContain("Failing: test_convert.TestConvert.test_km_to_mi");
    expect(notes(done)).toEqual([
      expect.stringMatching(/^The project's own tests fail on the merged result: python3 -m unittest discover -s tests — Ran 2 tests, FAILED \(errors=1\)\. Failing: test_convert\.TestConvert\.test_km_to_mi\. Offered once more: t1, t2\.$/),
      "The project's own tests pass on the merged result: python3 -m unittest discover -s tests — Ran 2 tests, OK.",
    ]);
  });

  it("is accepted when the suite passes, and the final reviewer is told so", async () => {
    project({ "convert.py": MODULE_FIXED, "tests/__init__.py": "", "tests/test_convert.py": MODULE_TESTS });
    outcomes = [
      { summary: shaped({ parallelism: 1, review: "final", rationale: "" }, SUITE_PLAN) },
      { summary: "Wrote convert.py.", filesTouched: ["convert.py"] },
      { summary: "Wrote the tests.", filesTouched: ["tests/test_convert.py"] },
    ];
    const board = await team.startTeam({ goal: "A unit converter", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("done");
    expect(runner.suiteSandbox).toHaveBeenCalledTimes(1);
    expect(starts.map(role)).toEqual(["planner", "worker", "worker", "reviewer"]);
    // tests/ is a package here, so discovery starts at the top.
    expect(String(starts[3].task)).toContain("The harness ran the project's own tests on the merged result and they pass: python3 -m unittest discover — Ran 2 tests, OK.");
    expect(done.finalReview).toMatchObject({ verdict: "accepted" });
    expect(notes(done)).toEqual(["The project's own tests pass on the merged result: python3 -m unittest discover — Ran 2 tests, OK."]);
    expect(done.tasks.map((t) => t.attempts)).toEqual([1, 1]);
  });

  it("changes nothing for a project with no test suite", async () => {
    project({ "index.html": "<!doctype html><title>Site</title>", "app.js": "console.log('hi');\n" });
    outcomes = [
      { summary: shaped({ parallelism: 1, review: "final", rationale: "" }, PLAN) },
      { summary: "index", filesTouched: ["index.html"] },
      { summary: "app", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("done");
    expect(runner.suiteSandbox).not.toHaveBeenCalled();
    expect(starts.map(role)).toEqual(["planner", "worker", "worker", "reviewer"]);
    expect(String(starts[3].task)).not.toContain("own tests");
    expect(notes(done)).toEqual([]);
    expect(done.finalReview).toMatchObject({ verdict: "accepted" });
  });

  it("sends a red suite's suspect straight back to a worker — a re-offer with a try left calls no lead, even on a dynamic team", async () => {
    runner.getTeamDynamic.mockResolvedValue(true);
    project({ "convert.py": CLI, "tests/test_convert.py": CLI_TESTS });
    outcomes = [
      { summary: shaped({ parallelism: 1, review: "final", rationale: "" }, SUITE_PLAN) },
      { summary: "Wrote convert.py.", filesTouched: ["convert.py"] },
      { summary: "Wrote the tests.", filesTouched: ["tests/test_convert.py"] },
      { summary: "Looked again.", filesTouched: ["tests/test_convert.py"] },
    ];
    const board = await team.startTeam({ goal: "A unit converter CLI", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("failed");
    expect(starts.map(role)).toEqual(["planner", "worker", "worker", "worker"]);
    expect(starts[3].team).toMatchObject({ role: "worker", taskId: "t2" });
    expect(String(starts[3].task)).toContain("A previous attempt was rejected: The project's own tests fail on the merged result");
    expect(String(starts[3].task)).toContain("test_convert.TestConvert.test_mi_to_km");
    expect(done.metrics.leadRuns).toBe(0);
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

  it("copies each run's tokens by kind from its own record onto the cast list and adds them up, in total and by role", async () => {
    const kind = (input: number, output: number, cacheCreation: number, cacheRead: number) => ({ input, output, cacheCreation, cacheRead });
    outcomes = [
      { summary: PLAN, tokensUsed: 1_100, tokenBreakdown: kind(600, 100, 400, 0) },
      { summary: "index", filesTouched: ["index.html"], tokensUsed: 20_000, tokenBreakdown: kind(2_000, 500, 1_500, 16_000) },
      { summary: "app", filesTouched: ["app.js"], tokensUsed: 30_000, tokenBreakdown: kind(3_000, 700, 1_300, 25_000) },
    ];
    reviews = [
      { summary: JSON.stringify({ verdict: "accepted", notes: "" }), tokensUsed: 5_000, tokenBreakdown: kind(1_000, 200, 0, 3_800) },
      // A record without the field: its total counts, its kinds stay off the cast list.
      { summary: JSON.stringify({ verdict: "accepted", notes: "" }), tokensUsed: 6_000 },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.runs.map((r) => [r.role, r.tokens, r.tokenBreakdown])).toEqual([
      ["planner", 1_100, kind(600, 100, 400, 0)],
      ["worker", 20_000, kind(2_000, 500, 1_500, 16_000)],
      ["reviewer", 5_000, kind(1_000, 200, 0, 3_800)],
      ["worker", 30_000, kind(3_000, 700, 1_300, 25_000)],
      ["reviewer", 6_000, undefined],
    ]);
    expect(done.metrics.tokensUsed).toBe(62_100);
    expect(done.metrics.tokenBreakdown).toEqual(kind(6_600, 1_500, 3_200, 44_800));
    expect(done.metrics.tokenBreakdownByRole).toEqual({
      planner: kind(600, 100, 400, 0),
      worker: kind(5_000, 1_200, 2_800, 41_000),
      reviewer: kind(1_000, 200, 0, 3_800),
      lead: kind(0, 0, 0, 0),
    });
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-team", `${board.id}.json`), "utf8"));
    expect(onDisk.runs.map((r: { tokenBreakdown?: unknown }) => r.tokenBreakdown)).toEqual(done.runs.map((r) => r.tokenBreakdown));
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

  it("says the worker's files count only once committed on its branch, and that its own commit is welcome", () => {
    expect(team.WORKER_BRIEF).toContain("Your files count only once they are committed on your branch");
    expect(team.WORKER_BRIEF).toContain("a `git add` and `git commit` of your files in your own folder before your final message is welcome");
  });

  it("puts scratch files in the evidence folder only — never in /tmp, never beside the project", () => {
    expect(team.WORKER_BRIEF).toContain("Scratch files go in your evidence folder only — never in /tmp, never beside the project. A write anywhere else is refused, and a refused write counts against your task.");
  });
});

describe("a second team: queued, not refused", () => {
  const ONE_TASK = JSON.stringify([{ task_description: "Scaffold index.html", files_hint: ["index.html"] }]);

  it("waits on disk with its place while one works, and starts by itself when that one settles", async () => {
    outcomes = [
      { summary: ONE_TASK },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: ONE_TASK },
      { summary: "index done again", filesTouched: ["index.html"] },
    ];
    // The first team's planner holds until the second has been asked for.
    const hold: { release?: () => void } = {};
    const plain = runner.waitForRun.getMockImplementation()!;
    runner.waitForRun.mockImplementationOnce((id: string) => new Promise((r) => { hold.release = () => r(plain(id, 0)); }));
    const first = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const second = await team.startTeam({ goal: "Build it again", directory: "site", source: "agent" });
    expect(second).toMatchObject({ status: "queued", queuePosition: 1 });
    // Read back from disk, a queued team is not an orphan of a restart.
    expect(team.getTeam(second.id)).toMatchObject({ status: "queued", queuePosition: 1 });
    expect(team.listTeams().find((t) => t.id === second.id)).toMatchObject({ status: "queued", queuePosition: 1 });
    // The planner reaches its wait a few ticks after the start: release it once it is there.
    for (let i = 0; i < 500 && !hold.release; i++) await new Promise((r) => setTimeout(r, 10));
    hold.release!();

    expect((await finished(first.id)).status).toBe("done");
    const done = await finished(second.id);
    expect(done.status).toBe("done");
    expect(done.log.map((e) => e.message)).toEqual(expect.arrayContaining([
      `Team → queued: Waiting for team ${first.id} to finish`,
      "Team → planning: Its turn in the queue came",
    ]));
    expect(done.queuePosition).toBeUndefined();
  });

  it("is taken out of the queue by the owner's cancel alone, never by a stop", async () => {
    let release: () => void = () => {};
    runner.waitForRun.mockImplementationOnce(() => new Promise((r) => { release = () => r(runs.get("run-00000001")); }));
    const first = await team.startTeam({ goal: "g", source: "owner" });
    const second = await team.startTeam({ goal: "h", source: "agent" });
    expect(() => team.stopTeam(second.id)).toThrow(/Only the owner can cancel a queued team/);
    const canceled = team.cancelQueuedTeam(second.id);
    expect(canceled.status).toBe("stopped");
    expect(canceled.log[canceled.log.length - 1]).toMatchObject({ actor: { kind: "owner" }, message: "Team → stopped: Canceled by the owner before it started" });
    Object.assign(runs.get("run-00000001")!, { status: "completed", summary: "nope" });
    outcomes = [{ summary: "nope" }];
    release();
    await finished(first.id);
    // Canceled stays canceled: nothing started it when the box came free.
    expect(team.getTeam(second.id)?.status).toBe("stopped");
  });

  it("is started at boot when it was waiting at a restart", async () => {
    // What a restart leaves: a queued board on disk and no team in this process.
    const board = await import("@/lib/coding-team-board");
    const queued = board.createBoard({ goal: "Build it", projectId: null, directory: "/home/clawbox/Projects/site", source: "owner" }, { kind: "owner" });
    board.setTeamStatus(queued, { kind: "system" }, "queued", "Waiting for team team-00000000 to finish");
    board.saveBoard(queued);
    outcomes = [{ summary: ONE_TASK }, { summary: "index done", filesTouched: ["index.html"] }];
    expect(team.getTeam(queued.id)?.status).toBe("queued");
    const started = await team.startNextQueuedTeam();
    expect(started?.id).toBe(queued.id);
    expect((await finished(queued.id)).status).toBe("done");
  });

  it("waits while the coding agent is switched off rather than failing", async () => {
    const board = await import("@/lib/coding-team-board");
    const queued = board.createBoard({ goal: "Build it", projectId: null, directory: "/home/clawbox/Projects/site", source: "owner" }, { kind: "owner" });
    board.setTeamStatus(queued, { kind: "system" }, "queued", "Waiting");
    board.saveBoard(queued);
    runner.isCodingAgentEnabled.mockResolvedValue(false);
    expect(await team.startNextQueuedTeam()).toBeNull();
    expect(team.getTeam(queued.id)?.status).toBe("queued");
  });
});


describe("the pull request the goal asks for: the orchestrator's, never a worker's", () => {
  const GREEN = { state: "OPEN", mergeable: "MERGEABLE", checks: { total: 2, passed: 2, failed: 0, pending: 0 }, noChecks: false, isDraft: false, labels: [] };
  const RED = { state: "OPEN", mergeable: "MERGEABLE", checks: { total: 2, passed: 1, failed: 1, pending: 0 }, noChecks: false, isDraft: false, labels: [] };
  const PENDING = { ...GREEN, checks: { total: 2, passed: 1, failed: 0, pending: 1 } };
  const FAILING = { name: "test (20.x)", state: "fail", url: "https://github.com/o/r/actions/runs/9/job/1" };
  const LOG = "test (20.x)\tRun\t2026-10-11T10:00:00.1Z  FAIL  app.test.js > the form > submits\ntest (20.x)\tRun\t2026-10-11T10:00:00.2Z  ❯ app.js:3:1";

  beforeEach(() => {
    team._setTeamPrTimingForTests(5, 60_000);
    github.openPullRequest.mockResolvedValue({ ok: true, number: 41, url: "https://github.com/o/r/pull/41" });
    github.mergePullRequest.mockResolvedValue({ ok: true });
    github.pushBranch.mockResolvedValue({ ok: true });
    github.readReviewSnapshot.mockResolvedValue({ checks: [FAILING] });
    github.readFailedCheckLogs.mockResolvedValue([{ check: FAILING, log: LOG }]);
  });

  it("opens it only once every task is accepted, and merges it when the goal asks and every check passes", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    github.readPullRequest.mockResolvedValueOnce(PENDING).mockResolvedValue(GREEN);
    const board = await team.startTeam({ goal: "Build it, open a pull request and merge it when CI is green", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("done");
    expect(github.openPullRequest).toHaveBeenCalledTimes(1);
    expect(github.openPullRequest.mock.calls[0][0]).toMatchObject({ directory: "/home/clawbox/Projects/site", branch: `clawbox/${board.id}`, base: "master", title: "Coding team: Build it, open a pull request and merge it when CI is green" });
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(github.mergePullRequest).toHaveBeenCalledWith("/home/clawbox/Projects/site", 41);
    expect(done.pr).toMatchObject({ number: 41, phase: "merged", merge: true, ciRounds: 0 });
    // After both acceptances, never before.
    const messages = done.log.map((e) => e.message);
    const opened = messages.findIndex((m) => m.startsWith("Opened pull request #41"));
    expect(opened).toBeGreaterThan(messages.findIndex((m) => m.startsWith("Task t2 accepted")));
    expect(messages).toContain("Merged pull request #41: every task accepted, the suite green, the final review passed and every check green.");
  });

  it("leaves it open, green, when the goal asked for a pull request and no merge", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    github.readPullRequest.mockResolvedValue(GREEN);
    const board = await team.startTeam({ goal: "Build it and open a PR", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.pr).toMatchObject({ phase: "green", merge: false });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("opens none for a goal that asks for none", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    expect((await finished(board.id)).pr).toBeNull();
    expect(github.openPullRequest).not.toHaveBeenCalled();
  });

  it("re-offers the task a red CI points at, with the failure, pushes the fix and watches again", async () => {
    outcomes = [
      { summary: PLAN },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "app done", filesTouched: ["app.js"] },
      { summary: "app fixed", filesTouched: ["app.js"] },
    ];
    github.readPullRequest.mockResolvedValueOnce(RED).mockResolvedValue(GREEN);
    const board = await team.startTeam({ goal: "Build it, open a PR and merge it", directory: "site", source: "owner" });
    const done = await finished(board.id);

    expect(done.status).toBe("done");
    expect(done.pr).toMatchObject({ phase: "merged", ciRounds: 1 });
    expect(done.pr?.failure).toMatchObject({ tests: ["app.test.js > the form > submits"], files: ["app.test.js", "app.js"] });
    // t2's hint is app.js: it — and only it — went back, not counted against its tries.
    expect(done.tasks.map((t) => [t.task_id, t.status, t.attempts, t.ciReoffers])).toEqual([["t1", "complete", 1, 0], ["t2", "complete", 2, 1]]);
    const workers = starts.filter((s) => (s.team as { role: string }).role === "worker");
    expect(workers.map((s) => (s.team as { taskId: string }).taskId)).toEqual(["t1", "t2", "t2"]);
    const retry = String(workers[2].task);
    expect(retry).toContain("A previous attempt was rejected: CI failed on pull request #41: test (20.x); failing tests: app.test.js > the form > submits.");
    expect(retry).toMatch(/Do not push: the team's orchestrator pushes the fix/);
    expect(github.pushBranch).toHaveBeenCalledTimes(1);
    expect(github.pushBranch).toHaveBeenCalledWith("/home/clawbox/Projects/site", `clawbox/${board.id}`);
    expect(done.log.find((e) => e.type === "ci")).toMatchObject({ actor: { kind: "system" }, task_id: "t2" });
    // A red CI is not a guardrail: no alert.
    expect(done.alerts).toBe(0);
  });

  it("fails the team, naming what still fails, after MAX_TEAM_CI_ROUNDS rounds of red", async () => {
    outcomes = [{ summary: PLAN }, ...Array.from({ length: 6 }, (_, i) => ({ summary: `work ${i}`, filesTouched: [i === 0 ? "index.html" : "app.js"] }))];
    github.readPullRequest.mockResolvedValue(RED);
    const board = await team.startTeam({ goal: "Build it and open a PR", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("The pull request's CI is still red after 2 rounds of fixes: CI failed on pull request #41: test (20.x); failing tests: app.test.js > the form > submits.");
    expect(done.pr).toMatchObject({ phase: "failed", ciRounds: 2 });
    expect(github.pushBranch).toHaveBeenCalledTimes(2);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("marks a draft ready once, and leaves it open — never polling for ever — when GitHub refuses", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    github.readPullRequest.mockResolvedValue({ ...GREEN, isDraft: true });
    github.markPullRequestReady.mockResolvedValue({ ok: false, detail: "gh: could not mark it ready." });
    const board = await team.startTeam({ goal: "Build it, open a pull request and merge it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.pr).toMatchObject({ phase: "left_open", detail: "gh: could not mark it ready." });
    expect(github.markPullRequestReady).toHaveBeenCalledTimes(1);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("fails the team with GitHub's reason when the pull request cannot be opened", async () => {
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    github.openPullRequest.mockResolvedValue({ ok: false, detail: "This project has no GitHub remote yet." });
    const board = await team.startTeam({ goal: "Build it and open a pull request", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("The goal asks for a pull request, and it could not be opened: This project has no GitHub remote yet.");
  });
});

describe("a goal that asks for a pull request, in a project with no branch of its own", () => {
  it("says on the board that none is opened, rather than skipping it in silence", async () => {
    runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/clawbox/data/code-projects/site", projectId: "site" });
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "Build it and open a PR", projectId: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.pr).toBeNull();
    expect(github.openPullRequest).not.toHaveBeenCalled();
    expect(done.log.map((e) => e.message)).toContain("The goal asks for a pull request, but this team works in place (a code project, no branch of its own), so none is opened: the work stays in the project.");
  });
});


describe("cost: run or team, the repo map, tokens per role, and the battery", () => {
  const roleOf = (s: Record<string, unknown>) => (s.team as { role: string } | null)?.role ?? "run";
  const MAP = { files: ["index.html — the page", "app.js — its script"], entry_points: ["index.html"], test_commands: ["npm test -- --maxWorkers=1"], gotchas: ["app.js is loaded as a module"] };

  it("runs a ONE-task plan as one ordinary run — no team branch, worktree or reviewer — and the board follows it", async () => {
    outcomes = [
      { summary: JSON.stringify({ repo_map: MAP, tasks: [{ task_description: "Fix the typo in README.md", files_hint: ["README.md"] }] }), tokensUsed: 9_000 },
      { summary: "Fixed the typo in README.md.", filesTouched: ["/home/clawbox/Projects/site/README.md"], tokensUsed: 41_000 },
    ];
    const board = await team.startTeam({ goal: "Fix the typo in the readme", directory: "site", source: "agent" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.map(roleOf)).toEqual(["planner", "run"]);
    const single = starts[1];
    // An ordinary run: in the project, the owner's goal first, the planner's map in its brief.
    expect(single).toMatchObject({ directory: "/home/clawbox/Projects/site", source: "agent" });
    expect(single.team).toBeUndefined();
    expect(single.readOnly).toBeUndefined();
    expect(String(single.task).split("\n")[0]).toBe("Fix the typo in the readme");
    expect(String(single.task)).toContain("The team's planner wrote it up as: Fix the typo in README.md");
    expect(String(single.extraBrief)).toContain("Test commands: npm test -- --maxWorkers=1");
    expect(plumbing.ensureTeamBranch).not.toHaveBeenCalled();
    expect(plumbing.addWorkerWorktree).not.toHaveBeenCalled();
    expect(done.branch).toBeNull();
    expect(done.singleRun).toBe(true);
    // The run settled the owner's usual way, with its own card: no second notice for the team — the chat still hears.
    await vi.waitFor(() => expect(gateway.gatewayWsChatSendMain).toHaveBeenCalledTimes(1));
    expect(notify.announceCodingTeam).not.toHaveBeenCalled();
    expect(done.advice).toEqual({ reason: "one_task", overlap: 100 });
    expect(done.tasks[0]).toMatchObject({ status: "complete", assigned_to: "run-00000002", result: "Fixed the typo in README.md.", review: { verdict: "accepted" } });
    expect(done.log.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/one task, so it runs as one ordinary run/)]));
    expect(done.metrics.tokensByRole).toEqual({ planner: 9_000, worker: 41_000, reviewer: 0, lead: 0 });
  });

  it("fails the team with the run when that one run does not finish", async () => {
    outcomes = [
      { summary: JSON.stringify([{ task_description: "Fix the typo in README.md", files_hint: ["README.md"] }]) },
      { status: "failed", error: "The harness exited." },
    ];
    const board = await team.startTeam({ goal: "Fix the typo", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/did not finish: The harness exited/);
    expect(done.tasks[0].status).toBe("failed");
  });

  it("hands the planner's repo map to every worker, said in its own worktree, and to every reviewer", async () => {
    outcomes = [
      { summary: JSON.stringify({ repo_map: { ...MAP, files: ["/home/clawbox/Projects/site/index.html — the page"] }, tasks: JSON.parse(PLAN) }) },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.repoMap?.testCommands).toEqual(["npm test -- --maxWorkers=1"]);
    const workers = starts.filter((s) => roleOf(s) === "worker");
    const reviewers = starts.filter((s) => roleOf(s) === "reviewer");
    expect(workers).toHaveLength(2);
    expect(reviewers).toHaveLength(2);
    for (const w of workers) {
      expect(String(w.extraBrief)).toContain(team.WORKER_BRIEF);
      expect(String(w.extraBrief)).toContain("Repo map — the team planner's map");
      // The project's path, said in the worker's own copy of it.
      expect(String(w.extraBrief)).toMatch(/\/\.clawbox\/worktrees\/t\d-1\/index\.html — the page/);
    }
    for (const r of reviewers) expect(String(r.extraBrief)).toContain("Test commands: npm test -- --maxWorkers=1");
  });

  it("starts ONE worker at a time on battery, says so, and shares no CPU budget it does not have", async () => {
    power.onBattery = true;
    outcomes = [
      { summary: PARALLEL_PLAN },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const workers = starts.filter((s) => roleOf(s) === "worker");
    expect(workers).toHaveLength(3);
    // Nobody started beside a worker still going.
    const workerIds = [...runs.values()].filter((r) => (r.team as { role?: string } | null)?.role === "worker").map((r) => String(r.id));
    expect(workerIds.map((id) => liveWorkersAtStart[id])).toEqual([0, 0, 0]);
    expect(workers.every((w) => w.cpuShare === 1)).toBe(true);
    expect(done.log.map((e) => e.message)).toContain("The box is on battery: one worker at a time until it is plugged in again.");
  });

  it("on mains, shares the CPU budget between the workers the plan allows side by side", async () => {
    outcomes = [
      { summary: PARALLEL_PLAN },
      { summary: "index done", filesTouched: ["index.html"] },
      { summary: "styles done", filesTouched: ["styles.css"] },
      { summary: "app done", filesTouched: ["app.js"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const workers = starts.filter((s) => roleOf(s) === "worker");
    expect(workers.every((w) => w.cpuShare === 3)).toBe(true);
    expect(done.log.map((e) => e.message).filter((m) => /battery/.test(m))).toEqual([]);
  });

  it("puts each role's tokens on the figures", async () => {
    outcomes = [
      { summary: PLAN, tokensUsed: 10_000 },
      { summary: "index done", filesTouched: ["index.html"], tokensUsed: 60_000 },
      { summary: "app done", filesTouched: ["app.js"], tokensUsed: 30_000 },
    ];
    reviews = [
      { summary: JSON.stringify({ verdict: "accepted", notes: "" }), tokensUsed: 4_000 },
      { summary: JSON.stringify({ verdict: "accepted", notes: "" }), tokensUsed: 5_000 },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.metrics.tokensByRole).toEqual({ planner: 10_000, worker: 90_000, reviewer: 9_000, lead: 0 });
    expect(done.metrics.tokensUsed).toBe(109_000);
  });

  it("runs a plan whose tasks mostly touch the same files as ONE ordinary run, says so up front, and keeps the advice", async () => {
    outcomes = [
      { summary: JSON.stringify([
        { task_description: "Add the header to index.html", files_hint: ["index.html", "styles.css"] },
        { task_description: "Add the footer to index.html", depends_on: ["t1"], files_hint: ["index.html", "styles.css"] },
      ]) },
      { summary: "Header and footer done.", filesTouched: ["index.html"] },
    ];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.map(roleOf)).toEqual(["planner", "run"]);
    expect(plumbing.ensureTeamBranch).not.toHaveBeenCalled();
    expect(String(starts[1].task)).toContain("1. Add the header to index.html (files: index.html, styles.css)\n2. Add the footer to index.html");
    expect(done.singleRun).toBe(true);
    expect(done.advice).toEqual({ reason: "overlap", overlap: 100 });
    expect(done.log.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^100% of the files this plan's tasks name are named by another task too: side by side they would only conflict, so its 2 tasks run as one ordinary run/)]));
    expect(done.tasks.map((t) => [t.status, t.assigned_to, t.review?.verdict])).toEqual([["complete", "run-00000002", "accepted"], ["complete", "run-00000002", "accepted"]]);
  });
});

describe("per-role models: bulk tasks, each run's own account, the cost by provider", () => {
  const roleOfStart = (s: Record<string, unknown>) => (s.team as { role: string } | null)?.role ?? "run";
  const NOT_CONNECTED = "Anthropic is not connected on this ClawBox.";
  /** A team on two accounts: its bulk work on ClawBox AI's flash tier, everything else on Anthropic. */
  const MIXED = roleMap({
    planner: { provider: "anthropic", model: "claude-sonnet-5", relativeCost: 10, auto: false },
    worker: { provider: "anthropic", model: "claude-opus-5-5", relativeCost: 20, auto: false },
    reviewer: { provider: "anthropic", model: "claude-sonnet-5", relativeCost: 10, auto: false },
    bulk: { provider: "clawbox-ai", model: "deepseek-v4-flash", relativeCost: 1, auto: false },
  });
  /** The runner as it starts a team's fresh run: on its role's provider and model, the record saying so. */
  function startsOnRole(map: RoleModelMap) {
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      const t = input.team as { role: string; bulk?: boolean };
      const modelRole = t.role === "lead" ? "planner" : t.role === "worker" && t.bulk === true ? "bulk" : (t.role as "planner" | "worker" | "reviewer");
      const r = map[modelRole];
      return Object.assign(fakeRun(input), { provider: r.provider, requestedModel: r.model, modelRole, model: null, modelsUsed: [] });
    });
  }
  const BULK_PLAN = JSON.stringify([
    { task_description: "Scrape the catalogue into data/items.json", files_hint: ["data/items.json"], role: "bulk" },
    { task_description: "Build the page from data/items.json", depends_on: ["t1"], files_hint: ["index.html"], role: "worker" },
  ]);
  const ACCEPTED = JSON.stringify({ verdict: "accepted", notes: "" });

  it("starts a bulk task's worker on the bulk role, keeps every run's own provider and model, and splits the cost by provider", async () => {
    runner.teamRoleModelMap.mockImplementation(async () => MIXED);
    startsOnRole(MIXED);
    outcomes = [
      { summary: BULK_PLAN, tokensUsed: 5_000 },
      { summary: "Scraped 400 items.\nCould not finish: two pages timed out.", filesTouched: ["data/items.json"], tokensUsed: 80_000, model: "deepseek-v4-flash" },
      { summary: "Built the page.", filesTouched: ["index.html"], tokensUsed: 30_000, model: "claude-opus-5-5", modelsUsed: ["claude-haiku-4-5", "claude-opus-5-5"] },
    ];
    reviews = [{ summary: ACCEPTED, tokensUsed: 2_000 }, { summary: ACCEPTED, tokensUsed: 3_000 }];
    const board = await team.startTeam({ goal: "Scrape the catalogue and build a page from it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(starts.map(roleOfStart)).toEqual(["planner", "worker", "reviewer", "worker", "reviewer"]);
    // The plan's mark is on the board, and only the bulk task's worker asked for the bulk role.
    expect(done.tasks.map((t) => [t.task_id, t.role])).toEqual([["t1", "bulk"], ["t2", undefined]]);
    expect(starts.filter((s) => roleOfStart(s) === "worker").map((w) => w.team)).toEqual([
      { id: board.id, role: "worker", taskId: "t1", bulk: true },
      { id: board.id, role: "worker", taskId: "t2" },
    ]);
    // The planner was told what each role runs on and costs: bulk is a real choice on this box.
    const brief = String(starts[0].extraBrief);
    expect(brief).toContain("- bulk: deepseek-v4-flash on ClawBox AI, ~1x");
    expect(brief).toContain("- worker: claude-opus-5-5 on Anthropic, ~20x");
    expect(brief).toContain("- planner (and the lead): claude-sonnet-5 on Anthropic, ~10x");
    expect(brief).toContain('"role": "worker" | "bulk"');
    // Every run keeps its own account and model — what answered, once it settled.
    const cast = done.runs.map((r) => [r.role, r.taskId, r.provider, r.model, r.modelRole]);
    expect(cast).toEqual([
      ["planner", null, "anthropic", "claude-sonnet-5", "planner"],
      ["worker", "t1", "clawbox-ai", "deepseek-v4-flash", "bulk"],
      ["reviewer", "t1", "anthropic", "claude-sonnet-5", "reviewer"],
      ["worker", "t2", "anthropic", "claude-opus-5-5", "worker"],
      ["reviewer", "t2", "anthropic", "claude-sonnet-5", "reviewer"],
    ]);
    expect(done.metrics.tokensByProvider).toEqual({ "clawbox-ai": 80_000, anthropic: 40_000, openai: 0 });
    expect(done.metrics.tokensUsed).toBe(120_000);
    // And the same off disk.
    const { loadBoard } = await import("@/lib/coding-team-board");
    const disk = loadBoard(board.id)!;
    expect(disk.runs.map((r) => [r.role, r.taskId, r.provider, r.model, r.modelRole])).toEqual(cast);
    expect(disk.metrics.tokensByProvider).toEqual(done.metrics.tokensByProvider);
    expect(disk.tasks[0].role).toBe("bulk");
    expect(disk.tasks[1]).not.toHaveProperty("role");
  });

  it("works a bulk task with an ordinary worker when the bulk role's account cannot run — with a note, never a refused team", async () => {
    const map = roleMap({ bulk: { provider: "anthropic", model: "claude-sonnet-5", relativeCost: 10, auto: false, ready: false, problems: [NOT_CONNECTED] } });
    runner.teamRoleModelMap.mockImplementation(async () => map);
    startsOnRole(map);
    outcomes = [{ summary: BULK_PLAN }, { summary: "Scraped.", filesTouched: ["data/items.json"] }, { summary: "Built.", filesTouched: ["index.html"] }];
    const board = await team.startTeam({ goal: "Scrape and build", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    expect(done.alerts).toBe(0);
    // The planner was told before it planned.
    expect(String(starts[0].extraBrief)).toContain(`- bulk: claude-sonnet-5 on Anthropic, ~10x — UNAVAILABLE: ${NOT_CONNECTED} A task marked bulk runs as an ordinary worker until it is.`);
    expect(starts.filter((s) => roleOfStart(s) === "worker").map((w) => (w.team as { bulk?: boolean }).bulk)).toEqual([undefined, undefined]);
    expect(done.runs.find((r) => r.role === "worker" && r.taskId === "t1")).toMatchObject({ provider: "clawbox-ai", modelRole: "worker" });
    expect(done.log.filter((e) => e.type === "note" && /marked bulk/.test(e.message)).map((e) => [e.task_id, e.message])).toEqual([
      ["t1", `Task t1 is marked bulk, but the bulk role's provider is unavailable — Anthropic cannot run right now: ${NOT_CONNECTED} It runs as an ordinary worker, on the workers' model.`],
    ]);
    // Still the plan's bulk task: the mark stays, only the worker changed.
    expect(done.tasks[0].role).toBe("bulk");
  });

  it("falls back the same way when the bulk spawn itself is refused for its account", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    runner.teamRoleModelMap.mockImplementation(async () => MIXED);
    startsOnRole(MIXED);
    const onRole = runner.startRun.getMockImplementation()!;
    runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
      if ((input.team as { bulk?: boolean }).bulk) throw new CodingAgentError("not_ready", "ClawBox AI is not connected.");
      return onRole(input);
    });
    outcomes = [{ summary: BULK_PLAN }, { summary: "Scraped.", filesTouched: ["data/items.json"] }, { summary: "Built.", filesTouched: ["index.html"] }];
    const board = await team.startTeam({ goal: "Scrape and build", directory: "site", source: "owner" });
    const done = await finished(board.id);
    expect(done.status).toBe("done");
    const t1 = runner.startRun.mock.calls.map(([input]) => input.team as { role: string; taskId: string | null }).filter((t) => t.role === "worker" && t.taskId === "t1");
    expect(t1).toEqual([{ id: board.id, role: "worker", taskId: "t1", bulk: true }, { id: board.id, role: "worker", taskId: "t1" }]);
    expect(done.runs.find((r) => r.role === "worker" && r.taskId === "t1")).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", modelRole: "worker" });
    expect(done.log.map((e) => e.message)).toContain("Task t1 is marked bulk, but the bulk role's provider is unavailable — ClawBox AI is not connected. It runs as an ordinary worker, on the workers' model.");
    expect(done.alerts).toBe(0);
  });

  it("refuses the team before any spawn when its planner, workers or reviewers cannot run — not_ready, naming the role, the provider and why", async () => {
    runner.teamRoleModelMap.mockImplementation(async () => roleMap({
      planner: { provider: "anthropic", model: "claude-sonnet-5", ready: false, problems: [NOT_CONNECTED] },
      reviewer: { provider: "anthropic", model: "claude-sonnet-5", ready: false, problems: [NOT_CONNECTED] },
    }));
    await expect(team.startTeam({ goal: "Build it", directory: "site", source: "owner" })).rejects.toMatchObject({
      kind: "not_ready",
      message: `The team's planner and reviewer run on Anthropic (anthropic), which cannot run right now: ${NOT_CONNECTED} Connect it, or choose another provider for the planner and reviewer under Team models in the Coding Agent settings.`,
    });
    // The workers, on the box's own account: refused the same way, in their own words.
    runner.teamRoleModelMap.mockImplementation(async () => roleMap({ worker: { ready: false, problems: ["Claude Code is not installed.", "ClawBox AI is not connected."] } }));
    await expect(team.startTeam({ goal: "Build it", directory: "site", source: "agent" })).rejects.toMatchObject({
      kind: "not_ready",
      message: expect.stringMatching(/^The team's worker runs on ClawBox AI \(clawbox-ai\), which cannot run right now: Claude Code is not installed\. ClawBox AI is not connected\. Connect it/),
    });
    // Nothing was made, queued or spawned.
    expect(runner.startRun).not.toHaveBeenCalled();
    expect(team.listTeams()).toEqual([]);
    expect(team.activeTeamId()).toBeNull();
  });

  it("starts the team when only the role models cannot be read: every run is still judged at its own spawn", async () => {
    runner.teamRoleModelMap.mockRejectedValue(new Error("config unreadable"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    outcomes = [{ summary: PLAN }, { summary: "index done", filesTouched: ["index.html"] }, { summary: "app done", filesTouched: ["app.js"] }];
    const board = await team.startTeam({ goal: "Build it", directory: "site", source: "owner" });
    const done = await finished(board.id);
    quiet.mockRestore();
    expect(done.status).toBe("done");
    expect(String(starts[0].extraBrief)).not.toContain("Team models");
    // Runs whose records name no provider keep the cast list as it was.
    expect(done.runs.every((r) => !("provider" in r) && !("model" in r))).toBe(true);
    expect(done.metrics.tokensByProvider).toEqual({ "clawbox-ai": 0, anthropic: 0, openai: 0 });
  });
});
