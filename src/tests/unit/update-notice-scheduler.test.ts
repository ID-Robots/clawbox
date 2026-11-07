/**
 * The weekly update check's timer (TASK-2260): armed from the persisted state
 * at boot, never earlier than the boot delay, re-armed after every fire, and
 * re-planned on demand (the owner's switch, a timezone change).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = { lastCheckedWeek: null as string | null, lastAttemptAt: null, jitterS: 0 };
const runWeeklyUpdateCheck = vi.fn(async (..._a: unknown[]) => ({ ran: true, week: "2026-11-09", outcome: "current" }));
vi.mock("@/lib/update-notice", () => ({
  readUpdateNoticeState: vi.fn(async () => ({ ...state })),
  runWeeklyUpdateCheck: (...a: unknown[]) => runWeeklyUpdateCheck(...a),
}));

let scheduler: typeof import("@/lib/update-notice-scheduler");
const savedTz = process.env.TZ;
const savedDelay = process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS;

beforeEach(async () => {
  process.env.TZ = "Europe/Sofia";
  delete process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS;
  vi.useFakeTimers();
  state.lastCheckedWeek = null;
  runWeeklyUpdateCheck.mockClear();
  vi.resetModules();
  scheduler = await import("@/lib/update-notice-scheduler");
});

afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  if (savedDelay === undefined) delete process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS;
  else process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS = savedDelay;
});

describe("update-notice-scheduler", () => {
  it("arms for Monday's slot when the box starts before it", async () => {
    vi.setSystemTime(new Date(2026, 10, 9, 8, 0));
    scheduler.resetStartForTests();
    state.lastCheckedWeek = "2026-11-02";
    await scheduler.start();
    expect(new Date(scheduler.nextRunAtMs())).toEqual(new Date(2026, 10, 9, 10, 0));
  });

  it("a box that was off on Monday checks once, BOOT_DELAY_MS after it starts", async () => {
    const thursday = new Date(2026, 10, 12, 9, 0);
    vi.setSystemTime(thursday);
    scheduler.resetStartForTests();
    state.lastCheckedWeek = "2026-11-02";
    await scheduler.start();
    expect(scheduler.nextRunAtMs()).toBe(thursday.getTime() + scheduler.BOOT_DELAY_MS);

    await vi.advanceTimersByTimeAsync(scheduler.BOOT_DELAY_MS - 1_000);
    expect(runWeeklyUpdateCheck).not.toHaveBeenCalled();
    state.lastCheckedWeek = "2026-11-09"; // what the run records
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runWeeklyUpdateCheck).toHaveBeenCalledTimes(1);
    // Re-armed for NEXT Monday, not looping on the same week.
    expect(new Date(scheduler.nextRunAtMs())).toEqual(new Date(2026, 10, 16, 10, 0));
  });

  it("backs off an hour after a run that broke, instead of waking again at once", async () => {
    const thursday = new Date(2026, 10, 12, 9, 0);
    vi.setSystemTime(thursday);
    scheduler.resetStartForTests(thursday.getTime() - 60 * 60_000);
    state.lastCheckedWeek = "2026-11-02"; // due, and stays due: the run cannot record it
    runWeeklyUpdateCheck.mockResolvedValueOnce({ ran: false, failed: true } as never);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(runWeeklyUpdateCheck).toHaveBeenCalledTimes(1);
    expect(scheduler.nextRunAtMs()).toBeGreaterThanOrEqual(thursday.getTime() + 60 * 60_000);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(runWeeklyUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it("the lab hook only SHORTENS the boot delay", async () => {
    process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS = "5000";
    expect(scheduler.bootDelayMs()).toBe(5_000);
    process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS = "999999999";
    expect(scheduler.bootDelayMs()).toBe(scheduler.BOOT_DELAY_MS);
    process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS = "10";
    expect(scheduler.bootDelayMs()).toBe(1_000);
    process.env.CLAWBOX_UPDATE_NOTICE_BOOT_DELAY_MS = "soon";
    expect(scheduler.bootDelayMs()).toBe(scheduler.BOOT_DELAY_MS);
  });

  it("re-plans on refresh, and stop disarms", async () => {
    vi.setSystemTime(new Date(2026, 10, 10, 12, 0));
    scheduler.resetStartForTests(Date.now() - 60 * 60_000);
    state.lastCheckedWeek = "2026-11-09";
    await scheduler.start();
    expect(new Date(scheduler.nextRunAtMs())).toEqual(new Date(2026, 10, 16, 10, 0));
    state.jitterS = 600;
    await scheduler.refresh();
    expect(new Date(scheduler.nextRunAtMs())).toEqual(new Date(2026, 10, 16, 10, 10));
    scheduler.stop();
    expect(scheduler.nextRunAtMs()).toBe(0);
    state.jitterS = 0;
  });
});
