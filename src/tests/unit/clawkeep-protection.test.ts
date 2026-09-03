import { describe, expect, it } from "vitest";
import {
  BACKUP_GRACE_MS,
  STALE_RUNNING_MS,
  UNSCHEDULED_MAX_AGE_MS,
  deriveProtection,
  expectedBackupWindowMs,
  isBackupRunning,
} from "@/lib/clawkeep-protection";

/**
 * The age term behind both shields. The window comes from the schedule the
 * daemon already publishes, never from a new probe, and the judgement is a
 * pure function of (published facts, now) so both surfaces can share it.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

const DAILY = { enabled: true, frequency: "daily" as const };
const WEEKLY = { enabled: true, frequency: "weekly" as const };
const OFF = { enabled: false, frequency: "daily" as const };

describe("expectedBackupWindowMs", () => {
  it("gives a nightly schedule its period plus the grace — the 36 h window", () => {
    expect(expectedBackupWindowMs(DAILY)).toBe(DAY + BACKUP_GRACE_MS);
    expect(expectedBackupWindowMs(DAILY)).toBe(36 * HOUR);
  });

  it("derives a weekly schedule's window from the same rule", () => {
    expect(expectedBackupWindowMs(WEEKLY)).toBe(7 * DAY + BACKUP_GRACE_MS);
  });

  it("falls back to a week when no schedule is armed", () => {
    expect(expectedBackupWindowMs(OFF)).toBe(UNSCHEDULED_MAX_AGE_MS);
    expect(expectedBackupWindowMs(undefined)).toBe(UNSCHEDULED_MAX_AGE_MS);
    expect(expectedBackupWindowMs(null)).toBe(UNSCHEDULED_MAX_AGE_MS);
  });
});

describe("deriveProtection", () => {
  it("is green for a backup inside the window", () => {
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 30 * HOUR, lastHeartbeatStatus: "ok", schedule: DAILY },
      NOW,
    )).toEqual({ state: "protected", reason: "ok" });
  });

  it("lapses on age alone, with the last heartbeat still reading ok", () => {
    // exit 3 (auth revoked) and a missing daemon (127) both leave the previous
    // run's "ok" in place and stop moving lastBackupAtMs. Age is the only tell.
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 37 * HOUR, lastHeartbeatStatus: "ok", schedule: DAILY },
      NOW,
    )).toEqual({ state: "lapsed", reason: "stale" });
  });

  it("holds a weekly box green for six days and lapses it after eight", () => {
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 6 * DAY, lastHeartbeatStatus: "ok", schedule: WEEKLY },
      NOW,
    ).state).toBe("protected");
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 8 * DAY, lastHeartbeatStatus: "ok", schedule: WEEKLY },
      NOW,
    ).state).toBe("lapsed");
  });

  it("gives a manual-only box the week-long window, not the nightly one", () => {
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 3 * DAY, lastHeartbeatStatus: "ok", schedule: OFF },
      NOW,
    ).state).toBe("protected");
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 8 * DAY, lastHeartbeatStatus: "ok", schedule: OFF },
      NOW,
    ).state).toBe("lapsed");
  });

  it("calls a box that never ran one unprotected, never lapsed", () => {
    // The false-failure side: a fresh install must not be scolded for a
    // backup it was never asked to make.
    expect(deriveProtection({ lastBackupAtMs: 0, schedule: DAILY }, NOW))
      .toEqual({ state: "unprotected", reason: "never" });
  });

  it("keeps an error heartbeat lapsed even on a fresh backup", () => {
    expect(deriveProtection(
      { lastBackupAtMs: NOW - HOUR, lastHeartbeatStatus: "error", schedule: DAILY },
      NOW,
    )).toEqual({ state: "lapsed", reason: "error" });
  });

  it("does not wait out the window on a run that REFUSED — nothing will move it", () => {
    // EXIT_NEED_PASSPHRASE (9) stamps "needs-passphrase" and returns without
    // touching lastBackupAtMs. Falling through to the age term would report
    // green for the next 36 h over a box on which nothing can succeed.
    expect(deriveProtection(
      { lastBackupAtMs: NOW - HOUR, lastHeartbeatStatus: "needs-passphrase", schedule: DAILY },
      NOW,
    )).toEqual({ state: "lapsed", reason: "blocked" });
    // The same fact, published directly, before the runner has been asked.
    expect(deriveProtection(
      { lastBackupAtMs: NOW - HOUR, lastHeartbeatStatus: "ok", encryptionConfigured: false, schedule: DAILY },
      NOW,
    )).toEqual({ state: "lapsed", reason: "blocked" });
  });

  it("still calls a never-backed-up box with no passphrase 'unprotected', not 'blocked'", () => {
    expect(deriveProtection(
      { lastBackupAtMs: 0, encryptionConfigured: false, schedule: DAILY },
      NOW,
    )).toEqual({ state: "unprotected", reason: "never" });
  });

  it("does not lapse a box for the schedule it was just given", () => {
    // Every box starts with DEFAULT_SCHEDULE.enabled === false, so the window
    // is a week. Arming Daily shrinks it to 36 h; applying that retroactively
    // would flip a green box amber on the same click, blaming a scheduled run
    // that has never run.
    const armedJustNow = {
      lastBackupAtMs: NOW - 3 * DAY,
      lastHeartbeatStatus: "ok",
      schedule: DAILY,
      scheduleChangedAtMs: NOW - MINUTE,
    };
    expect(deriveProtection(armedJustNow, NOW).state).toBe("protected");
    // …and it does lapse once that schedule has genuinely had its window.
    expect(deriveProtection({ ...armedJustNow, scheduleChangedAtMs: NOW - 40 * HOUR }, NOW).state)
      .toBe("lapsed");
  });

  it("gives no grace for a schedule change while auto-backup is off", () => {
    // Nothing is waiting to run, so a save must not extend a stale box's life.
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 8 * DAY, lastHeartbeatStatus: "ok", schedule: OFF, scheduleChangedAtMs: NOW - MINUTE },
      NOW,
    ).state).toBe("lapsed");
  });

  it("does not lapse a box whose backup is dated ahead of the clock", () => {
    expect(deriveProtection(
      { lastBackupAtMs: NOW + DAY, lastHeartbeatStatus: "ok", schedule: DAILY },
      NOW,
    ).state).toBe("protected");
  });
});

describe("isBackupRunning", () => {
  it("is true only for a heartbeat that is both running and fresh", () => {
    expect(isBackupRunning({ lastHeartbeatStatus: "running", lastHeartbeatAtMs: NOW - MINUTE }, NOW)).toBe(true);
    expect(isBackupRunning({ lastHeartbeatStatus: "ok", lastHeartbeatAtMs: NOW - MINUTE }, NOW)).toBe(false);
    expect(isBackupRunning({ lastHeartbeatStatus: "running", lastHeartbeatAtMs: 0 }, NOW)).toBe(false);
    expect(isBackupRunning(null, NOW)).toBe(false);
  });

  it("stops believing a 'running' nothing has refreshed for half an hour", () => {
    // runner.py persists "running" before the archive starts. A power cut or
    // OOM-kill mid-backup leaves it in state.json for ever, and with
    // auto-backup off nothing overwrites it.
    expect(isBackupRunning(
      { lastHeartbeatStatus: "running", lastHeartbeatAtMs: NOW - STALE_RUNNING_MS - 1 },
      NOW,
    )).toBe(false);
  });
});
