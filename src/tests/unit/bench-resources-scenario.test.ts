import { describe, expect, it } from "vitest";
import { run } from "../../../scripts/bench/scenarios/resources.mjs";
import { scoreArea } from "../../../scripts/bench/lib/score.mjs";

// The resources scenario (scripts/bench/scenarios/resources.mjs) reads the
// services' disk writes from /proc/<pid>/io through scripts/bench/lib/host.mjs.
// A kernel without per-task I/O accounting (the Jetson L4T kernel) or a
// service that restarted mid-bench gives writeBytesPerSec null; that is "not
// measured", never "wrote nothing", so the metric must stay null (unscored)
// instead of scoring a perfect 0 MB/min.

const MB = 1_048_576;

function fakeHost(webWrite: number | null, gwWrite: number | null) {
  return {
    snapshot: () => ({ system: { memTotalKb: 8_000_000 }, web: { pid: 1 }, gateway: { pid: 2 } }),
    delta: () => ({
      web: { cpuPct: 1, rssKb: 200_000, writeBytesPerSec: webWrite },
      gateway: { cpuPct: 2, rssKb: 1_000_000, writeBytesPerSec: gwWrite },
      system: { memAvailableKb: 4_000_000 },
    }),
  };
}

const scenario = (webWrite: number | null, gwWrite: number | null) =>
  run({ host: fakeHost(webWrite, gwWrite), hostStart: undefined, log: () => {} });

describe("resources scenario: disk_write_mb_min", () => {
  it("is null, not 0, when neither service's writes could be read", async () => {
    // A null reaching the log line's .toFixed would reject the whole scenario.
    const pending = scenario(null, null);
    await expect(pending).resolves.toBeDefined();
    const { metrics } = await pending;
    expect(metrics.disk_write_mb_min.value).toBeNull();
    expect(typeof scoreArea(metrics)).toBe("number");
  });

  it("is null when only the gateway's writes could not be read", async () => {
    const { metrics } = await scenario(MB / 60, null);
    expect(metrics.disk_write_mb_min.value).toBeNull();
  });

  it("sums both services in MB/min when both readings exist", async () => {
    const { metrics } = await scenario(MB / 60, (2 * MB) / 60);
    expect(metrics.disk_write_mb_min.value).toBe(3);
  });
});
