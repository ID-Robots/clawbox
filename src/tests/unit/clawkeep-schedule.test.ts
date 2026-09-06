import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SCHEDULE as actualDefaultSchedule, computeNextRunMs, type ClawKeepSchedule } from "@/lib/clawkeep";

const baseSchedule: ClawKeepSchedule = {
  enabled: true,
  frequency: "daily",
  timeOfDay: "02:00",
  weekday: 0,
  retentionKeepLast: 10,
};

describe("computeNextRunMs", () => {
  it("returns 0 when the schedule is disabled", () => {
    const now = new Date("2026-04-29T12:00:00");
    expect(computeNextRunMs({ ...baseSchedule, enabled: false }, now)).toBe(0);
  });

  it("daily: picks today's slot when it's still in the future", () => {
    const now = new Date("2026-04-29T01:00:00");
    const next = new Date(computeNextRunMs(baseSchedule, now));
    expect(next.getDate()).toBe(29);
    expect(next.getHours()).toBe(2);
    expect(next.getMinutes()).toBe(0);
  });

  it("daily: rolls forward to tomorrow once today's slot has passed", () => {
    const now = new Date("2026-04-29T05:00:00");
    const next = new Date(computeNextRunMs(baseSchedule, now));
    expect(next.getDate()).toBe(30);
    expect(next.getHours()).toBe(2);
  });

  it("daily: handles HH:MM exactly equal to now by rolling forward", () => {
    const now = new Date("2026-04-29T02:00:00");
    const next = new Date(computeNextRunMs(baseSchedule, now));
    expect(next.getDate()).toBe(30);
  });

  it("weekly: lands on the configured weekday", () => {
    // 2026-04-29 is a Wednesday (getDay() === 3).
    const wednesday = new Date("2026-04-29T12:00:00");
    // Schedule for Sunday (weekday=0).
    const next = new Date(computeNextRunMs({ ...baseSchedule, frequency: "weekly", weekday: 0 }, wednesday));
    expect(next.getDay()).toBe(0);
    expect(next.getHours()).toBe(2);
    // Should be the upcoming Sunday, May 3rd 2026.
    expect(next.getDate()).toBe(3);
  });

  it("weekly: same weekday with slot still ahead today fires today", () => {
    // Wednesday at 01:00, weekly schedule for Wednesday at 02:00 → today at 02:00.
    const now = new Date("2026-04-29T01:00:00");
    const next = new Date(computeNextRunMs({ ...baseSchedule, frequency: "weekly", weekday: 3 }, now));
    expect(next.getDate()).toBe(29);
    expect(next.getHours()).toBe(2);
  });

  it("weekly: same weekday after slot rolls forward seven days", () => {
    const now = new Date("2026-04-29T05:00:00"); // Wednesday after 02:00
    const next = new Date(computeNextRunMs({ ...baseSchedule, frequency: "weekly", weekday: 3 }, now));
    expect(next.getDay()).toBe(3);
    // 7 days after Apr 29 → May 6 (April has 30 days).
    expect(next.getMonth()).toBe(4);
    expect(next.getDate()).toBe(6);
  });

  it("returns 0 for malformed timeOfDay", () => {
    const now = new Date("2026-04-29T12:00:00");
    expect(computeNextRunMs({ ...baseSchedule, timeOfDay: "bogus" } as ClawKeepSchedule, now)).toBe(0);
  });
});

/**
 * The other half of the schedule: what the scheduler does with the result.
 *
 * `runBackup` resolves with the daemon's exit code for every outcome except a
 * box with no pairing — a spawn that ENOENTs resolves 127, a hung daemon
 * resolves 124, a config error resolves 64. `fireBackup()` had only a
 * `.catch()` to report with, so each of those was a nightly no-op that left
 * nothing in the journal at all: the Settings card cannot show it either (its
 * backup button is gated on `daemonInstalled`), so scheduled backups stopped
 * for as long as it took someone to notice `lastBackupAtMs` ageing.
 */
