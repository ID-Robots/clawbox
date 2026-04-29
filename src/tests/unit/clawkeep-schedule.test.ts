import { describe, expect, it } from "vitest";

import { computeNextRunMs, type ClawKeepSchedule } from "@/lib/clawkeep";

const baseSchedule: ClawKeepSchedule = {
  enabled: true,
  frequency: "daily",
  timeOfDay: "02:00",
  weekday: 0,
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
