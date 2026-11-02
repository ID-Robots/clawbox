/**
 * More than one run at a time, and what makes that safe.
 *
 * Until now the box allowed exactly one run and every run worked in the
 * project folder itself — the same fact twice. This covers the two halves of
 * taking that apart: the owner's `coding_agent_max_parallel_runs`, and the
 * worktree per run that stops two of them writing over each other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts a real process (bash / git): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
// Only the drawing is stubbed: a merge home reads the real BOX_FAVICONS
// (readCheckout in coding-team-worktree.ts) to tell the box's files from the owner's.
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));
// A roomy box for a team's second run: the memory guard reads MemAvailable,
// and the host's own is neither the fixture nor the same on every runner.
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projects: string;
let restore: () => void;

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/** A wrapper that runs `body` and exits. `$PWD` is the folder the run was given. */
function installWrapper(body: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), ["#!/usr/bin/env bash", readFirstTurn(), body].join("\n"), { mode: 0o755 });
}

const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-1" });

/**
 * The wrapper lines that write a file and report it the way the harness does.
 *
 * Two events, not one: a `tool_use` only PENDS the file, and the runner counts
 * it as changed when the matching `tool_result` comes back clean. And the path
 * has to be ABSOLUTE — a run whose `filesTouched` is empty is never committed
 * — so it is printed from `$PWD`, the only thing that knows the run's own copy
 * of the project.
 */
const wrote = (name: string) => [
  `echo "new" > "$PWD/${name}"`,
  `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"%s/${name}"}}]}}\\n' "$PWD"`,
  `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } })}'`,
];

/** A project folder under the owner's project folder, with a git history of its own. */
function makeGitProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

/** A project folder with no repository at all: the in-place path. */
function makePlainProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

