import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";

vi.mock("fs");
vi.mock("os");

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

let cpuUsage: typeof import("@/lib/cpu-usage");

/** `cpu user nice system idle …` — only fields 1-4 matter to the sampler. */
function procStat(user: number, idle: number): string {
  return `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n`;
}

beforeEach(async () => {
  vi.resetModules();
  mockOs.cpus.mockReturnValue([{} as os.CpuInfo, {} as os.CpuInfo, {} as os.CpuInfo, {} as os.CpuInfo]);
  mockOs.loadavg.mockReturnValue([1.0, 1.0, 1.0]);
  cpuUsage = await import("@/lib/cpu-usage");
});

describe("getCpuUsage — no per-request sleep (TASK-456)", () => {
  // The bug: the stats route read /proc/stat, `await`ed a 200 ms timer, then
  // read it again. That put a hard ~209 ms floor under every
  // /setup-api/system/stats response — measured live, 5 requests, 208-211 ms —
  // on an endpoint polled every 3 s. This test fails on that implementation.
  it("returns synchronously fast and reads /proc/stat exactly once per call", () => {
    mockFs.readFileSync.mockReturnValue(procStat(100, 900));

    const startedAt = Date.now();
    cpuUsage.getCpuUsage();
    cpuUsage.getCpuUsage();
    const elapsed = Date.now() - startedAt;

    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(mockFs.readFileSync).toHaveBeenCalledWith("/proc/stat", "utf-8");
    // Two calls of the OLD implementation could not finish under 400 ms.
    expect(elapsed).toBeLessThan(100);
  });

  it("diffs the second call against the cached first sample", () => {
    // 1000 -> 1100 total (+100), idle 900 -> 950 (+50) = 50% busy.
    mockFs.readFileSync
      .mockReturnValueOnce(procStat(100, 900))
      .mockReturnValueOnce(procStat(150, 950));

    // No prior sample: falls back to the load-average approximation
    // (loadavg 1.0 over 4 cores = 25%), same as the old code's error path.
    expect(cpuUsage.getCpuUsage(1_000)).toBe(25);
    expect(cpuUsage.getCpuUsage(4_000)).toBe(50);
  });

  it("averages over the caller's real poll interval, not a 200 ms window", () => {
    mockFs.readFileSync
      .mockReturnValueOnce(procStat(0, 1000))
      .mockReturnValueOnce(procStat(300, 1000)); // +300 busy, +0 idle = 100%

    cpuUsage.getCpuUsage(1_000);
    expect(cpuUsage.getCpuUsage(4_000)).toBe(100);
  });

  it("re-uses the previous figure when two calls land in the same jiffy", () => {
    mockFs.readFileSync
      .mockReturnValueOnce(procStat(100, 900))
      .mockReturnValueOnce(procStat(150, 950))
      .mockReturnValueOnce(procStat(150, 950)); // identical — dTotal === 0

    cpuUsage.getCpuUsage(1_000);
    expect(cpuUsage.getCpuUsage(4_000)).toBe(50);
    expect(cpuUsage.getCpuUsage(4_010)).toBe(50);
  });

  it("ignores a stale sample rather than averaging over minutes", () => {
    mockFs.readFileSync
      .mockReturnValueOnce(procStat(0, 1000))
      .mockReturnValueOnce(procStat(1000, 1000));

    cpuUsage.getCpuUsage(1_000);
    // 5 minutes later: the delta is real arithmetic but it is not "now".
    expect(cpuUsage.getCpuUsage(301_000)).toBe(25); // loadavg fallback
  });

  it("falls back to the load average when /proc/stat is unreadable", () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });
    mockOs.loadavg.mockReturnValue([2.0, 1.5, 1.0]); // 2.0 / 4 cores

    expect(cpuUsage.getCpuUsage()).toBe(50);
  });

  it("does not treat a truncated /proc/stat as a busy CPU", () => {
    // A short line has no idle field. Reading parts[3] as `undefined` used to
    // make idle NaN; clamping that to 0 would report 100% busy forever.
    mockFs.readFileSync.mockReturnValue("cpu  100 200\n");
    expect(cpuUsage.getCpuUsage()).toBe(25); // loadavg fallback, not 100
  });

  it("survives a counter that goes backwards", () => {
    mockFs.readFileSync
      .mockReturnValueOnce(procStat(500, 5000))
      .mockReturnValueOnce(procStat(10, 20)); // rollover / re-read

    cpuUsage.getCpuUsage(1_000);
    expect(cpuUsage.getCpuUsage(4_000)).toBe(25); // loadavg fallback, not negative
  });

  it("clamps to 0-100", () => {
    mockFs.readFileSync
      .mockReturnValueOnce(procStat(0, 1000))
      .mockReturnValueOnce(procStat(0, 1100)); // all idle

    cpuUsage.getCpuUsage(1_000);
    const usage = cpuUsage.getCpuUsage(4_000);
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(usage).toBeLessThanOrEqual(100);
    expect(usage).toBe(0);
  });

  it("__resetCpuUsageCache drops the cached sample", () => {
    mockFs.readFileSync
      .mockReturnValueOnce(procStat(100, 900))
      .mockReturnValueOnce(procStat(150, 950));

    cpuUsage.getCpuUsage(1_000);
    cpuUsage.__resetCpuUsageCache();
    expect(cpuUsage.getCpuUsage(4_000)).toBe(25); // cold again -> loadavg
  });
});

