/**
 * The daily auto-backup's timer (TASK-1358): armed at boot a few minutes out,
 * an hourly look after that, and a failed pass never ends the schedule. What a
 * pass does is pinned in project-backup.test.ts (runDueAutoBackups).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ runs: 0, fail: false }));
vi.mock("@/lib/project-backup", () => ({
  runDueAutoBackups: async () => {
    m.runs++;
    if (m.fail) throw new Error("boom");
    return 0;
  },
}));

import { _stopForTest, CHECK_EVERY_MS, checkNow, nextCheckAtMs, start } from "@/lib/project-backup-scheduler";

beforeEach(() => {
  vi.useFakeTimers();
  m.runs = 0;
  m.fail = false;
  _stopForTest();
});
afterEach(() => {
  _stopForTest();
  vi.useRealTimers();
});

describe("the project backup scheduler", () => {
  it("waits a few minutes after boot, then looks every hour", async () => {
    await start();
    const first = nextCheckAtMs();
    expect(first - Date.now()).toBe(5 * 60 * 1000);
    await start(); // idempotent
    expect(nextCheckAtMs()).toBe(first);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(m.runs).toBe(1);
    expect(nextCheckAtMs() - Date.now()).toBe(CHECK_EVERY_MS);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(m.runs).toBe(2);
  });

  it("keeps the schedule after a pass that failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.fail = true;
    await checkNow();
    expect(m.runs).toBe(1);
    expect(nextCheckAtMs()).toBeGreaterThan(Date.now());
    m.fail = false;
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(m.runs).toBe(2);
  });
});
