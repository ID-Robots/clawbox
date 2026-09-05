/**
 * What happens when the spawn itself throws.
 *
 * startRun persists the run as "running" BEFORE it spawns, so the status route
 * can answer immediately. If the spawn then throws synchronously — a working
 * folder that vanished between the check and the call, a setpriv that is not
 * executable — nothing else would ever settle that record: `live` has no entry
 * for it, so the boot sweep is the only thing that would, and until the next
 * restart the one-run-at-a-time rule answers every later run with "busy". The
 * feature would be wedged by a transient failure.
 *
 * child_process is mocked here and nowhere else in the coding-agent tests: the
 * others run the real shipped wrapper, which is the point of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { execFileSync } from "child_process";
import { saveEnv } from "@/tests/helpers/env";
import { isPrPending, runBranchName } from "@/lib/coding-pr-state";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const spawnMock = vi.hoisted(() => vi.fn());
// Only spawn is the subject here. The rest of child_process stays real,
// because modules further down the import graph (openclaw-config's execFile)
// need it at load time, and a mock that drops them fails before the test runs.
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: spawnMock,
}));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
// Every run draws its project an icon through an upstream ClawBox AI call.
// Nothing here asserts it, and left real it is one more thing racing the real
// `git` below for a loaded runner's attention.
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let restore: () => void;

function readyDevice(): void {
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({ clawai_token: "t", coding_agent_enabled: true }),
  );
  const project = path.join(root, "data", "code-projects", "site");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ projectId: "site", name: "site" }));
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-spawn-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  readyDevice();
  spawnMock.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  // Awaited: a settled run's commit and pull request are started from the
  // settle path and outlive the test that made them, so the removal below
  // raced the `git` still running inside this tree.
  await lib._resetCodingAgentStateForTests();
  restore();
  // maxRetries, as the backstop for what the drain cannot promise: it is
  // bounded, and a run this teardown had to KILL settles from its child's
  // own handler. Node retries exactly this family (EBUSY/ENOTEMPTY/EPERM)
  // and by default does not retry at all.
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a spawn that throws synchronously", () => {
  it("settles the run as failed instead of leaving it running forever", async () => {
    spawnMock.mockImplementation(() => { throw new Error("EACCES: permission denied"); });

    await expect(lib.startRun({ task: "do the thing", projectId: "site", source: "agent" }))
      .rejects.toMatchObject({ kind: "not_ready" });

    const runs = lib.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toMatch(/EACCES/);
    expect(runs[0].completedAt).not.toBeNull();
    expect(lib.runningCount()).toBe(0);

    // And it is on disk that way, not only in memory.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk[0].status).toBe("failed");
  });

  it("does not wedge the feature — the next run is not refused as busy", async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error("EACCES: permission denied"); });
    await expect(lib.startRun({ task: "first", projectId: "site", source: "agent" })).rejects.toBeTruthy();

    // A plausible child: enough of an EventEmitter for the runner to attach to.
    spawnMock.mockImplementation(() => {
      const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} });
      return Object.assign(new EventEmitter(), {
        stdout: stream(),
        stderr: stream(),
        stdin: { end: () => {}, on: () => {} },
        kill: () => {},
        pid: 4242,
      });
    });

    const second = await lib.startRun({ task: "second", projectId: "site", source: "agent" });
    expect(second.status).toBe("running");
    expect(lib.runningCount()).toBe(1);
  });
});

describe("a spawn that throws after the run's branch was made", () => {
  /** git (and the gh that names the base branch) are real here — the branch
   *  has to exist for the record to carry it — and only the harness fails to
   *  start, which is the failure under test. */
  async function failOnlyTheHarness(): Promise<void> {
    const real = await vi.importActual<typeof import("child_process")>("child_process");
    spawnMock.mockImplementation((bin: string, args: string[], opts: object) => {
      if (bin === "git" || bin === "gh") return real.spawn(bin, args, opts);
      throw new Error("EACCES: permission denied");
    });
  }

  /** The code project as a repository of its own, with a commit to fork from
   *  and an identity, so startRunBranch has nothing to seed. */
  function makeRepo(dir: string): void {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "--quiet");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("commit", "--quiet", "--allow-empty", "-m", "Initial commit");
  }

  it("settles the pull request with the run, naming the branch it left checked out", async () => {
    // startRun makes the run's branch BEFORE it spawns, so when the spawn
    // throws the record already carries a pull request in "opening". This
    // path never reaches finishRun, and nothing else settles the phase — so
    // it stayed pending for good, which keeps the run out of every history
    // sweep and the desktop polling for a change that is never coming.
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({ clawai_token: "t", coding_agent_enabled: true, coding_agent_auto_pr: true }),
    );
    makeRepo(path.join(root, "data", "code-projects", "site"));
    await failOnlyTheHarness();

    await expect(lib.startRun({ task: "do the thing", projectId: "site", source: "owner" }))
      .rejects.toMatchObject({ kind: "not_ready" });

    const run = lib.listRuns()[0];
    expect(run.status).toBe("failed");
    expect(run.pr?.phase).toBe("failed");
    expect(run.pr?.branch).toBe(runBranchName(run.id));
    expect(run.pr?.detail).toContain("could not start");
    expect(run.pr?.detail).toContain(runBranchName(run.id));
    expect(run.pr?.endedAt).not.toBeNull();
    expect(isPrPending(run.pr)).toBe(false);

    // On disk that way too: the boot sweep reads the file, not the memory.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk[0].pr.phase).toBe("failed");
  });
});

