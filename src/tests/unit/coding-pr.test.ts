/**
 * The auto-PR guardrails.
 *
 * These are the decisions that end with an agent merging its own code, so the
 * cases pinned here are the ones where a plausible implementation merges
 * something it should not have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import {
  decideMerge,
  emptyChecks,
  foldChecks,
  isPrPending,
  isPrPhase,
  runBranchName,
  MAX_WAIT_MS,
  NO_CHECKS_GRACE_MS,
  PR_PHASES,
  type PrSnapshot,
} from "@/lib/coding-pr-state";

// The runner tests below drive src/lib/coding-agent.ts against a fake
// claude-ds with GitHub stubbed out: the branch is "made", the pull request
// "opened", nothing touches git or gh. What is under test is the runner's
// bookkeeping of the pull request across the owner's gestures, which the pure
// helpers above cannot see.
const announce = vi.hoisted(() => vi.fn<(run: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: announce }));
const github = vi.hoisted(() => ({
  startRunBranch: vi.fn(),
  openPullRequest: vi.fn(),
  readPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  ...github,
}));
const commitRunWork = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-git")>()),
  commitRunWork,
}));

const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "OPEN",
  mergeable: "MERGEABLE",
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  noChecks: false,
  ...over,
});

describe("foldChecks", () => {
  it("reads a null rollup as no checks, not as an empty pass", () => {
    // gh answers `null` — not [] — when a PR has no checks at all.
    expect(foldChecks(null)).toEqual(emptyChecks());
    expect(foldChecks(undefined)).toEqual(emptyChecks());
  });

  it("counts a CheckRun that has not COMPLETED as pending, whatever its conclusion says", () => {
    expect(foldChecks([{ status: "IN_PROGRESS", conclusion: "SUCCESS" }])).toEqual(
      { total: 1, passed: 0, failed: 0, pending: 1 },
    );
    expect(foldChecks([{ status: "QUEUED", conclusion: null }])).toEqual(
      { total: 1, passed: 0, failed: 0, pending: 1 },
    );
  });

  it("folds both node shapes — CheckRun conclusion and StatusContext state", () => {
    expect(foldChecks([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { state: "SUCCESS" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
      { status: "COMPLETED", conclusion: "FAILURE" },
      { state: "PENDING" },
    ])).toEqual({ total: 5, passed: 3, failed: 1, pending: 1 });
  });
});

describe("decideMerge", () => {
  it("NEVER merges a pull request with no checks — vacuous green is the trap", () => {
    // A repo with no workflows, or with Actions disabled, satisfies "every
    // check passed" trivially. Merging on that would merge everything on sight.
    const verdict = decideMerge({
      snapshot: snap({ checks: emptyChecks(), noChecks: true }),
      waitedMs: NO_CHECKS_GRACE_MS + 1,
      reviewOk: true,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("No checks ran");
  });

  it("waits through the grace period before calling an empty rollup 'no checks'", () => {
    // GitHub attaches check runs seconds after the PR opens, so the first poll
    // routinely sees nothing. Reading that as 'no CI' would merge instantly.
    expect(decideMerge({
      snapshot: snap({ checks: emptyChecks(), noChecks: true }),
      waitedMs: 5_000,
      reviewOk: true,
    })).toEqual({ action: "wait" });
  });

  it("waits while any check is pending", () => {
    expect(decideMerge({
      snapshot: snap({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }),
      waitedMs: 30_000,
      reviewOk: true,
    })).toEqual({ action: "wait" });
  });

  it("blocks on a single failed check and says how many", () => {
    const verdict = decideMerge({
      snapshot: snap({ checks: { total: 3, passed: 2, failed: 1, pending: 0 } }),
      waitedMs: 30_000,
      reviewOk: true,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("1 of 3 checks failed");
  });

  it("merges only when a real check passed and nothing is outstanding", () => {
    expect(decideMerge({ snapshot: snap(), waitedMs: 30_000, reviewOk: true })).toEqual({ action: "merge" });
  });

  it("does not merge when the review pass was not clean", () => {
    const verdict = decideMerge({ snapshot: snap(), waitedMs: 30_000, reviewOk: false });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("review pass");
  });

  it("answers a failed review at once instead of polling the checks to the end", () => {
    // The verdict is already known; thirty minutes of `gh pr view` would only
    // delay it, and would then be reported as "gave up waiting".
    const verdict = decideMerge({
      snapshot: snap({ checks: { total: 2, passed: 0, failed: 0, pending: 2 } }),
      waitedMs: 1_000,
      reviewOk: false,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("review pass");
  });

  it("treats mergeable as the string enum it is, not a boolean", () => {
    // CONFLICTING is a definite no; UNKNOWN is GitHub still computing it.
    expect(decideMerge({ snapshot: snap({ mergeable: "CONFLICTING" }), waitedMs: 30_000, reviewOk: true }).action).toBe("block");
    expect(decideMerge({ snapshot: snap({ mergeable: "UNKNOWN" }), waitedMs: 30_000, reviewOk: true })).toEqual({ action: "wait" });
  });

  it("gives up rather than waiting forever", () => {
    const verdict = decideMerge({
      snapshot: snap({ mergeable: "UNKNOWN", checks: { total: 1, passed: 1, failed: 0, pending: 0 } }),
      waitedMs: MAX_WAIT_MS + 1,
      reviewOk: true,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("Gave up waiting");
  });

  it("gives up on a check that never completes", () => {
    // A stuck runner answers "pending" on every poll. Tested after the
    // pending branch, the ceiling was never reached and the watcher polled
    // for good — the run stayed pending and out of every history sweep.
    const verdict = decideMerge({
      snapshot: snap({ checks: { total: 1, passed: 0, failed: 0, pending: 1 } }),
      waitedMs: MAX_WAIT_MS + 1,
      reviewOk: true,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("Gave up waiting");
  });

  it("still names a failed check at the ceiling — a definite answer beats the clock", () => {
    const verdict = decideMerge({
      snapshot: snap({ checks: { total: 2, passed: 0, failed: 1, pending: 1 } }),
      waitedMs: MAX_WAIT_MS + 1,
      reviewOk: true,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("1 of 2 checks failed");
  });

  it("does not re-merge a merged or closed pull request", () => {
    expect(decideMerge({ snapshot: snap({ state: "MERGED" }), waitedMs: 1, reviewOk: true }).action).toBe("block");
    expect(decideMerge({ snapshot: snap({ state: "CLOSED" }), waitedMs: 1, reviewOk: true }).action).toBe("block");
  });
});

describe("run branches", () => {
  it("names one branch per run so two runs cannot collide", () => {
    expect(runBranchName("run-abc123")).toBe("clawbox/run-abc123");
    expect(runBranchName("run-abc123")).not.toBe(runBranchName("run-def456"));
  });

  it("knows which PRs are still being watched", () => {
    const base = { number: 1, url: "u", branch: "b", base: "main", checks: emptyChecks(), detail: null, startedAt: 0, endedAt: null, reviewOk: true };
    expect(isPrPending({ ...base, phase: "waiting" })).toBe(true);
    expect(isPrPending({ ...base, phase: "opening" })).toBe(true);
    expect(isPrPending({ ...base, phase: "merged" })).toBe(false);
    expect(isPrPending({ ...base, phase: "blocked" })).toBe(false);
    expect(isPrPending({ ...base, phase: "failed" })).toBe(false);
    expect(isPrPending(null)).toBe(false);
    expect(isPrPending(undefined)).toBe(false);
  });

  it("lists every phase a stored record may carry, and nothing else", () => {
    // The reader of coding-agent-runs.json validates against this list; a
    // phase written but not listed would drop the pull request on the next
    // read (the same trap RUN_STATUSES exists to close).
    expect([...PR_PHASES].sort()).toEqual(["blocked", "failed", "merged", "opening", "waiting"]);
    for (const phase of PR_PHASES) expect(isPrPhase(phase)).toBe(true);
    expect(isPrPhase("open")).toBe(false);
    expect(isPrPhase(undefined)).toBe(false);
  });
});

describe("the pull request across the owner's gestures", () => {
  type Lib = typeof import("@/lib/coding-agent");
  let lib: Lib;
  let base: string;
  let home: string;
  let root: string;
  let binDir: string;
  let restore: () => void;

  const INIT = '{"type":"system","subtype":"init","session_id":"sess-abc-123","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
  const ASSISTANT = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t_edit", name: "Edit", input: { file_path: "index.html" } }] },
  });
  const TOOL_RESULTS = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t_edit", content: "ok" }] },
  });
  const RESULT = JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01,
    result: "Changed index.html.", session_id: "sess-abc-123",
  });

  /** A stand-in for the wrapper: prints the stream-json `body` asks for. */
  function installFakeWrapper(lines: string[]): void {
    fs.writeFileSync(path.join(binDir, "claude-ds"), ["#!/usr/bin/env bash", "cat > /dev/null", ...lines].join("\n"), { mode: 0o755 });
  }
  /** One edit, then wait for `flag` before finishing — the window a pause lands in. */
  const waitingBody = (flag: string) => [
    `echo '${INIT}'`, `echo '${ASSISTANT}'`, `echo '${TOOL_RESULTS}'`,
    `while [ ! -f "${flag}" ]; do sleep 0.05; done`, `echo '${RESULT}'`, "exit 0",
  ];
  const finishingBody = () => [`echo '${INIT}'`, `echo '${ASSISTANT}'`, `echo '${TOOL_RESULTS}'`, `echo '${RESULT}'`, "exit 0"];

  async function finished(id: string) {
    const run = await lib.waitForRun(id, 15_000);
    if (!run) throw new Error("run vanished");
    return run;
  }

  /** A run started with auto-PR on and paused mid-work: the shape every test here begins from. */
  async function startAndPause(flag: string) {
    installFakeWrapper(waitingBody(flag));
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    expect(started.pr?.phase).toBe("opening");
    expect(github.startRunBranch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.filesTouched.length).toBeGreaterThan(0); }, { timeout: 5000 });
    lib.pauseRun(started.id);
    const paused = await finished(started.id);
    expect(paused.status).toBe("paused");
    return paused;
  }

  beforeEach(async () => {
    restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-pr-"));
    home = path.join(base, "home");
    root = path.join(home, "clawbox");
    binDir = path.join(home, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAWBOX_ROOT = root;
    fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, coding_agent_auto_pr: true }),
    );
    const project = path.join(root, "data", "code-projects", "site");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ projectId: "site", name: "site" }));
    fs.writeFileSync(path.join(project, "index.html"), "<html></html>");

    github.startRunBranch.mockImplementation(async ({ runId }: { runId: string }) => ({ ok: true, branch: runBranchName(runId), base: "main" }));
    github.openPullRequest.mockResolvedValue({ ok: true, number: 7, url: "https://github.com/o/r/pull/7" });
    // Never decides: the watcher's first tick is a poll interval away and unref'd.
    github.readPullRequest.mockResolvedValue({ error: "not in this test" });
    github.mergePullRequest.mockResolvedValue({ ok: false, detail: "not in this test" });
    commitRunWork.mockResolvedValue({ committed: true, sha: "abc1234", initialized: false });
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
  });

  afterEach(() => {
    lib._resetCodingAgentStateForTests();
    restore();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("keeps the pull request 'opening' through a pause and opens it when the resumed run completes", async () => {
    // A pause is not the end of the chain: the run resumes IN PLACE, on the
    // same record and branch. Settling the pull request on the pause meant
    // the completion after the resume found nothing left to open, and every
    // run the owner paused once ended on its own branch with no pull request.
    const paused = await startAndPause(path.join(base, "flag-1"));
    expect(paused.pr?.phase).toBe("opening");
    expect(paused.progress.join("\n")).not.toMatch(/Not merged/);
    expect(github.openPullRequest).not.toHaveBeenCalled();

    installFakeWrapper(finishingBody());
    await lib.resumeRun(paused.id);
    const done = await finished(paused.id);
    expect(done.status).toBe("completed");
    await vi.waitFor(() => { expect(lib.getRun(paused.id)?.pr?.phase).toBe("waiting"); }, { timeout: 5000 });
    const pr = lib.getRun(paused.id)?.pr;
    expect(pr).toMatchObject({ number: 7, branch: runBranchName(paused.id), base: "main", reviewOk: true });
    expect(github.openPullRequest).toHaveBeenCalledWith(expect.objectContaining({ branch: runBranchName(paused.id), base: "main" }));
  });

  it("keeps a paused run's pending pull request across a restart, as it keeps the run", async () => {
    // The boot sweep settles an "opening" pull request whose run the restart
    // killed — the settle that would have opened it died with the server. A
    // paused run is NOT that: its record survives the restart and it resumes
    // in place, so its pull request is still coming.
    const paused = await startAndPause(path.join(base, "flag-2"));
    lib._resetCodingAgentStateForTests();
    lib.resumePullRequestWatches();
    expect(lib.getRun(paused.id)?.status).toBe("paused");
    expect(lib.getRun(paused.id)?.pr?.phase).toBe("opening");
  });

  it("settles the pull request when a paused run is stopped — the one end a pause has that never comes back", async () => {
    // Stop on a paused run has no process and never reaches finishRun, so
    // the pull request the pause kept "opening" would have stayed pending for
    // good — and pending keeps the run out of the history sweeps.
    const paused = await startAndPause(path.join(base, "flag-3"));
    const stopped = lib.stopRun(paused.id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.pr?.phase).toBe("failed");
    expect(stopped.pr?.detail).toContain("Stopped before a pull request was opened");
    expect(stopped.pr?.detail).toContain(runBranchName(paused.id));
    expect(isPrPending(stopped.pr)).toBe(false);
    expect(github.openPullRequest).not.toHaveBeenCalled();
  });

  it("settles the pull request on the owner's Stop of a live run, and opens nothing", async () => {
    // Stop is the end of the chain — a stopped run is only ever taken up
    // again as a NEW run on a branch of its own — and pushing the owner's
    // code seconds after they pressed Stop would be the box overruling them.
    installFakeWrapper(waitingBody(path.join(base, "flag-4")));
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.filesTouched.length).toBeGreaterThan(0); }, { timeout: 5000 });
    lib.stopRun(started.id);
    const stopped = await finished(started.id);
    expect(stopped.status).toBe("stopped");
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.pr?.phase).toBe("failed"); }, { timeout: 5000 });
    expect(lib.getRun(started.id)?.pr?.detail).toContain("Stopped before a pull request was opened");
    expect(github.openPullRequest).not.toHaveBeenCalled();
  });
});
