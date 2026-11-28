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
// The account pool's pick, movable between the pause and the Resume: the
// preparation moves `run.anthropicAccount` onto whatever it picks, and a
// refused resume must not leave the record naming an account it never used.
const poolPick = vi.hoisted(() => ({ id: null as string | null, credential: "sk-ant-test-credential" }));
vi.mock("@/lib/anthropic-accounts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/anthropic-accounts")>();
  return {
    ...real,
    armCodingSwapConsumer: () => {},
    // Readiness asks the pool whether ANY credential is there; the pick below is
    // the account it would hand out, so the two say the same thing.
    poolHasCredential: async () => ({
      any: poolPick.id !== null,
      hasKey: poolPick.id !== null,
      hasLogin: false,
      hasOAuth: false,
      first: poolPick.id !== null ? "api_key" : null,
    }),
    prepareAccount: async () => {
      const id = poolPick.id;
      if (!id) return { prepared: null, health: { allLimited: false, room: null } as never };
      return {
        prepared: {
          account: {
            id,
            label: `Account ${id}`,
            email: null,
            kind: "api_key" as const,
            status: "ok" as const,
            limitedUntil: null,
            limitKind: null,
            addedAt: 0,
            lastUsedAt: null,
            lastLimitedAt: null,
            expiresAt: null,
            authFailedAt: null,
          },
          credential: { kind: "api_key" as const, secret: poolPick.credential },
        },
        health: { allLimited: false, room: null } as never,
      };
    },
  };
});
const resolveLocalEngine = vi.hoisted(() => vi.fn());
vi.mock("@/lib/local-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-engine")>()),
  resolveLocalEngine,
}));

// The last await of the preparation, so a flip here is a flip in the middle of
// everything a resume resolves: exactly where the lock used to be blind.
const armLockDuringPreparation = vi.hoisted(() => ({ armed: false }));
// The owner's Stop, pressed on the paused run while the resume is inside its
// preparation: the record ends under it, and the launch must cancel itself.
const armStopDuringPreparation = vi.hoisted(() => ({ fn: null as null | (() => void) }));
vi.mock("@/lib/coding-git-identity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/coding-git-identity")>();
  return {
    ...real,
    resolveCodingGitIdentity: async (dir: string) => {
      if (armStopDuringPreparation.fn) {
        const stop = armStopDuringPreparation.fn;
        armStopDuringPreparation.fn = null;
        stop();
      }
      if (armLockDuringPreparation.armed) cloudLockedSync.mockReturnValue(true);
      return real.resolveCodingGitIdentity(dir);
    },
  };
});

type Lib = typeof import("@/lib/coding-agent");
type Secrets = typeof import("@/lib/project-secrets");

let lib: Lib;
let secrets: Secrets;
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

/** The secrets audit, so "handed back" is read off the store's own record. */
function audit(): Record<string, unknown>[] {
  const file = path.join(root, "data", "secrets-audit.log");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A run the owner paused: live, with a session, which is what Resume comes back to. */
async function pausedRun(provider: "clawbox-ai" | "local" | "anthropic", name: string): Promise<string> {
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
    // On, so a resume's preparation pushes a feed line and CLAIMS one-run
    // copies — the two things a refusal has to give back.
    coding_agent_inject_secrets: true,
  });
  installWrapper();
  cloudLocked.mockReset().mockResolvedValue(false);
  cloudLockedSync.mockReset().mockReturnValue(false);
  armLockDuringPreparation.armed = false;
  armStopDuringPreparation.fn = null;
  poolPick.id = null;
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
  secrets = await import("@/lib/project-secrets");
  lib = await import("@/lib/coding-agent");
  // One box-wide key, and one copy limited to a single run: the two kinds a
  // resume hands out, and the two kinds a refusal must treat differently.
  await secrets.setSecret({ name: "DEPLOY_TOKEN", value: "vrc_live_9Q3k2Zx7pLmN4tR8sW1yB6dF0hJ5aC", scope: "@box", inject: true });
  await secrets.importSecret({ name: "ONE_RUN_TOKEN", value: "one-run-value-000000", scope: "@box", source: "hermes", expiresAt: "run" });
  await secrets.setSecretInject({ name: "ONE_RUN_TOKEN", scope: "@box", inject: true });
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