async function finished(id: string) {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  return run;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-parallel-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects });
  installWrapper(`echo '${result("done")}'\nexit 0`);
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("how many runs at once", () => {
  it("defaults to two, refuses a number outside the range rather than clamping it, and reports the bounds", async () => {
    expect(await lib.getMaxParallelRuns()).toBe(lib.DEFAULT_MAX_PARALLEL_RUNS);
    expect(lib.DEFAULT_MAX_PARALLEL_RUNS).toBe(2);
    expect(await lib.setMaxParallelRuns(4)).toBe(4);
    expect(await lib.getMaxParallelRuns()).toBe(4);
    const ceiling = lib.hostMaxParallelRuns();
    await expect(lib.setMaxParallelRuns(ceiling + 1)).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.setMaxParallelRuns(0)).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.setMaxParallelRuns(2.5)).rejects.toMatchObject({ kind: "invalid" });
    // Refused, not saved: the value the owner had is still in force.
    expect(await lib.getMaxParallelRuns()).toBe(4);
    const status = await lib.getCodingAgentStatus();
    expect(status.maxParallelRuns).toBe(4);
    expect(status.minMaxParallelRuns).toBe(1);
    expect(status.maxMaxParallelRuns).toBe(ceiling);
  });

  it("scales the ceiling with the host: four on a Jetson or under 16 GB, one per 4 GB above, at most sixteen", () => {
    const GB = 1024 ** 3;
    expect(lib.hostMaxParallelRuns(8 * GB, true)).toBe(4);
    expect(lib.hostMaxParallelRuns(64 * GB, true)).toBe(4);
    expect(lib.hostMaxParallelRuns(8 * GB, false)).toBe(4);
    expect(lib.hostMaxParallelRuns(15.9 * GB, false)).toBe(4);
    expect(lib.hostMaxParallelRuns(16 * GB, false)).toBe(4);
    expect(lib.hostMaxParallelRuns(24 * GB, false)).toBe(6);
    expect(lib.hostMaxParallelRuns(62 * GB, false)).toBe(15);
    expect(lib.hostMaxParallelRuns(128 * GB, false)).toBe(16);
    expect(lib.hostMaxParallelRuns(Number.NaN, false)).toBe(4);
    expect(lib.maxParallelRunsFrom(8, 4)).toBe(2);
    expect(lib.maxParallelRunsFrom(8, 15)).toBe(8);
  });

  it("starts an automatic review pass beside a full box, from its own pool of two", async () => {
    const flag = path.join(base, "go");
    installWrapper([`echo '${result("done")}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
    makePlainProject("alpha");
    makePlainProject("beta");
    makePlainProject("gamma");
    makePlainProject("delta");
    await lib.setMaxParallelRuns(1);
    const a = await lib.startRun({ task: "one", directory: "alpha", source: "owner" });
    await expect(lib.startRun({ task: "two", directory: "beta", source: "owner" })).rejects.toMatchObject({ kind: "busy" });
    const r1 = await lib.startRun({ task: "review one", directory: "beta", source: "owner", reviewOf: a.id });
    const r2 = await lib.startRun({ task: "review two", directory: "gamma", source: "owner", reviewOf: a.id });
    expect(r1.status).toBe("running");
    expect(r2.status).toBe("running");
    await expect(lib.startRun({ task: "review three", directory: "delta", source: "owner", reviewOf: a.id }))
      .rejects.toMatchObject({ kind: "busy", message: expect.stringMatching(/review passes/) });
    fs.writeFileSync(flag, "go");
    await finished(a.id);
    await finished(r1.id);
    await finished(r2.id);
  });

  it("reads a value nothing on this box could have written as the default", async () => {
    expect(lib.maxParallelRunsFrom(undefined)).toBe(2);
    expect(lib.maxParallelRunsFrom("three")).toBe(2);
    expect(lib.maxParallelRunsFrom(99)).toBe(2);
    expect(lib.maxParallelRunsFrom(1)).toBe(1);
  });

  it("lets a second run start beside the first, and refuses the third at the limit", async () => {
    // A wrapper that waits for a flag file, so the runs are genuinely live.
    const flag = path.join(base, "go");
    installWrapper([`echo '${result("done")}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
    makeGitProject("alpha");
    makeGitProject("beta");
    makeGitProject("gamma");
    const a = await lib.startRun({ task: "one", directory: "alpha", source: "owner" });
    const b = await lib.startRun({ task: "two", directory: "beta", source: "owner" });
    expect(lib.runningCount()).toBe(2);
    await expect(lib.startRun({ task: "three", directory: "gamma", source: "owner" }))
      .rejects.toMatchObject({ kind: "busy" });
    fs.writeFileSync(flag, "go");
    await finished(a.id);
    await finished(b.id);
    // With the limit at one, the sentence is the old one — a named run to wait for.
    await lib.setMaxParallelRuns(1);
    const c = await lib.startRun({ task: "four", directory: "gamma", source: "owner" });
    expect(c.status).toBe("running");
  });

  /**
   * The scenario the whole change exists for: two runs at once inside ONE
   * repository. Two worktrees, two branches, one `.git` — and two settles
   * merging back into one base branch through the shared per-checkout lock,
   * which is what stops the second tripping over `.git/index.lock`.
   */
  it("runs two at once in ONE project, each in its own copy, and lands both merges in its history", async () => {
    const dir = makeGitProject("alpha");
    const flag = path.join(base, "go");
    // Each run writes a file named after the folder it was given — its own
    // copy — so the two can be told apart in the history afterwards.
    installWrapper([
      `while [ ! -f "${flag}" ]; do sleep 0.05; done`,
      'echo "new" > "$PWD/$(basename "$PWD").txt"',
      `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"%s/%s.txt"}}]}}\\n' "$PWD" "$(basename "$PWD")"`,
      `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } })}'`,
      `echo '${result("wrote a file")}'`,
      "exit 0",
    ].join("\n"));

    const a = await lib.startRun({ task: "one", directory: "alpha", source: "owner" });
    const b = await lib.startRun({ task: "two", directory: "alpha", source: "owner" });
    // Two copies of one project, each on its own branch, neither of them the
    // project folder itself.
    expect(a.directory).not.toBe(b.directory);
    expect(a.worktree?.project).toBe(dir);
    expect(b.worktree?.project).toBe(dir);
    expect(a.worktree?.branch).toBe(`clawbox/${a.id}`);
    expect(b.worktree?.branch).toBe(`clawbox/${b.id}`);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");

    fs.writeFileSync(flag, "go");
    await finished(a.id);
    await finished(b.id);
    await vi.waitFor(() => {
      expect(lib.getRun(a.id)?.worktree?.removed).toBe(true);
      expect(lib.getRun(b.id)?.worktree?.removed).toBe(true);
    }, { timeout: 20_000 });

    // Both merges landed — the lock serialised them rather than one failing.
    expect(fs.existsSync(path.join(dir, `${a.id}.txt`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${b.id}.txt`))).toBe(true);
    const log = git(dir, "log", "--oneline");
    expect(log).toContain(a.id);
    expect(log).toContain(b.id);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  /**
   * The gate counts LIVE runs, and a start does not become one until several
   * awaits later. Two that arrive together therefore both saw room for one —
   * the third `claude -p` on a board sized for two, which is the exact thing
   * this setting exists to bound.
   */
  it("does not let two starts that arrive together both take the last slot", async () => {
    const flag = path.join(base, "go");
    installWrapper([`echo '${result("done")}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
    makeGitProject("alpha");
    makeGitProject("beta");
    await lib.setMaxParallelRuns(1);
    const both = await Promise.allSettled([
      lib.startRun({ task: "one", directory: "alpha", source: "owner" }),
      lib.startRun({ task: "two", directory: "beta", source: "owner" }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ kind: "busy" });
    expect(lib.runningCount()).toBe(1);
    fs.writeFileSync(flag, "go");
    const started = both.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>;
    await finished(started.value.id);
    // The slot is given back, so the next start is not refused for ever.
    const after = await lib.startRun({ task: "three", directory: "beta", source: "owner" });
    expect(after.status).toBe("running");
  });

  it("refuses a second run in the SAME folder even under the limit, because that folder gets no copy of its own", async () => {
    const flag = path.join(base, "go");
    installWrapper([`echo '${result("done")}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
    // No git history: the in-place path, where two runs really would edit
    // each other's half-written files.
    makePlainProject("plain");
    const a = await lib.startRun({ task: "one", directory: "plain", source: "owner" });
    expect(lib.getRun(a.id)?.worktree).toBeNull();
    await expect(lib.startRun({ task: "two", directory: "plain", source: "owner" }))
      .rejects.toMatchObject({ kind: "busy" });
    fs.writeFileSync(flag, "go");
    await finished(a.id);
  });

  /**
   * Bench, 2026-09-22: 5 of 6 teams lost a review to "Another coding run … is
   * already working in that folder" — the team's own sibling, read as a
   * stranger. A team's runs share the project; the orchestrator decides who
   * writes where.
   */
  it("lets a team's reviewer start in the project beside a live run of the SAME team, and still refuses a second writer or a run of no team there", async () => {
    const flag = path.join(base, "go");
    installWrapper([`echo '${result("done")}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
    makePlainProject("plain");
    // Room for all of them, so only the folder rule is in the way.
    await lib.setMaxParallelRuns(4);
    const team = "team-aaaa0001";
    const inFolder = /Another coding run \(run-\w+\) is already working in that folder/;
    // A worker of the team writing in place (a code project's shape).
    const writer = await lib.startRun({ task: "work t1", directory: "plain", source: "owner", team: { id: team, role: "worker", taskId: "t1" } });
    const reviewer = await lib.startRun({ task: "review t2", directory: "plain", source: "owner", readOnly: true, team: { id: team, role: "reviewer", taskId: "t2" } });
    expect(reviewer.status).toBe("running");
    expect(reviewer.directory).toBe(writer.directory);
    // A second WRITER of the same team in the same checkout: the two would
    // edit each other's half-written files, team or not.
    await expect(lib.startRun({ task: "work t3", directory: "plain", source: "owner", team: { id: team, role: "worker", taskId: "t3" } }))
      .rejects.toMatchObject({ kind: "busy", message: expect.stringMatching(inFolder) });
    await expect(lib.startRun({ task: "mine", directory: "plain", source: "owner" }))
      .rejects.toMatchObject({ kind: "busy", message: expect.stringMatching(inFolder) });
    fs.writeFileSync(flag, "go");
    await finished(writer.id);
    await finished(reviewer.id);
  });

  /**
   * A team was refused outright beside ANY live run that was not its own —
   * the automatic review pass the box starts after every run among them — and
   * died at its first second, while single runs went on side by side up to
   * the limit. A team now shares the box: its runs take the owner's slots
   * like anyone's, and a full box is a wait.
   */
  it("starts two teams' planners beside a live single run, and makes the next team run WAIT at the limit", async () => {
    const flag = path.join(base, "go");
    installWrapper([`echo '${result("done")}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
    for (const name of ["alpha", "beta", "gamma", "delta"]) makeGitProject(name);
    await lib.setMaxParallelRuns(3);
    const planner = (teamId: string) => ({ id: teamId, role: "planner" as const, taskId: null });
    const single = await lib.startRun({ task: "one", directory: "alpha", source: "owner" });
    const a = await lib.startRun({ task: "plan a", directory: "beta", source: "owner", readOnly: true, team: planner("team-aaaa0001") });
    const b = await lib.startRun({ task: "plan b", directory: "gamma", source: "owner", readOnly: true, team: planner("team-bbbb0002") });
    expect([a.status, b.status]).toEqual(["running", "running"]);
    expect(lib.runningCount()).toBe(3);
    // At the limit: a team's run is refused as a WAIT, which the orchestrator sits out…
    await expect(lib.startRun({ task: "plan c", directory: "delta", source: "owner", readOnly: true, team: planner("team-cccc0003") }))
      .rejects.toMatchObject({ kind: "busy", wait: true, message: expect.stringMatching(/3 coding runs at once/) });
    // …and the ordinary gate counts the teams' runs as slots taken.
    await expect(lib.startRun({ task: "two", directory: "delta", source: "owner" })).rejects.toMatchObject({ kind: "busy" });
    fs.writeFileSync(flag, "go");
    for (const run of [single, a, b]) await finished(run.id);
  });

  it("does not let a team's start and a single start that arrive together both take the last slot", async () => {
    const flag = path.join(base, "go");
    installWrapper([`echo '${result("done")}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
    makeGitProject("alpha");
    makeGitProject("beta");
    await lib.setMaxParallelRuns(1);
    const single = () => lib.startRun({ task: "one", directory: "alpha", source: "owner" });
    const planner = () => lib.startRun({ task: "plan", directory: "beta", source: "owner", readOnly: true, team: { id: "team-aaaa0001", role: "planner", taskId: null } });
    // In both orders: whichever reaches the gate second sees the first's hold.
    for (const order of [[single, planner], [planner, single]]) {
      fs.rmSync(flag, { force: true });
      const both = await Promise.allSettled(order.map((start) => start()));
      expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ kind: "busy" });
      expect(lib.runningCount()).toBe(1);
      fs.writeFileSync(flag, "go");
      await finished((both.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value.id);
    }
  });

  it("names the live run that holds a folder: the team's own never beside a reader, a stranger's or another team's always", () => {
    const dir = "/home/clawbox/Projects/site";
    const mine = { id: "run-aaaaaaaa", status: "running" as const, directory: dir, readOnly: false, team: { id: "team-aaaa0001", role: "worker" as const, taskId: "t1" } };
    const myReviewer = { id: "run-dddddddd", status: "running" as const, directory: dir, readOnly: true, team: { id: "team-aaaa0001", role: "reviewer" as const, taskId: "t3" } };
    const foreign = { id: "run-bbbbbbbb", status: "running" as const, directory: dir, readOnly: true, team: { id: "team-bbbb0002", role: "reviewer" as const, taskId: "t1" } };
    const loner = { id: "run-cccccccc", status: "running" as const, directory: dir, readOnly: false, team: null };
    const reviewer = { id: "team-aaaa0001", role: "reviewer" as const, taskId: "t2" };
    const worker = { id: "team-aaaa0001", role: "worker" as const, taskId: "t4" };
    // Only the same team live: a (read-only) reviewer of that team may start.
    expect(lib.folderHolder([mine, myReviewer], dir, reviewer, undefined, true)).toBeNull();
    // Same team AND another team live: the other team holds it, read-only or not.
    expect(lib.folderHolder([mine, foreign], dir, reviewer, undefined, true)?.id).toBe("run-bbbbbbbb");
    // A run of no team holds it against a team.
    expect(lib.folderHolder([mine, loner], dir, reviewer, undefined, true)?.id).toBe("run-cccccccc");
    // …and a run of no team is held off by any live run, a team's included.
    expect(lib.folderHolder([myReviewer], dir, null)?.id).toBe("run-dddddddd");
    // A writer of the team may start beside the team's readers, never beside its writer.
    expect(lib.folderHolder([myReviewer], dir, worker)).toBeNull();
    expect(lib.folderHolder([mine, myReviewer], dir, worker)?.id).toBe("run-aaaaaaaa");
    // Settled runs, other folders and the run itself (a resume) hold nothing.
    expect(lib.folderHolder([{ ...foreign, status: "completed" as const }], dir, reviewer, undefined, true)).toBeNull();
    expect(lib.folderHolder([{ ...foreign, directory: `${dir}/.clawbox/worktrees/t1-1` }], dir, reviewer, undefined, true)).toBeNull();
    expect(lib.folderHolder([loner], dir, null, "run-cccccccc")).toBeNull();
  });
});

describe("a run's own copy of the project", () => {
  it("works in a worktree on its own branch, so the project checkout never moves", async () => {
    const dir = makeGitProject("alpha");
    installWrapper([`echo "$PWD" > "${path.join(base, "cwd")}"`, `echo '${result("done")}'`, "exit 0"].join("\n"));
    const started = await lib.startRun({ task: "build it", directory: "alpha", source: "owner" });
    const wt = lib.getRun(started.id)!.worktree!;
    expect(wt.project).toBe(dir);
    expect(wt.branch).toBe(`clawbox/${started.id}`);
    expect(wt.base).toBe("master");
    expect(started.directory).toBe(path.join(dir, ".clawbox", "worktrees", started.id));
    // The harness really was started there.
    await finished(started.id);
    expect(fs.readFileSync(path.join(base, "cwd"), "utf8").trim()).toBe(started.directory);
    // …and the project itself is still on its own branch, untouched.
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
  });

  it("merges the work home and removes the copy when the run committed something", async () => {
    const dir = makeGitProject("alpha");
    installWrapper([...wrote("made.txt"), `echo '${result("wrote a file")}'`, "exit 0"].join("\n"));
    const started = await lib.startRun({ task: "make a file", directory: "alpha", source: "owner" });
    await finished(started.id);
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.worktree?.removed).toBe(true); }, { timeout: 20_000 });
    expect(fs.existsSync(path.join(dir, "made.txt"))).toBe(true);
    expect(git(dir, "log", "--oneline")).toMatch(/Coding agent run-/);
    expect(fs.existsSync(started.directory)).toBe(false);
    expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/Merged into master/);
  });

  it("merges the work home when the run made a branch of its own in its copy and committed there", async () => {
    const dir = makeGitProject("alpha");
    installWrapper([
      'git checkout -q -b fix/own-branch',
      ...wrote("made.txt"),
      'git add -A && git -c user.name=t -c user.email=t@x commit -q -m "fix on my own branch"',
      `echo '${result("wrote a file on fix/own-branch")}'`,
      "exit 0",
    ].join("\n"));
    const started = await lib.startRun({ task: "make a file", directory: "alpha", source: "owner" });
    const branch = lib.getRun(started.id)!.worktree!.branch;
    await finished(started.id);
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.worktree?.removed).toBe(true); }, { timeout: 20_000 });
    // Home, on the project's branch — not left on a branch nothing merges.
    expect(fs.existsSync(path.join(dir, "made.txt"))).toBe(true);
    expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/Merged into master/);
    expect(lib.getRun(started.id)?.worktree?.branchRemoved).toBe(false);
    expect(git(dir, "log", "--format=%s", branch)).toMatch(/fix on my own branch/);
  });

  it("says so, and keeps the copy, when the run's own branch cannot be brought onto its branch", async () => {
    makeGitProject("alpha");
    installWrapper([
      ...wrote("made.txt"),
      'git add -A && git -c user.name=t -c user.email=t@x commit -q -m "on the given branch"',
      'git checkout -q -b fix/clash master',
      'echo "other" > made.txt',
      'git add -A && git -c user.name=t -c user.email=t@x commit -q -m "on my own branch"',
      `echo '${result("two versions of made.txt")}'`,
      "exit 0",
    ].join("\n"));
    const started = await lib.startRun({ task: "make a file", directory: "alpha", source: "owner" });
    await finished(started.id);
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/copy of the project was kept/); }, { timeout: 20_000 });
    const progress = lib.getRun(started.id)!.progress.join("\n");
    expect(progress).toMatch(/Not committed: the run committed on a branch of its own, which could not be brought onto clawbox\/run-[a-z0-9]{8}: Merging fix\/clash into/);
    expect(progress).toMatch(/copy of the project was kept: .*the run committed on fix\/clash/);
    expect(lib.getRun(started.id)?.worktree?.removed).toBeFalsy();
    expect(fs.existsSync(started.directory)).toBe(true);
  });

  it("removes the copy AND its branch when the run left nothing on it", async () => {
    const dir = makeGitProject("alpha");
    const started = await lib.startRun({ task: "just look", directory: "alpha", source: "owner" });
    const branch = lib.getRun(started.id)!.worktree!.branch;
    await finished(started.id);
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.worktree?.removed).toBe(true); }, { timeout: 20_000 });
    expect(fs.existsSync(started.directory)).toBe(false);
    // An empty clawbox/<runId> per run would be litter in the owner's repo.
    expect(git(dir, "branch", "--list", branch)).toBe("");
    expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/copy of the project was removed/);
  });

  it("records that the BRANCH went too when the run left nothing on it, and not when it was merged home", async () => {
    makeGitProject("alpha");
    const nothing = await lib.startRun({ task: "just look", directory: "alpha", source: "owner" });
    await finished(nothing.id);
    await vi.waitFor(() => { expect(lib.getRun(nothing.id)?.worktree?.removed).toBe(true); }, { timeout: 20_000 });
    // Both gone, so no surface may tell the owner to look on a branch.
    expect(lib.getRun(nothing.id)?.worktree?.branchRemoved).toBe(true);

    installWrapper([...wrote("made.txt"), `echo '${result("wrote a file")}'`, "exit 0"].join("\n"));
    const worked = await lib.startRun({ task: "make a file", directory: "alpha", source: "owner" });
    await finished(worked.id);
    await vi.waitFor(() => { expect(lib.getRun(worked.id)?.worktree?.removed).toBe(true); }, { timeout: 20_000 });
    // The copy went, the branch stayed: its commits are history.
    expect(lib.getRun(worked.id)?.worktree?.branchRemoved).toBe(false);
  });

  it("removes the copy but keeps the branch when the merge cannot be made, records why, and touches nothing of the owner's", async () => {
    const dir = makeGitProject("alpha");
    installWrapper([...wrote("shared.txt"), `echo '${result("wrote a file")}'`, "exit 0"].join("\n"));
    const started = await lib.startRun({ task: "make a file", directory: "alpha", source: "owner" });
    // The owner leaves work of their own lying in the project folder: the box
    // must not commit it on their behalf to get its merge through.
    fs.writeFileSync(path.join(dir, "mine.txt"), "the owner's\n");
    await finished(started.id);
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/copy of the project was removed; its work is kept on/);
    }, { timeout: 20_000 });
    const run = lib.getRun(started.id)!;
    // The FILES are gone — a tree per refused merge was ten copies of one
    // project on the owner's box — and the BRANCH is where the work stays.
    expect(run.worktree?.removed).toBe(true);
    expect(run.worktree?.branchRemoved).toBe(false);
    expect(fs.existsSync(run.directory)).toBe(false);
    expect(run.worktree?.result).toMatchObject({ kind: "unmerged", reason: "dirty" });
    expect(run.progress.join("\n")).toMatch(/uncommitted changes of its own/);
    expect(fs.readFileSync(path.join(dir, "mine.txt"), "utf8")).toBe("the owner's\n");
    expect(fs.existsSync(path.join(dir, "shared.txt"))).toBe(false);
    expect(git(dir, "show", "--name-only", "--format=", run.worktree!.branch).trim()).toBe("shared.txt");
  });

  /**
   * The settle forces a tree away, and `commitsAhead` counts the branch only.
   * Work that never reached the branch — staged by a commit that then failed,
   * or written and never committed — lives in the tree alone, so the tree
   * stays. Each removal is guarded: nothing ahead, refused merge, merged.
   */
  it("keeps the copy, and its branch, when the run's commit failed with the work staged in it", async () => {
    const dir = makeGitProject("alpha");
    // `--no-verify` skips pre-commit and commit-msg, not prepare-commit-msg:
    // refusing there fails the commit AFTER `git add -A` staged the file, so
    // the branch gets nothing and the tree holds the work.
    const hook = path.join(dir, ".git", "hooks", "prepare-commit-msg");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    installWrapper([...wrote("made.txt"), `echo '${result("wrote a file")}'`, "exit 0"].join("\n"));
    const started = await lib.startRun({ task: "make a file", directory: "alpha", source: "owner" });
    await finished(started.id);
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/copy of the project was kept: the run's commit failed/);
    }, { timeout: 20_000 });
    const run = lib.getRun(started.id)!;
    expect(run.commitError).toBeTruthy();
    expect(run.worktree?.removed).toBe(false);
    expect(run.worktree?.branchRemoved).toBe(false);
    expect(git(dir, "branch", "--list", run.worktree!.branch)).toContain(run.worktree!.branch);
    expect(git(run.directory, "diff", "--cached", "--name-only")).toBe("made.txt");
    expect(run.progress.join("\n")).not.toMatch(/copy of the project was removed/);
  });

  it("keeps the copy when the merge is refused but the tree holds work its branch does not", async () => {
    const dir = makeGitProject("alpha");
    // One file committed through the run's own shell — the branch is ahead —
    // and a second left beside it, never committed.
    installWrapper([
      'echo "kept" > "$PWD/kept.txt"',
      'git -C "$PWD" add kept.txt && git -C "$PWD" -c user.name=t -c user.email=t@x commit -q -m "the run\'s own commit"',
      'echo "draft" > "$PWD/draft.txt"',
      `echo '${result("committed one file")}'`,
      "exit 0",
    ].join("\n"));
    const started = await lib.startRun({ task: "make two files", directory: "alpha", source: "owner" });
    fs.writeFileSync(path.join(dir, "mine.txt"), "the owner's\n");
    await finished(started.id);
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.progress.join("\n"))
        .toMatch(/copy of the project was kept: it holds changes that are not committed to its branch; the project folder has uncommitted changes of its own/);
    }, { timeout: 20_000 });
    const run = lib.getRun(started.id)!;
    expect(run.worktree?.removed).toBe(false);
    expect(run.worktree?.result).toMatchObject({ kind: "unmerged", reason: "dirty" });
    expect(fs.readFileSync(path.join(run.directory, "draft.txt"), "utf8")).toBe("draft\n");
    expect(git(dir, "show", "--name-only", "--format=", run.worktree!.branch).trim()).toBe("kept.txt");
  });

  it("keeps the copy after a merge when the tree still holds work the merge did not take", async () => {
    const dir = makeGitProject("alpha");
    installWrapper([
      'echo "kept" > "$PWD/kept.txt"',
      'git -C "$PWD" add kept.txt && git -C "$PWD" -c user.name=t -c user.email=t@x commit -q -m "the run\'s own commit"',
      'echo "draft" > "$PWD/draft.txt"',
      `echo '${result("committed one file")}'`,
      "exit 0",
    ].join("\n"));
    const started = await lib.startRun({ task: "make two files", directory: "alpha", source: "owner" });
    await finished(started.id);
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.progress.join("\n"))
        .toMatch(/copy of the project was kept: it was merged into master, but it holds changes that are not committed to its branch/);
    }, { timeout: 20_000 });
    const run = lib.getRun(started.id)!;
    expect(run.worktree?.removed).toBe(false);
    expect(run.worktree?.result).toMatchObject({ kind: "merged", base: "master" });
    expect(fs.existsSync(path.join(dir, "kept.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(run.directory, "draft.txt"), "utf8")).toBe("draft\n");
  });

  it("still removes a copy whose only stray entry is the project's own linked node_modules", async () => {
    const dir = makeGitProject("alpha");
    fs.mkdirSync(path.join(dir, "node_modules"));
    const started = await lib.startRun({ task: "just look", directory: "alpha", source: "owner" });
    expect(fs.lstatSync(path.join(started.directory, "node_modules")).isSymbolicLink()).toBe(true);
    await finished(started.id);
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.worktree?.removed).toBe(true); }, { timeout: 20_000 });
    expect(fs.existsSync(started.directory)).toBe(false);
    expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/copy of the project was removed; it left nothing on its branch/);
    // The link went, never what it pointed at.
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(true);
  });

  it("refuses Remove for a run that worked in the project folder itself", async () => {
    makePlainProject("plain");
    const started = await lib.startRun({ task: "look", directory: "plain", source: "owner" });
    await finished(started.id);
    await expect(lib.removeRunWorktreeFor(started.id)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("gives a team's worker and a read-only planner no copy of their own", async () => {
    makeGitProject("alpha");
    const planner = await lib.startRun({ task: "read it", directory: "alpha", source: "owner", readOnly: true });
    expect(planner.worktree).toBeNull();
    // A planner reads the PROJECT, which is the folder it was pointed at.
    expect(planner.directory).toBe(path.join(projects, "alpha"));
    await finished(planner.id);
  });

  it("puts the copy back for a resume after the settle removed it", async () => {
    makeGitProject("alpha");
    installWrapper([`echo '${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-9" })}'`, `echo '${result("paused work")}'`, "exit 0"].join("\n"));
    const started = await lib.startRun({ task: "look", directory: "alpha", source: "owner" });
    const dirOfRun = started.directory;
    await finished(started.id);
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.worktree?.removed).toBe(true); }, { timeout: 20_000 });
    expect(fs.existsSync(dirOfRun)).toBe(false);
    // A follow-up resumes the session, which lives in that folder.
    const again = await lib.startRun({ task: "carry on", resumeRunId: started.id, source: "owner" });
    expect(again.directory).toBe(dirOfRun);
    expect(fs.existsSync(dirOfRun)).toBe(true);
    expect(again.worktree?.branch).toBe(`clawbox/${started.id}`);
    await finished(again.id);
  });

  it("takes its branch from the worktree when pull requests are on, rather than branching the project checkout", async () => {
    const dir = makeGitProject("alpha");
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects, coding_agent_auto_pr: true });
    const started = await lib.startRun({ task: "ship it", directory: "alpha", source: "owner" });
    expect(started.pr).toMatchObject({ phase: "opening", branch: `clawbox/${started.id}`, base: "master" });
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    await finished(started.id);
  });
});
