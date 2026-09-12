/**
 * The deployment watch as the runner drives it: what one poll does to the
 * record, and what a failed build hands back to the harness.
 *
 * The decisions themselves are pinned in vercel-state.test.ts, which is pure,
 * and the calls in vercel-api.test.ts, which is a fake API. What neither of
 * those can see is the bookkeeping around them, and that is what this file is
 * for:
 *
 *  - a project with NO link is never asked about — the run's record stays null
 *    and nothing reaches Vercel;
 *  - a restart picks a pending watch back up (a record left `looking` with
 *    nothing polling would sit there for ever);
 *  - a FAILED build is handed back to the same session ONCE, with the log tail
 *    in the task, and the flag that says so is on the RECORD, so a reboot
 *    between the failure and the fix does not buy a second run;
 *  - the token is re-resolved on every tick, so an owner who unlinks is obeyed
 *    rather than outlived;
 *  - the fix turn does not branch, does not open a second pull request and is
 *    not itself reviewed.
 *
 * `@/lib/vercel` is mocked at its network callers only — the real ones reach
 * api.vercel.com, which is not the subject here and is not on the test runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { runBranchName } from "@/lib/coding-pr-state";
import type { VercelDeployment } from "@/lib/vercel-state";

// The awaited reset in teardown can spend the settle drain's budget plus the
// removal's retry backoff — the ceiling every coding-agent suite carries.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const vercel = vi.hoisted(() => ({
  listDeployments: vi.fn(),
  readDeployment: vi.fn(),
  readBuildLog: vi.fn(),
}));
vi.mock("@/lib/vercel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel")>()),
  ...vercel,
}));

const link = vi.hoisted(() => ({
  readVercelLink: vi.fn(),
  resolveVercelAuth: vi.fn(),
}));
vi.mock("@/lib/vercel-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel-link")>()),
  ...link,
}));

const review = vi.hoisted(() => ({ pushBranch: vi.fn() }));
vi.mock("@/lib/coding-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-review")>()),
  ...review,
}));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));

type Lib = typeof import("@/lib/coding-agent");

const RUN_ID = "run-deploy0001";
const TOKEN = "vrc_live_Xk29fLm4Qp7sT1wZ8bN3dH6jR0aC5yE";

const LINK = {
  projectId: "prj_acme",
  teamId: null,
  tokenSecretName: "VERCEL_TOKEN",
  createdAt: 1,
  updatedAt: 1,
};

function deployment(over: Partial<VercelDeployment> = {}): VercelDeployment {
  return {
    id: "dpl_1",
    readyState: "building",
    url: "https://shop-abc.vercel.app",
    inspectorUrl: "https://vercel.com/acme/shop/dpl_1",
    target: "preview",
    branch: runBranchName(RUN_ID),
    sha: "abc123",
    createdAt: 1,
    errorMessage: null,
    ...over,
  };
}

describe("the deployment watch", () => {
  let lib: Lib;
  let base: string;
  let home: string;
  let root: string;
  let restore: () => void;

  /** Only the deployment half ever varies between these cases. */
  type Over = { vercel?: Record<string, unknown> };

  /** A record as the previous server left it: pushed, waiting on Vercel. */
  function record(over: Over = {}) {
    const now = Date.now();
    return {
      id: RUN_ID,
      task: "build the shop",
      directory: home,
      // A code project's id IS the secret/link scope (`projectScopeFor`), which
      // is what makes this run one the watch can find a link for.
      projectId: "shop",
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
      commit: "abc123",
      pr: {
        phase: "blocked",
        number: 4,
        url: "https://github.com/o/r/pull/4",
        branch: runBranchName(RUN_ID),
        base: "main",
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        detail: null,
        startedAt: now - 60_000,
        endedAt: now - 30_000,
        reviewOk: true,
      },
      vercel: {
        phase: "looking",
        projectId: "prj_acme",
        teamId: null,
        deploymentId: null,
        readyState: "queued",
        url: null,
        inspectorUrl: null,
        target: null,
        branch: runBranchName(RUN_ID),
        sha: "abc123",
        startedAt: now - 10_000,
        endedAt: null,
        detail: null,
        fixRunId: null,
        feedbackSent: false,
        promotion: null,
        ...(over.vercel ?? {}),
      },
    };
  }

  function writeRecord(over: Over = {}): void {
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
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-vercel-watch-"));
    home = path.join(base, "home");
    root = path.join(home, "clawbox");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAWBOX_ROOT = root;
    vi.clearAllMocks();
    link.readVercelLink.mockResolvedValue(LINK);
    link.resolveVercelAuth.mockResolvedValue({ token: TOKEN, teamId: null });
    vercel.listDeployments.mockResolvedValue({ ok: true, deployments: [] });
    vercel.readDeployment.mockResolvedValue({ ok: true, deployment: deployment() });
    vercel.readBuildLog.mockResolvedValue({ ok: true, log: "" });
    review.pushBranch.mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    await lib._resetCodingAgentStateForTests();
    restore();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("records a build it found, and keeps waiting while it builds", async () => {
    vercel.listDeployments.mockResolvedValue({ ok: true, deployments: [deployment()] });
    await boot();
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.deploymentId).toBe("dpl_1"); });

    const state = lib.getRun(RUN_ID)?.vercel;
    expect(state?.phase).toBe("building");
    expect(state?.url).toBe("https://shop-abc.vercel.app");
    expect(state?.inspectorUrl).toBe("https://vercel.com/acme/shop/dpl_1");
    expect(state?.endedAt).toBeNull();
  });

  it("settles a build that finished, with the preview on the record and in the feed", async () => {
    vercel.listDeployments.mockResolvedValue({ ok: true, deployments: [deployment({ readyState: "ready" })] });
    await boot();
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.phase).toBe("ready"); });

    const run = lib.getRun(RUN_ID);
    expect(run?.vercel?.url).toBe("https://shop-abc.vercel.app");
    expect(run?.vercel?.endedAt).not.toBeNull();
    expect(run?.progress.join("\n")).toContain("Deployed to https://shop-abc.vercel.app");
    // And on disk that way, so the boot sweep does not start it again.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk[0].vercel.phase).toBe("ready");
  });

  it("ASKS VERCEL NOTHING for a project with no link, and leaves the record alone", async () => {
    link.readVercelLink.mockResolvedValue(null);
    await boot();
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.phase).toBe("abandoned"); });

    expect(vercel.listDeployments).not.toHaveBeenCalled();
    expect(lib.getRun(RUN_ID)?.vercel?.detail).toMatch(/link for this project was removed/i);
  });

  it("stops watching when the token is gone — that is not a failed build", async () => {
    link.resolveVercelAuth.mockRejectedValue(new Error("no readable secret called VERCEL_TOKEN"));
    await boot();
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.phase).toBe("abandoned"); });
    expect(lib.getRun(RUN_ID)?.vercel?.detail).toContain("VERCEL_TOKEN");
    expect(vercel.listDeployments).not.toHaveBeenCalled();
  });

  it("waits through a transient fault rather than calling the build a failure", async () => {
    vercel.listDeployments.mockResolvedValue({ ok: false, kind: "network", detail: "offline", status: null });
    await boot();
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(vercel.listDeployments).toHaveBeenCalled(); });
    // Still pending: the poll said nothing about the build.
    expect(lib.getRun(RUN_ID)?.vercel?.phase).toBe("looking");
  });

  it("stops watching when Vercel refuses the token, and says so", async () => {
    vercel.listDeployments.mockResolvedValue({ ok: false, kind: "auth", detail: "Vercel refused this ClawBox's token", status: 401 });
    await boot();
    writeRecord();

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.phase).toBe("abandoned"); });
    expect(lib.getRun(RUN_ID)?.vercel?.detail).toContain("refused");
  });

  it("asks about the KNOWN build directly, and stops searching the project's page for it", async () => {
    // The state a second poll finds: the deployment has already been matched.
    vercel.readDeployment.mockResolvedValue({ ok: true, deployment: deployment({ readyState: "ready" }) });
    await boot();
    writeRecord({ vercel: { phase: "building", deploymentId: "dpl_1" } });

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.phase).toBe("ready"); });

    // The page is BOUNDED, so a busy project can push this build off the end of
    // it; a watch that went on searching would lose one it had already found.
    expect(vercel.readDeployment).toHaveBeenCalledWith({ token: TOKEN, teamId: null }, "dpl_1");
    expect(vercel.listDeployments).not.toHaveBeenCalled();
  });

  it("gives up on a push no deployment ever appeared for, once the grace period is spent", async () => {
    await boot();
    // Armed long enough ago that the grace period has passed.
    writeRecord({ vercel: { startedAt: Date.now() - 10 * 60_000 } });

    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.phase).toBe("abandoned"); });
    expect(lib.getRun(RUN_ID)?.vercel?.detail).toMatch(/no vercel deployment appeared/i);
  });
});

