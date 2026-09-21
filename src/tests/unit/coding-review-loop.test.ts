/**
 * The review loop as the runner drives it: what one poll does to the record,
 * and what a round handed to the harness looks like.
 *
 * The decisions themselves are pinned in coding-review-state.test.ts, which is
 * pure. What that file cannot see is the bookkeeping around them — that the
 * pull request record leaves its pending phase when the loop ends (a loop that
 * did not would keep its run out of every history sweep and keep the desktop
 * polling for good), that a restart mid-round picks the loop back up, and that
 * a round is a follow-up run in the SAME session which does not branch and
 * does not open a second pull request.
 *
 * `@/lib/coding-review` is mocked at its `gh` callers only: the real ones spawn
 * `gh`, which is not the subject here and is not on the test runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { isPrPending, runBranchName } from "@/lib/coding-pr-state";
import type { ReviewSnapshot } from "@/lib/coding-review-state";
import {
  MAX_FEEDBACK_CHECKS,
  MAX_FEEDBACK_LOG_CHARS,
  MAX_FEEDBACK_THREADS,
  MAX_THREAD_BODY_CHARS,
  buildReviewFeedback,
} from "@/lib/coding-review-state";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// The same ceiling the other coding-agent suites carry: the awaited reset in
// teardown can spend the settle drain's own budget plus the removal's retry
// backoff, which is most of vitest's 10 s DEFAULT hook budget.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const review = vi.hoisted(() => ({
  readReviewSnapshot: vi.fn(),
  readFailedCheckLogs: vi.fn(),
  pushBranch: vi.fn(),
}));
vi.mock("@/lib/coding-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-review")>()),
  ...review,
}));
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
const newestCommitSince = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-git")>()),
  commitRunWork,
  newestCommitSince,
}));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));

type Lib = typeof import("@/lib/coding-agent");

const RUN_ID = "run-review0001";
const PR_NUMBER = 12;

const snap = (over: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: null,
  checks: [{ name: "tests", state: "pass", url: null }],
  noChecks: false,
  threads: [],
  ...over,
});

describe("the review loop's watcher", () => {
  let lib: Lib;
  let base: string;
  let home: string;
  let root: string;
  let restore: () => void;

  /** A record as the previous server left it: a pull request open, the loop watching. */
  function record(over: { round?: number; maxRounds?: number; state?: string; roundStartedAt?: number } = {}) {
    const now = Date.now();
    return {
      id: RUN_ID,
      task: "build the thing",
      directory: home,
      projectId: null,
      source: "owner",
      status: "completed",
      startedAt: now - 120_000,
      completedAt: now - 60_000,
      sessionId: "sess-old",
      summary: null,
      error: null,
      numTurns: 3,
      filesTouched: ["index.html"],
      commandsRun: 0,
      permissionDenials: 0,
      progress: [],
      exitCode: 0,
      pr: {
        phase: "review",
        number: PR_NUMBER,
        url: `https://github.com/o/r/pull/${PR_NUMBER}`,
        branch: runBranchName(RUN_ID),
        base: "beta",
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        detail: null,
        startedAt: now - 60_000,
        endedAt: null,
        reviewOk: true,
      },
      review: {
        prNumber: PR_NUMBER,
        url: `https://github.com/o/r/pull/${PR_NUMBER}`,
        base: "beta",
        round: over.round ?? 0,
        maxRounds: over.maxRounds ?? 3,
        state: over.state ?? "polling",
        checks: [],
        unresolvedThreads: 0,
        reviewDecision: null,
        lastPolledAt: null,
        roundStartedAt: over.roundStartedAt ?? now - 60_000,
        detail: null,
        fixRunId: null,
      },
    };
  }

  function writeRecord(over: Parameters<typeof record>[0] = {}): void {
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([record(over)]));
  }

  async function boot(config: Record<string, unknown> = {}): Promise<void> {
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({ clawai_token: "t", coding_agent_enabled: true, coding_agent_auto_pr: true, ...config }),
    );
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
  }

  beforeEach(() => {
    restore = saveEnv("HOME", "CLAWBOX_ROOT");
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-review-loop-"));
    home = path.join(base, "home");
    root = path.join(home, "clawbox");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAWBOX_ROOT = root;
    review.pushBranch.mockResolvedValue({ ok: true });
    review.readFailedCheckLogs.mockResolvedValue([]);
    github.mergePullRequest.mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    await lib._resetCodingAgentStateForTests();
    restore();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("ends CLEAN — not merged — when the owner has not switched merging on", async () => {
    review.readReviewSnapshot.mockResolvedValue(snap());
    await boot();
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("clean"); });

    expect(github.mergePullRequest).not.toHaveBeenCalled();
    const run = lib.getRun(RUN_ID);
    expect(run?.review?.detail).toMatch(/Merge it when you are ready/);
    // The pull request record has to leave its pending phase with the loop, or
    // the run stays out of the history sweeps and every desktop keeps polling.
    expect(run?.pr?.phase).toBe("blocked");
    expect(isPrPending(run?.pr)).toBe(false);
    expect(run?.pr?.endedAt).not.toBeNull();
    // And on disk that way, so the boot sweep does not start it again.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk[0].review.state).toBe("clean");
    expect(onDisk[0].pr.phase).toBe("blocked");
  });

  it("merges a green pull request once the owner HAS switched merging on", async () => {
    review.readReviewSnapshot.mockResolvedValue(snap());
    await boot({ coding_agent_auto_merge: true });
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("merged"); });

    expect(github.mergePullRequest).toHaveBeenCalledWith(home, PR_NUMBER);
    const run = lib.getRun(RUN_ID);
    expect(run?.pr?.phase).toBe("merged");
    expect(run?.progress.join("\n")).toMatch(/Merged into the base branch/);
  });

  it("records what the poll saw even while it goes on waiting", async () => {
    review.readReviewSnapshot.mockResolvedValue(snap({
      checks: [{ name: "tests", state: "pending", url: null }],
      reviewDecision: "REVIEW_REQUIRED",
      threads: [{ path: "a.ts", line: 1, author: "r", body: "look at this", url: null }],
    }));
    await boot();
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.lastPolledAt).not.toBeNull(); });

    const loop = lib.getRun(RUN_ID)?.review;
    expect(loop?.state).toBe("polling");
    expect(loop?.checks).toEqual([{ name: "tests", state: "pending", url: null }]);
    expect(loop?.unresolvedThreads).toBe(1);
    expect(loop?.reviewDecision).toBe("REVIEW_REQUIRED");
    expect(isPrPending(lib.getRun(RUN_ID)?.pr)).toBe(true);
  });

  it("hands the pull request back at the cap, naming what is still wrong", async () => {
    review.readReviewSnapshot.mockResolvedValue(snap({ checks: [{ name: "build", state: "fail", url: null }] }));
    await boot();
    // Every round already spent: the next poll cannot start another.
    writeRecord({ round: 3, maxRounds: 3 });

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("needs_owner"); });

    const run = lib.getRun(RUN_ID);
    expect(run?.review?.detail).toContain("3 review rounds did not clear it");
    expect(run?.review?.detail).toContain("1 failing check");
    expect(run?.pr?.phase).toBe("blocked");
  });

  it("refuses to merge when the automatic review pass did not finish cleanly", async () => {
    // `pr.reviewOk` is written when the pull request opens and is the loop's
    // only knowledge of the reviewer. Without reading it, a green suite merged
    // work the review had rejected — which is exactly what the checks-only
    // watcher has always refused (decideMerge).
    review.readReviewSnapshot.mockResolvedValue(snap());
    await boot({ coding_agent_auto_merge: true });
    const rec = record();
    rec.pr.reviewOk = false;
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([rec]));

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("needs_owner"); });

    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(lib.getRun(RUN_ID)?.review?.detail).toContain("review pass");
  });

  it("refuses to merge into main however green it is, and says so", async () => {
    review.readReviewSnapshot.mockResolvedValue(snap());
    await boot({ coding_agent_auto_merge: true });
    const rec = record();
    rec.pr.base = "main";
    rec.review.base = "main";
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([rec]));

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("needs_owner"); });

    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(lib.getRun(RUN_ID)?.review?.detail).toContain("main");
  });

  it("gives up at the ceiling when GitHub cannot be read, instead of polling for ever", async () => {
    review.readReviewSnapshot.mockResolvedValue({ error: "gh: To get started with GitHub CLI, please run: gh auth login" });
    await boot();
    // This round started just over the ceiling ago, so the very next poll is past it.
    writeRecord({ roundStartedAt: Date.now() - 61 * 60_000 });

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("needs_owner"); });

    const run = lib.getRun(RUN_ID);
    // The owner hears what gh said, not only that it failed.
    expect(run?.review?.detail).toContain("gh auth login");
    expect(run?.pr?.phase).toBe("blocked");
  });

  it("does NOT spend a round the box could not start, and keeps looking", async () => {
    // "busy", "not_ready" and "disabled" are all about the box this minute
    // rather than about this pull request, so `startFixRun` answers "retry"
    // before the round is counted. Spending the owner's last round on a start
    // that never happened would be the wrong bill.
    review.readReviewSnapshot.mockResolvedValue(snap({ checks: [{ name: "build", state: "fail", url: null }] }));
    await boot({ coding_agent_enabled: false });
    writeRecord({ round: 1 });

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.lastPolledAt).not.toBeNull(); });
    // No run was started, the round stands where it was, and the loop is still
    // watching rather than settled.
    expect(lib.listRuns().some((r) => r.reviewLoopOf === RUN_ID)).toBe(false);
    expect(lib.getRun(RUN_ID)?.review?.round).toBe(1);
    expect(lib.getRun(RUN_ID)?.review?.state).toBe("polling");
  });

  it("gives the pull request back once it has been unable to start a round for an hour", async () => {
    // The retry above is bounded by the same ceiling everything else here is,
    // or a box left switched off would poll this pull request for ever.
    review.readReviewSnapshot.mockResolvedValue(snap({ checks: [{ name: "build", state: "fail", url: null }] }));
    await boot({ coding_agent_enabled: false });
    writeRecord({ round: 1, roundStartedAt: Date.now() - 61 * 60_000 });

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("needs_owner"); });
    const run = lib.getRun(RUN_ID);
    expect(run?.review?.round).toBe(1);
    expect(run?.review?.detail).toContain("could not start a review round in time");
    expect(run?.pr?.phase).toBe("blocked");
  });

  it("picks a round up after a restart killed the run that was working on it", async () => {
    // "working" cannot survive a restart: the round's process died with the
    // previous server, so nothing will ever settle it back into the loop.
    // Whatever it committed is on disk; polling again is what picks it up.
    review.readReviewSnapshot.mockResolvedValue(snap());
    await boot();
    writeRecord({ state: "working", round: 1 });

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("clean"); });
    expect(review.readReviewSnapshot).toHaveBeenCalledWith(home, PR_NUMBER);
    // The round that died is not handed back: it was spent.
    expect(lib.getRun(RUN_ID)?.review?.round).toBe(1);
  });

  it("leaves a pull request the OLD checks-only watcher owns alone", async () => {
    // A box with the loop switched off keeps `pr.phase: "waiting"`, and that
    // watcher is a different one with a different ending.
    github.readPullRequest.mockResolvedValue({ error: "not in this test" });
    await boot({ coding_agent_review_rounds: 0 });
    const rec = record();
    rec.pr.phase = "waiting";
    (rec as { review?: unknown }).review = null;
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([rec]));

    lib.resumePullRequestWatches();
    // The old watcher's first tick is a poll interval away and unref'd, so
    // nothing happens here at all — which is the point: the loop must not have
    // taken this pull request over.
    await new Promise((r) => setTimeout(r, 50));
    expect(review.readReviewSnapshot).not.toHaveBeenCalled();
    expect(lib.getRun(RUN_ID)?.pr?.phase).toBe("waiting");
    expect(lib.getRun(RUN_ID)?.review).toBeNull();
  });
});

