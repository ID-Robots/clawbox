import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  DOCTOR_SERVICE_OWNERSHIP_RE,
  EXTERNAL_GATEWAY_SUPERVISOR_ENV,
  OPENCLAW_SERVICE_REPAIR_POLICY_ENV,
  OPENCLAW_SUPERVISOR_MODE_ENV,
  withExternalGatewaySupervisor,
} from "@/lib/openclaw-doctor-ownership";

/**
 * A `doctor --fix` that never started, on every box ClawBox actually ships.
 *
 * Measured against OpenClaw 2026.9.3 on a Jetson Nano on 2026-09-16, with
 * `clawbox-gateway.service` STOPPED and no environment:
 *
 *   RC=1, and:
 *   Doctor could not enter maintenance. Error: Gateway service ownership or
 *   shutdown could not be verified. Run `openclaw gateway status --deep` and
 *   stop it through its service owner before retrying. …
 *
 * The gateway on that box is the ClawBox SYSTEM unit, while the core's own
 * `gateway status --deep` answers `Service: systemd user (enabled)` with no
 * user unit in existence — so doctor could form neither an "owned" nor an
 * "absent" verdict and refused. Stopping the unit first does not help; the
 * refusal is about the verdict, not the process, which is why the caller's
 * existing `systemctl stop` was never enough.
 *
 * On the same box and in the same state, `OPENCLAW_SERVICE_REPAIR_POLICY=external`
 * exits 0, and so do both variables together. These tests pin the environment
 * rather than the exit code, because the environment is the part this repo owns.
 */

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
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

/** A child that writes `stderr` and exits 1, like a doctor that refused. */
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

/** A child that exits 0, like a doctor that ran. */
function succeedingChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

/** The environment the doctor child was actually spawned with. */
function spawnedDoctorEnv(): Record<string, string | undefined> {
  const call = mockSpawn.mock.calls.at(-1);
  expect(call).toBeDefined();
  return (call?.[2] as { env?: Record<string, string | undefined> } | undefined)?.env ?? {};
}

/** The core's sentence, verbatim from the box named above. */
const OWNERSHIP_REFUSAL =
  "Doctor could not enter maintenance. Error: Gateway service ownership or shutdown could not be"
  + " verified. Run `openclaw gateway status --deep` and stop it through its service owner before"
  + " retrying. Stop the Gateway service and other OpenClaw processes using this state, then run"
  + " `openclaw doctor --fix` from an independent shell.\n";

let ambientEdition: string | undefined;
let ambientSupervisorMode: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ambientEdition = process.env.CLAWBOX_EDITION;
  ambientSupervisorMode = process.env[OPENCLAW_SUPERVISOR_MODE_ENV];
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
  if (ambientSupervisorMode === undefined) delete process.env[OPENCLAW_SUPERVISOR_MODE_ENV];
  else process.env[OPENCLAW_SUPERVISOR_MODE_ENV] = ambientSupervisorMode;
});

describe("the external-supervisor declaration", () => {
  it("names both variables the core reads, both set to external", () => {
    expect(EXTERNAL_GATEWAY_SUPERVISOR_ENV).toEqual({
      OPENCLAW_SUPERVISOR_MODE: "external",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    });
  });

  it("is frozen, because three call sites spread the same object", () => {
    expect(Object.isFrozen(EXTERNAL_GATEWAY_SUPERVISOR_ENV)).toBe(true);
  });

  it("keeps the caller's own variables", () => {
    const merged = withExternalGatewaySupervisor({ HOME: "/home/clawbox", OPENCLAW_STATE_DIR: "/s" });
    expect(merged.HOME).toBe("/home/clawbox");
    expect(merged.OPENCLAW_STATE_DIR).toBe("/s");
  });

  it("OVERRIDES an inherited supervisor mode rather than deferring to it", () => {
    // The declaration is a fact about this device. A `managed` inherited from
    // the gateway's own unit file — or from the operator's shell — must not be
    // able to put doctor back into the refusal.
    const merged = withExternalGatewaySupervisor({ [OPENCLAW_SUPERVISOR_MODE_ENV]: "managed" });
    expect(merged[OPENCLAW_SUPERVISOR_MODE_ENV]).toBe("external");
  });

  it("defaults to a bare declaration when given no base", () => {
    expect(withExternalGatewaySupervisor()).toEqual({ ...EXTERNAL_GATEWAY_SUPERVISOR_ENV });
  });

  it("does not mutate the base it was handed", () => {
    const base: Record<string, string | undefined> = { HOME: "/home/clawbox" };
    withExternalGatewaySupervisor(base);
    expect(base[OPENCLAW_SUPERVISOR_MODE_ENV]).toBeUndefined();
  });
});

