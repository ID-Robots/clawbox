/**
 * The pull-request watcher when GitHub cannot be read.
 *
 * readPullRequest answering `{ error }` was "a transient read that says
 * nothing", and the watcher polled again — forever: the thirty-minute ceiling
 * lived in decideMerge, which a read that failed never reached. A `gh` that
 * kept failing (a sign-in that expired, a box offline for the evening) left
 * the pull request "waiting" for good — pending in the run history, and
 * polled again after every restart by the boot sweep. The ceiling now holds
 * on the error path too; a read error before it is still waited through.
 *
 * coding-pr is mocked at readPullRequest/mergePullRequest only: the real ones
 * spawn `gh`, which is not the subject here and is not on the test runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { isPrPending, MAX_WAIT_MS, POLL_INTERVAL_MS } from "@/lib/coding-pr-state";

// The same ceiling the other four coding-agent suites carry, for symmetry
// rather than for a cost this file pays today: it starts no run, so its
// awaited reset kills nothing and the drain returns on its first iteration.
// The declaration is here so a run added to this file later cannot quietly
// put an awaited drain (SETTLE_DRAIN_BUDGET_MS, 5 s) plus the removal's retry
// backoff inside vitest's 10 s DEFAULT hook budget — and it imports no
// child_process, so test-timeout-hygiene.test.ts would not say so.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const readPullRequest = vi.hoisted(() => vi.fn());
const mergePullRequest = vi.hoisted(() => vi.fn());
// Defaults, restored by mockReset: auto-merge unread unless a test says so.
const readAutoMergeFacts = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ error: "not read in this test" })));
const enableAutoMerge = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const disableAutoMerge = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  readPullRequest,
  mergePullRequest,
  readAutoMergeFacts,
  enableAutoMerge,
  disableAutoMerge,
}));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
// What follows a merge: the project folder is brought up to the merged base.
// The real one runs git against a remote; here only what the watcher DOES with
// its answer is the subject. Default, restored by mockReset: already there.
const bringBaseHome = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ ok: true, moved: false, commit: null, checkedOut: true })));
vi.mock("@/lib/coding-run-worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-run-worktree")>()),
  bringBaseHome,
}));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let restore: () => void;

const RUN_ID = "run-prwatch001";
const PR_NUMBER = 7;

/** A record as the previous server wrote it: a pull request open, checks pending. */
function waitingRecord(startedAt: number) {
  return {
    id: RUN_ID,
    task: "was waiting on a pull request",
    directory: home,
    projectId: null,
    source: "owner",
    status: "completed",
    startedAt: startedAt - 60_000,
    completedAt: startedAt,
    sessionId: "sess-old",
    model: null,
    summary: null,
    error: null,
    numTurns: 2,
    filesTouched: ["index.html"],
    commandsRun: 0,
    permissionDenials: 0,
    progress: [],
    exitCode: 0,
    pr: {
      phase: "waiting", number: PR_NUMBER, url: `https://github.com/o/r/pull/${PR_NUMBER}`, branch: `clawbox/${RUN_ID}`, base: "main",
      checks: { total: 1, passed: 0, failed: 0, pending: 1 }, detail: null, startedAt, endedAt: null, reviewOk: true,
    },
  };
}

function writeRecord(startedAt: number): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([waitingRecord(startedAt)]));
}