describe("a round handed to the harness", () => {
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
    result: "Fixed the failing check.", session_id: "sess-abc-123",
  });

  /** A stand-in for the wrapper that keeps the task it was handed, so the test
   *  can read what the loop actually said to the run. */
  function installFakeWrapper(): void {
    fs.writeFileSync(
      path.join(binDir, "claude-ds"),
      [
        "#!/usr/bin/env bash",
        readFirstTurn(path.join(base, "last-task.txt")),
        `printf '%s\\n' "$@" > "${path.join(base, "last-argv.txt")}"`,
        `echo '${INIT}'`, `echo '${ASSISTANT}'`, `echo '${TOOL_RESULTS}'`, `echo '${RESULT}'`, "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  beforeEach(async () => {
    restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-review-round-"));
    home = path.join(base, "home");
    root = path.join(home, "clawbox");
    binDir = path.join(home, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAWBOX_ROOT = root;
    fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    installFakeWrapper();
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({
        clawai_token: "claw_test_token",
        clawai_tier: "flash",
        coding_agent_enabled: true,
        coding_agent_generate_images: false,
        coding_agent_auto_pr: true,
        coding_agent_review_rounds: 3,
      }),
    );
    const project = path.join(root, "data", "code-projects", "site");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ projectId: "site", name: "site" }));
    fs.writeFileSync(path.join(project, "index.html"), "<html></html>");

    github.startRunBranch.mockImplementation(async ({ runId }: { runId: string }) => ({ ok: true, branch: runBranchName(runId), base: "beta" }));
    github.openPullRequest.mockResolvedValue({ ok: true, number: PR_NUMBER, url: `https://github.com/o/r/pull/${PR_NUMBER}` });
    github.mergePullRequest.mockResolvedValue({ ok: false, detail: "not in this test" });
    commitRunWork.mockResolvedValue({ committed: true, sha: "abc1234", initialized: false });
    newestCommitSince.mockResolvedValue(null);
    review.pushBranch.mockResolvedValue({ ok: true });
    review.readFailedCheckLogs.mockResolvedValue([
      { check: { name: "build", state: "fail", url: null }, log: "error TS2322: Type 'string' is not assignable" },
    ]);
    // One failing check, then green once the round has been through.
    review.readReviewSnapshot
      .mockResolvedValueOnce(snap({ checks: [{ name: "build", state: "fail", url: null }] }))
      .mockResolvedValue(snap());
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
  });

  afterEach(async () => {
    await lib._resetCodingAgentStateForTests();
    restore();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("resumes the run's own session with the failing check's log, and does not branch again", async () => {
    const started = await lib.startRun({ task: "build the site", projectId: "site", source: "owner" });
    expect(started.pr?.phase).toBe("opening");
    const origin = await lib.waitForRun(started.id, 15_000);
    expect(origin?.status).toBe("completed");

    // The pull request opens at the settle, the loop's first poll finds the
    // failing check, a round goes out, and the poll after it is green. With
    // `gh` mocked that whole arc takes milliseconds, so the end state is what
    // is waited for and the record is read back afterwards.
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.review?.state).toBe("clean"); }, { timeout: 20_000 });

    const fix = lib.listRuns().find((r) => r.reviewLoopOf === started.id);
    expect(fix).toBeTruthy();

    // A round is a follow-up turn, not a new piece of work: it stays on the
    // branch its pull request is already open from, and opens nothing.
    expect(github.startRunBranch).toHaveBeenCalledTimes(1);
    expect(fix?.pr).toBeNull();
    expect(github.openPullRequest).toHaveBeenCalledTimes(1);
    // And it gets no review pass of its own: the work it did was answering one.
    expect(lib.listRuns().some((r) => r.reviewOf === fix?.id)).toBe(false);

    // What the loop actually said to it.
    const task = fs.readFileSync(path.join(base, "last-task.txt"), "utf-8");
    expect(task).toContain(`#${PR_NUMBER}`);
    expect(task).toContain("review round 1 of 3");
    expect(task).toContain("### build");
    expect(task).toContain("error TS2322");
    expect(task).toContain("Do not open another pull request");

    // The round is on the origin's record, with the run that spent it.
    const origin2 = lib.getRun(started.id);
    expect(origin2?.review?.round).toBe(1);
    expect(origin2?.review?.fixRunId).toBe(fix?.id);
    // The DEFAULT path, recorded as such: the findings went back into the
    // session that wrote the code, which is what makes the round cheap and
    // what the fallback below exists to fall back FROM.
    expect(origin2?.review?.fixMode).toBe("resumed");
    expect(origin2?.review?.fixDetail).toContain(started.id);
    // And the round is on the fix run's own record, so its card can say which
    // one it is without the loop's counter.
    expect(fix?.reviewRound).toBe(1);
    expect(origin2?.progress.join("\n")).toMatch(/Review round 1 of 3 handed to the coding agent/);
    // The round's own commits are pushed on its way home — the run is told to
    // push and usually does, and an unpushed fix would have the loop re-read an
    // unchanged pull request until the rounds ran out.
    expect(review.pushBranch).toHaveBeenCalledWith(expect.any(String), runBranchName(started.id));
    expect(origin2?.pr?.phase).toBe("blocked");
  });
});

