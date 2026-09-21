import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

/**
 * TASK-741, item 6 — a doctor that was BLOCKED did not fail a migration.
 *
 * With a legacy `exec-approvals.json` in the state directory the core's
 * security gate throws on the file's mere PRESENCE, so `openclaw doctor --fix`
 * exits 1 having migrated NOTHING and its last line asks the operator to run
 * the command that has just run. Measured against 2026.8.1 on 2026-09-06 (in a
 * throwaway `OPENCLAW_STATE_DIR` under /tmp, on the OpenClaw box):
 *
 *   RC=1, and on STDERR:
 *   Legacy exec approvals exist at <state>/exec-approvals.json. Run
 *   `openclaw doctor --fix` … before using exec approvals.
 *
 * `runOpenclawDoctorFix` threw that at its caller like any other failure, and
 * `configure/route.ts` answered by ARCHIVING the auth-profiles file it had just
 * written and returning 502 — a subscription sign-in rolled back over a
 * migration that had not been attempted. The blocker is cleared by the
 * gateway's own ExecStartPre on the next start (TASK-737), which re-runs this
 * same migration, so the credential is deferred rather than lost.
 *
 * The two halves that must both hold: this one answer is reported, and every
 * other failure still throws.
 */

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    // `readEdition()` stats the edition file before reading it; a mock without
    // `statSync` throws a TypeError into its own catch and the edition guard
    // this whole path depends on is never exercised.
    statSync: vi.fn(() => { throw new Error("no edition file"); }),
    readFileSync: vi.fn(() => { throw new Error("no edition file"); }),
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => { throw new Error("no nvm dir"); }),
  },
}));

vi.mock("fs/promises", () => ({
  default: { readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), mkdir: vi.fn() },
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const mockExecFile = vi.mocked(childProcess.execFile);

let openclawConfig: typeof import("@/lib/openclaw-config");

/** A child that writes `stderr` and exits 1, like the blocked doctor. */
function failingChild(stderrText: string): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stderr = new EventEmitter();
  child.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  child.stderr = stderr as unknown as ChildProcess["stderr"];
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  queueMicrotask(() => {
    stderr.emit("data", Buffer.from(stderrText));
    child.emit("close", 1);
  });
  return child;
}

let ambientEdition: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ambientEdition = process.env.CLAWBOX_EDITION;
  process.env.CLAWBOX_EDITION = "openclaw";
  // The `systemctl stop` before doctor: promisified `execFile`, callback style.
  mockExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    cb?.(null, { stdout: "", stderr: "" });
    return undefined as unknown as ChildProcess;
  }) as unknown as typeof childProcess.execFile);
  openclawConfig = await import("@/lib/openclaw-config");
});

afterEach(() => {
  if (ambientEdition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = ambientEdition;
});

describe("runOpenclawDoctorFix and the legacy exec-approvals blocker", () => {
  it("reports the blocker instead of throwing it as a migration failure", async () => {
    mockSpawn.mockImplementation(() => failingChild(
      "Legacy exec approvals exist at /home/clawbox/.openclaw/exec-approvals.json."
      + " Run `openclaw doctor --fix` before using exec approvals.\n",
    ));

    await expect(openclawConfig.runOpenclawDoctorFix()).resolves.toBe("blocked-by-legacy-exec-approvals");
  });

  it("still throws every other doctor failure", async () => {
    // The invariant the change must not remove: a doctor that genuinely could
    // not migrate leaves a credential store OpenClaw 2 refuses to hydrate, and
    // the caller's rollback is the right answer to that.
    mockSpawn.mockImplementation(() => failingChild("doctor exploded\n"));

    await expect(openclawConfig.runOpenclawDoctorFix()).rejects.toThrow("doctor exploded");
  });

  it("answers completed on the ordinary path", async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
      child.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
      child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(openclawConfig.runOpenclawDoctorFix()).resolves.toBe("completed");
  });

  it("spawns nothing on the Hermes edition", async () => {
    process.env.CLAWBOX_EDITION = "hermes";
    vi.resetModules();
    const hermes = await import("@/lib/openclaw-config");

    await expect(hermes.runOpenclawDoctorFix()).resolves.toBe("completed");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