describe("a run the owner stops while the preparation is running", () => {
  it("does not start a process, gives its prepared secrets back and leaves the record stopped", async () => {
    const id = await pausedRun("clawbox-ai", "zeta");
    const spawnedBefore = spawnCount();
    expect(spawnedBefore).toBe(1);
    // A one-run copy appears after the pause. The preparation claims it; the
    // cancelled attempt has to hand it back rather than leave it spent.
    await secrets.importSecret({ name: "LATE_TOKEN", value: "late-one-run-value-000", scope: "@box", source: "hermes", expiresAt: "run" });
    await secrets.setSecretInject({ name: "LATE_TOKEN", scope: "@box", inject: true });
    // The owner presses Stop on the paused run from inside the preparation —
    // the window where the record is still paused and nothing has been flipped.
    armStopDuringPreparation.fn = () => { lib.stopRun(id); };

    const resumed = await lib.resumeRun(id);

    // The record the Stop left, not a run revived as running.
    expect(resumed.status).toBe("stopped");
    expect(spawnCount()).toBe(spawnedBefore);
    const after = lib.getRun(id)!;
    expect(after.status).toBe("stopped");
    expect(after.error).toBe("Stopped.");
    expect(after.completedAt).not.toBeNull();
    // The copy this attempt claimed is given back — by the Stop's own settle or
    // by this cancel, but gone either way: a stopped record keeps no hand-off
    // nothing will use.
    await vi.waitFor(async () => {
      expect((await secrets.listSecrets()).filter((s) => s.name === "LATE_TOKEN")).toEqual([]);
    }, { timeout: 10_000 });
  });
});

describe("what a refused resume gives back", () => {
  it("keeps the one-run copies the paused run already held, and gives back only the ones this resume claimed", async () => {
    const id = await pausedRun("clawbox-ai", "delta");
    const before = lib.getRun(id)!;
    expect([...before.secretNames].sort()).toEqual(["DEPLOY_TOKEN", "ONE_RUN_TOKEN"]);
    // A second one-run copy appears between the pause and the Resume. The
    // preparation claims it for this run; the refusal has to hand it back
    // WITHOUT taking the copy the paused run was already holding.
    await secrets.importSecret({ name: "LATE_TOKEN", value: "late-one-run-value-000", scope: "@box", source: "hermes", expiresAt: "run" });
    await secrets.setSecretInject({ name: "LATE_TOKEN", scope: "@box", inject: true });
    armLockDuringPreparation.armed = true;

    await expect(lib.resumeRun(id)).rejects.toThrow(/local-only AI lock is on/);

    // The record still says what the paused run holds — not what the refused
    // attempt resolved, which included the copy it had to give back.
    const after = lib.getRun(id)!;
    expect([...after.secretNames].sort()).toEqual(["DEPLOY_TOKEN", "ONE_RUN_TOKEN"]);
    // Exactly one delete, exactly the copy this resume claimed. The paused
    // run's own ONE_RUN_TOKEN is not on it: it is still that run's to resume
    // with. The give-back is tracked settle work, so waited for rather than
    // assumed to have landed with the throw.
    await vi.waitFor(() => {
      expect(audit().filter((line) => line.reason === "resume_refused")).toEqual([
        expect.objectContaining({ action: "delete", names: ["LATE_TOKEN"], scope: "@box", runId: id, reason: "resume_refused" }),
      ]);
    }, { timeout: 10_000 });
    const taken = audit().filter((line) => line.action === "delete" && (line.names as string[] | undefined)?.includes("ONE_RUN_TOKEN"));
    expect(taken).toEqual([]);
  });

  it("leaves the record on the account it was opened on when the resume is refused", async () => {
    // A run opened on one account, then the pool's pick has moved on by the time
    // the owner presses Resume — an account switch in between, a limit, another
    // run taking the first-line account. The preparation moves the record onto
    // the new one; the refusal never resumed on it, so the record must come out
    // naming the account the pause left (TASK-2501 PR-E, CodeRabbit's finding on
    // #1511).
    poolPick.id = "aaaabbbb";
    const id = await pausedRun("anthropic", "eta");
    expect(lib.getRun(id)!.anthropicAccount).toBe("aaaabbbb");
    poolPick.id = "ccccdddd";
    armLockDuringPreparation.armed = true;

    await expect(lib.resumeRun(id)).rejects.toThrow(/local-only AI lock is on/);

    const after = lib.getRun(id)!;
    expect(after.anthropicAccount).toBe("aaaabbbb");
    expect(after.status).toBe("paused");
  });

  it("gives the whole feed back, not just its length, when the preparation trimmed it", async () => {
    const id = await pausedRun("clawbox-ai", "epsilon");
    // A feed already at its cap: the preparation's own line pushes the middle
    // out, so a restored LENGTH leaves a gap marker and its count on the record
    // with the lines it stands for missing — the step the owner never took.
    for (let i = 0; i < 60; i += 1) lib.pushRunProgressForTests(id, `step ${i}`);
    const before = lib.getRun(id)!;
    expect(before.progress.length).toBe(60);
    armLockDuringPreparation.armed = true;

    await expect(lib.resumeRun(id)).rejects.toThrow(/local-only AI lock is on/);

    const after = lib.getRun(id)!;
    expect(after.progress).toEqual(before.progress);
    expect(after.progressAt).toEqual(before.progressAt);
  });
});