describe("the ownership-refusal matcher", () => {
  it("matches the sentence the box printed", () => {
    expect(DOCTOR_SERVICE_OWNERSHIP_RE.test(OWNERSHIP_REFUSAL)).toBe(true);
  });

  it("matches the config/state selection mismatch", () => {
    expect(DOCTOR_SERVICE_OWNERSHIP_RE.test(
      "Doctor and the managed Gateway select different config or state directories.",
    )).toBe(true);
  });

  it("matches the update-parent activation refusal", () => {
    expect(DOCTOR_SERVICE_OWNERSHIP_RE.test(
      "The update parent owns Gateway activation. Stop the service through its owner before retrying.",
    )).toBe(true);
  });

  it("does NOT match a doctor that ran and failed on something real", () => {
    // Fails safe: an unrecognised failure keeps the older, stricter handling.
    expect(DOCTOR_SERVICE_OWNERSHIP_RE.test("Doctor could not enter maintenance. Error: database is locked."))
      .toBe(false);
    expect(DOCTOR_SERVICE_OWNERSHIP_RE.test("doctor exploded")).toBe(false);
  });

  it("is not sticky, so repeated tests of the same string agree", () => {
    // A `/g` flag here would make every second caller disagree with the first.
    expect(DOCTOR_SERVICE_OWNERSHIP_RE.global).toBe(false);
    expect(DOCTOR_SERVICE_OWNERSHIP_RE.test(OWNERSHIP_REFUSAL)).toBe(true);
    expect(DOCTOR_SERVICE_OWNERSHIP_RE.test(OWNERSHIP_REFUSAL)).toBe(true);
  });
});

describe("runOpenclawDoctorFix and gateway service ownership", () => {
  it("declares ClawBox the gateway's supervisor to the doctor child", async () => {
    mockSpawn.mockImplementation(() => succeedingChild());

    await expect(openclawConfig.runOpenclawDoctorFix()).resolves.toBe("completed");

    const env = spawnedDoctorEnv();
    expect(env[OPENCLAW_SUPERVISOR_MODE_ENV]).toBe("external");
    expect(env[OPENCLAW_SERVICE_REPAIR_POLICY_ENV]).toBe("external");
  });

  it("overrides a supervisor mode inherited from the setup server's own env", async () => {
    process.env[OPENCLAW_SUPERVISOR_MODE_ENV] = "managed";
    vi.resetModules();
    const fresh = await import("@/lib/openclaw-config");
    mockSpawn.mockImplementation(() => succeedingChild());

    await expect(fresh.runOpenclawDoctorFix()).resolves.toBe("completed");

    // `spawnOpenclaw` spreads `process.env` before the caller's `env`, so this
    // asserts the ORDER of that merge, not just the value.
    expect(spawnedDoctorEnv()[OPENCLAW_SUPERVISOR_MODE_ENV]).toBe("external");
  });

  it("still stops the gateway unit before running doctor", async () => {
    // The declaration replaces neither half: doctor needs exclusive access to
    // the state the running gateway holds open.
    mockSpawn.mockImplementation(() => succeedingChild());

    await openclawConfig.runOpenclawDoctorFix();

    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/systemctl", "stop", "clawbox-gateway.service"],
      expect.anything(),
      expect.anything(),
    );
  });

  it("reports an ownership refusal instead of throwing it as a migration failure", async () => {
    // Reached only by a core too old to know the setting. The caller's rollback
    // is unchanged; what changes is that it can stop repeating the core's
    // advice to run the command that just refused.
    mockSpawn.mockImplementation(() => failingChild(OWNERSHIP_REFUSAL));

    await expect(openclawConfig.runOpenclawDoctorFix()).resolves.toBe("blocked-by-service-ownership");
  });

  it("still throws every other doctor failure", async () => {
    // The invariant the change must not remove: a doctor that genuinely could
    // not migrate leaves a credential store OpenClaw 2 refuses to hydrate.
    mockSpawn.mockImplementation(() => failingChild("doctor exploded\n"));

    await expect(openclawConfig.runOpenclawDoctorFix()).rejects.toThrow("doctor exploded");
  });

  it("keeps the legacy exec-approvals blocker ahead of the ownership one", async () => {
    // Both sentences in one output: the approvals file is the actionable one
    // and its message names a file the owner can move.
    mockSpawn.mockImplementation(() => failingChild(
      `Legacy exec approvals exist at /home/clawbox/.openclaw/exec-approvals.json.\n${OWNERSHIP_REFUSAL}`,
    ));

    await expect(openclawConfig.runOpenclawDoctorFix())
      .resolves.toBe("blocked-by-legacy-exec-approvals");
  });
});
