import { describe, expect, it, vi, beforeEach } from "vitest";
import * as childProcess from "child_process";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

import {
  describeStillStarting,
  formatWaited,
  gatewayStartPhase,
  readGatewayStartState,
  waitForGatewayStart,
  type GatewayStartState,
  type GatewayStartWaitOptions,
} from "@/lib/gateway-start-wait";

const mockExecFile = vi.mocked(childProcess.execFile);

function unit(activeState: string, subState: string, extra: Partial<GatewayStartState> = {}): GatewayStartState {
  return { activeState, subState, result: "success", job: "", restarts: 0, ...extra };
}

/**
 * A clock that only moves when the wait waits: every port window and every
 * sleep advances it by exactly what was asked, so a ten-minute start runs in
 * microseconds and every timing assertion is exact.
 */
function harness(script: {
  /** Whether the port answers, given how long the wait has run. */
  listeningAt?: (elapsedMs: number) => boolean;
  /** What systemd says on the n-th read (0-based). */
  states: (read: number, elapsedMs: number) => GatewayStartState | null;
}) {
  let clock = 0;
  const windows: number[] = [];
  const reads: number[] = [];
  const progress: Array<{ state: GatewayStartState | null; waitedMs: number }> = [];
  const options: GatewayStartWaitOptions = {
    firstWindowMs: 45_000,
    limitMs: 600_000,
    pollMs: 5_000,
    maxPollMs: 15_000,
    unknownIsStarting: true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    waitForPort: async (ms) => {
      windows.push(ms);
      // The port opens part-way through a window: the probe answers then.
      for (let t = 0; t < ms; t += 500) {
        if (script.listeningAt?.(clock + t)) {
          clock += t;
          return true;
        }
      }
      clock += ms;
      return script.listeningAt?.(clock) ?? false;
    },
    readState: async () => {
      reads.push(clock);
      return script.states(reads.length - 1, clock);
    },
    onStillStarting: (state, waitedMs) => progress.push({ state, waitedMs }),
  };
  return { options, windows, reads, progress, elapsed: () => clock };
}

