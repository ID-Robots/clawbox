/**
 * The weekly update check's clock (TASK-2260): Monday 10:00 in the BOX's zone
 * plus a fixed per-box jitter, once per named week, a catch-up at the next
 * start after downtime, and an hourly retry for a check that could not look.
 *
 * The zone is the PROCESS zone (`applyProcessTimeZone` keeps it on the
 * owner's), so each case sets `process.env.TZ` — Node honours a runtime
 * assignment — and restores it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UPDATE_CHECK_JITTER_MAX_S,
  UPDATE_CHECK_RETRY_MS,
  clampJitter,
  drawJitter,
  isCheckDue,
  planNextCheck,
  slotOf,
  weekKey,
  weekStart,
} from "@/lib/update-notice-schedule";

const savedTz = process.env.TZ;

function inZone(tz: string): void {
  process.env.TZ = tz;
}

/** A local wall-clock time in the current process zone. */
function local(y: number, m: number, d: number, h = 0, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

const fresh = (jitterS = 0) => ({ lastCheckedWeek: null, lastAttemptAt: null, jitterS });

beforeEach(() => inZone("Europe/Sofia"));
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("the week", () => {
  it("is named after its Monday, in the box's zone", () => {
    // 2026-11-11 is a Wednesday.
    expect(weekKey(local(2026, 11, 11, 15))).toBe("2026-11-09");
    expect(weekKey(local(2026, 11, 9, 0, 0))).toBe("2026-11-09");
  });

  it("runs Monday to Sunday — Sunday night still belongs to the week that began on Monday", () => {
    expect(weekKey(local(2026, 11, 15, 23, 59))).toBe("2026-11-09");
    expect(weekKey(local(2026, 11, 16, 0, 0))).toBe("2026-11-16");
  });

  it("crosses a month and a year cleanly", () => {
    // 2027-01-01 is a Friday; its Monday is 2026-12-28.
    expect(weekKey(local(2027, 1, 1, 12))).toBe("2026-12-28");
  });

  it("follows the box's zone, not UTC: the same instant is Sunday in New York and Monday in Tokyo", () => {
    const instant = Date.UTC(2026, 10, 16, 2, 0); // Mon 2026-11-16 02:00Z
    inZone("America/New_York");
    expect(weekKey(new Date(instant))).toBe("2026-11-09"); // Sun 21:00 local
    inZone("Asia/Tokyo");
    expect(weekKey(new Date(instant))).toBe("2026-11-16"); // Mon 11:00 local
  });
});

describe("the slot", () => {
  it("is Monday 10:00 local plus the jitter", () => {
    const slot = new Date(slotOf(weekStart(local(2026, 11, 11)), 25 * 60 + 7));
    expect(slot.getDay()).toBe(1);
    expect(slot.getHours()).toBe(10);
    expect(slot.getMinutes()).toBe(25);
    expect(slot.getSeconds()).toBe(7);
  });

  it("is 10:00 on the box's clock in every zone — a different instant for each", () => {
    const week = local(2026, 11, 11);
    inZone("Asia/Tokyo");
    const tokyo = slotOf(weekStart(week), 0);
    inZone("America/Los_Angeles");
    const la = slotOf(weekStart(week), 0);
    expect(new Date(tokyo).toISOString()).toBe("2026-11-09T01:00:00.000Z");
    expect(new Date(la).toISOString()).toBe("2026-11-09T18:00:00.000Z");
  });

  it("stays at 10:00 local across a DST change (Europe/Sofia leaves summer time on 2026-10-25)", () => {
    const before = new Date(slotOf(weekStart(local(2026, 10, 21)), 0));
    const after = new Date(slotOf(weekStart(local(2026, 10, 28)), 0));
    expect(before.toISOString()).toBe("2026-10-19T07:00:00.000Z"); // UTC+3
    expect(after.toISOString()).toBe("2026-10-26T08:00:00.000Z"); // UTC+2
    expect(before.getHours()).toBe(10);
    expect(after.getHours()).toBe(10);
  });
});

describe("the jitter", () => {
  it("is drawn inside [0, one hour) and kept whole", () => {
    expect(drawJitter(() => 0)).toBe(0);
    expect(drawJitter(() => 0.5)).toBe(1800);
    expect(drawJitter(() => 0.999999)).toBe(UPDATE_CHECK_JITTER_MAX_S - 1);
  });

  it("spreads the fleet: different boxes, different slots, same Monday morning", () => {
    const monday = weekStart(local(2026, 11, 11));
    const slots = [0.1, 0.4, 0.9].map((r) => new Date(slotOf(monday, drawJitter(() => r))));
    expect(new Set(slots.map((s) => s.getTime())).size).toBe(3);
    for (const s of slots) {
      expect(s.getDay()).toBe(1);
      expect(s.getHours()).toBe(10);
    }
  });

  it("is clamped whatever was on disk", () => {
    expect(clampJitter(-5)).toBe(0);
    expect(clampJitter(10_000_000)).toBe(UPDATE_CHECK_JITTER_MAX_S - 1);
    expect(clampJitter("600")).toBe(0);
    expect(clampJitter(Number.NaN)).toBe(0);
    expect(clampJitter(61.9)).toBe(61);
  });
});

describe("planNextCheck", () => {
  const jitterS = 17 * 60;
  const slotThisWeek = () => slotOf(weekStart(local(2026, 11, 11)), jitterS);

  it("before Monday's slot, waits for it", () => {
    const plan = planNextCheck(fresh(jitterS), local(2026, 11, 9, 9, 0));
    expect(plan).toEqual({ at: slotThisWeek(), week: "2026-11-09" });
    expect(isCheckDue(fresh(jitterS), local(2026, 11, 9, 9, 0))).toBeNull();
  });

  it("at the slot, is due", () => {
    const at = new Date(slotThisWeek());
    expect(isCheckDue(fresh(jitterS), at)).toEqual({ at: at.getTime(), week: "2026-11-09" });
  });

  it("runs once per week: a week already checked waits for next Monday", () => {
    const state = { lastCheckedWeek: "2026-11-09", lastAttemptAt: null, jitterS };
    const plan = planNextCheck(state, local(2026, 11, 9, 11, 0));
    expect(plan.week).toBe("2026-11-16");
    expect(new Date(plan.at).getDay()).toBe(1);
    expect(new Date(plan.at).getHours()).toBe(10);
    expect(new Date(plan.at).getMinutes()).toBe(17);
    expect(isCheckDue(state, local(2026, 11, 13, 18, 0))).toBeNull();
  });

  it("catches up after downtime: a box off across Monday checks at its next start that week", () => {
    // Last checked the previous week; switched on again on Thursday.
    const state = { lastCheckedWeek: "2026-11-02", lastAttemptAt: null, jitterS };
    const thursday = local(2026, 11, 12, 8, 30);
    expect(isCheckDue(state, thursday)).toEqual({ at: thursday.getTime(), week: "2026-11-09" });
  });

  it("does not carry a missed week over: Sunday's catch-up is that week's, Monday starts clean", () => {
    const state = { lastCheckedWeek: "2026-11-02", lastAttemptAt: null, jitterS };
    expect(isCheckDue(state, local(2026, 11, 15, 22, 0))?.week).toBe("2026-11-09");
    // Monday 08:00 of the next week: the old week is gone, the new slot is ahead.
    expect(isCheckDue(state, local(2026, 11, 16, 8, 0))).toBeNull();
  });

  it("retries an hour after a check that could not look, inside the same week", () => {
    const failedAt = slotThisWeek() + 60_000;
    const state = { lastCheckedWeek: "2026-11-02", lastAttemptAt: failedAt, jitterS };
    expect(isCheckDue(state, new Date(failedAt + 30 * 60_000))).toBeNull();
    expect(planNextCheck(state, new Date(failedAt + 30 * 60_000)).at).toBe(failedAt + UPDATE_CHECK_RETRY_MS);
    expect(isCheckDue(state, new Date(failedAt + UPDATE_CHECK_RETRY_MS))).not.toBeNull();
  });

  it("ignores a failed attempt from an earlier week", () => {
    const lastWeek = slotOf(weekStart(local(2026, 11, 4)), jitterS) + 60_000;
    const state = { lastCheckedWeek: "2026-10-26", lastAttemptAt: lastWeek, jitterS };
    const at = new Date(slotThisWeek());
    expect(isCheckDue(state, at)).toEqual({ at: at.getTime(), week: "2026-11-09" });
  });

  it("checks again if the clock was stepped back to a week it has not settled", () => {
    const state = { lastCheckedWeek: "2027-03-01", lastAttemptAt: null, jitterS };
    expect(isCheckDue(state, local(2026, 11, 12, 12))).not.toBeNull();
  });
});