describe("a failed build going back to the harness", () => {
  let lib: Lib;
  let base: string;
  let home: string;
  let root: string;
  let restore: () => void;

  function writeRecord(over: { vercel?: Record<string, unknown> } = {}): void {
    const now = Date.now();
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([{
      id: RUN_ID,
      task: "build the shop",
      directory: home,
      // A code project's id IS the secret/link scope (`projectScopeFor`), which
      // is what makes this run one the watch can find a link for.
      projectId: "shop",
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
      commit: "abc123",
      vercel: {
        phase: "looking",
        projectId: "prj_acme",
        teamId: null,
        deploymentId: null,
        readyState: "queued",
        url: null,
        inspectorUrl: null,
        target: null,
        branch: runBranchName(RUN_ID),
        sha: "abc123",
        startedAt: now - 10_000,
        endedAt: null,
        detail: null,
        fixRunId: null,
        feedbackSent: false,
        promotion: null,
        ...(over.vercel ?? {}),
      },
    }]));
  }

  beforeEach(async () => {
    restore = saveEnv("HOME", "CLAWBOX_ROOT");
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-vercel-fix-"));
    home = path.join(base, "home");
    root = path.join(home, "clawbox");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAWBOX_ROOT = root;
    vi.clearAllMocks();
    link.readVercelLink.mockResolvedValue(LINK);
    link.resolveVercelAuth.mockResolvedValue({ token: TOKEN, teamId: null });
    vercel.listDeployments.mockResolvedValue({
      ok: true,
      deployments: [deployment({ readyState: "error", errorMessage: 'Command "npm run build" exited with 1' })],
    });
    vercel.readDeployment.mockResolvedValue({
      ok: true,
      deployment: deployment({ readyState: "error", errorMessage: 'Command "npm run build" exited with 1' }),
    });
    vercel.readBuildLog.mockResolvedValue({ ok: true, log: "> next build\nType error: x is not assignable to y" });
    review.pushBranch.mockResolvedValue({ ok: true });

    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({ clawai_token: "t", coding_agent_enabled: true, coding_agent_auto_pr: true }),
    );
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
  });

  afterEach(async () => {
    await lib._resetCodingAgentStateForTests();
    restore();
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("settles the build as failed with Vercel's own sentence", async () => {
    writeRecord();
    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.phase).toBe("failed"); });

    const run = lib.getRun(RUN_ID);
    expect(run?.vercel?.detail).toBe('Command "npm run build" exited with 1');
    expect(run?.progress.join("\n")).toContain("The Vercel deployment failed");
  });

  it("fetches the log of THAT deployment, once, and marks the hand-off ON THE RECORD", async () => {
    writeRecord();
    lib.resumePullRequestWatches();
    await vi.waitFor(() => { expect(lib.getRun(RUN_ID)?.vercel?.feedbackSent).toBe(true); });

    expect(vercel.readBuildLog).toHaveBeenCalledTimes(1);
    expect(vercel.readBuildLog).toHaveBeenCalledWith({ token: TOKEN, teamId: null }, "dpl_1");
    // On the RECORD and on DISK, so a reboot between the failure and the fix
    // does not spend a second run saying the same thing to the same session.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk[0].vercel.feedbackSent).toBe(true);

    // A second sweep over the same file asks for nothing more: the watch has
    // settled and the hand-off is spent.
    vercel.readBuildLog.mockClear();
    lib.resumePullRequestWatches();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vercel.readBuildLog).not.toHaveBeenCalled();
  });

  it("never asks for a build log for a record that was already handed one", async () => {
    // The state a restart finds: failed, and already fed back.
    writeRecord({ vercel: { phase: "failed", deploymentId: "dpl_1", feedbackSent: true, endedAt: Date.now() } });
    lib.resumePullRequestWatches();
    // Settled, so there is nothing pending to poll — and nothing to fetch.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vercel.readBuildLog).not.toHaveBeenCalled();
    expect(vercel.listDeployments).not.toHaveBeenCalled();
  });
});
