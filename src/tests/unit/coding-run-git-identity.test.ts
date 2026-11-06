/**
 * Who the HARNESS's own commits are authored as.
 *
 * A flashed board has no global git identity once the factory one is cleared,
 * so the agent's own `git commit` in its worktree failed with "Author identity
 * unknown" — and the agent then made one up:
 * `-c user.name="Claude Code" -c user.email=noreply@anthropic.com`. A run's
 * environment now carries the identity the box's own commits use: the owner's
 * setting, else the box's placeholder ("ClawBox Coding Agent").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts a real process (bash / git). See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

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

// The TEST's own git, for the fixture's first commit only: the run is given
// none of this, which is the point.
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-1" });

/**
 * A harness that commits in its own folder the way the bench's agent did —
 * `extra` is what it passes to git — and writes down who git says the commit
 * is by, or git's refusal.
 */
function installCommittingWrapper(extra: string): string {
  const seen = path.join(base, "author.txt");
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), [
    "#!/usr/bin/env bash",
    readFirstTurn(),
    `echo hi > "$PWD/hello.txt"`,
    `git add hello.txt`,
    `if git ${extra} commit -q -m "agent's own commit" 2>"${seen}.err"; then git log -1 --format='%an <%ae>|%cn <%ce>' > "${seen}"; else echo "refused" > "${seen}"; fi`,
    `echo '${result("done")}'`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  return seen;
}

function makeGitProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-git-identity-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  // No ~/.gitconfig under this HOME: the box as flashed, with no identity of its own.
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function load(cfg: Record<string, unknown>): Promise<void> {
  writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects, ...cfg });
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
}

describe("a run's own git commit, on a box with no git identity", () => {
  it("is authored as the owner's configured identity, in the run's worktree", async () => {
    await load({ coding_agent_git_name: "Ada Owner", coding_agent_git_email: "ada@example.com" });
    const seen = installCommittingWrapper("");
    makeGitProject("alpha");
    const started = await lib.startRun({ task: "say hi", directory: "alpha", source: "owner" });
    const run = await lib.waitForRun(started.id, 20_000);
    expect(run?.status).toBe("completed");
    expect(fs.readFileSync(seen, "utf8").trim()).toBe("Ada Owner <ada@example.com>|Ada Owner <ada@example.com>");
  });

  it("falls back to the box's own name, never one the agent makes up", async () => {
    await load({});
    // What the bench's agent did after git refused it.
    const seen = installCommittingWrapper(`-c user.name="Claude Code" -c user.email=noreply@anthropic.com`);
    makeGitProject("beta");
    const started = await lib.startRun({ task: "say hi", directory: "beta", source: "owner" });
    await lib.waitForRun(started.id, 20_000);
    expect(fs.readFileSync(seen, "utf8").trim()).toBe("ClawBox Coding Agent <coding-agent@clawbox.local>|ClawBox Coding Agent <coding-agent@clawbox.local>");
  });

  it("keeps the project's own identity where it has one", async () => {
    await load({ coding_agent_git_name: "Ada Owner", coding_agent_git_email: "ada@example.com" });
    const seen = installCommittingWrapper("");
    const dir = makeGitProject("gamma");
    git(dir, "config", "user.name", "Project Person");
    git(dir, "config", "user.email", "person@project.example");
    const started = await lib.startRun({ task: "say hi", directory: "gamma", source: "owner" });
    await lib.waitForRun(started.id, 20_000);
    expect(fs.readFileSync(seen, "utf8").trim()).toBe("Project Person <person@project.example>|Project Person <person@project.example>");
  });
});

describe("buildRunEnv", () => {
  it("names the identity for both author and committer, and no stored secret can replace it", async () => {
    await load({});
    const env = lib.buildRunEnv({
      gitIdentity: { name: "Ada Owner", email: "ada@example.com" },
      secrets: { GIT_AUTHOR_NAME: "Mallory", GIT_COMMITTER_EMAIL: "m@evil.example" },
    });
    expect(env.GIT_AUTHOR_NAME).toBe("Ada Owner");
    expect(env.GIT_AUTHOR_EMAIL).toBe("ada@example.com");
    expect(env.GIT_COMMITTER_NAME).toBe("Ada Owner");
    expect(env.GIT_COMMITTER_EMAIL).toBe("ada@example.com");
  });
});
