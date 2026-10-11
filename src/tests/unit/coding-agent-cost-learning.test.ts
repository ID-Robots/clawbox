/**
 * The runner's half of four cost and learning changes, end to end against a
 * fake harness that writes down what it was given:
 *
 *  - a team's planner and reviewer start on the provider's CHEAPER model at no
 *    more than `xhigh` (src/lib/coding-role-models.ts), a worker on the owner's
 *    own, and the owner's per-role choice wins;
 *  - every run gets a CPU budget (src/lib/coding-run-cpu.ts) in its environment,
 *    and a writing run's brief asks it to keep its builds and tests to it;
 *  - the project's RUN NOTES (src/lib/coding-run-notes.ts) reach every run's
 *    prompt, and the lessons a run proposes are merged — vetted — at settle,
 *    into the project root, outside its worktree and out of `git status`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts real processes (bash / git): see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
// An eight-thread box on mains: the host's own CPUs and charger are neither the
// fixture nor the same on every runner.
vi.mock("@/lib/coding-run-cpu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-run-cpu")>();
  return { ...actual, hostCpuCount: () => 8, onBatteryPower: vi.fn(async () => false) };
});

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let artifactsDir: (runId: string) => string;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projects: string;
let restore: () => void;

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const BASE_CONFIG = { clawai_token: "claw_test_token", coding_agent_enabled: true } as Record<string, unknown>;

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ ...BASE_CONFIG, coding_agent_default_directory: projects, ...cfg }), "utf-8");
}

const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-1" });

/**
 * A harness that writes down what it was handed — its model, effort and CPU
 * budget from the environment, its whole argv — into its own evidence folder,
 * runs `extra`, and finishes.
 */
function installWrapper(extra: string[] = []): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), [
    "#!/usr/bin/env bash",
    readFirstTurn(),
    'printf "%s" "${CLAUDE_DS_MODEL:-}" > "$CLAWBOX_RUN_ARTIFACTS_DIR/model.txt"',
    'printf "%s" "${CLAUDE_DS_EFFORT:-}" > "$CLAWBOX_RUN_ARTIFACTS_DIR/effort.txt"',
    'printf "%s" "${CLAWBOX_RUN_CPU_BUDGET:-}" > "$CLAWBOX_RUN_ARTIFACTS_DIR/budget.txt"',
    'printf "%s\\n" "$@" > "$CLAWBOX_RUN_ARTIFACTS_DIR/argv.txt"',
    ...extra,
    `echo '${result("done")}'`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
}

/** What the harness of that run wrote down. */
const handed = (runId: string, what: "model" | "effort" | "budget" | "argv") => fs.readFileSync(path.join(artifactsDir(runId), `${what}.txt`), "utf8");

function makeGitProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

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

const TEAM = "team-aaaa0001";

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "CLAUDE_DS_MODEL", "CLAUDE_DS_EFFORT");
  delete process.env.CLAUDE_DS_MODEL;
  delete process.env.CLAUDE_DS_EFFORT;
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-cost-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({});
  installWrapper();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  artifactsDir = (await import("@/lib/coding-agent-artifacts")).artifactsDir;
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a team's roles: the cheaper model where nobody writes code", () => {
  it("starts a planner on the plan's flash tier at no more than xhigh, and a worker on the owner's own", async () => {
    makePlainProject("plain");
    const planner = await lib.startRun({ task: "plan it", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    expect(planner).toMatchObject({ provider: "clawbox-ai", requestedModel: "deepseek-v4-flash", effort: "xhigh" });
    await finished(planner.id);
    // What the harness was actually handed, and what the record keeps after a reload.
    expect(handed(planner.id, "model")).toBe("deepseek-v4-flash");
    expect(handed(planner.id, "effort")).toBe("xhigh");
    expect(lib.getRun(planner.id)).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "xhigh" });

    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    // The owner's own: the plan picks the model, and the effort is the box's default.
    expect(worker).toMatchObject({ provider: "clawbox-ai", requestedModel: null, effort: "ultracode" });
    await finished(worker.id);
    expect(handed(worker.id, "model")).toBe("");

    // A lead and a reviewer are read-only runs on the same cheaper tier.
    const reviewer = await lib.startRun({ task: "review t1", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "reviewer", taskId: "t1" } });
    expect(reviewer).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "xhigh" });
    await finished(reviewer.id);
    const lead = await lib.startRun({ task: "decide", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "lead", taskId: "t1" } });
    expect(lead).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "xhigh" });
    await finished(lead.id);
  });

  it("never thinks harder than the owner's own effort, and follows the owner's per-role choice", async () => {
    makePlainProject("plain");
    writeConfig({ coding_agent_effort: "low", coding_agent_role_models: { reviewer: { model: "standard", effort: "max" }, worker: { model: "economy" } } });
    const planner = await lib.startRun({ task: "plan it", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    expect(planner).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "low" });
    await finished(planner.id);
    const reviewer = await lib.startRun({ task: "review", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "reviewer", taskId: "t1" } });
    expect(reviewer).toMatchObject({ requestedModel: null, effort: "max" });
    await finished(reviewer.id);
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "low" });
    await finished(worker.id);
  });

  it("leaves a run that is not a team's exactly as it was", async () => {
    makePlainProject("plain");
    const run = await lib.startRun({ task: "build it", directory: "plain", source: "owner" });
    expect(run).toMatchObject({ requestedModel: null, effort: "ultracode" });
    await finished(run.id);
  });

  it("answers the choices in the status, `auto` on a box that never chose, and saves an edit", async () => {
    expect((await lib.getCodingAgentStatus()).roleModels).toEqual({
      planner: { model: "auto", effort: "auto" },
      worker: { model: "auto", effort: "auto" },
      reviewer: { model: "auto", effort: "auto" },
    });
    await lib.setRoleModels({ planner: { model: "standard" } });
    expect((await lib.getCodingAgentStatus()).roleModels.planner).toEqual({ model: "standard", effort: "auto" });
    await expect(lib.setRoleModels({ planner: { model: "cheapest" } })).rejects.toMatchObject({ kind: "invalid" });
    expect(lib.checkRoleModelsPatch({ lead: {} })).toMatch(/Unknown role/);
    expect(lib.checkRoleModelsPatch({ worker: { effort: "auto" } })).toBeNull();
  });
});

