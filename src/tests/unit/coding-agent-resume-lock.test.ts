/**
 * The local-only AI lock has to stop a RESUME, not only a start (TASK-2501
 * PR-E, CodeRabbit's finding on #1511).
 *
 * `resumeRunOnce` is almost all awaits: the tools, the worktree, the folder, the
 * permission rules and then the whole preparation — accounts, MCP servers, the
 * project's secrets, git identity. A lock the owner turns on inside any of them
 * must stop the launch, and the record must come out exactly as it went in:
 * still paused (or still given up), with no attempt spent, no prepared secrets
 * left behind and no feed line claiming a hand-off that never happened.
 *
 * The lock is asked twice, and it is the LAST question before the spawn that
 * this file is about: the check that must not be followed by another await,
 * because that await is the gap a cloud process slips through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({
  announceCodingAgent: vi.fn(async () => undefined),
  announceCodingRunToChat: vi.fn(async () => undefined),
}));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));

// The lock, both faces of it: the awaited read every gate takes at the start of
// a resume, and the synchronous one the launch itself asks. Kept separate so a
// case can let the resume through every gate and then flip the lock inside the
// preparation — the race, as the owner can cause it.
const cloudLocked = vi.hoisted(() => vi.fn(async () => false));
const cloudLockedSync = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/ai-cloud-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-cloud-lock")>()),
  isCloudAiLocked: cloudLocked,
  isCloudAiLockedSync: cloudLockedSync,
}));
vi.mock("@/lib/feature-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-engine")>()),
  cloudAiLockOn: cloudLocked,
}));
const resolveLocalEngine = vi.hoisted(() => vi.fn());
vi.mock("@/lib/local-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-engine")>()),
  resolveLocalEngine,
}));

// The last await of the preparation, so a flip here is a flip in the middle of
// everything a resume resolves: exactly where the lock used to be blind.
const armLockDuringPreparation = vi.hoisted(() => ({ armed: false }));
vi.mock("@/lib/coding-git-identity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/coding-git-identity")>();
  return {
    ...real,
    resolveCodingGitIdentity: async (dir: string) => {
      if (armLockDuringPreparation.armed) cloudLockedSync.mockReturnValue(true);
      return real.resolveCodingGitIdentity(dir);
    },
  };
});

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projects: string;
let starts: string;
let flag: string;
let restore: () => void;

const INIT = '{"type":"system","subtype":"init","session_id":"sess-lock-1","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-lock-1" });

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/** Every spawn is counted, so "no process started" is checked on the disk a child
 *  would have touched rather than on the record's word for it. Each one waits to
 *  be killed: the shape a pause needs, a live process with a session to return to. */
function installWrapper(): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      `echo start >> "${starts}"`,
      readFirstTurn(),
      `echo '${INIT}'`,
      `while [ ! -f "${flag}" ]; do sleep 0.05; done`,
      `echo '${result("done")}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function folder(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

function spawnCount(): number {
  try {
    return fs.readFileSync(starts, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** A run the owner paused: live, with a session, which is what Resume comes back to. */
async function pausedRun(provider: "clawbox-ai" | "local", name: string): Promise<string> {
  const run = await lib.startRun({ task: "Do the thing", directory: folder(name), source: "owner", provider });
  await vi.waitFor(() => { expect(lib.getRun(run.id)?.status).toBe("running"); }, { timeout: 20_000 });
  // The spawn returns before the child has exec'd anything, so a pause taken on
  // the status alone can kill it before its first line — wait for the marker the
  // wrapper writes, which is this file's proof that a process really started.
  await vi.waitFor(() => { expect(spawnCount()).toBeGreaterThan(0); }, { timeout: 20_000 });
  lib.pauseRun(run.id);
  const settled = await lib.waitForRun(run.id, 20_000);
  expect(settled?.status).toBe("paused");
  return run.id;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-resume-lock-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  starts = path.join(base, "spawns");
  flag = path.join(base, "go");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  writeConfig({
    clawai_token: "claw_test_token",
    coding_agent_enabled: true,
    coding_agent_default_directory: projects,
    coding_agent_max_parallel_runs: 2,
  });
  installWrapper();
  cloudLocked.mockReset().mockResolvedValue(false);
  cloudLockedSync.mockReset().mockReturnValue(false);
  armLockDuringPreparation.armed = false;
  resolveLocalEngine.mockReset().mockResolvedValue({
    kind: "clawext",
    model: "dsv41-flash",
    modelRef: "clawext/dsv41-flash",
    chatUrl: "http://192.0.2.9:8899/v1/chat/completions",
    authorization: "Bearer engine-secret-key",
    contextTokens: 1_000_000,
    maxOutputTokens: 32_000,
    parallel: 1,
    imageInput: false,
  });
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  fs.writeFileSync(flag, "go");
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a resume on a cloud provider with the lock turned on", () => {
  it("does not launch when the lock goes on during the preparation, and leaves the run exactly as paused", async () => {
    const id = await pausedRun("clawbox-ai", "alpha");
    const before = lib.getRun(id)!;
    const spawnedBefore = spawnCount();
    expect(spawnedBefore).toBe(1);
    // Every gate has already been passed by the time the preparation runs: this
    // is the owner flipping the lock in the window the awaited read left open.
    armLockDuringPreparation.armed = true;

    await expect(lib.resumeRun(id)).rejects.toThrow(/local-only AI lock is on/);

    // No process: the child that would have been started is the one thing this
    // test must not see.
    expect(spawnCount()).toBe(spawnedBefore);
    const after = lib.getRun(id)!;
    expect(after.status).toBe("paused");
    expect(after.error).toBeNull();
    expect(after.exitCode).toBeNull();
    expect(after.completedAt).toBe(before.completedAt);
    expect(after.pauseReason).toEqual(before.pauseReason);
    // Nothing to show for the attempt either: the preparation's own feed lines
    // are given back with its secrets, so the card still reads as the pause the
    // owner left behind.
    expect(after.progress).toEqual(before.progress);
    expect(after.secretNames).toEqual(before.secretNames);
  });

  it("still resumes when nothing turns the lock on, so the check is not a refusal in disguise", async () => {
    const id = await pausedRun("clawbox-ai", "beta");
    const spawnedBefore = spawnCount();

    const resumed = await lib.resumeRun(id);

    expect(resumed.status).toBe("running");
    await vi.waitFor(() => { expect(spawnCount()).toBe(spawnedBefore + 1); }, { timeout: 10_000 });
  });

  it("resumes a run on the box's own engine with the lock on — the lock is about the cloud, not the resume", async () => {
    const id = await pausedRun("local", "gamma");
    const spawnedBefore = spawnCount();
    // The lock is on for everything cloud, and the run's own engine is what it
    // allows: Resume has to go through.
    cloudLocked.mockResolvedValue(true);
    cloudLockedSync.mockReturnValue(true);

    const resumed = await lib.resumeRun(id);

    expect(resumed.status).toBe("running");
    await vi.waitFor(() => { expect(spawnCount()).toBe(spawnedBefore + 1); }, { timeout: 10_000 });
  });
});