describe("waitForGatewayStart", () => {
  it("answers a gateway that listens inside the first window without asking systemd", async () => {
    const h = harness({ listeningAt: (t) => t >= 10_000, states: () => unit("active", "running") });
    const verdict = await waitForGatewayStart(h.options);
    expect(verdict).toEqual({ kind: "listening", waitedMs: 10_000 });
    expect(h.reads).toHaveLength(0);
    expect(h.progress).toHaveLength(0);
  });

  it("waits out a slow start past the old window while systemd says it is starting", async () => {
    // The field case: pre-start for 90 s, then the process up and loading its
    // databases until 4 min — far past the 45 s the update used to allow.
    const h = harness({
      listeningAt: (t) => t >= 240_000,
      states: (_read, t) => (t < 90_000 ? unit("activating", "start-pre") : unit("active", "running")),
    });
    const verdict = await waitForGatewayStart(h.options);
    expect(verdict.kind).toBe("listening");
    // Noticed within the probe's own half-second step of the port opening.
    expect(verdict.waitedMs).toBeGreaterThanOrEqual(240_000);
    expect(verdict.waitedMs).toBeLessThan(240_500);
    // Said on every round, and it said what systemd was doing at the time.
    expect(h.progress.length).toBe(h.reads.length);
    expect(h.progress[0].state?.subState).toBe("start-pre");
    expect(h.progress.at(-1)?.state?.activeState).toBe("active");
  });

  it("asks systemd at a backing-off interval, capped", async () => {
    const h = harness({ listeningAt: (t) => t >= 120_000, states: () => unit("active", "running") });
    await waitForGatewayStart(h.options);
    expect(h.windows.slice(0, 6)).toEqual([45_000, 5_000, 7_500, 11_250, 15_000, 15_000]);
  });

  it("fails at once on a failed unit, long before the limit, and only on a second read", async () => {
    const h = harness({ states: () => unit("failed", "failed", { result: "exit-code" }) });
    const verdict = await waitForGatewayStart(h.options);
    expect(verdict).toMatchObject({ kind: "failed", reason: "unit-failed" });
    expect(h.reads).toHaveLength(2);
    expect(verdict.waitedMs).toBe(50_000);
    // A failed unit is never shown as one still starting.
    expect(h.progress).toHaveLength(0);
  });

  it("does not take one failed read between two transitions for a verdict", async () => {
    const h = harness({
      listeningAt: (t) => t >= 70_000,
      states: (read) => (read === 0 ? unit("failed", "failed") : unit("activating", "start-pre")),
    });
    expect((await waitForGatewayStart(h.options)).kind).toBe("listening");
  });

  it("fails on a unit that stopped with nothing queued to start it", async () => {
    const h = harness({ states: () => unit("inactive", "dead") });
    expect(await waitForGatewayStart(h.options)).toMatchObject({ kind: "failed", reason: "unit-stopped" });
  });

  it("counts an inactive unit with a start job queued as starting", async () => {
    const h = harness({
      listeningAt: (t) => t >= 80_000,
      states: (read) => (read < 3 ? unit("inactive", "dead", { job: "1234" }) : unit("active", "running")),
    });
    expect((await waitForGatewayStart(h.options)).kind).toBe("listening");
  });

  it("calls a unit systemd keeps restarting a crash loop, without waiting for the limit", async () => {
    const h = harness({ states: (read) => unit("activating", "auto-restart", { restarts: 4 + read }) });
    const verdict = await waitForGatewayStart(h.options);
    // Counted from the first answer: four restarts before the wait are not its.
    expect(verdict).toMatchObject({ kind: "failed", reason: "crash-loop", restarts: 3 });
    expect(h.reads).toHaveLength(4);
  });

  it("keeps counting across a reset of systemd's restart counter", async () => {
    // 5 -> 6 is one; the drop to 0 is a manual start resetting it; 0 -> 2 is two more.
    const counts = [5, 6, 0, 1, 2];
    const h = harness({ states: (read) => unit("activating", "auto-restart", { restarts: counts[read] ?? 2 }) });
    expect(await waitForGatewayStart(h.options)).toMatchObject({ kind: "failed", reason: "crash-loop", restarts: 3 });
  });

  it("is not fooled by one restart of a gateway that then comes up", async () => {
    // OpenClaw restarts itself once by exiting (supervisor restart).
    const h = harness({
      listeningAt: (t) => t >= 150_000,
      states: (read) => unit("active", "running", { restarts: read < 2 ? 0 : 1 }),
    });
    expect((await waitForGatewayStart(h.options)).kind).toBe("listening");
  });

  it("gives up at the limit, never past it, and says where the unit stood", async () => {
    const h = harness({ states: () => unit("active", "running") });
    const verdict = await waitForGatewayStart(h.options);
    expect(verdict.kind).toBe("timed-out");
    expect(verdict.waitedMs).toBe(600_000);
    expect(verdict).toMatchObject({ state: { activeState: "active", subState: "running" } });
  });

  it("waits on a unit it cannot see after a restart it made", async () => {
    const h = harness({ listeningAt: (t) => t >= 200_000, states: () => null });
    expect((await waitForGatewayStart(h.options)).kind).toBe("listening");
    expect(h.progress[0]).toEqual({ state: null, waitedMs: 45_000 });
  });

  it("does not wait on a guess before any restart: unconfirmed right after the first window", async () => {
    const h = harness({ states: () => null });
    const verdict = await waitForGatewayStart({ ...h.options, firstWindowMs: 30_000, unknownIsStarting: false });
    expect(verdict).toMatchObject({ kind: "failed", reason: "unconfirmed", waitedMs: 30_000 });
    expect(h.reads).toHaveLength(1);
  });

  it("lasts its rounds even when the probe answers 'closed' at once", async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const verdict = await waitForGatewayStart({
      firstWindowMs: 1_000,
      limitMs: 20_000,
      pollMs: 5_000,
      maxPollMs: 5_000,
      unknownIsStarting: true,
      now: () => clock,
      sleep,
      waitForPort: async () => false,
      readState: async () => unit("active", "running"),
    });
    // The last round is cut to what is left of the limit, never run past it.
    expect(verdict).toMatchObject({ kind: "timed-out", waitedMs: 20_000 });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 5_000, 5_000, 5_000, 4_000]);
  });

  it("stays bounded, and never spins, when its numbers are not numbers", async () => {
    // What `Number("abc")` makes of an unparsable env override.
    let clock = 0;
    const readState = vi.fn(async () => unit("active", "running"));
    const verdict = await waitForGatewayStart({
      firstWindowMs: 1_000,
      limitMs: Number.NaN,
      pollMs: Number.NaN,
      maxPollMs: Number.NaN,
      unknownIsStarting: true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      waitForPort: async () => false,
      readState,
    });
    // No limit is no extension: the first window, one look at the unit, done.
    expect(verdict).toMatchObject({ kind: "timed-out", waitedMs: 1_000 });
    expect(readState).toHaveBeenCalledTimes(1);

    clock = 0;
    readState.mockClear();
    const sleeps: number[] = [];
    await waitForGatewayStart({
      firstWindowMs: 1_000,
      limitMs: 60_000,
      pollMs: Number.NaN,
      maxPollMs: Number.NaN,
      unknownIsStarting: true,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      waitForPort: async () => false,
      readState,
    });
    // The default gaps, each a real wait: 5 s growing to 15 s.
    expect(sleeps.slice(0, 5)).toEqual([1_000, 5_000, 7_500, 11_250, 15_000]);
    expect(readState.mock.calls.length).toBeLessThan(10);
  });
});

