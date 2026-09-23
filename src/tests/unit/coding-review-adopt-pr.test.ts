/**
 * The pull request the RUN opened, and whether the review loop ever sees it.
 *
 * THE DEFECT THIS PINS. `pr.number` was written on the auto-PR path and nowhere
 * else, so the loop only ever watched a pull request the box had opened itself.
 * A run whose task says to open one — which is most delegated work on this
 * device — pushed, ran `gh pr create` in its own turn, and settled with
 * `pr: null` and `review: null` on the record. Observed on a real run with the
 * review pass and auto-PR both switched on: a pull request open on GitHub, and
 * zero rounds worked, with nothing on the record to say why.
 *
 * Every test here fails without the adoption step, each in its own way: the
 * auto-PR path settles "failed" on the twin `gh pr create` refuses, and the
 * no-record path simply never grows a `pr` at all.
 *
 * Real git, because the branch is the whole subject: `attachRunWorktree` forks
 * the run's own branch and that name is what `gh pr list --head` is asked
 * about. `gh` itself is mocked — it is not on the test runner, and what it
 * answers is exactly what these tests vary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { runBranchName } from "@/lib/coding-pr-state";
import type { ReviewSnapshot } from "@/lib/coding-review-state";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts real processes (bash, git): vitest's 5 s test and 10 s hook defaults
// are not enough on a loaded runner. See test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const review = vi.hoisted(() => ({
  findOpenPullRequestForBranch: vi.fn(),
  readReviewSnapshot: vi.fn(),
  readFailedCheckLogs: vi.fn(),
  pushBranch: vi.fn(),
}));
vi.mock("@/lib/coding-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-review")>()),
  ...review,
}));
const github = vi.hoisted(() => ({
  openPullRequest: vi.fn(),
  readPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  // Defaults, restored by mockReset: auto-merge is not this file's subject.
  readAutoMergeFacts: vi.fn(async () => ({ error: "not read in this test" })),
  enableAutoMerge: vi.fn(async () => ({ ok: true })),
  disableAutoMerge: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  ...github,
}));
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
let project: string;
let restore: () => void;

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const snap = (over: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: null,
  checks: [{ name: "tests", state: "pass", url: null }],
  noChecks: false,
  threads: [],
  ...over,
});

const RESULT = JSON.stringify({
  type: "result", subtype: "success", is_error: false, num_turns: 1,
  result: "Opened the pull request myself.", session_id: "sess-own-pr",
});

/** A wrapper that writes a file (so the run has work to commit) and reports it
 *  the way the harness does — a run with no `filesTouched` is never committed. */