describe("the CPU budget", () => {
  it("is in every run's environment, and in a writing run's brief by each runner's own flag", async () => {
    makePlainProject("plain");
    const run = await lib.startRun({ task: "build it", directory: "plain", source: "owner" });
    // Alone on an eight-thread box: half of it.
    expect(run.cpuBudget).toBe(4);
    await finished(run.id);
    expect(handed(run.id, "budget")).toBe("4");
    expect(handed(run.id, "argv")).toContain("CPU budget: 4 parallel jobs");
    expect(handed(run.id, "argv")).toContain("--maxWorkers=4");
  });

  it("is shared between a team's workers side by side, and a read-only run is told nothing about builds", async () => {
    makePlainProject("plain");
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", cpuShare: 2, team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker.cpuBudget).toBe(2);
    await finished(worker.id);
    expect(handed(worker.id, "budget")).toBe("2");
    const planner = await lib.startRun({ task: "plan", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    await finished(planner.id);
    expect(handed(planner.id, "budget")).toBe(String(planner.cpuBudget));
    expect(handed(planner.id, "argv")).not.toContain("CPU budget:");
  });
});

describe("the project's run notes", () => {
  it("reach the run's prompt, and its vetted lessons land in the PROJECT's notes — outside the worktree and out of git status", async () => {
    const project = makeGitProject("site");
    fs.mkdirSync(path.join(project, ".clawbox"), { recursive: true });
    fs.writeFileSync(path.join(project, ".clawbox", "run-notes.md"), "- Tests: bun run test\n");
    installWrapper([
      `printf '%s' '${JSON.stringify({ lessons: ["Lint with bunx eslint before committing", "Deploy key: token=ghp_abcdefghijklmnopqrstuvwxyz0123", "tests: bun run test"] })}' > "$CLAWBOX_RUN_ARTIFACTS_DIR/run-notes.json"`,
    ]);
    const run = await lib.startRun({ task: "build it", directory: "site", source: "owner" });
    // A run of its own in its own worktree: the notes are the project's, not the tree's.
    expect(run.directory).toContain(path.join(".clawbox", "worktrees"));
    await finished(run.id);
    const argv = handed(run.id, "argv");
    expect(argv).toContain("<run-notes>");
    expect(argv).toContain("- Tests: bun run test");
    expect(argv).toContain("run-notes.json");
    const notes = fs.readFileSync(path.join(project, ".clawbox", "run-notes.md"), "utf8");
    expect(notes).toBe("- Tests: bun run test\n- Lint with bunx eslint before committing\n");
    expect(notes).not.toContain("ghp_");
    expect(git(project, "status", "--porcelain")).not.toContain(".clawbox");
  });

  it("are read, not offered for writing, by a read-only run", async () => {
    const project = makePlainProject("plain");
    fs.mkdirSync(path.join(project, ".clawbox"), { recursive: true });
    fs.writeFileSync(path.join(project, ".clawbox", "run-notes.md"), "- The dev server is on port 3100\n");
    const planner = await lib.startRun({ task: "plan", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    await finished(planner.id);
    const argv = handed(planner.id, "argv");
    expect(argv).toContain("- The dev server is on port 3100");
    expect(argv).not.toContain("run-notes.json");
  });
});
