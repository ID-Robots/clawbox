import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";

/**
 * A root step outlives the web server that started it: its unit runs on under
 * systemd. What a background task needs to follow it again after a restart is
 * WHICH run it was — recorded by `followRootStep` the first time it sees the
 * unit running — and a follow that claims an ending only for that run.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));
const h = vi.hoisted(() => ({ startRootStep: vi.fn(async () => {}) }));
vi.mock("@/lib/root-step-runner", () => ({ startRootStep: h.startRootStep }));

const mockExecFile = vi.mocked(childProcess.execFile);
const RUN_A = "a".repeat(32);
const RUN_B = "b".repeat(32);

/** The unit as systemd answers it, poll by poll: the last entry repeats. */
let states: string[] = [];
let invocation = "";
let journal = "";
let shows = 0;

beforeEach(() => {
  vi.clearAllMocks();
  states = [];
  invocation = "";
  journal = "";
  shows = 0;
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    optsOrCallback?: unknown,
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = (typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback) as
      (error: Error | null, result: { stdout: string; stderr: string }) => void;
    let stdout = "";
    if (cmd.includes("systemctl") && args.includes("InvocationID")) {
      stdout = `InvocationID=${invocation}\n`;
    } else if (cmd.includes("systemctl")) {
      stdout = states[Math.min(shows, states.length - 1)] ?? "ActiveState=inactive\nResult=success\n";
      shows += 1;
    } else if (cmd.includes("journalctl")) {
      stdout = journal;
    }
    callback?.(null, { stdout, stderr: "" });
    return undefined as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

const ACTIVE = "ActiveState=active\nResult=success\n";
const DONE = "ActiveState=inactive\nResult=success\n";
const FAILED = "ActiveState=failed\nResult=exit-code\n";

async function run<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.finally(() => { settled = true; });
  for (let i = 0; i < 20 && !settled; i += 1) await vi.advanceTimersByTimeAsync(3_000);
  return promise;
}

describe("followRootStep records the run it follows", () => {
  it("hands over the invocation once, the first time the unit is seen running", async () => {
    const { followRootStep } = await import("@/lib/root-step-follow");
    states = [ACTIVE, ACTIVE, DONE];
    invocation = RUN_A;
    const onRunning = vi.fn();

    const result = await run(followRootStep("embed_model", { timeoutMs: 60_000, label: "the download", onStatus: () => {}, onRunning }));

    expect(result.ok).toBe(true);
    expect(onRunning).toHaveBeenCalledTimes(1);
    expect(onRunning).toHaveBeenCalledWith({ step: "embed_model", sinceMs: expect.any(Number), invocationId: RUN_A });
  });

  it("records nothing when systemd does not name the run", async () => {
    const { followRootStep } = await import("@/lib/root-step-follow");
    states = [ACTIVE, DONE];
    invocation = "";
    const onRunning = vi.fn();
    await run(followRootStep("embed_model", { timeoutMs: 60_000, label: "the download", onStatus: () => {}, onRunning }));
    expect(onRunning).not.toHaveBeenCalled();
  });
});

describe("followRootStepRun follows a run somebody else dispatched", () => {
  it("follows the same invocation to its end, starting nothing", async () => {
    const { followRootStepRun } = await import("@/lib/root-step-follow");
    states = [ACTIVE, ACTIVE, DONE];
    invocation = RUN_A;
    journal = "  Downloading the memory-search model...\n";
    const lines: string[] = [];

    const result = await run(followRootStepRun(
      { step: "embed_model", sinceMs: Date.now() - 60_000, invocationId: RUN_A },
      { timeoutMs: 60_000, label: "the download", onStatus: (l) => lines.push(l) },
    ));

    expect(result).toEqual({ ok: true });
    expect(h.startRootStep).not.toHaveBeenCalled();
    expect(lines).toContain("Downloading the memory-search model...");
  });

  it("reads a recorded run that has already ended as its ending", async () => {
    const { followRootStepRun } = await import("@/lib/root-step-follow");
    states = [DONE];
    expect(await run(followRootStepRun(
      { step: "embed_model", sinceMs: 1, invocationId: RUN_A },
      { timeoutMs: 60_000, label: "the download", onStatus: () => {} },
    ))).toEqual({ ok: true });

    shows = 0;
    states = [FAILED];
    journal = "Error: failed to download the memory-search model\n";
    const failed = await run(followRootStepRun(
      { step: "embed_model", sinceMs: 1, invocationId: RUN_A },
      { timeoutMs: 60_000, label: "the download", onStatus: () => {} },
    ));
    expect(failed.ok).toBe(false);
    expect(failed.lost).toBeUndefined();
    expect(failed.error).toContain("failed to download");
  });

  it("does not claim another run's ending", async () => {
    const { followRootStepRun } = await import("@/lib/root-step-follow");
    states = [ACTIVE];
    invocation = RUN_B;
    const result = await run(followRootStepRun(
      { step: "embed_model", sinceMs: 1, invocationId: RUN_A },
      { timeoutMs: 60_000, label: "the download", onStatus: () => {} },
    ));
    expect(result.ok).toBe(false);
    expect(result.lost).toBe(true);
  });

  it("says it does not know when the run was never seen running and the unit is idle", async () => {
    const { followRootStepRun } = await import("@/lib/root-step-follow");
    states = [DONE];
    const result = await run(followRootStepRun(
      { step: "embed_model", sinceMs: 1, invocationId: null },
      { timeoutMs: 60_000, label: "the download", onStatus: () => {} },
    ));
    expect(result.ok).toBe(false);
    expect(result.lost).toBe(true);
  });
});