beforeEach(async () => {
  vi.useFakeTimers();
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-prwatch-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "t", coding_agent_enabled: true }));
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  readPullRequest.mockReset();
  mergePullRequest.mockReset();
  bringBaseHome.mockReset();
  bringBaseHome.mockResolvedValue({ ok: true, moved: false, commit: null, checkedOut: true });
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  // Real timers first: the reset now waits for the settle path, and a frozen
  // clock would never let it finish.
  vi.useRealTimers();
  await lib._resetCodingAgentStateForTests();
  restore();
  // maxRetries, as the backstop for what the drain cannot promise: it is
  // bounded, and a run this teardown had to KILL settles from its child's
  // own handler. Node retries exactly this family (EBUSY/ENOTEMPTY/EPERM)
  // and by default does not retry at all.
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a pull request GitHub will not answer about", () => {
  it("is given up on at the ceiling instead of being polled forever", async () => {
    readPullRequest.mockResolvedValue({ error: "gh: To get started with GitHub CLI, please run: gh auth login" });
    // Opened just over the ceiling ago: the very next poll is past it.
    writeRecord(Date.now() - MAX_WAIT_MS - 1_000);

    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(readPullRequest).toHaveBeenCalledTimes(1);
    expect(readPullRequest).toHaveBeenCalledWith(home, PR_NUMBER);
    expect(mergePullRequest).not.toHaveBeenCalled();

    const run = lib.getRun(RUN_ID);
    expect(run?.pr?.phase).toBe("blocked");
    expect(run?.pr?.detail).toMatch(/could not be read/);
    // The owner hears what gh said, not only that it failed.
    expect(run?.pr?.detail).toContain("gh auth login");
    expect(run?.pr?.endedAt).not.toBeNull();
    expect(isPrPending(run?.pr)).toBe(false);
    expect(run?.progress.join("\n")).toMatch(/Not merged/);

    // On disk that way too, so the boot sweep does not start the loop again.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk[0].pr.phase).toBe("blocked");

    // And the watcher is gone: another interval reads nothing.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(readPullRequest).toHaveBeenCalledTimes(1);
  });

  it("waits through a read error before the ceiling, and goes on when GitHub answers", async () => {
    readPullRequest.mockResolvedValue({ error: "connect: network is unreachable" });
    writeRecord(Date.now() - 60_000);

    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(readPullRequest).toHaveBeenCalledTimes(1);
    expect(lib.getRun(RUN_ID)?.pr?.phase).toBe("waiting");

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(readPullRequest).toHaveBeenCalledTimes(2);
    expect(lib.getRun(RUN_ID)?.pr?.phase).toBe("waiting");
    expect(isPrPending(lib.getRun(RUN_ID)?.pr)).toBe(true);

    // The network is back: the same watcher reads the checks and merges.
    readPullRequest.mockResolvedValue({
      state: "OPEN",
      mergeable: "MERGEABLE",
      checks: { total: 1, passed: 1, failed: 0, pending: 0 },
      noChecks: false,
    });
    mergePullRequest.mockResolvedValue({ ok: true });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(readPullRequest).toHaveBeenCalledTimes(3);
    expect(mergePullRequest).toHaveBeenCalledWith(home, PR_NUMBER);
    const run = lib.getRun(RUN_ID);
    expect(run?.pr?.phase).toBe("merged");
    expect(run?.pr?.checks).toEqual({ total: 1, passed: 1, failed: 0, pending: 0 });
    expect(isPrPending(run?.pr)).toBe(false);
  });
});

describe("a pull request the box merged", () => {
  const green = { state: "OPEN", mergeable: "MERGEABLE", checks: { total: 1, passed: 1, failed: 0, pending: 0 }, noChecks: false };
  /** One poll that finds the checks green and merges, then the settle path's own work. */
  const mergeNow = async () => {
    readPullRequest.mockResolvedValue(green);
    mergePullRequest.mockResolvedValue({ ok: true });
    writeRecord(Date.now() - 5 * 60_000);
    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(lib.getRun(RUN_ID)?.pr?.phase).toBe("merged");
  };

  it("is brought into the project folder, and the feed says where the folder is now", async () => {
    // run-deyse3g9 (2026-11-10): "Merged into the base branch" on GitHub, and
    // the project folder — with the app served from it — still on the base
    // from before the run; the next run would have forked from that.
    bringBaseHome.mockResolvedValue({ ok: true, moved: true, commit: "a1c935b0c4f4d7f0f4a8f4d0e7d9b1c2d3e4f5a6", checkedOut: true });
    await mergeNow();
    expect(bringBaseHome).toHaveBeenCalledTimes(1);
    expect(bringBaseHome).toHaveBeenCalledWith({ projectDir: home, base: "main" });
    const feed = lib.getRun(RUN_ID)?.progress.join("\n") ?? "";
    expect(feed).toMatch(/Merged into the base branch/);
    expect(feed).toMatch(/The project folder is on the merged main now \(a1c935b\)/);
  });

  it("says why the folder was left, with what to do, when it could not follow", async () => {
    bringBaseHome.mockResolvedValue({ ok: false, reason: "dirty", detail: "uncommitted changes there are in files the merge also changes" });
    await mergeNow();
    const run = lib.getRun(RUN_ID);
    // Still a merge: where the folder is does not change what GitHub did.
    expect(run?.pr?.phase).toBe("merged");
    // Whole, inside the feed's 160-character line: what to do is said before why.
    expect(run?.progress).toContain("The merged main is not in the project folder yet — run git pull there: uncommitted changes there are in files the merge also changes");
  });

  it("says nothing more when the folder already has the merge", async () => {
    await mergeNow();
    expect(bringBaseHome).toHaveBeenCalledTimes(1);
    expect(lib.getRun(RUN_ID)?.progress.join("\n")).not.toMatch(/project folder/);
  });

  it("moves only the base when the folder is on another branch, and says the folder was left", async () => {
    bringBaseHome.mockResolvedValue({ ok: true, moved: true, commit: "a1c935b0", checkedOut: false });
    await mergeNow();
    expect(lib.getRun(RUN_ID)?.progress.join("\n")).toMatch(/main in the project folder is on the merged work now; the folder is on another branch and was left as it is/);
  });

  it("is not brought home when it was NOT merged", async () => {
    readPullRequest.mockResolvedValue({ error: "gh: To get started with GitHub CLI, please run: gh auth login" });
    writeRecord(Date.now() - MAX_WAIT_MS - 1_000);
    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(lib.getRun(RUN_ID)?.pr?.phase).toBe("blocked");
    expect(bringBaseHome).not.toHaveBeenCalled();
  });
});

