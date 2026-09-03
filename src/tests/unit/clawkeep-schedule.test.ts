import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeNextRunMs, type ClawKeepSchedule } from "@/lib/clawkeep";

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

  async function armWith(runBackup: ReturnType<typeof vi.fn>) {
    vi.doMock("@/lib/clawkeep", async () => {
      const actual = await vi.importActual<typeof import("@/lib/clawkeep")>("@/lib/clawkeep");
      return { ...actual, runBackup, readSchedule: vi.fn(async () => SCHEDULE) };
    });
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
