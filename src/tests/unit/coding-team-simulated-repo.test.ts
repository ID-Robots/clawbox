/**
 * A coding team in a SIMULATED repository: a real git repo in the system's
 * temp folder — a few files on `develop` and a fake test script — the team's
 * real git plumbing (its branch, a worktree per worker, the merges home, the
 * conflicts git cannot settle), and a scripted runner whose workers write and
 * commit real files in their worktrees. No model runs.
 *
 * Four ways teams failed with nothing wrong in the code (night run, 2026-10-29):
 *
 *  - a team restarted in the same folder forked from the failed team's branch
 *    and rebuilt the fixes it already carried, conflicting with itself;
 *  - merge conflicts and one refused command spent the alert ceiling of a team
 *    whose integration worker had every check green, and it was stopped;
 *  - a reviewer that could run nothing ("static review only") was taken as a
 *    review, and a finished team published nothing;
 *  - a plan whose tasks touch the same files ran side by side anyway, and was
 *    told only afterwards that one run would have been cheaper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Real git processes, several per worker: vitest's 5 s default is not enough
// on a loaded runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

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
  getAutoPr: vi.fn(),
  getPrBodyIncludesTask: vi.fn(),
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
// The notices, mocked: the finish notice is coding-agent-notify.test.ts's to
// test, and a real one would reach the owner's own Telegram from a test.
vi.mock("@/lib/coding-agent-notify", () => ({
  announceCodingAgent: vi.fn(async () => undefined),
  announceCodingTeam: vi.fn(async () => undefined),
  announceAnthropicLimit: vi.fn(async () => undefined),
}));
// The gateway link a settled team's chat line goes over, mocked: a real one
// would post into the owner's chat from a test.
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()), gatewayWsChatSendMain: vi.fn(async () => ({ sessionKey: "main" })) }));
vi.mock("@/lib/coding-run-cpu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-run-cpu")>();
  return { ...actual, onBatteryPower: vi.fn(async () => false) };
});
// GitHub, faked where the orchestrator reaches it. The git plumbing is NOT.
const github = vi.hoisted(() => ({
  openPullRequest: vi.fn(),
  readPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  markPullRequestReady: vi.fn(),
  pushBranch: vi.fn(),
}));
vi.mock("@/lib/coding-pr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-pr")>();
  return { ...actual, openPullRequest: github.openPullRequest, readPullRequest: github.readPullRequest, mergePullRequest: github.mergePullRequest, markPullRequestReady: github.markPullRequestReady };
});
vi.mock("@/lib/coding-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-review")>();
  return { ...actual, pushBranch: github.pushBranch };
});

type Team = typeof import("@/lib/coding-team");
let team: Team;

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();

/** The simulated project: on `develop`, a keyboard module, its spec, and a test script that only says it passed. */
let repo: string;
function makeRepo(): string {
  const dir = path.join(root, "skyhub");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "spec"), { recursive: true });
  git(dir, "init", "-q", "-b", "develop");
  git(dir, "config", "user.email", "t@x");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "src", "keyboard.js"), "export const up = -1;\n");
  fs.writeFileSync(path.join(dir, "spec", "keyboard.spec.js"), "expect(up).toBe(-1);\n");
  fs.writeFileSync(path.join(dir, "test.sh"), "#!/bin/sh\necho 'keyboard.spec.js: 3 passing'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "README.md"), "# skyhub (simulated)\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

/** What the fake test script prints: the evidence a worker quotes. */
const testScriptSays = () => execFileSync("sh", [path.join(repo, "test.sh")], { encoding: "utf8" }).trim();

/**
 * How a run ends, keyed `<who>#<n>`: `planner#1`, `t1#2` (the second worker
 * run on t1, whichever team), `review:t1#1`, `run#1` (an ordinary run).
 * `writes` are written in the run's folder and committed there, as the runner
 * commits a worker's work; `when` holds the run open until it is true.
 * `ownBranch` is a branch the worker makes itself (`git checkout -b`) before
 * it writes, and `backAfter` checks its given branch out again once it has
 * committed there.
 */
type Outcome = Partial<{ status: string; summary: string; error: string; writes: Record<string, string>; permissionDenials: number; deniedActions: string[]; when: () => boolean; ownBranch: string; backAfter: boolean }>;
let script: Record<string, Outcome>;
let runs: Map<string, Record<string, unknown>>;
let starts: Array<Record<string, unknown> & { key: string }>;
let seq: number;
const counts = new Map<string, number>();

function keyOf(input: Record<string, unknown>): string {
  const t = (input.team ?? null) as { role?: string; taskId?: string | null } | null;
  const who = !t ? "run" : t.role === "planner" ? "planner" : t.role === "reviewer" ? `review:${t.taskId ?? "final"}` : t.role === "lead" ? "lead" : String(t.taskId);
  const n = (counts.get(who) ?? 0) + 1;
  counts.set(who, n);
  return `${who}#${n}`;
}

function fakeRun(input: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  const id = `run-${String(seq).padStart(8, "0")}`;
  const key = keyOf(input);
  const run = {
    id, key, task: input.task, directory: String(input.directory ?? repo), projectId: null, source: input.source,
    status: "running", startedAt: Date.now(), completedAt: null, summary: null, error: null,
    filesTouched: [] as string[], permissionDenials: 0, deniedActions: [] as string[],
    team: input.team ?? null, readOnly: input.readOnly === true, extraBrief: input.extraBrief ?? null,
  };
  runs.set(id, run);
  starts.push({ ...input, key });
  return run;
}

const ACCEPT = JSON.stringify({ verdict: "accepted", notes: "" });

function settleRun(run: Record<string, unknown>): void {
  const key = String(run.key);
  const outcome = script[key] ?? (key.startsWith("review:") ? { summary: ACCEPT } : { summary: "done" });
  const { writes, ownBranch, backAfter, ...rest } = outcome;
  delete rest.when;
  const dir = String(run.directory);
  const files = Object.keys(writes ?? {});
  const given = ownBranch ? git(dir, "rev-parse", "--abbrev-ref", "HEAD") : null;
  if (ownBranch) git(dir, "checkout", "-q", "-b", ownBranch);
  for (const [file, content] of Object.entries(writes ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  // The runner commits what a worker wrote in its worktree when it finishes.
  if (files.length && dir.includes(`${path.sep}.clawbox${path.sep}worktrees${path.sep}`)) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `Coding agent: ${key}`);
  }
  if (given && backAfter) git(dir, "checkout", "-q", given);
  Object.assign(run, { status: "completed", completedAt: Date.now(), filesTouched: files }, rest);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "team-sim-"));
  repo = makeRepo();
  runs = new Map();
  starts = [];
  seq = 0;
  counts.clear();
  script = {};
  vi.resetModules();
  vi.clearAllMocks();
  runner.isCodingAgentEnabled.mockResolvedValue(true);
  runner.getTeamDynamic.mockResolvedValue(false);
  // The owner's pull-request switch: off unless a case turns it on.
  runner.getAutoPr.mockResolvedValue(false);
  // How much of the task a pull request carries: the box's default unless a case says otherwise.
  runner.getPrBodyIncludesTask.mockResolvedValue("summary");
  runner.resolveWorkingDirectory.mockImplementation(async () => ({ directory: repo, projectId: null }));
  // Every role ready on the box's own provider.
  runner.teamRoleModelMap.mockImplementation(async () => {
    const ready = { provider: "clawbox-ai" as const, model: null, effort: "high" as const, auto: true, ready: true, problems: [], relativeCost: null };
    return { planner: ready, worker: ready, reviewer: ready };
  });
  runner.getMaxParallelRuns.mockResolvedValue(16);
  runner.suiteSandbox.mockResolvedValue({ bin: "/usr/bin/env", args: [], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root } });
  runner.startRun.mockImplementation(async (input: Record<string, unknown>) => fakeRun(input));
  runner.waitForRun.mockImplementation(async (id: string) => {
    const run = runs.get(id);
    if (!run) return null;
    if (run.status === "running") {
      const when = script[String(run.key)]?.when;
      if (when && !when()) {
        // Still working: a real wait blocks, and a spinning one would starve git.
        await new Promise((r) => setTimeout(r, 20));
        return run;
      }
      settleRun(run);
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
  team = await import("@/lib/coding-team");
  team._setTeamPrTimingForTests(5, 60_000);
  github.openPullRequest.mockResolvedValue({ ok: true, number: 77, url: "https://github.com/o/skyhub/pull/77" });
  github.readPullRequest.mockResolvedValue({ state: "OPEN", mergeable: "MERGEABLE", checks: { total: 2, passed: 2, failed: 0, pending: 0 }, noChecks: false, isDraft: false, labels: [] });
  github.pushBranch.mockResolvedValue({ ok: true });
});

afterEach(() => {
  team._resetCodingTeamStateForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

async function finished(id: string) {
  for (let i = 0; i < 4000 && !["done", "failed", "stopped"].includes(team.getTeam(id)?.status ?? ""); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return team.getTeam(id)!;
}

const roleOf = (s: Record<string, unknown>) => (s.team as { role: string } | null)?.role ?? "run";
const messages = (board: { log: Array<{ message: string }> }) => board.log.map((e) => e.message);
const plan = (tasks: Array<Record<string, unknown>>) => ({ summary: JSON.stringify(tasks) });
/** The checkout's team branch is where merges land: a file there is a merged one. */
const merged = (file: string) => () => fs.existsSync(path.join(repo, file));

describe("D1: a team started after a failed one", () => {
  it("forks from the project's base branch, never from the failed team's branch it finds checked out", async () => {
    const PLAN = [
      { task_description: "Make ↑ fly forward in the keyboard flight", files_hint: ["src/keyboard.js"] },
      { task_description: "Update the keyboard spec to the new sign", depends_on: ["t1"], files_hint: ["spec/keyboard.spec.js"] },
    ];
    // The first team: its t1 fix is merged on its branch, then t2 fails, and so does the team.
    script = {
      "planner#1": plan(PLAN),
      "t1#1": { summary: "↑ flies forward", writes: { "src/keyboard.js": "export const up = 1;\n" } },
      "t2#1": { status: "failed", error: "Stopped at the cost ceiling" },
      // The restart: the same plan, the same fix built again from the base.
      "planner#2": plan(PLAN),
      "t1#2": { summary: "↑ flies forward", writes: { "src/keyboard.js": "export const up = 1;\n" } },
      "t2#2": { summary: "spec updated", writes: { "spec/keyboard.spec.js": "expect(up).toBe(1);\n" } },
    };
    const first = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard", source: "agent" })).id);
    expect(first.status).toBe("failed");
    expect(first.base).toBe("develop");
    // What a failed team leaves behind: the checkout on its branch, its fix on it.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(first.branch);
    const leftover = git(repo, "rev-parse", String(first.branch));

    const second = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard", source: "agent" })).id);
    expect(second.base).toBe("develop");
    expect(second.branch).toBe(`clawbox/${second.id}`);
    // It does not carry the failed team's commits: it forked from develop.
    expect(() => git(repo, "merge-base", "--is-ancestor", leftover, String(second.branch))).toThrow();
    expect(git(repo, "merge-base", "develop", String(second.branch))).toBe(git(repo, "rev-parse", "develop"));
    expect(second.status).toBe("done");
    expect(second.alerts).toBe(0);
  });
});

describe("D2: the alert ceiling", () => {
  // Two workers fix the same line side by side (one conflict), one worker is
  // refused a push it was never meant to make, and the integration worker is
  // refused once too before it reports every check green.
  const PLAN = [
    { task_description: "Make ↑ fly forward in the keyboard flight", files_hint: ["src/keyboard.js", "docs/keys.md"] },
    { task_description: "Make PgUp climb with the same sign as a stick pushed forward", files_hint: ["src/keyboard.js", "docs/pgup.md", "docs/notes.md"] },
    { task_description: "Integration: run Biome, Jest, the build and Playwright on the merged result", depends_on: ["t1", "t2"], files_hint: ["docs/integration.md", "docs/ci.md", "test.sh"] },
  ];
  const PUSH_REFUSED = { permissionDenials: 1, deniedActions: ["Bash: git push origin HEAD"] };

  it("does not count merge conflicts or a refused command: the team finishes done with the integration worker's green result", async () => {
    script = {
      "planner#1": plan(PLAN),
      "t1#1": { summary: "↑ flies forward", writes: { "src/keyboard.js": "export const up = 1;\n", "docs/keys.md": "↑ forward\n" }, ...PUSH_REFUSED },
      // Forked before t1 merged, home after: the same line, a real conflict.
      "t2#1": { summary: "PgUp climbs", writes: { "src/keyboard.js": "export const up = -1;\nexport const pgUp = 1;\n", "docs/pgup.md": "PgUp climbs\n" }, when: merged("docs/keys.md") },
      "t1#2": { summary: "↑ flies forward, notes updated", writes: { "docs/keys.md": "↑ flies forward\n" } },
      "t2#2": { summary: "PgUp climbs", writes: { "src/keyboard.js": "export const up = 1;\nexport const pgUp = 1;\n", "docs/pgup.md": "PgUp climbs\n" } },
      "t3#1": { summary: `Biome, Jest, build and Playwright all green. ${testScriptSays()}`, writes: { "docs/integration.md": "green\n" }, ...PUSH_REFUSED },
      "t3#2": { summary: `Biome, Jest, build and Playwright all green. ${testScriptSays()}`, writes: { "docs/integration.md": "all green\n" } },
    };
    const done = await finished((await team.startTeam({ goal: "Forward/back on the keyboard, both arrows", source: "agent" })).id);
    const said = messages(done);
    // All three are on the record, as alerts…
    expect(said.filter((m) => /Merge conflict for t2/.test(m))).toHaveLength(1);
    expect(said.filter((m) => /refused 1 action\(s\): Bash: git push origin HEAD/.test(m))).toHaveLength(2);
    expect(done.alerts).toBe(3);
    // …and none of them is the team failing.
    expect(done.error ?? null).toBeNull();
    expect(done.status).toBe("done");
    expect(done.tasks.map((t) => [t.task_id, t.status, t.review?.verdict])).toEqual([["t1", "complete", "accepted"], ["t2", "complete", "accepted"], ["t3", "complete", "accepted"]]);
    expect(fs.readFileSync(path.join(repo, "docs", "integration.md"), "utf8")).toBe("all green\n");
  });

  it("finishes done once every planned task is accepted, whatever the alert count", async () => {
    // Each reviewer answers prose twice: accepted by rule, one counted alert each.
    script = {
      "planner#1": plan(PLAN.slice(0, 2).map((t, i) => ({ ...t, files_hint: [`docs/part${i + 1}.md`] })).concat([{ task_description: "Write the changelog", files_hint: ["CHANGELOG.md"] }])),
      "t1#1": { summary: "part 1", writes: { "docs/part1.md": "1\n" } },
      "t2#1": { summary: "part 2", writes: { "docs/part2.md": "2\n" } },
      "t3#1": { summary: "changelog", writes: { "CHANGELOG.md": "- keys\n" } },
      ...Object.fromEntries(["t1", "t2", "t3"].flatMap((t) => [[`review:${t}#1`, { summary: "Looks right to me." }], [`review:${t}#2`, { summary: "Still looks right." }]])),
    };
    const done = await finished((await team.startTeam({ goal: "Three small parts", source: "agent" })).id);
    expect(done.alerts).toBe(3);
    expect(done.tasks.every((t) => t.status === "complete" && t.review?.verdict === "accepted")).toBe(true);
    expect(done.status).toBe("done");
  });
});

describe("D3: the reviewer gate and the team's pull request", () => {
  const PLAN = [
    { task_description: "Make ↑ fly forward in the keyboard flight", files_hint: ["src/keyboard.js"] },
    { task_description: "Update the keyboard spec to the new sign", files_hint: ["spec/keyboard.spec.js"] },
  ];

  it("reviews each task ONCE, with a shell in a throwaway checkout of the merged work, and takes the checkout away after", async () => {
    script = {
      "planner#1": plan(PLAN),
      "t1#1": { summary: `↑ flies forward. ${testScriptSays()}`, writes: { "src/keyboard.js": "export const up = 1;\n" } },
      "t2#1": { summary: "spec updated", writes: { "spec/keyboard.spec.js": "expect(up).toBe(1);\n" }, when: merged("src/keyboard.js") },
      "review:t1#1": { summary: JSON.stringify({ verdict: "accepted", notes: "Ran git diff develop and sh test.sh: 3 passing." }) },
    };
    const done = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard", source: "agent" })).id);
    expect(done.status).toBe("done");
    const reviewers = starts.filter((s) => s.key.startsWith("review:t1#"));
    expect(reviewers).toHaveLength(1);
    // Not read-only — a team run that writes, which is what the merge deny-list
    // and the hook's merge guard key on — in a worktree of the merged work, told
    // where it stands and where the project's node_modules are.
    const [reviewer] = reviewers;
    expect(reviewer.readOnly).not.toBe(true);
    expect(reviewer.team).toMatchObject({ role: "reviewer", taskId: "t1" });
    expect(String(reviewer.directory)).toContain(`${path.sep}.clawbox${path.sep}worktrees${path.sep}review-t1-1`);
    expect(String(reviewer.task)).toContain(`Your folder: ${reviewer.directory} — a throwaway checkout of the team's branch ${done.branch}, forked from ${done.base}. The project itself is at ${repo};`);
    expect(String(reviewer.task)).toContain(`ln -s ${repo}/node_modules node_modules`);
    expect(String(reviewer.extraBrief)).toContain("with a shell");
    expect(String(reviewer.extraBrief)).not.toContain("Change NOTHING");
    expect(done.tasks[0].review).toMatchObject({ verdict: "accepted", notes: "Ran git diff develop and sh test.sh: 3 passing." });
    // The throwaway checkout is gone, its branch too.
    expect(git(repo, "worktree", "list")).not.toMatch(/review-t1/);
    expect(git(repo, "branch", "--list", "*review-t1*")).toBe("");
  });

  it("takes the reviewer's verdict as it is — a rejection stands, and a redo is reviewed again", async () => {
    const REJECTED = JSON.stringify({ verdict: "rejected", notes: "src/keyboard.js still exports -1: sh test.sh fails." });
    script = {
      "planner#1": plan(PLAN),
      "t1#1": { summary: `↑ flies forward. ${testScriptSays()}`, writes: { "src/keyboard.js": "export const up = -1; // unchanged\n" } },
      "t1#2": { summary: `↑ flies forward now. ${testScriptSays()}`, writes: { "src/keyboard.js": "export const up = 1;\n" } },
      "t2#1": { summary: `spec updated. ${testScriptSays()}`, writes: { "spec/keyboard.spec.js": "expect(up).toBe(1);\n" } },
      "review:t1#1": { summary: REJECTED },
    };
    const done = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard", source: "agent" })).id);
    expect(done.status).toBe("done");
    const t1 = done.tasks[0];
    expect(t1.attempts).toBe(2);
    expect(messages(done)).toEqual(expect.arrayContaining([expect.stringMatching(/^Task t1 rejected: src\/keyboard\.js still exports -1/)]));
    expect(t1.review?.verdict).toBe("accepted");
    // One shell review per attempt, each in its own checkout, none left behind.
    expect(starts.filter((s) => s.key.startsWith("review:t1#"))).toHaveLength(2);
    expect(git(repo, "worktree", "list")).not.toMatch(/review-/);
  });

  it("publishes the team's branch as one pull request when every task is accepted, the way a single run does — and none when pull requests are off", async () => {
    script = {
      "planner#1": plan(PLAN),
      "t1#1": { summary: "↑ flies forward", writes: { "src/keyboard.js": "export const up = 1;\n" } },
      "t2#1": { summary: "spec updated", writes: { "spec/keyboard.spec.js": "expect(up).toBe(1);\n" } },
    };
    runner.getAutoPr.mockResolvedValue(true);
    const done = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard", source: "agent" })).id);
    expect(done.status).toBe("done");
    expect(github.openPullRequest).toHaveBeenCalledTimes(1);
    expect(github.openPullRequest.mock.calls[0][0]).toMatchObject({ directory: repo, branch: `clawbox/${done.id}`, base: "develop" });
    expect(done.pr).toMatchObject({ number: 77, phase: "green", merge: false });

    // Pull requests switched off: the work stays on the team's branch.
    github.openPullRequest.mockClear();
    runner.getAutoPr.mockResolvedValue(false);
    script = {
      "planner#2": plan(PLAN),
      "t1#2": { summary: "↑ flies forward", writes: { "src/keyboard.js": "export const up = 2;\n" } },
      "t2#2": { summary: "spec updated", writes: { "spec/keyboard.spec.js": "expect(up).toBe(2);\n" } },
    };
    const off = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard", source: "agent" })).id);
    expect(off.status).toBe("done");
    expect(github.openPullRequest).not.toHaveBeenCalled();
    expect(off.pr).toBeNull();
  });

  it("keeps the goal out of the published pull request when the owner keeps the task out of pull requests, as a single run's", async () => {
    script = {
      "planner#1": plan(PLAN),
      "t1#1": { summary: "↑ flies forward", writes: { "src/keyboard.js": "export const up = 1;\n" } },
      "t2#1": { summary: "spec updated", writes: { "spec/keyboard.spec.js": "expect(up).toBe(1);\n" } },
    };
    runner.getAutoPr.mockResolvedValue(true);
    runner.getPrBodyIncludesTask.mockResolvedValue("none");
    const done = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard for the private customer build", source: "agent" })).id);
    expect(done.status).toBe("done");
    const body = String(github.openPullRequest.mock.calls[0][0].body);
    expect(body).not.toContain("private customer build");
    expect(body).not.toContain("Make ↑ fly forward");
    expect(body).toContain("- t1 — ↑ flies forward");
  });
});

describe("D4: a plan whose tasks touch the same files", () => {
  it("runs as ONE ordinary run from the start, and the board says so before anything runs", async () => {
    script = {
      "planner#1": plan([
        { task_description: "Make ↑ fly forward", files_hint: ["src/keyboard.js", "spec/keyboard.spec.js"] },
        { task_description: "Make PgUp climb with the same sign", depends_on: ["t1"], files_hint: ["src/keyboard.js", "spec/keyboard.spec.js"] },
      ]),
      "run#1": { summary: `Both arrows fixed. ${testScriptSays()}`, writes: { "src/keyboard.js": "export const up = 1;\nexport const pgUp = 1;\n" } },
    };
    const done = await finished((await team.startTeam({ goal: "Forward/back on the keyboard", source: "agent" })).id);
    expect(done.status).toBe("done");
    expect(starts.map(roleOf)).toEqual(["planner", "run"]);
    // An ordinary run: no team branch, no worktree, no reviewer run around it.
    expect(done.singleRun).toBe(true);
    expect(done.branch).toBeNull();
    expect(git(repo, "branch", "--list", "clawbox/team-*")).toBe("");
    const single = starts[1];
    expect(single.team).toBeUndefined();
    expect(String(single.task)).toContain("Make ↑ fly forward");
    expect(String(single.task)).toContain("Make PgUp climb with the same sign");
    // Said up front: the note is on the log before the run is assigned anything.
    const said = messages(done);
    const note = said.findIndex((m) => /100% of the files this plan's tasks name/.test(m) && /one ordinary run/.test(m));
    expect(note).toBeGreaterThanOrEqual(0);
    expect(note).toBeLessThan(said.findIndex((m) => /assigned to run-/.test(m)));
    expect(done.tasks.map((t) => [t.task_id, t.status, t.assigned_to, t.review?.verdict])).toEqual([
      ["t1", "complete", "run-00000002", "accepted"],
      ["t2", "complete", "run-00000002", "accepted"],
    ]);
  });
});

describe("D5: a worker that commits on a branch of its own", () => {
  // Two tasks on different files: a real team, a worktree per worker.
  const PLAN = [
    { task_description: "Make ↑ fly forward in the keyboard flight", files_hint: ["src/keyboard.js"] },
    { task_description: "Note the new sign in the README", files_hint: ["README.md"] },
  ];

  it("has its commits merged — not rejected as NO CHANGE — when it made the branch with `git checkout -b` and stayed on it", async () => {
    script = {
      "planner#1": plan(PLAN),
      "t1#1": { summary: "↑ flies forward, committed on fix/arrow-up", ownBranch: "fix/arrow-up", writes: { "src/keyboard.js": "export const up = 1;\n" } },
      "t2#1": { summary: "README notes the sign", writes: { "README.md": "# skyhub (simulated)\n\n↑ flies forward.\n" } },
    };
    const done = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard and say so", source: "agent" })).id);
    const said = messages(done);
    expect(said.some((m) => m.includes("NO CHANGE"))).toBe(false);
    expect(done.status).toBe("done");
    expect(done.tasks.map((t) => [t.task_id, t.status, t.attempts, t.review?.verdict])).toEqual([["t1", "complete", 1, "accepted"], ["t2", "complete", 1, "accepted"]]);
    // On the team branch, merged: the checkout is on it.
    expect(fs.readFileSync(path.join(repo, "src", "keyboard.js"), "utf8")).toBe("export const up = 1;\n");
    expect(said.some((m) => /committed on a branch of its own \(fix\/arrow-up\)/.test(m))).toBe(true);
    // The reviewer was shown the file, as for any worker.
    expect(String(starts.find((s) => s.key === "review:t1#1")?.task)).toContain("src/keyboard.js");
  });

  it("has its commits merged when it committed on its own branch and then checked its given branch out again", async () => {
    script = {
      "planner#1": plan(PLAN),
      "t1#1": { summary: "↑ flies forward", ownBranch: "fix/arrow-back", backAfter: true, writes: { "src/keyboard.js": "export const up = 1;\n" } },
      "t2#1": { summary: "README notes the sign", writes: { "README.md": "# skyhub (simulated)\n\n↑ flies forward.\n" } },
    };
    const done = await finished((await team.startTeam({ goal: "Fix ↑ on the keyboard and say so", source: "agent" })).id);
    expect(messages(done).some((m) => m.includes("NO CHANGE"))).toBe(false);
    expect(done.status).toBe("done");
    expect(done.tasks.every((t) => t.status === "complete" && t.attempts === 1)).toBe(true);
    expect(fs.readFileSync(path.join(repo, "src", "keyboard.js"), "utf8")).toBe("export const up = 1;\n");
  });
});