/**
 * The round that arrives after the session is gone.
 *
 * A round routinely arrives twenty minutes or more after the run settled — the
 * install check alone takes that long — and by then a run that failed, was
 * stopped, or gave up has no session left to re-enter. Resuming is still the
 * DEFAULT and the right one: the run holds the code it wrote and why. This is
 * the fallback, and before it existed the start was refused outright, the loop
 * settled `needs_owner`, and the owner's round bought nothing.
 */
describe("a round whose run can no longer be resumed", () => {
  let lib: Lib;
  let base: string;
  let home: string;
  let root: string;
  let binDir: string;
  let restore: () => void;

  const INIT = '{"type":"system","subtype":"init","session_id":"sess-fresh-1","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
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
    result: "Read the branch and fixed the failing check.", session_id: "sess-fresh-1",
  });

  /** The origin as a run that FAILED leaves it: a session id on the record, and
   *  nothing behind it that can be re-entered. */
  function writeDeadRecord(): void {
    const now = Date.now();
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([{
      id: RUN_ID,
      task: "build the thing",
      directory: home,
      projectId: null,
      source: "owner",
      status: "failed",
      resumable: false,
      // Inherited by the round, like the provider and the model: a round is a
      // continuation, not a new piece of work.
      effort: "low",
      startedAt: now - 1_800_000,
      completedAt: now - 1_500_000,
      sessionId: "sess-dead",
      summary: null,
      error: "the harness went away",
      numTurns: 3,
      filesTouched: ["index.html"],
      commandsRun: 0,
      permissionDenials: 0,
      progress: [],
      exitCode: 1,
      pr: {
        phase: "review",
        number: PR_NUMBER,
        url: `https://github.com/o/r/pull/${PR_NUMBER}`,
        branch: runBranchName(RUN_ID),
        base: "beta",
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        detail: null,
        startedAt: now - 1_500_000,
        endedAt: null,
        reviewOk: true,
        foundBy: "adopted",
      },
      review: {
        prNumber: PR_NUMBER,
        url: `https://github.com/o/r/pull/${PR_NUMBER}`,
        base: "beta",
        round: 0,
        maxRounds: 3,
        state: "polling",
        checks: [],
        unresolvedThreads: 0,
        reviewDecision: null,
        lastPolledAt: null,
        roundStartedAt: now - 60_000,
        detail: null,
        fixRunId: null,
        fixMode: null,
        fixDetail: null,
      },
    }]));
  }

  beforeEach(async () => {
    restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-review-fresh-"));
    home = path.join(base, "home");
    root = path.join(home, "clawbox");
    binDir = path.join(home, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAWBOX_ROOT = root;
    fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(binDir, "claude-ds"),
      [
        "#!/usr/bin/env bash",
        readFirstTurn(path.join(base, "last-task.txt")),
        `printf '%s\\n' "$@" > "${path.join(base, "last-argv.txt")}"`,
        `echo '${INIT}'`, `echo '${ASSISTANT}'`, `echo '${TOOL_RESULTS}'`, `echo '${RESULT}'`, "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({
        clawai_token: "claw_test_token",
        clawai_tier: "flash",
        coding_agent_enabled: true,
        coding_agent_generate_images: false,
        coding_agent_auto_pr: true,
        coding_agent_review_rounds: 3,
        // The owner's CURRENT effort, which the round must not pick up over the
        // one the run it is fixing was working at.
        coding_agent_effort: "max",
      }),
    );
    review.pushBranch.mockResolvedValue({ ok: true });
    review.readFailedCheckLogs.mockResolvedValue([
      { check: { name: "build", state: "fail", url: null }, log: "error TS2322: Type 'string' is not assignable" },
    ]);
    review.readReviewSnapshot
      .mockResolvedValueOnce(snap({ checks: [{ name: "build", state: "fail", url: null }] }))
      .mockResolvedValue(snap());
    github.mergePullRequest.mockResolvedValue({ ok: false, detail: "not in this test" });
    writeDeadRecord();
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
  });

  afterEach(async () => {
    await lib._resetCodingAgentStateForTests();
    restore();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("starts a FRESH run on the same branch, says why, and still spends one round", async () => {
    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("clean"); }, { timeout: 20_000 });

    const origin = lib.getRun(RUN_ID);
    // ONE round against the owner's budget, whichever path was taken.
    expect(origin?.review?.round).toBe(1);
    // Which path, and why — the thing anyone reads first about a round that
    // went badly, and the reason there is no owner setting for the choice.
    expect(origin?.review?.fixMode).toBe("fresh");
    expect(origin?.review?.fixDetail).toContain(RUN_ID);
    expect(origin?.review?.fixDetail).toContain("failed");

    const fix = lib.listRuns().find((r) => r.reviewLoopOf === RUN_ID);
    expect(fix).toBeTruthy();
    expect(origin?.review?.fixRunId).toBe(fix?.id);
    // Linked on BOTH records: the origin points at the round, the round names
    // the loop it belongs to and which round of it it is.
    expect(fix?.reviewRound).toBe(1);
    expect(fix?.progress.join("\n")).toMatch(new RegExp(`Review round 1 for ${RUN_ID}`));

    // The same chain: the same folder, so the same branch and the same project.
    expect(fix?.directory).toBe(origin?.directory);
    expect(fix?.projectId).toBe(origin?.projectId);
    // The same effort as the run it is fixing, NOT the owner's current one.
    expect(fix?.effort).toBe("low");
    // It opens nothing of its own, exactly as a resumed round does not.
    expect(fix?.pr).toBeNull();

    // The dead session was not re-entered: a resume replays what killed it.
    const argv = fs.readFileSync(path.join(base, "last-argv.txt"), "utf-8");
    expect(argv).not.toContain("sess-dead");
    expect(argv).not.toContain("--resume");

    // And it was told it is starting cold, with the findings it still has to fix.
    const task = fs.readFileSync(path.join(base, "last-task.txt"), "utf-8");
    expect(task).toMatch(/no memory of it/i);
    expect(task).toContain("git diff origin/beta...HEAD");
    expect(task).toContain(`#${PR_NUMBER}`);
    expect(task).toContain("review round 1 of 3");
    expect(task).toContain("### build");
    expect(task).toContain("error TS2322");

    // The round's commits are pushed on its way home, the same belt and braces
    // a resumed round gets.
    expect(review.pushBranch).toHaveBeenCalledWith(expect.any(String), runBranchName(RUN_ID));
  });

  it("seeds the round from the ORIGIN when the previous round's record is gone", async () => {
    // `review.fixRunId` names a run the owner cleared out of the history. The
    // seed has to fall back to the origin, which is the record the loop is
    // standing in: `startRun` refuses a `resumeRunId` it cannot find with
    // `not_found`, and this function reads that as a failure of the LOOP —
    // so the pull request was handed back over a record that was merely gone.
    const stored = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    stored[0].review.round = 1;
    stored[0].review.fixRunId = "run-vanished1";
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify(stored));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("clean"); }, { timeout: 20_000 });

    const origin = lib.getRun(RUN_ID);
    // The round happened — it is round TWO, because one was already spent.
    expect(origin?.review?.round).toBe(2);
    expect(origin?.review?.fixMode).toBe("fresh");
    // Named after the ORIGIN, not after the record that is no longer there.
    expect(origin?.review?.fixDetail).toContain(RUN_ID);
    expect(origin?.review?.fixDetail).not.toContain("run-vanished1");
    const fix = lib.listRuns().find((r) => r.reviewLoopOf === RUN_ID);
    expect(fix?.reviewRound).toBe(2);
  });

  it("does the round even when the run never opened a session at all", async () => {
    // The case that was not merely un-oriented but REFUSED: `startRun` throws
    // `invalid` for a resume target with no session id, `startFixRun` read that
    // as a failure of the loop rather than of the box, and the pull request was
    // handed back with the owner's rounds untouched and nothing done.
    const stored = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    stored[0].sessionId = null;
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify(stored));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("clean"); }, { timeout: 20_000 });

    const origin = lib.getRun(RUN_ID);
    expect(origin?.review?.round).toBe(1);
    expect(origin?.review?.fixMode).toBe("fresh");
    expect(origin?.review?.fixDetail).toMatch(/never opened a session/i);
    expect(lib.listRuns().some((r) => r.reviewLoopOf === RUN_ID)).toBe(true);
  });
});