describe("GitHub's auto-merge under the checks-only watcher", () => {
  const pending = { state: "OPEN", mergeable: "MERGEABLE", checks: { total: 2, passed: 1, failed: 0, pending: 1 }, noChecks: false };
  const facts = (over: Record<string, unknown> = {}) => ({
    state: "OPEN", draft: false, base: "beta", labels: [] as string[], mergeState: "BLOCKED", enabled: false, ...over,
  });

  it("hands the merge to GitHub while a required check runs, and looks again no more than once a minute", async () => {
    readPullRequest.mockResolvedValue(pending);
    readAutoMergeFacts.mockResolvedValue(facts());
    // Past the grace a fresh pull request's checks get.
    writeRecord(Date.now() - 5 * 60_000);

    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(enableAutoMerge).toHaveBeenCalledWith(home, PR_NUMBER);
    const run = lib.getRun(RUN_ID);
    expect(run?.pr?.autoMergeAt).toEqual(expect.any(Number));
    expect(run?.pr?.phase).toBe("waiting");
    expect(run?.progress.join("\n")).toContain(`Turned on GitHub's auto-merge for pull request #${PR_NUMBER}`);

    // The watcher polls every few seconds; auto-merge is looked at once a minute.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(readPullRequest).toHaveBeenCalledTimes(2);
    expect(readAutoMergeFacts).toHaveBeenCalledTimes(1);
  });

  it("leaves it on when it gives up at its ceiling, and says the pull request still merges by itself", async () => {
    readPullRequest.mockResolvedValue(pending);
    readAutoMergeFacts.mockResolvedValue(facts({ enabled: true }));
    writeRecord(Date.now() - MAX_WAIT_MS - 1_000);

    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    const run = lib.getRun(RUN_ID);
    expect(run?.pr?.phase).toBe("blocked");
    expect(run?.pr?.detail).toContain("Gave up waiting for GitHub Actions");
    expect(run?.pr?.detail).toContain("GitHub's auto-merge is on for it, so it merges by itself");
    expect(disableAutoMerge).not.toHaveBeenCalled();
  });

  it("never merges a pull request labelled hold, and turns auto-merge off over the label", async () => {
    readPullRequest.mockResolvedValue({ ...pending, checks: { total: 2, passed: 2, failed: 0, pending: 0 }, labels: ["hold"] });
    readAutoMergeFacts.mockResolvedValue(facts({ labels: ["hold"], enabled: true }));
    writeRecord(Date.now() - 5 * 60_000);

    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(disableAutoMerge).toHaveBeenCalledWith(home, PR_NUMBER);
    const run = lib.getRun(RUN_ID);
    expect(run?.pr?.phase).toBe("blocked");
    expect(run?.pr?.detail).toContain("hold label");
  });

  it("never turns it on for a pull request into main", async () => {
    readPullRequest.mockResolvedValue(pending);
    readAutoMergeFacts.mockResolvedValue(facts({ base: "main" }));
    writeRecord(Date.now() - 5 * 60_000);

    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(readAutoMergeFacts).toHaveBeenCalledTimes(1);
    expect(enableAutoMerge).not.toHaveBeenCalled();
  });
});
