import { describe, expect, it } from "vitest";
import {
  BACKUP_GRACE_MS,
  BACKUP_RUN_CAP_MS,
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
      scheduleArmedAtMs: NOW - MINUTE,
    };
    expect(deriveProtection(armedJustNow, NOW).state).toBe("protected");
    // …and it does lapse once that schedule has genuinely had its window.
    expect(deriveProtection({ ...armedJustNow, scheduleArmedAtMs: NOW - 40 * HOUR }, NOW).state)
      .toBe("lapsed");
  });

  it("gives no grace for a schedule change while auto-backup is off", () => {
    // Nothing is waiting to run, so a save must not extend a stale box's life.
    expect(deriveProtection(
      { lastBackupAtMs: NOW - 8 * DAY, lastHeartbeatStatus: "ok", schedule: OFF, scheduleArmedAtMs: NOW - MINUTE },
      NOW,
    ).state).toBe("lapsed");
  });


  it("gives the grace to the arm, never to a re-save", () => {
    // `scheduleArmedAtMs` moves only when a schedule is switched on or
    // tightened, so a box armed two months ago whose backups died ten days ago
    // carries a stamp older than its own last backup and gets no grace at all
    // — however many times its owner has since nudged the retention count or
    // the backup time on the schedule card the lapsed copy sends them to.
    expect(deriveProtection(
      {
        lastBackupAtMs: NOW - 10 * DAY,
        lastHeartbeatStatus: "ok",
        schedule: DAILY,
        scheduleArmedAtMs: NOW - 60 * DAY,
      },
      NOW,
    )).toEqual({ state: "lapsed", reason: "stale" });
  });

  it("does not let an arm stamp reach past the longest window any cadence allows", () => {
    // The stamp is taken at face value here — whether the arm was *earned* is
    // `writeSchedule()`'s question, because only it knows the window the box was
    // being judged against a moment ago (see the schedule route tests). What
    // this function still refuses is a grace that outlives every cadence there
    // is: a backup older than the weekly window is stale under all of them.
    expect(deriveProtection(
      {
        lastBackupAtMs: NOW - 10 * DAY,
        lastHeartbeatStatus: "ok",
        schedule: DAILY,
        scheduleArmedAtMs: NOW - MINUTE,
      },
      NOW,
    )).toEqual({ state: "lapsed", reason: "stale" });
    // And the ceiling is the weekly window, not a week: a weekly box at 7 d 6 h
    // is legitimately protected, so tightening it to Daily must not lapse it on
    // the click — which is the one thing the grace exists to prevent.
    expect(deriveProtection(
      {
        lastBackupAtMs: NOW - (7 * DAY + 6 * HOUR),
        lastHeartbeatStatus: "ok",
        schedule: DAILY,
        scheduleArmedAtMs: NOW - MINUTE,
      },
      NOW,
    )).toEqual({ state: "protected", reason: "ok" });
  });

  it("does not let an arm stamp dated ahead of the clock hold a box green for ever", () => {
    // A Jetson whose RTC jumped forward before a save (no battery-backed clock,
    // NTP only) writes a stamp a month ahead. Unclamped, the anchor never falls
    // behind `now`, so the shield reads green until wall-clock catches up — and
    // re-grants itself on every read.
    const skewed = {
      lastBackupAtMs: NOW - 3 * DAY,
      lastHeartbeatStatus: "ok",
      schedule: DAILY,
      scheduleArmedAtMs: NOW + 30 * DAY,
    };
    expect(deriveProtection(skewed, NOW).state).toBe("protected");
    // Clamped to now and still ceilinged by the week: the skew buys days, not
    // the month it claims.
    expect(deriveProtection(skewed, NOW + 5 * DAY))
      .toEqual({ state: "lapsed", reason: "stale" });
  });

  it("tells a box with no passphrase to set one even when the heartbeat says 'error'", () => {
    // runner.py publishes `"needs-passphrase" if ok else "error"`, so a run
    // refused for want of a passphrase lands on "error" whenever the heartbeat
    // could not reach the portal. "One retry and we'll lock it back down" is
    // the wrong remedy for a box that has nothing to retry with.
    expect(deriveProtection(
      {
        lastBackupAtMs: NOW - HOUR,
        lastHeartbeatStatus: "error",
        encryptionConfigured: false,
        schedule: DAILY,
      },
      NOW,
    )).toEqual({ state: "lapsed", reason: "blocked" });
    // With a passphrase in place an error is still just an error.
    expect(deriveProtection(
      {
        lastBackupAtMs: NOW - HOUR,
        lastHeartbeatStatus: "error",
        encryptionConfigured: true,
        schedule: DAILY,
      },
      NOW,
    )).toEqual({ state: "lapsed", reason: "error" });
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

  it("stops believing a 'running' older than the cap the run is spawned under", () => {
    // runner.py persists "running" before the archive starts. A power cut or
    // OOM-kill mid-backup leaves it in state.json for ever, and with
    // auto-backup off nothing overwrites it.
    expect(isBackupRunning(
      { lastHeartbeatStatus: "running", lastHeartbeatAtMs: NOW - STALE_RUNNING_MS - 1 },
      NOW,
    )).toBe(false);
  });

  it("still believes a backup that has been going for an hour of a large box", () => {
    // The daemon stamps the heartbeat once, at run start, and TASK-675 made
    // 10 GB+ archives the supported case. The old half-hour rule called those
    // runs dead — dropping the shelf's progress pulse and, on a box whose first
    // backup this is, turning the shield red while the upload was healthy.
    expect(isBackupRunning(
      { lastHeartbeatStatus: "running", lastHeartbeatAtMs: NOW - 45 * MINUTE },
      NOW,
    )).toBe(true);
    // The bound is not a guess: `runBackup()` SIGKILLs the daemon at
    // BACKUP_RUN_CAP_MS, so past it there is nothing left alive to pulse for.
    expect(STALE_RUNNING_MS).toBe(BACKUP_RUN_CAP_MS);
    expect(BACKUP_RUN_CAP_MS).toBe(60 * MINUTE);
  });

  it("does not let a clock-skewed heartbeat pulse for as long as the skew", () => {
    // These boxes have no battery-backed clock and the reader is a browser, so
    // the stamp can land ahead of `nowMs`. A few minutes of that is the gap
    // between the two reads on a run that has just started — believe it.
    expect(isBackupRunning(
      { lastHeartbeatStatus: "running", lastHeartbeatAtMs: NOW + 5 * MINUTE },
      NOW,
    )).toBe(true);
    // A month ahead is not a longer backup. A SIGKILLed run leaves "running"
    // in state.json for ever, so without this the shelf pulses and the card
    // shows a progress panel over a dead daemon until wall-clock catches up.
    expect(isBackupRunning(
      { lastHeartbeatStatus: "running", lastHeartbeatAtMs: NOW + 30 * DAY },
      NOW,
    )).toBe(false);
  });
});
