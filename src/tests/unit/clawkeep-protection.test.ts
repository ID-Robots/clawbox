import { describe, expect, it } from "vitest";
import {
  BACKUP_GRACE_MS,
  UNSCHEDULED_MAX_AGE_MS,
  deriveProtection,
  expectedBackupWindowMs,
} from "@/lib/clawkeep-protection";

/**
 * The age term behind both shields. The window comes from the schedule the
 * daemon already publishes, never from a new probe, and the judgement is a
 * pure function of (published facts, now) so both surfaces can share it.
 */

const HOUR = 60 * 60 * 1000;
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

  it("ages a needs-passphrase box out too — nothing has run since", () => {
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 40 * HOUR, lastHeartbeatStatus: "needs-passphrase", schedule: DAILY },
      NOW,
    ).state).toBe("lapsed");
  });

  it("does not lapse a box on an unsampled clock or a backup dated ahead", () => {
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 40 * HOUR, lastHeartbeatStatus: "ok", schedule: DAILY },
      0,
    ).state).toBe("protected");
    expect(deriveProtection(
      { lastBackupAtMs: NOW + DAY, lastHeartbeatStatus: "ok", schedule: DAILY },
      NOW,
    ).state).toBe("protected");
  });
});
