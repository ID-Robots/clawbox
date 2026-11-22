/**
 * MULTI-FOLDER projects in the runner (TASK-2757, src/lib/project-folders.ts):
 * a project that lists several git repositories of the owner's project folder.
 *
 * What is under test: a run on such a project gets one folder of its own
 * holding a git worktree of EACH repository side by side, every one on
 * `clawbox/<runId>` in its own repository and forked from that folder's base;
 * the run is told so; its work is committed per repository and merged home per
 * repository; with pull requests on, one request is opened per repository
 * that changed, each naming the others; a repository it left untouched loses
 * its empty branch; and `coding_agent_run`'s project id reaches the project.
 * A single-folder project is the other suites' (coding-agent-parallel-runs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts real processes (bash, git): vitest's defaults are not enough on a
// loaded runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const github = vi.hoisted(() => ({
  openPullRequest: vi.fn(),
  updatePullRequestBody: vi.fn(),
}));
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  ...github,
}));
const review = vi.hoisted(() => ({ findOpenPullRequestForBranch: vi.fn(async () => null) }));
vi.mock("@/lib/coding-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-review")>()),
  ...review,
}));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));
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

function writeConfig(extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({
    clawai_token: "claw_test_token",
    coding_agent_enabled: true,
    coding_agent_default_directory: projects,
    coding_agent_project_folders: { skyhub: [{ folder: "gateway" }, { folder: "dashboard", base: "develop" }] },
    ...extra,
  }), "utf-8");
}

/** A wrapper that records where it ran and what it was told, runs `body`, and finishes. */
function installWrapper(body: string[]): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), [
    "#!/usr/bin/env bash",
    readFirstTurn(path.join(base, "first-turn")),
    `echo "$PWD" > "${path.join(base, "cwd")}"`,
    ...body,
    `echo '${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", session_id: "sess-1" })}'`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
}

function makeGitProject(name: string, branches: string[] = []): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  for (const b of branches) git(dir, "branch", b);
  return dir;
}

async function settled(id: string) {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  await vi.waitFor(() => { expect(lib.getRun(id)?.multiFolder?.folders.every((f) => f.removed)).toBe(true); }, { timeout: 20_000 });
  return lib.getRun(id)!;
}