describe("a pull request left 'opening' by a restart", () => {
  /** A record as the previous server wrote it, mid-pull-request. */
  const recordWithOpeningPr = (id: string, status: string, branch: string | null) => ({
    id,
    task: "was preparing a pull request",
    directory: home,
    projectId: null,
    source: "owner",
    status,
    startedAt: Date.now() - 60_000,
    completedAt: status === "paused" ? null : Date.now() - 30_000,
    sessionId: "sess-old",
    model: null,
    summary: null,
    error: null,
    numTurns: 2,
    filesTouched: ["index.html"],
    commandsRun: 0,
    permissionDenials: 0,
    progress: [],
    exitCode: status === "paused" ? null : 0,
    pr: {
      phase: "opening", number: null, url: null, branch, base: "main",
      checks: { total: 0, passed: 0, failed: 0, pending: 0 }, detail: null, startedAt: Date.now() - 60_000, endedAt: null, reviewOk: true,
    },
  });

  it("settles a settled run's pull request as never opened, and leaves a paused run's alone", () => {
    // The settle that would have opened the settled run's pull request died
    // with the previous server; nothing in this one will ever come back to
    // it. A paused run is different: its record survives the restart and it
    // resumes IN PLACE, so its pull request is still coming — settling it
    // here meant the resumed run completed with nothing left to open.
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([
      recordWithOpeningPr("run-settled01", "completed", "clawbox/run-settled01"),
      recordWithOpeningPr("run-paused001", "paused", "clawbox/run-paused001"),
    ]));

    lib.resumePullRequestWatches();

    const settled = lib.getRun("run-settled01");
    expect(settled?.status).toBe("completed");
    expect(settled?.pr?.phase).toBe("failed");
    expect(settled?.pr?.detail).toMatch(/restarted before the pull request was opened/);
    expect(settled?.pr?.detail).toContain("clawbox/run-settled01");
    expect(settled?.pr?.endedAt).not.toBeNull();
    expect(isPrPending(settled?.pr)).toBe(false);
    expect(settled?.progress.join("\n")).toMatch(/Not merged/);

    const paused = lib.getRun("run-paused001");
    expect(paused?.status).toBe("paused");
    expect(paused?.pr?.phase).toBe("opening");
    expect(isPrPending(paused?.pr)).toBe(true);

    // Persisted, so the next reader — and the next restart — sees it settled.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk.find((r: { id: string }) => r.id === "run-settled01").pr.phase).toBe("failed");
    expect(onDisk.find((r: { id: string }) => r.id === "run-paused001").pr.phase).toBe("opening");
  });

  it("names the run's branch even when the record did not keep it", () => {
    // An older record's pr blob may lack `branch`; the owner is still told
    // where the work is, from the one name a run's branch can have.
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([
      recordWithOpeningPr("run-nobranch1", "failed", null),
    ]));
    lib.resumePullRequestWatches();
    expect(lib.getRun("run-nobranch1")?.pr?.phase).toBe("failed");
    expect(lib.getRun("run-nobranch1")?.pr?.detail).toContain(runBranchName("run-nobranch1"));
  });
});