describe("the ClawKeep backup scheduler", () => {
  const SCHEDULE: ClawKeepSchedule = {
    enabled: true,
    frequency: "daily",
    timeOfDay: "06:00",
    weekday: 0,
    retentionKeepLast: 10,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T05:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@/lib/clawkeep");
  });

  /**
   * Stubbed on purpose: the real read resolves `CLAWKEEP_DATA_DIR` at import
   * time, so a scheduler test that left it real would read the developer's own
   * `~/.clawkeep`.
   */
  function mockClawkeep(
    runBackup: ReturnType<typeof vi.fn>,
    snapshot: { schedule: ClawKeepSchedule; armedAtMs: number; unreadable: boolean },
  ) {
    vi.doMock("@/lib/clawkeep", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep")>("@/lib/clawkeep");
      return {
        ...actual,
        runBackup,
        readScheduleSnapshot: vi.fn(async () => snapshot),
      };
    });
  }

  async function armWith(runBackup: ReturnType<typeof vi.fn>) {
    mockClawkeep(runBackup, { schedule: SCHEDULE, armedAtMs: Date.now(), unreadable: false });
    const sched = await import("@/lib/clawkeep-scheduler");
    await sched.start();
    return sched;
  }

  it("logs a scheduled backup the daemon failed, instead of letting it pass as done", async () => {
    // `clawkeepd` gone from PATH — a pipx/venv reinstall, or install.sh's pip
    // fallback failing non-fatally. runBackup resolves, it does not reject.
    const runBackup = vi.fn(async () => ({
      exitCode: 127,
      stdout: "",
      stderr: "spawn clawkeepd ENOENT",
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await armWith(runBackup);
    await vi.advanceTimersByTimeAsync(61 * 60_000);

    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-backup failed"),
      expect.stringContaining("127"),
    );
    warn.mockRestore();
  });

  it("does not read a schedule.json it cannot open as the owner switching auto-backup off", async () => {
    // TASK-433, the half that stops a box that WAS backing up. An unreadable
    // `schedule.json` — root-owned after a restore, EIO on failing storage,
    // EMFILE on a loaded Jetson, a JSON truncated by a power cut — resolves to
    // `DEFAULT_SCHEDULE`, whose `enabled` is false. `arm()` then returns, the
    // nightly timer is torn down, and nothing anywhere says a word.
    const runBackup = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = { schedule: SCHEDULE, armedAtMs: Date.now(), unreadable: false };
    mockClawkeep(runBackup, snapshot);

    const sched = await import("@/lib/clawkeep-scheduler");
    await sched.start();
    const armedBefore = sched.nextRunAtMs();
    expect(armedBefore).toBeGreaterThan(Date.now());

    // The next read fails. A transient I/O error must not disarm the box.
    snapshot.schedule = { ...actualDefaultSchedule };
    snapshot.armedAtMs = 0;
    snapshot.unreadable = true;
    await sched.refresh();

    expect(sched.nextRunAtMs()).toBe(armedBefore);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("schedule.json could not be read"),
    );

    // The run it was armed for happens...
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(runBackup).toHaveBeenCalledTimes(1);

    // ...and so does the NEXT one. The post-fire rearm has no live timer to
    // preserve, so "keep what is armed" is not an answer there: a box that
    // ran once more and then stopped for ever would look identical to a
    // healthy one for a whole day.
    expect(sched.nextRunAtMs()).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(runBackup).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("keeps asking when the box BOOTS on a schedule it cannot read", async () => {
    // There is no last-known-good at boot, so nothing can be armed — and
    // answering "can I read the schedule?" once and believing it for the life
    // of the process is the probe-once class. On this file it is total: the
    // box would never back up again, on one log line.
    const runBackup = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = { schedule: { ...actualDefaultSchedule }, armedAtMs: 0, unreadable: true };
    mockClawkeep(runBackup, snapshot);

    const sched = await import("@/lib/clawkeep-scheduler");
    await sched.start();
    expect(sched.nextRunAtMs()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nothing is armed"));

    // The permissions are repaired (or the storage settles). Nobody touches
    // the panel — the retry is the only thing that can notice.
    snapshot.schedule = SCHEDULE;
    snapshot.unreadable = false;
    await vi.advanceTimersByTimeAsync(16 * 60_000);

    expect(sched.nextRunAtMs()).toBeGreaterThan(Date.now());

    // And it stops asking.
    warn.mockClear();
    await vi.advanceTimersByTimeAsync(46 * 60_000);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(runBackup).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("honours a save whose schedule the route already holds", async () => {
    // The owner switches auto-backup OFF. The route hands `refresh` the
    // schedule `writeSchedule()` returned, so a read that would have failed on
    // this path cannot leave the old cadence armed under a 200 answer.
    const runBackup = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const snapshot = { schedule: SCHEDULE, armedAtMs: Date.now(), unreadable: false };
    mockClawkeep(runBackup, snapshot);

    const sched = await import("@/lib/clawkeep-scheduler");
    await sched.start();
    expect(sched.nextRunAtMs()).toBeGreaterThan(Date.now());

    // The file read would now fail; the route does not need it.
    snapshot.unreadable = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sched.refresh({ ...SCHEDULE, enabled: false });

    expect(sched.nextRunAtMs()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(runBackup).not.toHaveBeenCalled();
    // A save also settles any outstanding re-read: the route's answer is
    // newer than anything the file could say, so a retry must not survive it
    // and re-arm the cadence the owner has just switched off.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stops re-reading once any successful read gets in first", async () => {
    // A pending 15-minute retry that a successful read does not cancel keeps
    // firing for the life of the process, tearing the armed backup timer down
    // and rebuilding it from `lastGood` — which may be staler than whatever
    // set the schedule in between. Permanent background churn nothing notices,
    // so it is pinned on the read itself rather than on a symptom.
    const runBackup = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = { schedule: { ...actualDefaultSchedule }, armedAtMs: 0, unreadable: true };
    const read = vi.fn(async () => snapshot);
    vi.doMock("@/lib/clawkeep", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep")>("@/lib/clawkeep");
      return { ...actual, runBackup, readScheduleSnapshot: read };
    });
    const sched = await import("@/lib/clawkeep-scheduler");

    await sched.start();          // unreadable: arms a retry
    snapshot.schedule = SCHEDULE;
    snapshot.unreadable = false;
    await sched.refresh();        // a good read lands inside the retry window
    const readsSoFar = read.mock.calls.length;

    // Three retry windows, and deliberately short of 06:00: the scheduled
    // backup re-reads on its own `.finally(rearm)`, which would mask this.
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(read).toHaveBeenCalledTimes(readsSoFar);
    warn.mockRestore();
  });

  it("stops re-reading when the route saves inside the retry window", async () => {
    // The same, through the door the owner actually uses. `refresh(schedule)`
    // reads nothing at all, so a retry it left behind would re-read and re-arm
    // over the save that had just replaced it.
    const runBackup = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = { schedule: { ...actualDefaultSchedule }, armedAtMs: 0, unreadable: true };
    const read = vi.fn(async () => snapshot);
    vi.doMock("@/lib/clawkeep", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep")>("@/lib/clawkeep");
      return { ...actual, runBackup, readScheduleSnapshot: read };
    });
    const sched = await import("@/lib/clawkeep-scheduler");

    await sched.start();          // unreadable: arms a retry
    await sched.refresh(SCHEDULE);
    const readsSoFar = read.mock.calls.length;

    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(read).toHaveBeenCalledTimes(readsSoFar);
    expect(sched.nextRunAtMs()).toBeGreaterThan(Date.now());
    warn.mockRestore();
  });

  it("lets the newer read win when a save lands during one that is in flight", async () => {
    // `start()` and `rearm()` no longer clear synchronously before their
    // await — that is what stops an unreadable read disarming a live timer —
    // so two rearms can be in flight at once. Without the generation guard the
    // OLDER read arms last, and the box keeps backing up on the cadence the
    // owner has already replaced. Silent, and gone by the next reboot, so it
    // never reproduces on demand.
    const runBackup = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    let releaseSlowRead: (() => void) | null = null;
    const slowRead = new Promise<void>((resolve) => { releaseSlowRead = resolve; });
    const snapshot = { schedule: SCHEDULE, armedAtMs: Date.now(), unreadable: false };

    vi.doMock("@/lib/clawkeep", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep")>("@/lib/clawkeep");
      return {
        ...actual,
        runBackup,
        readScheduleSnapshot: vi.fn(async () => { await slowRead; return snapshot; }),
      };
    });
    const sched = await import("@/lib/clawkeep-scheduler");

    // A boot read that has not answered yet...
    const booting = sched.start();
    // ...and the owner saves while it is still out.
    await sched.refresh({ ...SCHEDULE, enabled: false });
    expect(sched.nextRunAtMs()).toBe(0);

    // The stale read now answers with the schedule the save replaced.
    releaseSlowRead!();
    await booting;

    expect(sched.nextRunAtMs()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(runBackup).not.toHaveBeenCalled();
  });

  it("says nothing when the scheduled backup actually ran", async () => {
    const runBackup = vi.fn(async () => ({ exitCode: 0, stdout: "uploaded", stderr: "" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await armWith(runBackup);
    await vi.advanceTimersByTimeAsync(61 * 60_000);

    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
