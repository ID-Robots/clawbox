/**
 * A run's pull request that goes RED (owner's brief, 2026-10-11): the
 * watcher reads the failed jobs' logs (bounded), names the failing tests and
 * files on the record, and the run offers a "Fix CI" continuation
 * (`resumeRunId` + `fixCi`) — the box appending what failed to the task, at
 * most MAX_CI_FIX_ATTEMPTS times along the chain, never twice from one failure.
 *
 * `gh` is mocked where the runner calls it (coding-pr, coding-review), as the
 * PR watcher's own suite does; the Fix CI start runs a fake claude-ds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { decodeHarnessTurns } from "@/tests/helpers/fake-harness";
import { POLL_INTERVAL_MS } from "@/lib/coding-pr-state";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const readPullRequest = vi.hoisted(() => vi.fn());
const mergePullRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  readPullRequest,
  mergePullRequest,
  readAutoMergeFacts: vi.fn(async () => ({ error: "not read in this test" })),
  enableAutoMerge: vi.fn(async () => ({ ok: true })),
  disableAutoMerge: vi.fn(async () => ({ ok: true })),
}));
const readReviewSnapshot = vi.hoisted(() => vi.fn());
const readFailedCheckLogs = vi.hoisted(() => vi.fn());
const findOpenPullRequestForBranch = vi.hoisted(() => vi.fn());
const pushBranch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-review")>()),
  readReviewSnapshot,
  readFailedCheckLogs,
  findOpenPullRequestForBranch,
  pushBranch,
}));
// A run's own copy of the project, faked where a resume and a settle reach
// git: put back from its branch, and "cannot tell" how far ahead it is, which
// keeps the copy as it is.
vi.mock("@/lib/coding-run-worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-run-worktree")>()),
  restoreRunWorktree: vi.fn(async () => true),
  commitsAhead: vi.fn(async () => null),
}));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));

type Lib = typeof import("@/lib/coding-agent");
let lib: Lib;
let base: string;
let home: string;
let root: string;
let restore: () => void;

const RUN_ID = "run-cifail001";
const PR_NUMBER = 7;
const FAILING = { name: "test (20.x)", state: "fail", url: "https://github.com/o/r/actions/runs/123/job/456" };
const LOG = [
  "test (20.x)\tRun tests\t2026-10-11T10:00:00.1Z  FAIL  src/tests/unit/cart.test.ts > cart > adds the tax",
  "test (20.x)\tRun tests\t2026-10-11T10:00:00.2Z AssertionError: expected 10 to be 11",
  "test (20.x)\tRun tests\t2026-10-11T10:00:00.3Z  ❯ src/lib/cart.ts:12:3",
].join("\n");

const runsFile = () => path.join(root, "data", "coding-agent-runs.json");

function record(over: Record<string, unknown> = {}) {
  const at = Date.now();
  return {
    id: RUN_ID, task: "Add the tax line", directory: home, projectId: null, source: "owner", status: "completed",
    startedAt: at - 60_000, completedAt: at, sessionId: "sess-old", model: null, summary: null, error: null,
    numTurns: 2, filesTouched: ["src/lib/cart.ts"], commandsRun: 0, permissionDenials: 0, progress: [], exitCode: 0,
    ...over,
  };
}

async function reload(): Promise<void> {
  await lib._resetCodingAgentStateForTests();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-ci-fix-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "t", coding_agent_enabled: true }));
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  readPullRequest.mockReset();
  mergePullRequest.mockReset();
  readReviewSnapshot.mockReset();
  readFailedCheckLogs.mockReset();
  findOpenPullRequestForBranch.mockReset();
  pushBranch.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  vi.useRealTimers();
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a pull request that goes red under the checks watcher", () => {
  it("reads the failed jobs' logs, names the failing tests and files on the record, and says so on the feed", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    fs.writeFileSync(runsFile(), JSON.stringify([record({
      pr: {
        phase: "waiting", number: PR_NUMBER, url: `https://github.com/o/r/pull/${PR_NUMBER}`, branch: `clawbox/${RUN_ID}`, base: "main",
        checks: { total: 1, passed: 0, failed: 0, pending: 1 }, detail: null, startedAt, endedAt: null, reviewOk: true,
      },
    })]));
    await reload();
    readPullRequest.mockResolvedValue({ state: "OPEN", mergeable: "MERGEABLE", checks: { total: 2, passed: 1, failed: 1, pending: 0 }, noChecks: false, isDraft: false, labels: [] });
    readReviewSnapshot.mockResolvedValue({ checks: [FAILING, { name: "lint", state: "pass", url: null }] });
    readFailedCheckLogs.mockResolvedValue([{ check: FAILING, log: LOG }]);

    lib.resumePullRequestWatches();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    // Only the failing check's log is fetched.
    expect(readFailedCheckLogs).toHaveBeenCalledWith(home, [FAILING]);
    const run = lib.getRun(RUN_ID)!;
    expect(run.pr?.phase).toBe("blocked");
    expect(run.ci).toMatchObject({
      prNumber: PR_NUMBER,
      checks: ["test (20.x)"],
      tests: ["src/tests/unit/cart.test.ts > cart > adds the tax"],
      files: ["src/tests/unit/cart.test.ts", "src/lib/cart.ts"],
      attempt: 0,
      fixRunId: null,
    });
    expect(run.ci?.excerpt).toContain("AssertionError: expected 10 to be 11");
    expect(run.progress).toContain("CI failed on pull request #7: test (20.x); failing tests: src/tests/unit/cart.test.ts > cart > adds the tax");
    // On disk, for the page and the status tool after a restart.
    expect(JSON.parse(fs.readFileSync(runsFile(), "utf-8"))[0].ci.prNumber).toBe(PR_NUMBER);
  });
});

describe("ciFixAttempt", () => {
  const ci = { prNumber: 7, at: 1, checks: [], tests: [], files: [], excerpt: "", unread: [], attempt: 0, fixRunId: null };

  it("counts along the chain and stops at MAX_CI_FIX_ATTEMPTS", () => {
    expect(lib.ciFixAttempt({ ci, ciFixOf: null }, null)).toBe(1);
    expect(lib.ciFixAttempt({ ci: { ...ci, attempt: 1 }, ciFixOf: { runId: "run-aaaaaaaa", attempt: 1 } }, null)).toBe(2);
    expect(() => lib.ciFixAttempt({ ci: { ...ci, attempt: 2 }, ciFixOf: { runId: "run-aaaaaaaa", attempt: 2 } }, null)).toThrow(/had its 2 Fix CI runs/);
  });

  it("refuses a run with no failed CI, and a second Fix CI from one failure — but not the queued one itself", () => {
    expect(() => lib.ciFixAttempt({ ci: null, ciFixOf: null }, null)).toThrow(/no failed CI on record/);
    expect(() => lib.ciFixAttempt({ ci: { ...ci, fixRunId: "run-bbbbbbbb" }, ciFixOf: null }, null)).toThrow(/already started from that failure \(run-bbbbbbbb\)/);
    expect(lib.ciFixAttempt({ ci: { ...ci, fixRunId: "run-bbbbbbbb" }, ciFixOf: null }, "run-bbbbbbbb")).toBe(1);
  });
});

describe("a Fix CI continuation", () => {
  const turnFile = () => path.join(base, "turn.txt");

  beforeEach(async () => {
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "claude-ds"), [
      "#!/usr/bin/env bash",
      `head -n 1 > "${turnFile()}"`,
      `echo '{"type":"system","subtype":"init","session_id":"sess-fix","model":"m"}'`,
      `echo '${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Fixed.", session_id: "sess-fix" })}'`,
      "exit 0",
    ].join("\n"), { mode: 0o755 });
    const ci = { prNumber: 7, at: 1, checks: ["test (20.x)"], tests: ["src/tests/unit/cart.test.ts > cart > adds the tax"], files: ["src/lib/cart.ts"], excerpt: "AssertionError: expected 10 to be 11", unread: [], attempt: 0, fixRunId: null };
    fs.writeFileSync(runsFile(), JSON.stringify([record({ ci })]));
    await reload();
  });

  it("is told what failed after the caller's words, records its place in the chain, and claims the failure", async () => {
    const run = await lib.startRun({ task: "Fix the failing CI checks.", resumeRunId: RUN_ID, source: "owner", fixCi: true });
    const done = await lib.waitForRun(run.id, 20_000);
    expect(done?.status).toBe("completed");
    const [turn] = decodeHarnessTurns(fs.readFileSync(turnFile(), "utf-8"));
    expect(turn.startsWith("Fix the failing CI checks.\n\nCI failed on pull request #7: test (20.x)")).toBe(true);
    expect(turn).toContain("- src/tests/unit/cart.test.ts > cart > adds the tax");
    expect(turn).toContain("AssertionError: expected 10 to be 11");
    expect(turn).toMatch(/commit and push the branch so pull request #7 updates/);
    expect(done?.ciFixOf).toEqual({ runId: RUN_ID, attempt: 1 });
    expect(done?.progress).toContain(`Fixing the failed CI of ${RUN_ID} (attempt 1 of 2)`);
    expect(lib.getRun(RUN_ID)?.ci?.fixRunId).toBe(run.id);
    // Once per failure.
    await expect(lib.startRun({ task: "Again.", resumeRunId: RUN_ID, source: "owner", fixCi: true })).rejects.toThrow(/already started from that failure/);
  });

  it("needs the run it continues", async () => {
    await expect(lib.startRun({ task: "Fix it.", directory: home, source: "owner", fixCi: true })).rejects.toThrow(/name it in resumeRunId/);
  });
});

describe("a Fix CI run's fix reaches the pull request it fixes", () => {
  const wt = () => path.join(base, "wt");

  beforeEach(async () => {
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(wt(), { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "claude-ds"), [
      "#!/usr/bin/env bash",
      "head -n 1 > /dev/null",
      `echo '{"type":"system","subtype":"init","session_id":"sess-fix","model":"m"}'`,
      // It changes a file, as a fix does — what the review pass is started for.
      `echo "fixed" > "$PWD/cart.js"`,
      `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"%s/cart.js"}}]}}\\n' "$PWD"`,
      `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", is_error: false }] } })}'`,
      `echo '${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Fixed.", session_id: "sess-fix" })}'`,
      "exit 0",
    ].join("\n"), { mode: 0o755 });
    // The run whose pull request went red, in its own copy of the project.
    const ci = { prNumber: 7, at: 1, checks: ["test"], tests: [], files: [], excerpt: "", unread: [], attempt: 0, fixRunId: null };
    const worktree = { path: wt(), branch: `clawbox/${RUN_ID}`, base: "main", project: home, removed: false, branchRemoved: false, result: null };
    fs.writeFileSync(runsFile(), JSON.stringify([record({ directory: wt(), worktree, ci })]));
    findOpenPullRequestForBranch.mockResolvedValue({ number: 7, url: "https://github.com/o/r/pull/7", base: "main" });
    pushBranch.mockResolvedValue({ ok: true });
    readReviewSnapshot.mockResolvedValue({ error: "not read in this test" });
  });

  it("pushes on the adopt path — the one a box with the auto-PR switch off takes", async () => {
    fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "t", coding_agent_enabled: true, coding_agent_auto_pr: false }));
    await reload();
    const fix = await lib.startRun({ task: "Fix the CI.", resumeRunId: RUN_ID, source: "owner", fixCi: true });
    await lib.waitForRun(fix.id, 20_000);
    await vi.waitFor(() => { expect(pushBranch).toHaveBeenCalledWith(wt(), `clawbox/${RUN_ID}`); }, { timeout: 15_000 });
    expect(pushBranch).toHaveBeenCalledTimes(1);
  });

  it("pushes when the run settling last is the Fix CI run's review pass", async () => {
    fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "t", coding_agent_enabled: true, coding_agent_auto_pr: false, coding_agent_review_pass: true }));
    await reload();
    const fix = await lib.startRun({ task: "Fix the CI.", resumeRunId: RUN_ID, source: "owner", fixCi: true });
    await lib.waitForRun(fix.id, 20_000);
    // The review pass is a run of its own; its settle is the one that adopts.
    await vi.waitFor(() => { expect(lib.listRuns().some((r) => r.reviewOf === fix.id)).toBe(true); }, { timeout: 15_000 });
    await vi.waitFor(() => { expect(pushBranch).toHaveBeenCalledWith(wt(), `clawbox/${RUN_ID}`); }, { timeout: 20_000 });
  });

  it("does not push for a continuation that is not a Fix CI", async () => {
    fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "t", coding_agent_enabled: true, coding_agent_auto_pr: false }));
    await reload();
    const plain = await lib.startRun({ task: "Carry on.", resumeRunId: RUN_ID, source: "owner" });
    await lib.waitForRun(plain.id, 20_000);
    await vi.waitFor(() => { expect(findOpenPullRequestForBranch).toHaveBeenCalled(); }, { timeout: 15_000 });
    expect(pushBranch).not.toHaveBeenCalled();
  });
});

describe("a Fix CI start that cannot spawn", () => {
  it("gives the failure it claimed back", async () => {
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "claude-ds"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const ci = { prNumber: 7, at: 1, checks: ["test"], tests: [], files: [], excerpt: "", unread: [], attempt: 0, fixRunId: null };
    fs.writeFileSync(runsFile(), JSON.stringify([record({ ci })]));
    // Where the run's stream log goes is a FILE: the spawn throws before any process exists.
    fs.writeFileSync(path.join(root, "data", "coding-agent-streams"), "not a folder");
    await reload();
    await expect(lib.startRun({ task: "Fix the CI.", resumeRunId: RUN_ID, source: "owner", fixCi: true })).rejects.toMatchObject({ kind: "not_ready" });
    expect(lib.getRun(RUN_ID)?.ci?.fixRunId).toBeNull();
    expect(lib.ciFixAttempt(lib.getRun(RUN_ID)!, null)).toBe(1);
  });
});