/**
 * A round longer than anything an owner may type (TASK-901).
 *
 * The owner's 4 000-character limit was applied to every start, including the
 * rounds the box writes itself — and a round quotes GitHub. PR #926's four
 * CodeRabbit threads came to 17 385 characters; the round was refused with "The
 * task is too long: at most 4000 characters." and the pull request was handed
 * back unreviewed. Here the primary task is 6 000 characters, past the typed
 * limit as well, and the findings are the size GitHub actually sends.
 */
describe("a round longer than the owner's task limit", () => {
  let lib: Lib;
  let base: string;
  let home: string;
  let root: string;
  let restore: () => void;

  const PRIMARY_TASK = "Finish the pull request for TASK-899 and name every file it touches. ".repeat(100).slice(0, 6_000);

  const INIT = '{"type":"system","subtype":"init","session_id":"sess-long-1","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
  const RESULT = JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01,
    result: "Answered every review comment.", session_id: "sess-long-1",
  });

  /** Four review comments at the length the thread parser keeps of each. */
  const THREADS = [1, 2, 3, 4].map((n) => ({
    path: `src/lib/area-${n}.ts`,
    line: n * 10,
    author: "coderabbitai",
    body: `Finding ${n}:`.padEnd(MAX_THREAD_BODY_CHARS, " The guard here does not hold on an empty list."),
    url: null,
  }));

  /** A run that COMPLETED with a 6 000-character task, its pull request open and watched. */
  function writeLongRecord(): void {
    const now = Date.now();
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([{
      id: RUN_ID,
      task: PRIMARY_TASK,
      directory: home,
      projectId: null,
      source: "agent",
      status: "completed",
      effort: "low",
      startedAt: now - 1_800_000,
      completedAt: now - 1_500_000,
      sessionId: "sess-long",
      summary: null,
      error: null,
      numTurns: 3,
      filesTouched: ["index.html"],
      commandsRun: 0,
      permissionDenials: 0,
      progress: [],
      exitCode: 0,
      pr: {
        phase: "review",
        number: PR_NUMBER,
        url: `https://github.com/o/r/pull/${PR_NUMBER}`,
        branch: runBranchName(RUN_ID),
        base: "beta",
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        detail: null,
        startedAt: now - 1_500_000,
        endedAt: null,
        reviewOk: true,
        foundBy: "opened",
      },
      review: {
        prNumber: PR_NUMBER,
        url: `https://github.com/o/r/pull/${PR_NUMBER}`,
        base: "beta",
        round: 0,
        maxRounds: 3,
        state: "polling",
        checks: [],
        unresolvedThreads: 0,
        reviewDecision: null,
        lastPolledAt: null,
        roundStartedAt: now - 60_000,
        detail: null,
        fixRunId: null,
        fixMode: null,
        fixDetail: null,
      },
    }]));
  }

  beforeEach(async () => {
    restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-review-long-"));
    home = path.join(base, "home");
    root = path.join(home, "clawbox");
    const binDir = path.join(home, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAWBOX_ROOT = root;
    fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(binDir, "claude-ds"),
      [
        "#!/usr/bin/env bash",
        readFirstTurn(path.join(base, "last-task.txt")),
        `echo '${INIT}'`, `echo '${RESULT}'`, "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({
        clawai_token: "claw_test_token",
        clawai_tier: "flash",
        coding_agent_enabled: true,
        coding_agent_generate_images: false,
        coding_agent_auto_pr: true,
        coding_agent_review_rounds: 3,
      }),
    );
    review.pushBranch.mockResolvedValue({ ok: true });
    review.readFailedCheckLogs.mockResolvedValue([
      {
        check: { name: "build", state: "fail", url: null },
        log: "error TS2322: Type 'string' is not assignable".padEnd(MAX_FEEDBACK_LOG_CHARS, "\n  at build (src/lib/area-1.ts:10:3)"),
      },
    ]);
    review.readReviewSnapshot
      .mockResolvedValueOnce(snap({
        checks: [{ name: "build", state: "fail", url: null }],
        reviewDecision: "CHANGES_REQUESTED",
        threads: THREADS,
      }))
      .mockResolvedValue(snap());
    github.mergePullRequest.mockResolvedValue({ ok: false, detail: "not in this test" });
    writeLongRecord();
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
  });

  afterEach(async () => {
    await lib._resetCodingAgentStateForTests();
    restore();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("starts the round for a 6 000-character primary task, with every finding in it", async () => {
    expect(PRIMARY_TASK.length).toBe(6_000);
    expect(PRIMARY_TASK.length).toBeGreaterThan(lib.MAX_TASK_CHARS);

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.review?.state).toBe("clean"); }, { timeout: 20_000 });

    // The round was spent on a run that actually went out — not refused and
    // settled `needs_owner` with "The task is too long".
    const origin = lib.getRun(RUN_ID);
    expect(origin?.review?.round).toBe(1);
    expect(origin?.review?.fixMode).toBe("resumed");
    expect(origin?.review?.detail ?? "").not.toMatch(/too long/i);
    const fix = lib.listRuns().find((r) => r.reviewLoopOf === RUN_ID);
    expect(fix).toBeTruthy();
    expect(origin?.review?.fixRunId).toBe(fix?.id);
    expect(fix?.status).toBe("completed");
    expect(fix?.reviewRound).toBe(1);

    // Longer than the owner may type — the very thing that used to refuse it —
    // and whole: nothing the reviewer said was clipped away to make it fit.
    expect(fix?.task.length).toBeGreaterThan(lib.MAX_TASK_CHARS);
    const task = fs.readFileSync(path.join(base, "last-task.txt"), "utf-8");
    for (const thread of THREADS) expect(task).toContain(`### ${thread.path}:${thread.line} — @coderabbitai`);
    expect(task).toContain("### build");
    expect(task).toContain("error TS2322");
    expect(task).not.toContain("…(truncated)");
    // The round points at the pull request and resumes the session that holds
    // the primary task; it never carries that task again.
    expect(task).toContain(`#${PR_NUMBER}`);
    expect(task).not.toContain(PRIMARY_TASK.slice(0, 200));
  });

  it("keeps the longest round and review pass the box can write under its own ceiling", () => {
    // Every cap buildReviewFeedback has, overrun: more failing checks and
    // threads than it quotes, each at full length, on a conflicting branch.
    const worst = buildReviewFeedback({
      prNumber: 99_999,
      url: "https://github.com/o/r/pull/99999",
      branch: runBranchName(RUN_ID),
      base: "beta",
      round: 6,
      maxRounds: 6,
      failedChecks: Array.from({ length: MAX_FEEDBACK_CHECKS + 3 }, (_, i) => ({
        check: { name: `check-${i}`, state: "fail" as const, url: `https://github.com/o/r/actions/runs/${i}` },
        log: "e".repeat(MAX_FEEDBACK_LOG_CHARS * 2),
      })),
      threads: Array.from({ length: MAX_FEEDBACK_THREADS + 5 }, (_, i) => ({
        path: `src/${"deep/".repeat(40)}file-${i}.ts`,
        line: i + 1,
        author: "coderabbitai",
        body: "b".repeat(MAX_THREAD_BODY_CHARS),
        url: `https://github.com/o/r/pull/99999#discussion_r${i}`,
      })),
      conflicting: true,
      changesRequested: true,
      fresh: true,
    });
    expect(worst.length).toBeGreaterThan(lib.MAX_TASK_CHARS);
    expect(worst.length).toBeLessThanOrEqual(lib.MAX_BOX_TASK_CHARS);

    // The review pass names its interface files, so a long file list is the
    // way it grows.
    const pass = lib.reviewPassTask({
      filesTouched: Array.from({ length: 200 }, (_, i) => `src/components/${"nested/".repeat(20)}Screen${i}.tsx`),
    });
    expect(pass.length).toBeLessThanOrEqual(lib.MAX_BOX_TASK_CHARS);
  });
});
