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

const readPullRequest = vi.hoisted(() => vi.fn());
const mergePullRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  readPullRequest,
  mergePullRequest,
}));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));

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
