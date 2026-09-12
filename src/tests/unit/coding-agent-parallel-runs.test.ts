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

// Starts a real process (bash / git): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));

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
  fs.writeFileSync(path.join(binDir, "claude-ds"), ["#!/usr/bin/env bash", "cat > /dev/null", body].join("\n"), { mode: 0o755 });
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
    await expect(lib.setMaxParallelRuns(5)).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.setMaxParallelRuns(0)).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.setMaxParallelRuns(2.5)).rejects.toMatchObject({ kind: "invalid" });
    // Refused, not saved: the value the owner had is still in force.
    expect(await lib.getMaxParallelRuns()).toBe(4);
    const status = await lib.getCodingAgentStatus();
    expect(status.maxParallelRuns).toBe(4);
    expect(status.minMaxParallelRuns).toBe(1);
    expect(status.maxMaxParallelRuns).toBe(4);
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

  it("keeps the copy when the merge cannot be made, and says why", async () => {
    const dir = makeGitProject("alpha");
    installWrapper([...wrote("shared.txt"), `echo '${result("wrote a file")}'`, "exit 0"].join("\n"));
    const started = await lib.startRun({ task: "make a file", directory: "alpha", source: "owner" });
    // The owner leaves work of their own lying in the project folder: the box
    // must not commit it on their behalf to get its merge through.
    fs.writeFileSync(path.join(dir, "mine.txt"), "the owner's\n");
    await finished(started.id);
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/copy of the project was kept/);
    }, { timeout: 20_000 });
    const run = lib.getRun(started.id)!;
    expect(run.worktree?.removed).toBe(false);
    expect(fs.existsSync(run.directory)).toBe(true);
    expect(run.progress.join("\n")).toMatch(/uncommitted changes of its own/);
    expect(fs.readFileSync(path.join(dir, "mine.txt"), "utf8")).toBe("the owner's\n");

    // …and the owner's own Remove takes the files while the branch keeps the work.
    const after = await lib.removeRunWorktreeFor(started.id);
    expect(after.worktree?.removed).toBe(true);
    expect(fs.existsSync(run.directory)).toBe(false);
    expect(git(dir, "show", "--name-only", "--format=", after.worktree!.branch).trim()).toBe("shared.txt");
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

describe("the weekly worktree sweep", () => {
  it("runs at most once a week and records when it last ran", async () => {
    makeGitProject("alpha");
    const started = await lib.startRun({ task: "look", directory: "alpha", source: "owner" });
    await finished(started.id);
    expect(await lib.sweepCodingWorktrees()).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8"));
    expect(typeof config[lib.WORKTREE_SWEEP_AT_KEY]).toBe("number");
    // A second call inside the week does nothing at all.
    expect(await lib.sweepCodingWorktrees()).toBe(0);
  });

  it("prunes a fortnight-old copy whose branch is merged, and marks the record so a resume rebuilds it", async () => {
    const dir = makeGitProject("alpha");
    installWrapper([...wrote("made.txt"), `echo '${result("wrote a file")}'`, "exit 0"].join("\n"));
    // The owner's stray file blocks the settle's merge, so the copy survives it.
    fs.writeFileSync(path.join(dir, "mine.txt"), "the owner's\n");
    const started = await lib.startRun({ task: "make a file", directory: "alpha", source: "owner" });
    await finished(started.id);
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/copy of the project was kept/);
    }, { timeout: 20_000 });

    // The owner merges it themselves, later, and the copy goes stale.
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "the owner's own");
    git(dir, "merge", "--no-ff", "--no-edit", "-m", "merge the run", `clawbox/${started.id}`);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    fs.utimesSync(started.directory, old, old);

    expect(await lib.sweepCodingWorktrees({ force: true })).toBe(1);
    expect(fs.existsSync(started.directory)).toBe(false);
    expect(lib.getRun(started.id)?.worktree?.removed).toBe(true);
  });
});