describe("parseProcStat", () => {
  it("sums every field into total and picks idle from field 4", () => {
    const sample = cpuUsage.parseProcStat("cpu  1 2 3 4 5 6\n", 42);
    expect(sample).toEqual({ idle: 4, total: 21, at: 42 });
  });

  it("rejects a line that is not /proc/stat", () => {
    expect(cpuUsage.parseProcStat("intr 1 2 3 4\n", 0)).toBeNull();
    expect(cpuUsage.parseProcStat("", 0)).toBeNull();
    expect(cpuUsage.parseProcStat("cpu  a b c d\n", 0)).toBeNull();
  });
});

/**
 * Per-core usage, for the htop-style bars on Settings → System.
 *
 * Same file, same delta discipline and the same read as the aggregate figure —
 * so the thing worth pinning is not the arithmetic but the honesty: a core that
 * has not been measured yet, or whose counters went backwards over a suspend,
 * must not be drawn as an idle one.
 */
describe("getCpuCoreUsage", () => {
  /** Four cores, each with its own user/idle pair, under the aggregate line. */
  function cores(pairs: [number, number][]): string {
    const total = pairs.reduce((a, [u, i]) => [a[0] + u, a[1] + i] as [number, number], [0, 0]);
    return [
      `cpu  ${total[0]} 0 0 ${total[1]} 0 0 0 0 0 0`,
      ...pairs.map(([user, idle], n) => `cpu${n} ${user} 0 0 ${idle} 0 0 0 0 0 0`),
      "intr 12345",
      "",
    ].join("\n");
  }

  it("reads one figure per core out of the same /proc/stat", () => {
    mockFs.readFileSync.mockReturnValue(cores([[100, 900], [100, 900], [100, 900], [100, 900]]));
    cpuUsage.getCpuCoreUsage();
    // core 0 busy, core 1 idle, cores 2-3 half.
    mockFs.readFileSync.mockReturnValue(cores([[200, 900], [100, 1000], [150, 950], [150, 950]]));
    expect(cpuUsage.getCpuCoreUsage()).toEqual([100, 0, 50, 50]);
  });

  it("answers nothing at all when /proc/stat cannot be read", () => {
    // Not a row of zeros: an empty list is "no reading", and a row of zeros
    // would be a claim that every core on the box is idle.
    mockFs.readFileSync.mockImplementation(() => { throw new Error("EACCES"); });
    expect(cpuUsage.getCpuCoreUsage()).toEqual([]);
  });

  it("keeps the last real figures when the counters go backwards", () => {
    mockFs.readFileSync.mockReturnValue(cores([[100, 900], [100, 900]]));
    cpuUsage.getCpuCoreUsage();
    mockFs.readFileSync.mockReturnValue(cores([[200, 900], [100, 1000]]));
    expect(cpuUsage.getCpuCoreUsage()).toEqual([100, 0]);
    // A suspend/rollover rewinds the counters; the previous answer stands
    // rather than a fabricated 0%.
    mockFs.readFileSync.mockReturnValue(cores([[10, 90], [10, 90]]));
    expect(cpuUsage.getCpuCoreUsage()).toEqual([100, 0]);
  });

  it("starts over when the core count changes under it", () => {
    mockFs.readFileSync.mockReturnValue(cores([[100, 900], [100, 900]]));
    cpuUsage.getCpuCoreUsage();
    // A hotplug leaves nothing comparable; the next call is the one with a
    // real figure, and this one must not diff core 2 against core 1's history.
    mockFs.readFileSync.mockReturnValue(cores([[200, 900], [100, 1000], [100, 1000]]));
    expect(cpuUsage.getCpuCoreUsage()).toEqual([0, 0, 0]);
  });

  it("skips a core line it cannot parse rather than calling it idle", () => {
    mockFs.readFileSync.mockReturnValue("cpu  100 0 0 900 0\ncpu0 1 2\ncpu1 100 0 0 900 0\n");
    expect(cpuUsage.parseProcStatCores("cpu  1 0 0 1\ncpu0 1 2\ncpu1 100 0 0 900\n", 1_000))
      .toEqual([null, { idle: 900, total: 1000, at: 1_000 }]);
  });
});
