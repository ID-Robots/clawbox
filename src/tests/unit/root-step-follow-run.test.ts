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
/** What PID 1 logged for the run (`INVOCATION_ID=`), which outlives the instance. */
let ending = "";
let shows = 0;

beforeEach(() => {
  vi.clearAllMocks();
  states = [];
  invocation = "";
  journal = "";
  ending = "";
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
    } else if (cmd.includes("journalctl") && args.some((a) => a.startsWith("INVOCATION_ID="))) {
      stdout = args.includes(`INVOCATION_ID=${RUN_A}`) ? ending : "";
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
    ending = "clawbox-root-update@embed_model.service: Deactivated successfully.\n";
    const lines: string[] = [];

    const result = await run(followRootStepRun(
      { step: "embed_model", sinceMs: Date.now() - 60_000, invocationId: RUN_A },
      { timeoutMs: 60_000, label: "the download", onStatus: (l) => lines.push(l) },
    ));

    expect(result).toEqual({ ok: true });
    expect(h.startRootStep).not.toHaveBeenCalled();
    expect(lines).toContain("Downloading the memory-search model...");
  });

  it("follows an adopted run to its end across a forward step of the wall clock", async () => {
    // A run adopted from the previous web server is followed again as this
    // one starts — on a cold boot, before timesyncd has stepped the clock of
    // a box with no RTC. The step must not spend the follow's whole budget.
    const { followRootStepRun } = await import("@/lib/root-step-follow");
    states = [ACTIVE, ACTIVE, DONE];
    invocation = RUN_A;
    ending = "clawbox-root-update@embed_model.service: Deactivated successfully.\n";
    const realNow = Date.now;
    let step = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + step);
    const answer = mockExecFile.getMockImplementation()!;
    mockExecFile.mockImplementation(((cmd: string, args: string[], ...rest: unknown[]) => {
      if (cmd.includes("systemctl") && !args.includes("InvocationID") && shows === 0) step = 12 * 60 * 60 * 1000;
      return (answer as (...a: unknown[]) => unknown)(cmd, args, ...rest);
    }) as unknown as typeof childProcess.execFile);

    const result = await run(followRootStepRun(
      { step: "embed_model", sinceMs: realNow.call(Date) - 60_000, invocationId: RUN_A },
      { timeoutMs: 60_000, label: "the download", onStatus: () => {} },
    ));

    expect(result).toEqual({ ok: true });
    expect(shows).toBe(3);
  });

  it("reads a recorded run that has already ended as its ending, on systemd's own word for it", async () => {
    const { followRootStepRun } = await import("@/lib/root-step-follow");
    states = [DONE];
    ending = "Finished clawbox-root-update@embed_model.service.\nclawbox-root-update@embed_model.service: Deactivated successfully.\n";
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

  it("does not read an idle unit as a run that ended well when systemd never said so (a reboot, a collected instance)", async () => {
    const { followRootStepRun } = await import("@/lib/root-step-follow");
    states = [DONE];
    ending = "";
    const result = await run(followRootStepRun(
      { step: "embed_model", sinceMs: 1, invocationId: RUN_A },
      { timeoutMs: 60_000, label: "the download", onStatus: () => {} },
    ));
    expect(result.ok).toBe(false);
    expect(result.lost).toBe(true);
  });

  it("reads systemd's own failure for the run as a failure", async () => {
    const { followRootStepRun } = await import("@/lib/root-step-follow");
    states = [DONE];
    ending = "clawbox-root-update@embed_model.service: Main process exited, code=exited, status=1/FAILURE\nclawbox-root-update@embed_model.service: Failed with result 'exit-code'.\n";
    journal = "Error: failed to download the memory-search model\n";
    const result = await run(followRootStepRun(
      { step: "embed_model", sinceMs: 1, invocationId: RUN_A },
      { timeoutMs: 60_000, label: "the download", onStatus: () => {} },
    ));
    expect(result.ok).toBe(false);
    expect(result.lost).toBeUndefined();
    expect(result.error).toContain("failed to download");
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

describe("an unanswered systemd is not an ending", () => {
  it("asks again instead of reading a failed query as the unit having stopped", async () => {
    const { followRootStep } = await import("@/lib/root-step-follow");
    // Seen running, then three polls systemd did not answer, then really done.
    states = [ACTIVE, "", "", "", DONE];
    invocation = RUN_A;
    const result = await run(followRootStep("embed_model", { timeoutMs: 120_000, label: "the download", onStatus: () => {} }));
    expect(result).toEqual({ ok: true });
    expect(shows).toBe(5);
  });

  it("gives up, without claiming success, when systemd never answers", async () => {
    const { followRootStep } = await import("@/lib/root-step-follow");
    states = [""];
    let settled = false;
    const pending = followRootStep("embed_model", { timeoutMs: 600_000, label: "the download", onStatus: () => {} });
    void pending.finally(() => { settled = true; });
    for (let i = 0; i < 40 && !settled; i += 1) await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not be asked");
  });
});

describe("followRootStep never makes the root step's plumbing the headline (TASK-2128)", () => {
  it("shows the last line that says what the step is doing, and logs su's and PAM's lines", async () => {
    const { followRootStep } = await import("@/lib/root-step-follow");
    states = [ACTIVE, DONE];
    invocation = RUN_A;
    journal = [
      "  Installing faster-whisper...",
      "(to clawbox) root on none",
      "pam_unix(su-l:session): session opened for user clawbox(uid=1000) by (uid=0)",
      "pam_unix(su-l:session): session closed for user clawbox",
    ].join("\n");
    const onStatus = vi.fn();
    const onLog = vi.fn();
    const result = await run(followRootStep("voice_whisper_install", { timeoutMs: 60_000, label: "the speech install", onStatus, onLog }));

    expect(result.ok).toBe(true);
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(["Installing faster-whisper..."]);
    expect(onLog).toHaveBeenCalledWith("pam_unix(su-l:session): session closed for user clawbox");
  });
});