function installWrapper(): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      readFirstTurn(),
      'echo "hello" > "$PWD/index.html"',
      `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"%s/index.html"}}]}}\\n' "$PWD"`,
      `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } })}'`,
      `echo '${RESULT}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

async function boot(config: Record<string, unknown>): Promise<void> {
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({
      clawai_token: "claw_test_token",
      coding_agent_enabled: true,
      coding_agent_generate_images: false,
      coding_agent_default_directory: projects,
      ...config,
    }),
  );
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
}

beforeEach(() => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-adopt-pr-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;

  project = path.join(projects, "site");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "# site\n");
  git(project, "init", "--quiet", "-b", "master");
  git(project, "add", "-A");
  git(project, "commit", "--quiet", "-m", "first");

  installWrapper();
  review.pushBranch.mockResolvedValue({ ok: true });
  review.readFailedCheckLogs.mockResolvedValue([]);
  review.readReviewSnapshot.mockResolvedValue(snap());
  review.findOpenPullRequestForBranch.mockResolvedValue(null);
  github.mergePullRequest.mockResolvedValue({ ok: false, detail: "not in this test" });
  github.readPullRequest.mockResolvedValue({ error: "not in this test" });
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a pull request the run opened for itself", () => {
  it("is adopted instead of opening a twin, and the loop watches it", async () => {
    // GitHub already has one on the run's branch, because the run opened it.
    // `gh pr create` over that branch is refused — which before this fix
    // settled the record "failed" and left the real pull request unwatched.
    review.findOpenPullRequestForBranch.mockResolvedValue({
      number: 77,
      base: "beta",
      url: "https://github.com/o/r/pull/77",
    });
    github.openPullRequest.mockResolvedValue({ ok: false, detail: "a pull request for branch already exists" });
    await boot({ coding_agent_auto_pr: true, coding_agent_review_rounds: 3 });

    const started = await lib.startRun({ task: "build the site and open a pull request", directory: "site", source: "owner" });
    expect((await lib.waitForRun(started.id, 30_000))?.status).toBe("completed");
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.review?.state).toBe("clean"); }, { timeout: 20_000 });

    const run = lib.getRun(started.id);
    expect(run?.pr?.number).toBe(77);
    expect(run?.pr?.url).toBe("https://github.com/o/r/pull/77");
    // How it was found is ON THE RECORD, which is the evidence that the loop
    // now watches a pull request it did not open.
    expect(run?.pr?.foundBy).toBe("adopted");
    // GitHub's base wins over the record's intention: the run aimed its own
    // pull request at beta, and the merge guard is about where it really goes.
    expect(run?.pr?.base).toBe("beta");
    expect(run?.review?.prNumber).toBe(77);
    expect(run?.review?.base).toBe("beta");
    // Nothing was opened. A twin would have been refused by GitHub anyway.
    expect(github.openPullRequest).not.toHaveBeenCalled();
    expect(review.findOpenPullRequestForBranch).toHaveBeenCalledWith(expect.any(String), runBranchName(started.id));
    expect(run?.progress.join("\n")).toMatch(/Picked up pull request #77 into beta, opened by the run itself/);
    // And on disk, so the boot sweep picks the same loop up after a restart.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk[0].pr.number).toBe(77);
    expect(onDisk[0].pr.foundBy).toBe("adopted");
  });

  it("still opens one itself when the branch has none, and says so", async () => {
    // The regression guard on the line above: asking first must not have
    // replaced the auto-PR path, only got out of its way.
    review.findOpenPullRequestForBranch.mockResolvedValue(null);
    github.openPullRequest.mockResolvedValue({ ok: true, number: 12, url: "https://github.com/o/r/pull/12" });
    await boot({ coding_agent_auto_pr: true, coding_agent_review_rounds: 3 });

    const started = await lib.startRun({ task: "build the site", directory: "site", source: "owner" });
    expect((await lib.waitForRun(started.id, 30_000))?.status).toBe("completed");
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.review?.state).toBe("clean"); }, { timeout: 20_000 });

    const run = lib.getRun(started.id);
    expect(github.openPullRequest).toHaveBeenCalledTimes(1);
    expect(run?.pr?.number).toBe(12);
    expect(run?.pr?.foundBy).toBe("opened");
    expect(run?.pr?.base).toBe("master");
    expect(run?.progress.join("\n")).toMatch(/Opened pull request #12 into master/);
  });

  it("is picked up even when the run had no pull request record at all", async () => {
    // THE REPORTED CASE. With auto-PR off there is no `pr` on the record for a
    // number to be written into, so before this fix the settle returned at the
    // first line and the loop never engaged — `pr: null`, `review: null`, zero
    // rounds, over a pull request that was open the whole time.
    review.findOpenPullRequestForBranch.mockResolvedValue({
      number: 88,
      base: "beta",
      url: "https://github.com/o/r/pull/88",
    });
    await boot({ coding_agent_auto_pr: false, coding_agent_review_rounds: 3 });

    const started = await lib.startRun({ task: "fix the bug and open a pull request with gh", directory: "site", source: "owner" });
    const settled = await lib.waitForRun(started.id, 30_000);
    expect(settled?.status).toBe("completed");
    // The branch asked about is the run's OWN — its worktree's — and never a
    // guess at whatever HEAD happens to be: a shared branch would match a pull
    // request belonging to somebody else.
    expect(settled?.worktree?.branch).toBe(runBranchName(started.id));

    await vi.waitFor(() => { expect(lib.getRun(started.id)?.review?.state).toBe("clean"); }, { timeout: 20_000 });
    const run = lib.getRun(started.id);
    expect(run?.pr?.number).toBe(88);
    expect(run?.pr?.foundBy).toBe("adopted");
    expect(run?.pr?.branch).toBe(runBranchName(started.id));
    expect(run?.review?.prNumber).toBe(88);
    expect(review.findOpenPullRequestForBranch).toHaveBeenCalledWith(expect.any(String), runBranchName(started.id));
    // Nothing was opened on the owner's behalf: the auto-PR switch is still off
    // and this step only ever ADOPTS.
    expect(github.openPullRequest).not.toHaveBeenCalled();
  });

  it("leaves it alone when the owner has switched the review rounds off", async () => {
    // With no rounds there is nothing to adopt INTO: the older checks-only
    // watcher exists to finish what this box opened, and pointing it at a pull
    // request the box did not open would be a new behaviour under a setting
    // that promises the opposite.
    review.findOpenPullRequestForBranch.mockResolvedValue({
      number: 99,
      base: "beta",
      url: "https://github.com/o/r/pull/99",
    });
    await boot({ coding_agent_auto_pr: false, coding_agent_review_rounds: 0 });

    const started = await lib.startRun({ task: "fix the bug", directory: "site", source: "owner" });
    expect((await lib.waitForRun(started.id, 30_000))?.status).toBe("completed");

    const run = lib.getRun(started.id);
    expect(run?.pr).toBeNull();
    expect(run?.review).toBeNull();
    expect(review.findOpenPullRequestForBranch).not.toHaveBeenCalled();
  });
});
