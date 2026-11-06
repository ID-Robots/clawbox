/**
 * Stop, then Resume, on a run with a worktree of its own.
 *
 * On a bench a run stopped at 75 s had its half-finished work committed,
 * MERGED into the project's main branch and its worktree removed; the resume
 * the owner asked for then got the removed path as its folder and failed in
 * 0 s ("The current working directory was deleted"). Stop now leaves the work
 * on the run's branch, unmerged, and a resume waits for the stop's settle and
 * works in a copy restored from that branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts a real process (bash / git). See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

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

const init = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-stop-1" });
const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-stop-1" });

/**
 * A harness that writes `name` in its folder and reports it, then — the FIRST
 * time only — waits to be stopped; any later spawn (the resume) writes down
 * whether its folder is there and finishes.
 */
function installWrapper(name: string): { resumedIn: string } {
  const marker = path.join(base, "spawned-once");
  const resumedIn = path.join(base, "resumed-in.txt");
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), [
    "#!/usr/bin/env bash",
    readFirstTurn(),
    `echo '${init}'`,
    `if [ -f ${JSON.stringify(marker)} ]; then`,
    // The resume: give the stop's settle every chance to remove the folder under it.
    "  sleep 1",
    `  if [ -d "$PWD" ] && [ -f "$PWD/${name}" ]; then echo "$PWD" > ${JSON.stringify(resumedIn)}; else echo gone > ${JSON.stringify(resumedIn)}; fi`,
    `  echo '${result("carried on")}'`,
    "  exit 0",
    "fi",
    `touch ${JSON.stringify(marker)}`,
    `echo "half" > "$PWD/${name}"`,
    `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"%s/${name}"}}]}}\\n' "$PWD"`,
    `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } })}'`,
    "while true; do sleep 0.1; done",
  ].join("\n"), { mode: 0o755 });
  return { resumedIn };
}

function makeGitProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

async function stopWhenWritten(id: string): Promise<void> {
  await vi.waitFor(() => expect(lib.getRun(id)?.filesTouched.length).toBeGreaterThan(0), { timeout: 20_000 });
  lib.stopRun(id);
  await vi.waitFor(() => expect(lib.getRun(id)?.status).toBe("stopped"), { timeout: 20_000 });
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-stop-resume-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects });
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("Stop on a run with a worktree", () => {
  it("commits the half-finished work on the run's branch and leaves it unmerged — never into the owner's base branch", async () => {
    const dir = makeGitProject("alpha");
    installWrapper("half.txt");
    const started = await lib.startRun({ task: "build half of it", directory: "alpha", source: "owner" });
    await stopWhenWritten(started.id);
    // The settle is over once it has decided about the worktree.
    await vi.waitFor(() => expect(lib.getRun(started.id)?.worktree?.removed).toBe(true), { timeout: 30_000 });

    const run = lib.getRun(started.id)!;
    expect(run.worktree?.result).toMatchObject({ kind: "unmerged", reason: "stopped" });
    expect(run.worktree?.removed).toBe(true);
    // The owner's main has nothing of it; the run's branch has all of it.
    expect(git(dir, "ls-tree", "--name-only", "main")).not.toContain("half.txt");
    expect(fs.existsSync(path.join(dir, "half.txt"))).toBe(false);
    expect(git(dir, "ls-tree", "--name-only", `clawbox/${started.id}`)).toContain("half.txt");
    expect(run.progress.join("\n")).toMatch(/stopped before it finished/);
  });
});

describe("Resume of a stopped run", () => {
  it("waits for the stop's settle and works in a copy restored from the run's branch, not a deleted folder", async () => {
    const dir = makeGitProject("beta");
    // A merge home that takes a while, as one does on a Jetson: the resume
    // lands while the stop's settle is past its "anyone working in here?" look
    // and before the worktree's removal — where the bench's resume landed.
    const merging = path.join(base, "merging");
    fs.writeFileSync(path.join(dir, ".git", "hooks", "post-merge"), `#!/bin/sh\ntouch ${JSON.stringify(merging)}\nsleep 2\n`, { mode: 0o755 });
    const { resumedIn } = installWrapper("half.txt");
    const started = await lib.startRun({ task: "build half of it", directory: "beta", source: "owner" });
    await stopWhenWritten(started.id);
    // Resumed once the settle has either started its merge home or finished
    // with the worktree — whichever this build does.
    await vi.waitFor(() => expect(fs.existsSync(merging) || lib.getRun(started.id)?.worktree?.removed === true).toBe(true), { timeout: 30_000, interval: 20 });
    const again = await lib.startRun({ task: "carry on", resumeRunId: started.id, source: "owner" });
    expect(again.directory).toBe(started.directory);
    const done = await lib.waitForRun(again.id, 30_000);
    expect(done?.status).toBe("completed");
    // The resumed harness found its folder, with the stopped run's work in it.
    expect(fs.readFileSync(resumedIn, "utf8").trim()).toBe(started.directory);
  });
});

describe("A run that leaves something running in its worktree", () => {
  it("brings its work home but leaves the folder under what is still running there", async () => {
    const dir = makeGitProject("gamma");
    fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, "claude-ds"), [
      "#!/usr/bin/env bash",
      readFirstTurn(),
      `echo '${init}'`,
      `echo "page" > "$PWD/page.html"`,
      `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"%s/page.html"}}]}}\\n' "$PWD"`,
      `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } })}'`,
      // A server it leaves behind, in its own process group like the harness's.
      "sleep 6 >/dev/null 2>&1 &",
      `echo '${result("served")}'`,
      "exit 0",
    ].join("\n"), { mode: 0o755 });
    const started = await lib.startRun({ task: "serve the page", directory: "gamma", source: "owner" });
    expect((await lib.waitForRun(started.id, 20_000))?.status).toBe("completed");
    await vi.waitFor(() => expect(lib.getRun(started.id)?.worktree?.result?.kind).toBe("merged"), { timeout: 20_000 });
    expect(git(dir, "ls-tree", "--name-only", "main")).toContain("page.html");
    await vi.waitFor(() => expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(/still running in it/), { timeout: 10_000 });
    expect(fs.existsSync(started.directory)).toBe(true);
    expect(lib.getRun(started.id)?.worktree?.removed).toBe(false);
  });
});