describe("gatewayStartPhase", () => {
  it.each([
    [unit("activating", "start-pre"), "starting"],
    [unit("activating", "auto-restart"), "starting"],
    [unit("active", "running"), "starting"],
    [unit("deactivating", "stop-sigterm"), "starting"],
    [unit("inactive", "dead", { job: "77" }), "starting"],
    [unit("inactive", "dead"), "stopped"],
    [unit("failed", "failed"), "failed"],
    [null, "unknown"],
  ] as const)("%o is %s", (state, phase) => {
    expect(gatewayStartPhase(state)).toBe(phase);
  });
});

describe("the words the update screen shows", () => {
  it("formats how long it has waited", () => {
    expect(formatWaited(45_400)).toBe("45 s");
    expect(formatWaited(120_000)).toBe("2 min");
    expect(formatWaited(95_000)).toBe("1 min 35 s");
  });

  it("says what the gateway is doing while it starts", () => {
    expect(describeStillStarting(unit("activating", "start-pre"), 60_000))
      .toBe("Gateway still starting: running its start-up checks (1 min so far)");
    expect(describeStillStarting(unit("active", "running"), 125_000))
      .toBe("Gateway still starting: loading its data, large memory databases take a few minutes (2 min 5 s so far)");
    expect(describeStillStarting(unit("activating", "auto-restart"), 50_000)).toContain("restarting");
    expect(describeStillStarting(unit("deactivating", "stop-sigterm"), 50_000)).toContain("previous one to stop");
    expect(describeStillStarting(null, 50_000)).toBe("Gateway still starting: waiting for it to answer (50 s so far)");
  });
});

describe("readGatewayStartState", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  function answer(stdout: string | Error) {
    mockExecFile.mockImplementation(((...call: unknown[]) => {
      const cb = call.at(-1) as (e: Error | null, r?: unknown) => void;
      if (stdout instanceof Error) cb(stdout);
      else cb(null, { stdout, stderr: "" });
    }) as never);
  }

  it("reads the state, job and restart counter in one systemctl show", async () => {
    answer("ActiveState=activating\nSubState=start-pre\nResult=success\nJob=4021\nNRestarts=2\n");
    expect(await readGatewayStartState("clawbox-gateway.service")).toEqual({
      activeState: "activating",
      subState: "start-pre",
      result: "success",
      job: "4021",
      restarts: 2,
    });
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe("/usr/bin/systemctl");
    expect(args).toEqual([
      "show", "clawbox-gateway.service",
      "-p", "ActiveState", "-p", "SubState", "-p", "Result", "-p", "Job", "-p", "NRestarts",
      "--no-pager",
    ]);
  });

  it("leaves the counter unknown on a systemd that does not report one", async () => {
    answer("ActiveState=active\nSubState=running\nResult=success\nJob=\n");
    expect(await readGatewayStartState("clawbox-gateway.service")).toMatchObject({ restarts: null, job: "" });
  });

  it("answers null when systemctl could not be asked or said nothing", async () => {
    answer(new Error("Failed to connect to bus"));
    expect(await readGatewayStartState("clawbox-gateway.service")).toBeNull();
    answer("");
    expect(await readGatewayStartState("clawbox-gateway.service")).toBeNull();
  });
});
