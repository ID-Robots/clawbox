import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `restartGateway()` used to answer as soon as `systemctl restart` returned.
 *
 * clawbox-gateway.service is `Type=simple` with no `NotifyAccess`, so systemd
 * considers the start job done the moment the main process is FORKED — seconds
 * before OpenClaw binds :18789. Every save route that awaited it therefore
 * answered `{success:true}` over a gateway that was not yet serving: the model
 * was configured, the Telegram token registered, the transcription engine
 * switched, and the box did not answer for another ten to fifteen seconds. When
 * the gateway did not come back at all, the owner was told the save had worked.
 *
 * So the restart is not finished until the port is open, and a gateway that
 * never opens it is a failure the callers can report.
 */
const execFileMock = vi.hoisted(() => vi.fn());
const waitForPortOpenMock = vi.hoisted(() => vi.fn());
/** Every `openclaw` the code spawns: never a real one, whatever a test reaches. */
const spawnMock = vi.hoisted(() => vi.fn());

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execFile: execFileMock,
  spawn: spawnMock,
}));

/** An `openclaw` that exits 0 at once. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {}, write: () => {}, on: () => {} };
  child.kill = () => {};
  setTimeout(() => child.emit("close", 0), 1);
  return child;
}

vi.mock("@/lib/port-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: waitForPortOpenMock,
}));

describe("restartGateway waits for the gateway to listen again", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    waitForPortOpenMock.mockReset();
    // promisify(execFile) resolves through the node-style callback.
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      cb(null, { stdout: "", stderr: "" });
    });
    waitForPortOpenMock.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.CLAWBOX_EDITION;
    delete process.env.CLAWBOX_EDITION_FILE;
  });

  /** Force the edition through the env fallback (no root-owned file in tests). */
  async function load(edition: string) {
    process.env.CLAWBOX_EDITION_FILE = "/nonexistent/edition.env";
    process.env.CLAWBOX_EDITION = edition;
    return import("@/lib/openclaw-config");
  }

  it("rejects when the gateway never starts listening again", async () => {
    const { restartGateway, GatewayNotReadyError } = await load("openclaw");
    waitForPortOpenMock.mockResolvedValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restartGateway()).rejects.toBeInstanceOf(GatewayNotReadyError);
    await expect(restartGateway()).rejects.toThrow(/did not come back/i);
    errorSpy.mockRestore();
  });

  it("probes the gateway's own port on loopback", async () => {
    const { restartGateway } = await load("openclaw");
    await restartGateway();

    expect(waitForPortOpenMock).toHaveBeenCalledTimes(1);
    const [port, host] = waitForPortOpenMock.mock.calls[0];
    expect(port).toBe(18789);
    expect(host).toBe("127.0.0.1");
  });

  it("reports itself in flight for the whole restart, refused or not (TASK-1535)", async () => {
    // `/setup-api/gateway/health` reads this so the OLD process, still
    // listening while systemd stops it, is not taken for the gateway being back.
    const { restartGateway } = await load("openclaw");
    const { gatewayRestartInFlight } = await import("@/lib/gateway-restart-tracker");
    let during: boolean | null = null;
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes("restart")) during = gatewayRestartInFlight();
      cb(null, { stdout: "", stderr: "" });
    });

    expect(gatewayRestartInFlight()).toBe(false);
    await restartGateway({ awaitReady: false });
    expect(during).toBe(true);
    expect(gatewayRestartInFlight()).toBe(false);

    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      cb(args.includes("restart") ? new Error("Unit clawbox-gateway.service is masked.") : null, { stdout: "", stderr: "" });
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restartGateway({ awaitReady: false })).rejects.toThrow(/masked/);
    errorSpy.mockRestore();
    expect(gatewayRestartInFlight()).toBe(false);
  });

  it("resolves as soon as the port opens", async () => {
    const { restartGateway } = await load("openclaw");
    await expect(restartGateway()).resolves.toBeUndefined();
  });

  it("waits after the legacy user-unit fallback too", async () => {
    // The fallback path used to `return` straight out of the catch block, so a
    // box without the system unit kept the old unwaited behaviour.
    const { restartGateway } = await load("openclaw");
    const missing = new Error("Unit clawbox-gateway.service could not be found.");
    execFileMock.mockImplementation((_cmd: string, args: string[], _o: unknown, cb: ExecCallback) => {
      if (args.includes("restart") && args.includes("clawbox-gateway.service")) {
        cb(missing);
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });
    waitForPortOpenMock.mockResolvedValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restartGateway()).rejects.toThrow(/did not come back/i);
    expect(execFileMock.mock.calls.some(([, args]) => (args as string[]).includes("--user"))).toBe(true);
    errorSpy.mockRestore();
  });

  it("does not probe at all on a Hermes device", async () => {
    // No gateway, no port, nothing to wait for — and a wait here would add 30 s
    // to every save on the one edition that has nothing to restart.
    const { restartGateway } = await load("hermes");
    await expect(restartGateway()).resolves.toBeUndefined();
    expect(waitForPortOpenMock).not.toHaveBeenCalled();
  });

  it("lets a caller that runs its own recovery wait opt out", async () => {
    // The updater restarts the gateway and then waits 45 s itself, reading the
    // journal when that fails so it can quarantine legacy state and retry. A
    // throw from here would skip that recovery entirely.
    const { restartGateway } = await load("openclaw");
    waitForPortOpenMock.mockResolvedValue(false);

    await expect(restartGateway({ awaitReady: false })).resolves.toBeUndefined();
    expect(waitForPortOpenMock).not.toHaveBeenCalled();
  });
});

