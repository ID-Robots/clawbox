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

// What the agent databases weigh, which sizes doctor's bound. 0 by default —
// what the real reader answers under the `fs/promises` mock above.
const { mockDatabaseBytes } = vi.hoisted(() => ({ mockDatabaseBytes: vi.fn<(stateDir: string) => Promise<number>>(async () => 0) }));
vi.mock("@/lib/openclaw-migration-status", async (orig) => ({
  ...(await orig<typeof import("@/lib/openclaw-migration-status")>()),
  openclawDatabaseBytes: mockDatabaseBytes,
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const mockExecFile = vi.mocked(childProcess.execFile);

let openclawConfig: typeof import("@/lib/openclaw-config");

/** A child that writes `stderr` (and, when given, `stdout`) and exits 1, like the blocked doctor. */
function failingChild(stderrText: string, stdoutText = ""): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stderr = new EventEmitter();
  const stdout = new EventEmitter();
  child.stdout = stdout as unknown as ChildProcess["stdout"];
  child.stderr = stderr as unknown as ChildProcess["stderr"];
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  queueMicrotask(() => {
    stderr.emit("data", Buffer.from(stderrText));
    if (stdoutText) stdout.emit("data", Buffer.from(stdoutText));
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

  it("says what doctor said on STDOUT as well — its verdict is mostly there (SUP-1023)", async () => {
    // Doctor's stderr is mostly Node's deprecation warnings; "Doctor finished,
    // but config fixes were not applied." is the last line of its STDOUT. The
    // default failure message (stderr when there is any) was the warnings, so
    // a rolled-back sign-in left nothing that said why. Measured on 2026.11.3.
    mockSpawn.mockImplementation(() => failingChild(
      "(node:1) [DEP_PLUGIN_SDK] DeprecationWarning: Plugin SDK: createOpenClawCodingTools is deprecated.\n",
      "Migrated auth profile JSON into SQLite.\nThe config changed after Doctor prepared these repairs.\n"
      + "Doctor finished, but config fixes were not applied.\n",
    ));

    const failure = await openclawConfig.runOpenclawDoctorFix().catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("DeprecationWarning");
    expect(message).toContain("Doctor finished, but config fixes were not applied.");
    // …after the warnings, so the END of the message is the verdict.
    expect(message.trimEnd().endsWith("config fixes were not applied.")).toBe(true);
    // stdout was piped for it: with "ignore" there is nothing to read.
    const stdio = (mockSpawn.mock.calls.at(-1)?.[2] as { stdio?: unknown[] } | undefined)?.stdio;
    expect(stdio?.[1]).toBe("pipe");
  });

  it("keeps only the END of a very long stdout, so a doctor's output cannot grow without bound", async () => {
    const verdict = "Doctor finished, but config fixes were not applied.";
    mockSpawn.mockImplementation(() => failingChild("", `${"banner line\n".repeat(60_000)}${verdict}\n`));

    const failure = await openclawConfig.runOpenclawDoctorFix().catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message.length).toBeLessThanOrEqual(64 * 1024 + 1);
    expect(message.trimEnd().endsWith(verdict)).toBe(true);
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

  it("gives doctor the time a few GB of agent databases take instead of killing it at 180 s", async () => {
    // A stopped doctor here is a rolled-back sign-in (configure/route.ts), and
    // on a box with ~3 GB of agent databases doctor reads for minutes.
    mockDatabaseBytes.mockResolvedValue(3e9);
    let doctor: ChildProcess | undefined;
    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
      child.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
      child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
      if (args.includes("doctor")) doctor = child;
      else queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as unknown as typeof childProcess.spawn);
    vi.useFakeTimers();
    try {
      const outcome = openclawConfig.runOpenclawDoctorFix();
      // Five minutes of doctor: past the old flat 180 s, inside 90 + 3 x 120.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(doctor).toBeDefined();
      expect(doctor!.kill).not.toHaveBeenCalled();
      doctor!.emit("close", 0);
      await expect(outcome).resolves.toBe("completed");
      expect(mockDatabaseBytes).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      mockDatabaseBytes.mockResolvedValue(0);
    }
  });

  it("spawns nothing on the Hermes edition", async () => {
    process.env.CLAWBOX_EDITION = "hermes";
    vi.resetModules();
    const hermes = await import("@/lib/openclaw-config");

    await expect(hermes.runOpenclawDoctorFix()).resolves.toBe("completed");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