let gateway: string;
let dashboard: string;

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-multi-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(projects, "skyhub"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  gateway = makeGitProject("gateway");
  dashboard = makeGitProject("dashboard", ["develop"]);
  writeConfig();
  installWrapper([]);
  github.openPullRequest.mockReset();
  github.updatePullRequestBody.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a run on a multi-folder project", () => {
  it("works in one folder holding a copy of each repository, each on its own branch from its own base, and is told so", async () => {
    const started = await lib.startRun({ task: "wire the dashboard to the gateway", projectId: "skyhub", source: "owner" });
    const dir = path.join(projects, "skyhub", ".clawbox", "worktrees", started.id);
    expect(started.directory).toBe(dir);
    expect(started.worktree).toBeNull();
    expect(started.multiFolder?.project).toBe(path.join(projects, "skyhub"));
    expect(started.multiFolder?.folders.map((f) => [f.name, f.path, f.branch, f.base, f.project])).toEqual([
      ["gateway", path.join(dir, "gateway"), `clawbox/${started.id}`, "master", gateway],
      ["dashboard", path.join(dir, "dashboard"), `clawbox/${started.id}`, "develop", dashboard],
    ]);
    expect(git(path.join(dir, "gateway"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`clawbox/${started.id}`);
    expect(git(path.join(dir, "dashboard"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`clawbox/${started.id}`);
    // The run is the project's, not its folder's.
    expect(lib.projectDirectoryOf(started)).toBe(path.join(projects, "skyhub"));
    await lib.waitForRun(started.id, 20_000);
    expect(fs.readFileSync(path.join(base, "cwd"), "utf8").trim()).toBe(dir);
    const told = fs.readFileSync(path.join(base, "first-turn"), "utf8");
    expect(told).toContain(`gateway/ (branch clawbox/${started.id}, forked from master)`);
    expect(told).toContain(`dashboard/ (branch clawbox/${started.id}, forked from develop)`);
    expect(told).toContain("This folder itself is not a repository");
    // The owners' checkouts never moved.
    expect(git(gateway, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    expect(git(dashboard, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
  });

  it("commits each repository it changed and merges each home; an untouched one loses its empty branch", async () => {
    installWrapper([`echo api > "$PWD/gateway/api.txt"`]);
    const started = await lib.startRun({ task: "add the api file", directory: "skyhub", source: "owner" });
    const run = await settled(started.id);
    expect(fs.readFileSync(path.join(gateway, "api.txt"), "utf8")).toBe("api\n");
    expect(git(gateway, "log", "-1", "--format=%s")).toMatch(new RegExp(`Coding agent ${started.id}|Coding agent: add the api file`));
    const [gw, db] = run.multiFolder!.folders;
    expect(gw.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(gw.result?.kind).toBe("merged");
    expect(db.commit).toBeNull();
    expect(db.branchRemoved).toBe(true);
    expect(git(dashboard, "branch", "--list", `clawbox/${started.id}`)).toBe("");
    expect(run.progress.join("\n")).toMatch(/gateway: committed as/);
    // The run's own folder is gone once its copies are.
    expect(fs.existsSync(started.directory)).toBe(false);
  });

  it("opens one pull request per repository that changed, with the same title, each naming the others", async () => {
    writeConfig({ coding_agent_auto_pr: true });
    installWrapper([`echo api > "$PWD/gateway/api.txt"`, `echo ui > "$PWD/dashboard/ui.txt"`]);
    github.openPullRequest.mockImplementation(async (input: { directory: string }) => (
      input.directory.endsWith("gateway")
        ? { ok: true, number: 11, url: "https://github.com/acme/gateway/pull/11" }
        : { ok: true, number: 22, url: "https://github.com/acme/dashboard/pull/22" }
    ));
    const bodies = new Map<number, string>();
    github.updatePullRequestBody.mockImplementation(async ({ number, rewrite }: { number: number; rewrite: (b: string) => string }) => {
      bodies.set(number, rewrite("TASK-2757 body"));
      return { ok: true, changed: true };
    });
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    const started = await lib.startRun({ task: "TASK-2757: show gateway health on the dashboard", projectId: "skyhub", source: "owner" });
    expect(started.pr).toBeNull();
    const run = await settled(started.id);

    expect(github.openPullRequest).toHaveBeenCalledTimes(2);
    const calls = github.openPullRequest.mock.calls.map(([input]) => input as { directory: string; branch: string; base: string; title: string; draft?: boolean });
    expect(calls.map((c) => [path.basename(c.directory), c.branch, c.base])).toEqual([
      ["gateway", `clawbox/${started.id}`, "master"],
      ["dashboard", `clawbox/${started.id}`, "develop"],
    ]);
    expect(new Set(calls.map((c) => c.title))).toEqual(new Set(["TASK-2757: show gateway health on the dashboard"]));
    expect(run.multiFolder!.folders.map((f) => f.pr?.url)).toEqual(["https://github.com/acme/gateway/pull/11", "https://github.com/acme/dashboard/pull/22"]);
    expect(bodies.get(11)).toContain("dashboard: https://github.com/acme/dashboard/pull/22");
    expect(bodies.get(11)).not.toContain("gateway: https://github.com/acme/gateway/pull/11");
    expect(bodies.get(22)).toContain("gateway: https://github.com/acme/gateway/pull/11");
    // A pull request owns each branch: the copies go, the branches stay, nothing is merged home.
    expect(fs.existsSync(path.join(gateway, "api.txt"))).toBe(false);
    expect(git(gateway, "branch", "--list", `clawbox/${started.id}`)).toContain(`clawbox/${started.id}`);
    expect(run.progress.join("\n")).toMatch(/gateway: pull request https:\/\/github\.com\/acme\/gateway\/pull\/11/);
  });

  it("opens no pull request for a repository the run left untouched", async () => {
    writeConfig({ coding_agent_auto_pr: true });
    installWrapper([`echo ui > "$PWD/dashboard/ui.txt"`]);
    github.openPullRequest.mockResolvedValue({ ok: true, number: 22, url: "https://github.com/acme/dashboard/pull/22" });
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    const started = await lib.startRun({ task: "restyle the dashboard", projectId: "skyhub", source: "owner" });
    const run = await settled(started.id);
    expect(github.openPullRequest).toHaveBeenCalledTimes(1);
    expect(path.basename((github.openPullRequest.mock.calls[0][0] as { directory: string }).directory)).toBe("dashboard");
    // One request has nobody to name.
    expect(github.updatePullRequestBody).not.toHaveBeenCalled();
    expect(run.multiFolder!.folders[0].pr).toBeNull();
  });

  it("refuses the start, and leaves no copy or branch behind, when one repository cannot be copied", async () => {
    writeConfig({ coding_agent_project_folders: { skyhub: [{ folder: "gateway" }, { folder: "dashboard", base: "nope" }] } });
    await expect(lib.startRun({ task: "anything", projectId: "skyhub", source: "owner" })).rejects.toMatchObject({ kind: "invalid", message: expect.stringMatching(/^dashboard: /) });
    expect(git(gateway, "branch", "--list", "clawbox/*")).toBe("");
    expect(fs.readdirSync(path.join(projects, "skyhub", ".clawbox", "worktrees"))).toEqual([]);
  });

  it("puts every copy back for a follow-up after the settle removed them", async () => {
    installWrapper([`echo api > "$PWD/gateway/api.txt"`]);
    const started = await lib.startRun({ task: "first go", projectId: "skyhub", source: "owner" });
    await settled(started.id);
    const again = await lib.startRun({ task: "carry on", resumeRunId: started.id, source: "owner" });
    expect(again.directory).toBe(started.directory);
    expect(again.multiFolder?.folders.map((f) => fs.existsSync(f.path))).toEqual([true, true]);
    expect(again.multiFolder?.folders.map((f) => f.branch)).toEqual([`clawbox/${started.id}`, `clawbox/${started.id}`]);
    await lib.waitForRun(again.id, 20_000);
  });

  it("keeps a project that lists no folders a single-folder project", async () => {
    writeConfig({ coding_agent_project_folders: undefined });
    await expect(lib.resolveWorkingDirectory({ projectId: "gateway" })).rejects.toMatchObject({ kind: "not_found" });
    const started = await lib.startRun({ task: "plain", directory: "gateway", source: "owner" });
    expect(started.multiFolder).toBeUndefined();
    expect(started.worktree?.project).toBe(gateway);
    expect(JSON.parse(JSON.stringify(lib.getRun(started.id)))).not.toHaveProperty("multiFolder");
    await lib.waitForRun(started.id, 20_000);
  });
});