/**
 * A restart that outlives its 60 s client (F2, 2026-10-15). On an x64 bridge
 * the bridge's ExecStop waits for OpenClaw's own drain (its user unit stops
 * within 330 s), so Node killed `sudo systemctl restart` at 60 s and the route
 * said "Command failed" over a restart systemd finished five minutes later.
 * A client killed by its own deadline is a job in flight: what it came to is
 * read off the unit, never off the port, where the old gateway still listens.
 */
describe("restartGateway when the restart outlives its client", () => {
  const timedOut = () =>
    Object.assign(new Error("Command failed: /usr/bin/sudo /usr/bin/systemctl restart clawbox-gateway.service"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });

  /** The restart is killed at its deadline; `show` answers from the list, last answer repeating. */
  function unitAnswers(answers: string[]) {
    let shown = 0;
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes("restart")) {
        cb(timedOut());
        return;
      }
      if (args.includes("show")) {
        const answer = answers[Math.min(shown, answers.length - 1)];
        shown += 1;
        cb(null, { stdout: answer, stderr: "" });
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });
  }

  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    waitForPortOpenMock.mockReset();
    waitForPortOpenMock.mockResolvedValue(true);
    spawnMock.mockReset();
    spawnMock.mockImplementation(fakeChild);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAWBOX_EDITION;
    delete process.env.CLAWBOX_EDITION_FILE;
  });

  async function load() {
    process.env.CLAWBOX_EDITION_FILE = "/nonexistent/edition.env";
    process.env.CLAWBOX_EDITION = "openclaw";
    return import("@/lib/openclaw-config");
  }

  it("waits for the job and resolves once the unit is active again", async () => {
    const { restartGateway } = await load();
    unitAnswers([
      "Job=4711\nActiveState=deactivating\nSubState=stop\nResult=success\n",
      "Job=4711\nActiveState=activating\nSubState=start\nResult=timeout\n",
      "Job=\nActiveState=active\nSubState=exited\nResult=success\n",
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const restarted = restartGateway();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(restarted).resolves.toBeUndefined();
    // The port is asked only after the job finished, never while the old one drained.
    expect(waitForPortOpenMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    log.mockRestore();
  });

  it("says in plain words when the job finished and the gateway did not come back", async () => {
    const { restartGateway, GatewayNotReadyError } = await load();
    unitAnswers(["Job=\nActiveState=failed\nSubState=failed\nResult=exit-code\n"]);
    const quiet = [vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(() => {}));
    const restarted = restartGateway();
    restarted.catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await restarted.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GatewayNotReadyError);
    expect((err as Error).message).toMatch(/did not start again/);
    expect((err as Error).message).toMatch(/failed \(failed, exit-code\)/);
    expect((err as Error).message).not.toMatch(/Command failed/);
    expect(waitForPortOpenMock).not.toHaveBeenCalled();
    quiet.forEach((s) => s.mockRestore());
  });

  it("reports a job still running at the budget as not back yet, not as a failure", async () => {
    const { restartGateway, GatewayNotReadyError } = await load();
    unitAnswers(["Job=4711\nActiveState=deactivating\nSubState=stop-sigterm\nResult=success\n"]);
    const quiet = [vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(() => {}));
    const restarted = restartGateway();
    restarted.catch(() => {});
    await vi.advanceTimersByTimeAsync(400_000);
    const err = await restarted.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayNotReadyError);
    expect((err as Error).message).toMatch(/still restarting/);
    quiet.forEach((s) => s.mockRestore());
  });

  it("answers a request in under the tunnel's ~100 s: still restarting after 30 s more by default", async () => {
    const { restartGateway, GatewayNotReadyError } = await load();
    unitAnswers(["Job=4711\nActiveState=deactivating\nSubState=stop-sigterm\nResult=success\n"]);
    const quiet = [vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(() => {}));
    let err: unknown = "pending";
    restartGateway().then(() => { err = null; }, (e: unknown) => { err = e; });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(err).toBeInstanceOf(GatewayNotReadyError);
    quiet.forEach((s) => s.mockRestore());
  });

  it("waits the whole stop-and-start budget for a caller nobody waits on", async () => {
    const { restartGateway } = await load();
    const answers = Array.from({ length: 50 }, () => "Job=4711\nActiveState=deactivating\nSubState=stop-sigterm\nResult=success\n");
    unitAnswers([...answers, "Job=\nActiveState=active\nSubState=exited\nResult=success\n"]);
    const quiet = [vi.spyOn(console, "warn"), vi.spyOn(console, "log")].map((s) => s.mockImplementation(() => {}));
    let settled = false;
    const restarted = restartGateway({ awaitReady: false, restartSettleMs: 360_000 }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(80_000);
    await expect(restarted).resolves.toBeUndefined();
    quiet.forEach((s) => s.mockRestore());
  });

  it("does not run doctor beside a gateway that is still stopping", async () => {
    const { runOpenclawDoctorFix } = await load();
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes("stop")) {
        cb(Object.assign(new Error("Command failed: sudo systemctl stop"), { killed: true, signal: "SIGTERM", code: null }));
        return;
      }
      if (args.includes("show")) {
        cb(null, { stdout: "Job=88\nActiveState=deactivating\nSubState=stop-sigterm\nResult=success\n", stderr: "" });
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixed = runOpenclawDoctorFix();
    fixed.catch(() => {});
    await vi.advanceTimersByTimeAsync(100_000);
    await expect(fixed).rejects.toThrow(/still stopping .*not run beside it/);
    quiet.mockRestore();
  });

  /** A stop that failed outright, and `show` answering `state`. */
  function failedStopThen(activeState: string) {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes("stop")) {
        cb(Object.assign(new Error("Job for clawbox-gateway.service canceled."), { code: 1 }));
        return;
      }
      if (args.includes("show")) {
        cb(null, { stdout: `Job=\nActiveState=${activeState}\nSubState=x\nResult=success\n`, stderr: "" });
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });
  }
  const doctorSpawned = () => spawnMock.mock.calls.some(([, argv]) => (argv as string[]).includes("doctor"));

  it("does not run doctor beside a gateway a cancelled stop left restarting", async () => {
    // Another surface's restart replaced the stop job: `systemctl stop` exits
    // 1, and the gateway is coming back up while doctor would migrate its state.
    const { runOpenclawDoctorFix } = await load();
    failedStopThen("activating");
    const fixed = runOpenclawDoctorFix();
    fixed.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(fixed).rejects.toThrow(/did not stop .*not run beside it/);
    expect(doctorSpawned()).toBe(false);
  });

  it("treats a failed stop over a unit still deactivating as still stopping", async () => {
    const { runOpenclawDoctorFix } = await load();
    failedStopThen("deactivating");
    const fixed = runOpenclawDoctorFix();
    fixed.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(fixed).rejects.toThrow(/still stopping .*not run beside it/);
    expect(doctorSpawned()).toBe(false);
  });

  it("runs doctor after a failed stop when the unit says it is down", async () => {
    // An older sudoers refusing the stop of a gateway that is already stopped
    // keeps the old leniency: the unit is asked, and inactive is down.
    const { runOpenclawDoctorFix } = await load();
    failedStopThen("inactive");
    const fixed = runOpenclawDoctorFix();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(fixed).resolves.toBe("completed");
    expect(doctorSpawned()).toBe(true);
  });

  it("still fails at once on a restart systemd refused", async () => {
    const { restartGateway } = await load();
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes("restart")) {
        cb(Object.assign(new Error("Job for clawbox-gateway.service failed because the control process exited with error code."), { code: 1 }));
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restartGateway()).rejects.toThrow(/control process exited/);
    expect(execFileMock.mock.calls.some(([, args]) => (args as string[]).includes("show"))).toBe(false);
    quiet.mockRestore();
  });
});
