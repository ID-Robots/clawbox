/**
 * Bringing a settled run's work home, against a real repository and a real
 * (fake) harness.
 *
 * THE CASE. A run works in a copy of the project and the settle merges its
 * branch back — but only into a clean checkout that is still on the base
 * branch, and never through a conflict, because that folder is the owner's.
 * On a box whose owner keeps any uncommitted change in a project folder that
 * refusal is EVERY run: the run said `completed`, its work lived on
 * `clawbox/<runId>` and nothing on the card could bring it in.
 *
 * What is pinned here is the whole round trip: the settle RECORDS what became
 * of the work, the blocker is answered again and by name while it is still
 * there, the owner's own uncommitted work is never touched, and the merge
 * lands once they have dealt with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts real processes (bash / git): vitest's 5 s test and 10 s hook defaults
// are not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
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

function installWrapper(body: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), ["#!/usr/bin/env bash", readFirstTurn(), body].join("\n"), { mode: 0o755 });
}

const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-1" });

/** A harness that writes one file into its own copy and reports it, as the real one does. */
function harnessWrites(name: string, contents = "the run's work\n"): void {
  installWrapper([
    `printf '%s' ${JSON.stringify(contents)} > "$PWD/${name}"`,
    `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"%s/${name}"}}]}}\\n' "$PWD"`,
    `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } })}'`,
    `echo '${result("wrote a file")}'`,
    "exit 0",
  ].join("\n"));
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

/** Wait for the run to settle AND for its worktree verdict to be recorded. */
async function settled(id: string) {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  await vi.waitFor(() => {
    expect(lib.getRun(id)?.worktree?.result).toBeTruthy();
  }, { timeout: 20_000 });
  return lib.getRun(id)!;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-bring-home-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects });
  harnessWrites("feature.txt");
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a settled run whose work could not be merged", () => {
  it("records the blocker, refuses it again by name while it is there, and merges once it is gone", async () => {
    const dir = makeGitProject("alpha");
    // The owner's own uncommitted change — the commonest state of a folder
    // somebody actually works in, and the one the settle will not merge over.
    fs.writeFileSync(path.join(dir, "README.md"), "# alpha\n\nmine, not committed\n");

    const started = await lib.startRun({ task: "add a feature", directory: "alpha", source: "owner" });
    const run = await settled(started.id);

    expect(run.status).toBe("completed");
    expect(run.worktree?.removed).toBe(false);
    expect(run.worktree?.result).toMatchObject({ kind: "unmerged", reason: "dirty" });
    expect(run.worktree?.result?.detail).toContain("uncommitted");
    // The work is on the branch and nowhere else yet.
    expect(fs.existsSync(path.join(dir, "feature.txt"))).toBe(false);

    // Pressing the button while the blocker is still there answers the same
    // reason and touches nothing of the owner's.
    const refused = await lib.bringRunWorkHome(started.id);
    expect(refused).toMatchObject({ ok: false, reason: "dirty" });
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("mine, not committed");
    expect(fs.existsSync(path.join(dir, "feature.txt"))).toBe(false);
    expect(lib.getRun(started.id)?.worktree?.result).toMatchObject({ kind: "unmerged", reason: "dirty" });

    // The owner commits their own change, which is exactly what the card told
    // them to do, and presses it again.
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "my own edit");
    const brought = await lib.bringRunWorkHome(started.id);
    expect(brought).toMatchObject({ ok: true, merged: true, base: "master" });
    if (!brought.ok) return;
    expect(brought.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.readFileSync(path.join(dir, "feature.txt"), "utf8")).toContain("the run's work");
    expect(git(dir, "log", "--oneline")).toContain(started.id);

    // The record says where it went, and the copy is gone with the merge.
    const after = lib.getRun(started.id)!;
    expect(after.worktree?.result).toMatchObject({ kind: "merged", base: "master", commit: brought.commit });
    expect(after.worktree?.removed).toBe(true);
    expect(fs.existsSync(after.worktree!.path)).toBe(false);
  });

  it("records where the work went when the settle could merge it, so nothing offers to bring it home twice", async () => {
    const dir = makeGitProject("beta");
    const started = await lib.startRun({ task: "add a feature", directory: "beta", source: "owner" });
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.worktree?.removed).toBe(true);
    }, { timeout: 20_000 });
    const run = lib.getRun(started.id)!;
    expect(run.worktree?.result).toMatchObject({ kind: "merged", base: "master" });
    expect(run.worktree?.result?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(dir, "feature.txt"))).toBe(true);
  });

  it("names `not_on_base` when the project has been moved, and never moves it back", async () => {
    const dir = makeGitProject("gamma");
    fs.writeFileSync(path.join(dir, "README.md"), "# gamma\n\nmine\n");
    const started = await lib.startRun({ task: "add a feature", directory: "gamma", source: "owner" });
    await settled(started.id);
    // The owner tidies up their own change — but on another branch.
    git(dir, "checkout", "--quiet", "-b", "release");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "my own edit");
    const refused = await lib.bringRunWorkHome(started.id);
    expect(refused).toMatchObject({ ok: false, reason: "not_on_base" });
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
    expect(lib.getRun(started.id)?.worktree?.result).toMatchObject({ kind: "unmerged", reason: "not_on_base" });
  });

  it("names `conflict` when the two edits cannot be reconciled, and leaves the project on its own commit", async () => {
    const dir = makeGitProject("delta");
    // Both sides edit the same file. The project's edit is UNCOMMITTED while
    // the run works, so the settle refuses `dirty`; committing it turns the
    // next attempt into the conflict.
    harnessWrites("README.md", "# delta\n\nthe run's line\n");
    fs.writeFileSync(path.join(dir, "README.md"), "# delta\n\nthe owner's line\n");
    const started = await lib.startRun({ task: "edit the readme", directory: "delta", source: "owner" });
    await settled(started.id);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "my own edit");
    const head = git(dir, "rev-parse", "HEAD");

    const refused = await lib.bringRunWorkHome(started.id);
    expect(refused).toMatchObject({ ok: false, reason: "conflict" });
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("the owner's line");
    // The copy is still there, so the branch is still reachable by hand.
    expect(lib.getRun(started.id)?.worktree?.removed).toBe(false);
  });

  it("refuses a run that has no copy of its own, and one somebody is still working in", async () => {
    await expect(lib.bringRunWorkHome("run-nothere00")).rejects.toMatchObject({ kind: "not_found" });

    // A folder with no repository gets no worktree: its work was always in the
    // project folder, so there is nothing to bring home.
    const plain = path.join(projects, "plain");
    fs.mkdirSync(plain, { recursive: true });
    const inPlace = await lib.startRun({ task: "do it", directory: "plain", source: "owner" });
    expect(lib.getRun(inPlace.id)?.worktree).toBeNull();
    await lib.waitForRun(inPlace.id, 20_000);
    await expect(lib.bringRunWorkHome(inPlace.id)).rejects.toMatchObject({ kind: "invalid" });

    // A live run is still writing into that tree and committing to that
    // branch: merging half of it home is the race worktrees exist to stop.
    makeGitProject("epsilon");
    const flag = path.join(base, "go");
    installWrapper([`echo '${result("done")}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
    const live = await lib.startRun({ task: "keep going", directory: "epsilon", source: "owner" });
    await expect(lib.bringRunWorkHome(live.id)).rejects.toMatchObject({ kind: "busy" });
    fs.writeFileSync(flag, "go");
    await lib.waitForRun(live.id, 20_000);
  });
});
