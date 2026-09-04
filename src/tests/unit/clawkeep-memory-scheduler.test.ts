import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-398: the schedule has to survive a reboot and an update.
 *
 * It does that by being rebuilt from a file at every process start rather than
 * by existing as a crontab entry, so these tests boot the scheduler the way
 * `instrumentation.ts` does and assert what it armed.
 */

let tmpDir = "";

// The owner's switch, which the scheduler now reads on every re-arm and on
// every fire. Mocked rather than written to the config store: that store is a
// file under a root shared by every test in the worker, so a switch left
// behind here would decide another file's answer.
const { shard } = vi.hoisted(() => ({ shard: { enabled: true } }));
vi.mock("@/lib/memory-shard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory-shard")>(),
  getMemoryShardEnabled: async () => shard.enabled,
}));

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawkeep-memsched-"));
  process.env.CLAWKEEP_DATA_DIR = tmpDir;
  shard.enabled = true;
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-22T05:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.CLAWKEEP_DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSchedule(schedule: unknown) {
  await fs.writeFile(path.join(tmpDir, "memory-index-schedule.json"), JSON.stringify(schedule));
}

describe("the memory index scheduler", () => {
  it("arms nothing when the schedule is off", async () => {
    await writeSchedule({ enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();
    expect(sched.nextRunAtMs()).toBe(0);
  });

  it("arms nothing when there is no schedule file at all — a fresh box", async () => {
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();
    expect(sched.nextRunAtMs()).toBe(0);
  });

  it("rebuilds the armed slot from the file, which is what makes it survive a reboot", async () => {
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();
    const armed = sched.nextRunAtMs();
    expect(armed).toBeGreaterThan(Date.now());
    expect(new Date(armed).getHours()).toBe(3);

    // "Reboot": a second process start reads the same file and lands on the
    // same slot. Nothing is duplicated and nothing is lost.
    await sched.start();
    expect(sched.nextRunAtMs()).toBe(armed);
  });

  it("re-arms from the new file when the user saves a different time", async () => {
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();
    const first = sched.nextRunAtMs();

    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "06:30", weekday: 0 });
    await sched.refresh();
    expect(sched.nextRunAtMs()).not.toBe(first);
    expect(new Date(sched.nextRunAtMs()).getHours()).toBe(6);
  });

  it("disarms when the user turns it off, rather than leaving a timer behind", async () => {
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();
    expect(sched.nextRunAtMs()).toBeGreaterThan(0);

    await writeSchedule({ enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    await sched.refresh();
    expect(sched.nextRunAtMs()).toBe(0);
  });

  it("arms nothing while Memory Shard is switched off, whatever the schedule file says", async () => {
    // The switch is the owner's consent for this box to spend its night
    // embedding their documents. A saved schedule under a switched-off shard
    // used to arm a timer anyway — an "off" that kept indexing.
    shard.enabled = false;
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();
    expect(sched.nextRunAtMs()).toBe(0);
  });

  it("arms the schedule the owner had saved when the switch goes back on", async () => {
    shard.enabled = false;
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();
    expect(sched.nextRunAtMs()).toBe(0);

    // What the enable route does after writing the switch: the hour the owner
    // chose comes back, rather than waiting for the next reboot.
    shard.enabled = true;
    await sched.refresh();
    expect(new Date(sched.nextRunAtMs()).getHours()).toBe(3);
  });

  it("stands down for a slot armed before the switch was turned off", async () => {
    // The timer is set hours ahead of the slot, so the state that matters is
    // the one at the moment it fires — not the one it was armed with.
    const startMemoryIndex = vi.fn(async () => ({ accepted: true, run: {} as never }));
    vi.doMock("@/lib/updater", () => ({ updateInFlight: vi.fn(async () => false) }));
    vi.doMock("@/lib/clawkeep-memory", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep-memory")>("@/lib/clawkeep-memory");
      return { ...actual, startMemoryIndex };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "06:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();

    shard.enabled = false;
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(startMemoryIndex).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Memory Shard is switched off"));
    // And nothing is armed for tomorrow either, so the panel cannot print a
    // next run for a box that is not going to index.
    await vi.waitFor(() => { expect(sched.nextRunAtMs()).toBe(0); });
    log.mockRestore();
  });

  it("runs an incremental pass when the slot arrives, never a full reindex", async () => {
    // A scheduled run must not spend hours re-embedding everything unattended.
    // `startMemoryIndex` is stubbed rather than exercised here: it shells out
    // to the OpenClaw CLI, and under fake timers that promise would never
    // settle. The empty-index upgrade it applies to the request is covered in
    // clawkeep-memory.test.ts.
    const startMemoryIndex = vi.fn(async () => ({ accepted: true, run: {} as never }));
    vi.doMock("@/lib/updater", () => ({ updateInFlight: vi.fn(async () => false) }));
    vi.doMock("@/lib/clawkeep-memory", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep-memory")>("@/lib/clawkeep-memory");
      return { ...actual, startMemoryIndex };
    });
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "06:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    // The schedule asks for an incremental pass through the same call the
    // button makes — so the button and the schedule can never disagree.
    expect(startMemoryIndex).toHaveBeenCalledWith("incremental", "schedule");
  });

  it("leaves a manual run alone when the slot lands on it, and says so in the log", async () => {
    // The decline is startMemoryIndex's; the scheduler's job is to not paper
    // over it. Before this line existed a declined slot left no trace at all
    // — the card showed the manual run, the journal showed nothing.
    const startMemoryIndex = vi.fn(async () => ({ accepted: false, run: { status: "running" } as never }));
    vi.doMock("@/lib/updater", () => ({ updateInFlight: vi.fn(async () => false) }));
    vi.doMock("@/lib/clawkeep-memory", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep-memory")>("@/lib/clawkeep-memory");
      return { ...actual, startMemoryIndex };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "06:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(startMemoryIndex).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped: an index run is in progress"));
    log.mockRestore();
  });

  it("tells the log apart a busy box from a switch that went off under the slot", async () => {
    // startMemoryIndex reads the owner's switch inside its own lock, because
    // the reading the slot made minutes earlier is not the one that should
    // decide. When that late reading is what refuses, the journal must not
    // report a run in progress that nobody started.
    const startMemoryIndex = vi.fn(async () => ({
      accepted: false, declined: "disabled" as const, run: { status: "idle" } as never,
    }));
    vi.doMock("@/lib/updater", () => ({ updateInFlight: vi.fn(async () => false) }));
    vi.doMock("@/lib/clawkeep-memory", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep-memory")>("@/lib/clawkeep-memory");
      return { ...actual, startMemoryIndex };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "06:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("switched off before the run started"));
    log.mockRestore();
  });

  it("stands down for the slot while an update is in flight, and re-arms", async () => {
    // post_update repairs the OpenClaw store with the gateway masked so there
    // is one writer; `openclaw memory index` would be a second. A slot that
    // lands inside an update is skipped — one missed incremental pass costs
    // nothing — and the next slot is armed as usual.
    const startMemoryIndex = vi.fn(async () => ({ accepted: true, run: {} as never }));
    const updateInFlight = vi.fn(async () => true);
    vi.doMock("@/lib/updater", () => ({ updateInFlight }));
    vi.doMock("@/lib/clawkeep-memory", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep-memory")>("@/lib/clawkeep-memory");
      return { ...actual, startMemoryIndex };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "06:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(updateInFlight).toHaveBeenCalledTimes(1);
    expect(startMemoryIndex).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped: an update is in progress"));
    // Tomorrow's slot, not nothing (the re-arm re-reads the schedule file).
    await vi.waitFor(() => {
      expect(sched.nextRunAtMs()).toBe(new Date("2026-08-23T06:00:00").getTime());
    });
    log.mockRestore();
  });
});
