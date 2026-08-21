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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawkeep-memsched-"));
  process.env.CLAWKEEP_DATA_DIR = tmpDir;
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

  it("runs an incremental pass when the slot arrives, never a full reindex", async () => {
    // A scheduled run must not spend hours re-embedding everything unattended.
    // `resolveIndexMode` is stubbed rather than exercised here: it shells out
    // to the OpenClaw CLI, and under fake timers that promise would never
    // settle. Its own rule is covered in clawkeep-memory.test.ts.
    const startMemoryIndex = vi.fn(async () => ({ accepted: true, run: {} as never }));
    const resolveIndexMode = vi.fn(async (m: string) => m);
    vi.doMock("@/lib/clawkeep-memory", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep-memory")>("@/lib/clawkeep-memory");
      return { ...actual, startMemoryIndex, resolveIndexMode };
    });
    await writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "06:00", weekday: 0 });
    const sched = await import("@/lib/clawkeep-memory-scheduler");
    await sched.start();

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    // The schedule asks for an incremental pass and runs whatever the shared
    // rule resolves — so the button and the schedule can never disagree.
    expect(resolveIndexMode).toHaveBeenCalledWith("incremental");
    expect(startMemoryIndex).toHaveBeenCalledWith("incremental", "schedule");
  });
});
