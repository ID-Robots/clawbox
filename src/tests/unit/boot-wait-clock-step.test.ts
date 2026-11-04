import * as childProcess from "child_process";
import net from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForGatewayStart, type GatewayStartState } from "@/lib/gateway-start-wait";
import { waitForUnitJob } from "@/lib/gateway-unit-job";
import { withOpenclawMaintenanceRetry } from "@/lib/openclaw-maintenance";
import { waitForPortOpen } from "@/lib/port-probe";

/**
 * The waits a box runs while it boots, across the step of its wall clock.
 *
 * The box has no battery-backed RTC: after a cold boot it runs on the clock it
 * saved at shutdown until timesyncd steps it forward, half a day after a night
 * off, in the same minute the update's second half and the gateway's start are
 * being waited for. A deadline taken on the wall clock before that step has
 * passed the moment after it, and the wait ends as a timeout over a start that
 * was going fine. These budgets mirror systemd's own, which it counts on a
 * monotonic clock; so must they. Here only `Date.now()` steps, as on the box.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));
const mockExecFile = vi.mocked(childProcess.execFile);

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
let wallClockStep = 0;

beforeEach(() => {
  wallClockStep = 0;
  const realNow = Date.now;
  vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + wallClockStep);
});

describe("waitForGatewayStart", () => {
  it("keeps waiting for a gateway still in its pre-start when the wall clock steps forward", async () => {
    const starting: GatewayStartState = { activeState: "activating", subState: "start-pre", result: "", job: "", restarts: 0 };
    let reads = 0;
    const verdict = await waitForGatewayStart({
      waitForPort: async () => reads >= 2,
      readState: async () => {
        reads += 1;
        if (reads === 1) wallClockStep = TWELVE_HOURS_MS;
        return starting;
      },
      firstWindowMs: 10,
      limitMs: 60_000,
      pollMs: 1,
      maxPollMs: 1,
      unknownIsStarting: true,
      sleep: async () => {},
    });
    expect(verdict.kind).toBe("listening");
    expect(reads).toBe(2);
  });
});

describe("waitForUnitJob", () => {
  it("waits a restart job out when the wall clock steps forward while it is pending", async () => {
    let shows = 0;
    mockExecFile.mockImplementation(((
      _cmd: string,
      _args: string[],
      optsOrCallback?: unknown,
      maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = (typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback) as
        (error: Error | null, result: { stdout: string; stderr: string }) => void;
      shows += 1;
      if (shows === 1) wallClockStep = TWELVE_HOURS_MS;
      const stdout = shows === 1
        ? "Job=77\nActiveState=activating\nSubState=start-pre\nResult=success\n"
        : "Job=\nActiveState=active\nSubState=running\nResult=success\n";
      callback?.(null, { stdout, stderr: "" });
      return undefined as unknown as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile);

    const outcome = await waitForUnitJob({ unit: "clawbox-gateway.service", timeoutMs: 1_000, settleBudgetMs: 60_000, pollMs: 1 });
    expect(outcome.kind).toBe("settled");
    expect(shows).toBe(2);
  });
});

describe("withOpenclawMaintenanceRetry", () => {
  it("asks again with what is really left of the budget when the wall clock stepped during the refused ask", async () => {
    // The updater's quiesced repair at boot (`doctor --fix`, `config validate`)
    // goes through this. On the wall clock the step either ended the window at
    // once or handed the next ask 1 ms, a kill over a command never given time.
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const given: number[] = [];
    const answer = await withOpenclawMaintenanceRetry(async (timeoutMs) => {
      given.push(timeoutMs);
      if (given.length === 1) {
        wallClockStep = TWELVE_HOURS_MS;
        throw Object.assign(new Error("Command failed"), {
          stderr: "OpenClaw state is undergoing offline maintenance; retry when it finishes.",
        });
      }
      return "valid";
    }, { timeoutMs: 60_000, label: "config validate", pauseMs: 1 });
    expect(answer).toBe("valid");
    expect(given).toHaveLength(2);
    expect(given[1]).toBeGreaterThan(50_000);
    quiet.mockRestore();
  });
});

describe("waitForPortOpen", () => {
  let server: net.Server | null = null;
  const listen = (port = 0): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer();
    server = s;
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port));
  });
  const close = (): Promise<void> => new Promise((resolve) => {
    const s = server;
    server = null;
    if (!s) return resolve();
    s.close(() => resolve());
  });
  afterEach(close);

  it("keeps probing when the wall clock steps forward before the port opens", async () => {
    const port = await listen();
    await close();
    setTimeout(() => { wallClockStep = TWELVE_HOURS_MS; }, 30);
    setTimeout(() => void listen(port), 150);
    expect(await waitForPortOpen(port, "127.0.0.1", { timeoutMs: 3_000, intervalMs: 20, probeTimeoutMs: 200 })).toBe(true);
  });
});
