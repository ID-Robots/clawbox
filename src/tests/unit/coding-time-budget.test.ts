/**
 * The time budget's pure half (src/lib/coding-time-budget.ts): the chips on
 * the box's wall clock across zones and DST changes, the start request's
 * `budget` token, the task's own words in English, Bulgarian and German, the
 * precedence between the three, and the records a budgeted run keeps.
 *
 * Every case passes its own `now` and zone: nothing here may depend on the
 * machine the suite runs on.
 */
import { describe, expect, it } from "vitest";
import {
  budgetDurationMs,
  budgetStopReason,
  fitsBeforeCutoff,
  marginCutoffMs,
  safetyMarginMs,
  withDefaultTokenCap,
  customBudget,
  describeBudget,
  elapsedMs,
  formatDuration,
  formatLocalDeadline,
  formatTimeRecordLine,
  MAX_BUDGET_MS,
  needsTeam,
  parseBudgetFromText,
  parseBudgetToken,
  parseDuration,
  parseIsoInstant,
  presetBudget,
  readBudgetInput,
  readTimeBudget,
  readTimeRecord,
  remainingMs,
  resolveBudget,
  safeTimeZone,
  summarizeTimeRecords,
  TEAM_BUDGET_THRESHOLD_MS,
  timeRecord,
  type TimeBudget,
} from "@/lib/coding-time-budget";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Wednesday 14 Oct 2026, 15:00 UTC — 18:00 in Sofia, 11:00 in New York, 00:00 (Thu) in Tokyo. */
const NOW = Date.parse("2026-10-14T15:00:00Z");
const SOFIA = "Europe/Sofia";

const at = (b: TimeBudget | null | undefined) => b?.deadline;
function ok(text: string, now = NOW, tz = SOFIA) {
  const r = parseBudgetFromText(text, now, tz);
  if (!r || !r.ok) throw new Error(`expected a budget from ${JSON.stringify(text)}, got ${JSON.stringify(r)}`);
  return r;
}

describe("the chips", () => {
  it("count 30 minutes, 1 hour and 1 day from now, labelled and stamped", () => {
    expect(presetBudget("30m", NOW, SOFIA)).toEqual({
      deadline: "2026-10-14T15:30:00.000Z", label: "30 minutes", preset: "30m", source: "picker", setAt: "2026-10-14T15:00:00.000Z",
    });
    expect(at(presetBudget("1h", NOW, SOFIA))).toBe("2026-10-14T16:00:00.000Z");
    expect(at(presetBudget("1d", NOW, SOFIA))).toBe("2026-10-15T15:00:00.000Z");
    expect(presetBudget("1d", NOW, SOFIA, "default").source).toBe("default");
  });

  it("put 'until tomorrow morning' at the next 08:00 on the BOX's clock, zone by zone", () => {
    expect(at(presetBudget("morning", NOW, SOFIA))).toBe("2026-10-15T05:00:00.000Z"); // 08:00 EEST
    expect(at(presetBudget("morning", NOW, "UTC"))).toBe("2026-10-15T08:00:00.000Z");
    expect(at(presetBudget("morning", NOW, "America/New_York"))).toBe("2026-10-15T12:00:00.000Z"); // 08:00 EDT
    // Already Thursday 00:00 in Tokyo: the next 08:00 is eight hours away, today.
    expect(at(presetBudget("morning", NOW, "Asia/Tokyo"))).toBe("2026-10-14T23:00:00.000Z");
  });

  it("never lands the morning less than an hour away: at 07:30 it means tomorrow", () => {
    const sevenThirty = Date.parse("2026-10-15T04:30:00Z"); // 07:30 in Sofia
    expect(at(presetBudget("morning", sevenThirty, SOFIA))).toBe("2026-10-16T05:00:00.000Z");
    const seven = Date.parse("2026-10-15T04:00:00Z"); // 07:00: exactly an hour — today still
    expect(at(presetBudget("morning", seven, SOFIA))).toBe("2026-10-15T05:00:00.000Z");
    const twoAm = Date.parse("2026-10-14T23:00:00Z"); // 02:00 Thursday: the morning ahead
    expect(at(presetBudget("morning", twoAm, SOFIA))).toBe("2026-10-15T05:00:00.000Z");
  });

  it("keeps the morning at 08:00 local across a DST change — and 1 day at 24 hours of clock", () => {
    // Berlin falls back on 25 Oct 2026: 22:00 CEST the evening before, 08:00 CET after.
    const berlinEve = Date.parse("2026-10-24T20:00:00Z");
    expect(at(presetBudget("morning", berlinEve, "Europe/Berlin"))).toBe("2026-10-25T07:00:00.000Z");
    expect(at(presetBudget("1d", berlinEve, "Europe/Berlin"))).toBe("2026-10-25T20:00:00.000Z");
    // New York springs forward on 8 Mar 2026: 23:00 EST the evening before, 08:00 EDT after.
    const nyEve = Date.parse("2026-03-08T04:00:00Z");
    expect(at(presetBudget("morning", nyEve, "America/New_York"))).toBe("2026-03-08T12:00:00.000Z");
    // Sofia falls back on 25 Oct too: 08:00 EET is 06:00 UTC.
    expect(at(presetBudget("morning", Date.parse("2026-10-24T19:00:00Z"), SOFIA))).toBe("2026-10-25T06:00:00.000Z");
  });

  it("keeps the morning right in half-hour zones and across a southern-hemisphere DST change", () => {
    expect(at(presetBudget("morning", NOW, "Asia/Kolkata"))).toBe("2026-10-15T02:30:00.000Z"); // 08:00 IST, +05:30
    expect(at(presetBudget("morning", NOW, "Australia/Sydney"))).toBe("2026-10-14T21:00:00.000Z"); // 08:00 AEDT
    expect(at(presetBudget("morning", NOW, "Australia/Lord_Howe"))).toBe("2026-10-14T21:00:00.000Z"); // 08:00 at +11, a half-hour DST
    // Sydney springs forward on 4 Oct 2026: 22:00 AEST the evening before, 08:00 AEDT after.
    expect(at(presetBudget("morning", Date.parse("2026-10-03T12:00:00Z"), "Australia/Sydney"))).toBe("2026-10-03T21:00:00.000Z");
  });

  it("reads a wall-clock time in the hour a clock repeats as the earlier one, and one in the skipped hour on the offset before the jump", () => {
    expect(parseIsoInstant("2026-11-01T01:30", "America/New_York")).toBe(Date.parse("2026-11-01T05:30:00Z")); // EDT, not EST
    expect(parseIsoInstant("2026-10-25T03:30", SOFIA)).toBe(Date.parse("2026-10-25T00:30:00Z")); // EEST, not EET
    expect(parseIsoInstant("2026-03-08T02:30", "America/New_York")).toBe(Date.parse("2026-03-08T07:30:00Z")); // 02:30 never happens: EST
  });

  it("reads a zone this engine does not know as UTC rather than failing", () => {
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
    expect(safeTimeZone("")).toBe("UTC");
    expect(at(presetBudget("morning", NOW, "Mars/Olympus"))).toBe("2026-10-15T08:00:00.000Z");
  });
});

describe("a picked period", () => {
  it("reads an end without an offset on the box's wall clock, one with an offset as it says", () => {
    const local = customBudget("2026-10-15T18:00", NOW, null, { tz: SOFIA });
    expect(local).toEqual({ ok: true, budget: expect.objectContaining({ deadline: "2026-10-15T15:00:00.000Z", preset: "custom", label: "Until Thu 15 Oct, 18:00" }) });
    const zulu = customBudget("2026-10-15T18:00:00Z", NOW, null, { tz: SOFIA });
    expect(zulu.ok && zulu.budget?.deadline).toBe("2026-10-15T18:00:00.000Z");
    const offset = customBudget("2026-10-15T18:00:00+02:00", NOW, null, { tz: SOFIA });
    expect(offset.ok && offset.budget?.deadline).toBe("2026-10-15T16:00:00.000Z");
  });

  it("keeps a start, and counts the budget from it", () => {
    const r = customBudget("2026-10-15T18:00:00Z", NOW, "2026-10-15T09:00:00Z", { tz: "UTC" });
    expect(r.ok).toBe(true);
    const b = (r as { budget: TimeBudget }).budget;
    expect(b.start).toBe("2026-10-15T09:00:00.000Z");
    expect(budgetDurationMs(b)).toBe(9 * HOUR);
    expect(elapsedMs(b, NOW)).toBe(0);
  });

  it("refuses an end in the past, over 14 days away, under 5 minutes, before its start, or unreadable", () => {
    const err = (r: ReturnType<typeof customBudget>) => (r.ok ? "" : r.error);
    expect(err(customBudget("2026-10-14T14:00:00Z", NOW))).toMatch(/in the past/);
    expect(err(customBudget("2026-10-29T15:00:01Z", NOW))).toMatch(/at most 14 days/);
    expect(customBudget("2026-10-28T15:00:00Z", NOW).ok).toBe(true); // exactly 14 days
    expect(err(customBudget("2026-10-14T15:04:00Z", NOW))).toMatch(/at least 5 minutes/);
    expect(err(customBudget("2026-10-15T10:00:00Z", NOW, "2026-10-15T11:00:00Z"))).toMatch(/start must be before its end/);
    expect(err(customBudget("next week", NOW))).toMatch(/ISO 8601/);
    expect(err(customBudget("2026-02-31T10:00", NOW))).toMatch(/ISO 8601/);
  });
});

describe("the budget token a caller sends", () => {
  it("takes the chips, their aliases, lengths and ISO durations", () => {
    for (const chip of ["30m", "1h", "morning", "1d"] as const) {
      const r = parseBudgetToken(chip, NOW, SOFIA);
      expect(r.ok && r.budget?.preset).toBe(chip);
    }
    expect((parseBudgetToken("tomorrow-morning", NOW, SOFIA) as { budget: TimeBudget }).budget.preset).toBe("morning");
    const ninety = parseBudgetToken("90m", NOW, SOFIA);
    expect(ninety).toEqual({ ok: true, budget: expect.objectContaining({ preset: "custom", label: "1 h 30 min", deadline: "2026-10-14T16:30:00.000Z" }) });
    // A length that IS a chip reads back as the chip.
    expect((parseBudgetToken("60 min", NOW, SOFIA) as { budget: TimeBudget }).budget.preset).toBe("1h");
    expect((parseBudgetToken("24h", NOW, SOFIA) as { budget: TimeBudget }).budget.preset).toBe("1d");
    expect((parseBudgetToken("PT2H", NOW, SOFIA) as { budget: TimeBudget }).budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(parseDuration("1.5 hours")).toBe(90 * MIN);
    expect(parseDuration("2,5h")).toBe(150 * MIN);
    expect(parseDuration("soon")).toBeNull();
  });

  it("takes an end time and a start/end period", () => {
    expect((parseBudgetToken("2026-10-15T18:00", NOW, SOFIA) as { budget: TimeBudget }).budget.deadline).toBe("2026-10-15T15:00:00.000Z");
    const period = parseBudgetToken("2026-10-15T09:00:00Z/2026-10-15T18:00:00Z", NOW, SOFIA);
    expect(period).toEqual({ ok: true, budget: expect.objectContaining({ start: "2026-10-15T09:00:00.000Z", deadline: "2026-10-15T18:00:00.000Z" }) });
  });

  it("reads \"none\" as an explicit no-budget", () => {
    expect(parseBudgetToken("none", NOW, SOFIA)).toEqual({ ok: true, budget: null });
    expect(parseBudgetToken("NONE", NOW, SOFIA)).toEqual({ ok: true, budget: null });
  });

  it("refuses junk, a past end and one too far away — with a sentence that says what it takes", () => {
    const junk = parseBudgetToken("soonish", NOW, SOFIA);
    expect(junk.ok).toBe(false);
    expect((junk as { error: string }).error).toMatch(/"soonish" is not one this box knows.*30m, 1h, morning or 1d/);
    expect((parseBudgetToken("", NOW, SOFIA) as { ok: boolean }).ok).toBe(false);
    expect((parseBudgetToken("x".repeat(500), NOW, SOFIA) as { ok: boolean }).ok).toBe(false);
    expect((parseBudgetToken("2026-10-01T10:00:00Z", NOW, SOFIA) as { error: string }).error).toMatch(/in the past/);
    expect((parseBudgetToken("15d", NOW, SOFIA) as { error: string }).error).toMatch(/at most 14 days/);
    expect((parseBudgetToken("3m", NOW, SOFIA) as { error: string }).error).toMatch(/at least 5 minutes/);
    expect((parseBudgetToken("a/b/c", NOW, SOFIA) as { ok: boolean }).ok).toBe(false);
  });

  it("refuses the names an object inherits — a 400 sentence, never a deadline of NaN", () => {
    for (const token of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const r = parseBudgetToken(token, NOW, SOFIA);
      expect(r, token).toMatchObject({ ok: false, error: expect.stringMatching(/is not one this box knows/) });
    }
  });

  it("takes exactly the 5-minute floor and the 14-day ceiling", () => {
    expect(parseBudgetToken("5m", NOW, SOFIA)).toEqual({ ok: true, budget: expect.objectContaining({ deadline: "2026-10-14T15:05:00.000Z" }) });
    expect(parseBudgetToken("14d", NOW, SOFIA)).toEqual({ ok: true, budget: expect.objectContaining({ deadline: "2026-10-28T15:00:00.000Z" }) });
  });

  it("takes the object shapes the start UI sends, and refuses anything else", () => {
    expect((readBudgetInput({ preset: "1h" }, NOW, SOFIA) as { budget: TimeBudget }).budget.preset).toBe("1h");
    expect(readBudgetInput({ preset: "none" }, NOW, SOFIA)).toEqual({ ok: true, budget: null });
    const custom = readBudgetInput({ preset: "custom", start: "2026-10-15T09:00", end: "2026-10-15T18:00" }, NOW, SOFIA);
    expect(custom).toEqual({ ok: true, budget: expect.objectContaining({ preset: "custom", start: "2026-10-15T06:00:00.000Z", deadline: "2026-10-15T15:00:00.000Z" }) });
    // A budget this box answered can be sent back: `deadline` reads as the end.
    const back = readBudgetInput({ preset: "custom", deadline: "2026-10-15T15:00:00.000Z", label: "Until Thu 15 Oct, 18:00" }, NOW, SOFIA);
    expect(back.ok && back.budget?.label).toBe("Until Thu 15 Oct, 18:00");
    for (const bad of [42, true, ["1h"], { preset: "2 weeks" }, { preset: "custom" }]) {
      expect(readBudgetInput(bad, NOW, SOFIA).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the task's words — English", () => {
  it("reads the presets' phrasing", () => {
    expect(ok("Build a scraper. You have 30 minutes.").budget).toMatchObject({ preset: "30m", source: "text", deadline: "2026-10-14T15:30:00.000Z" });
    expect(ok("You have an hour to fix the login page").budget.preset).toBe("1h");
    expect(ok("Work until tomorrow morning on the scraper").budget).toMatchObject({ preset: "morning", deadline: "2026-10-15T05:00:00.000Z" });
    expect(ok("you have 1 day for the dashboard").budget.preset).toBe("1d");
    expect(ok("1 day").budget.preset).toBe("1d");
    expect(ok("Build the dashboard. Budget: 1 day.").budget.preset).toBe("1d");
  });

  it("reads lengths and deadlines", () => {
    const twoHours = ok("For 2 hours, polish the settings page");
    expect(twoHours.budget).toMatchObject({ preset: "custom", label: "2 hours", deadline: "2026-10-14T17:00:00.000Z" });
    expect(twoHours.match).toEqual({ phrase: "For 2 hours", index: 0, lang: "en" });
    expect(ok("Fix it, until Friday 18:00").budget).toMatchObject({ preset: "custom", deadline: "2026-10-16T15:00:00.000Z", label: "Until Fri 16 Oct, 18:00" });
    expect(ok("You have until Friday 6pm").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
    expect(ok("you have an hour and a half").budget.deadline).toBe("2026-10-14T16:30:00.000Z");
    expect(ok("Take half an hour.").budget.preset).toBe("30m");
    expect(ok("work for the next 3 hours").budget.deadline).toBe("2026-10-14T18:00:00.000Z");
    expect(ok("keep working until 23:30").budget.deadline).toBe("2026-10-14T20:30:00.000Z");
  });

  it("rolls a weekday or a time already gone to the next one", () => {
    const fridayEvening = Date.parse("2026-10-16T16:00:00Z"); // Fri 19:00 in Sofia
    expect(ok("until Friday 18:00", fridayEvening).budget.deadline).toBe("2026-10-23T15:00:00.000Z");
    const fridayMorning = Date.parse("2026-10-16T07:00:00Z"); // Fri 10:00
    expect(ok("until Friday 18:00", fridayMorning).budget.deadline).toBe("2026-10-16T15:00:00.000Z");
    // 17:00 has passed at 18:00 — tomorrow's.
    expect(ok("finish by 17:00").budget.deadline).toBe("2026-10-15T14:00:00.000Z");
    // A day without a time: weekdays end at 18:00, tomorrow is its morning.
    expect(ok("work until Monday").budget.deadline).toBe("2026-10-19T15:00:00.000Z");
    expect(ok("work until tomorrow").budget.deadline).toBe("2026-10-15T05:00:00.000Z");
  });

  it("does not read a feature's own times as a budget", () => {
    for (const text of [
      "Cache results for 2 hours",
      "Add a time limit of 30 minutes to quizzes",
      "Show tasks whose deadline is tomorrow",
      "It took 1.5 hours. Done",
      "Login page (2 hours)\n- Settings (1 day)",
      "you have days of data to clean",
      "keep sessions alive for 2 hours.",
      "Open from 9:00 until 18:00 on weekdays",
      "Each request should take 5 minutes at most",
      "Retry until the server answers",
      "",
    ]) {
      expect(parseBudgetFromText(text, NOW, SOFIA), text).toBeNull();
    }
  });

  it("answers a stated budget it will not take with the reason, so the start UI can say so", () => {
    const far = parseBudgetFromText("Work for 20 days on the rewrite", NOW, SOFIA);
    expect(far).toMatchObject({ ok: false, match: { phrase: "Work for 20 days" } });
    expect((far as { error: string }).error).toMatch(/at most 14 days/);
    expect(parseBudgetFromText("work until today 10:00", NOW, SOFIA)).toMatchObject({ ok: false, error: expect.stringMatching(/in the past/) });
    expect(parseBudgetFromText("you have 2 minutes", NOW, SOFIA)).toMatchObject({ ok: false, error: expect.stringMatching(/at least 5 minutes/) });
  });

  it("takes the first statement when the words state two", () => {
    expect(ok("You have 30 minutes. Later: work until Friday 18:00.").budget.preset).toBe("30m");
  });
});

describe("the task's words — Bulgarian", () => {
  it("reads the presets' phrasing", () => {
    expect(ok("Имаш 30 минути за задачата").budget).toMatchObject({ preset: "30m", source: "text" });
    expect(ok("Имаш 30 минути за задачата").match.lang).toBe("bg");
    expect(ok("имаш един час").budget.preset).toBe("1h");
    expect(ok("имаш час").budget.preset).toBe("1h");
    expect(ok("Работи до утре сутринта по скрейпъра").budget).toMatchObject({ preset: "morning", deadline: "2026-10-15T05:00:00.000Z" });
    expect(ok("За един ден направи сайта").budget.preset).toBe("1d");
    expect(ok("имате половин час").budget.preset).toBe("30m");
  });

  it("reads lengths and deadlines", () => {
    expect(ok("За 2 часа направи страницата").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(ok("До петък 18:00 направи сайта").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
    expect(ok("работи до петък в 18 ч.").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
    expect(ok("имаш час и половина").budget.deadline).toBe("2026-10-14T16:30:00.000Z");
  });

  it("does not read a feature's own times as a budget", () => {
    expect(parseBudgetFromText("Магазинът работи до 18:00", NOW, SOFIA)).toBeNull();
    expect(parseBudgetFromText("Кеширай резултатите за 2 часа", NOW, SOFIA)).toBeNull();
  });
});

describe("the task's words — German", () => {
  it("reads the presets' phrasing", () => {
    expect(ok("Du hast 30 Minuten.").budget).toMatchObject({ preset: "30m", source: "text" });
    expect(ok("Du hast 30 Minuten.").match.lang).toBe("de");
    expect(ok("Für eine Stunde: räume die Einstellungen auf").budget.preset).toBe("1h");
    expect(ok("Arbeite bis morgen früh an dem Scraper").budget).toMatchObject({ preset: "morning", deadline: "2026-10-15T05:00:00.000Z" });
    expect(ok("Du hast einen Tag").budget.preset).toBe("1d");
    expect(ok("du hast eine halbe Stunde").budget.preset).toBe("30m");
  });

  it("reads lengths and deadlines", () => {
    expect(ok("Für 2 Stunden: baue die Seite").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(ok("Bis Freitag 18 Uhr fertig").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
    expect(ok("Du hast anderthalb Stunden").budget.deadline).toBe("2026-10-14T16:30:00.000Z");
    expect(ok("Du hast 1,5 Stunden").budget.deadline).toBe("2026-10-14T16:30:00.000Z");
    expect(ok("arbeite bis Freitag um 18.00 Uhr").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
  });

  it("does not read a feature's own times as a budget", () => {
    expect(parseBudgetFromText("Öffnungszeiten: 9 bis 18 Uhr", NOW, SOFIA)).toBeNull();
    expect(parseBudgetFromText("Sitzungen laufen nach 2 Stunden ab", NOW, SOFIA)).toBeNull();
  });
});

describe("the task's words — a part of the day, and a day after its time", () => {
  // NOW is Wednesday 18:00 in Sofia (UTC+3): Thursday 18:00 is 15:00 UTC.
  it("reads the part of the day a deadline names, rather than the day's default hour", () => {
    expect(ok("work until tomorrow evening").budget).toMatchObject({ preset: "custom", deadline: "2026-10-15T15:00:00.000Z", label: "Until Thu 15 Oct, 18:00" });
    expect(ok("work until tomorrow afternoon").budget.deadline).toBe("2026-10-15T12:00:00.000Z");
    expect(ok("work until tomorrow night").budget.deadline).toBe("2026-10-15T19:00:00.000Z");
    expect(ok("until tomorrow at noon").budget.deadline).toBe("2026-10-15T09:00:00.000Z");
    expect(ok("until Friday morning").budget.deadline).toBe("2026-10-16T05:00:00.000Z");
    expect(ok("до утре вечер").budget.deadline).toBe("2026-10-15T15:00:00.000Z");
    expect(ok("работи до петък сутринта").budget.deadline).toBe("2026-10-16T05:00:00.000Z");
    expect(ok("bis morgen Abend").budget.deadline).toBe("2026-10-15T15:00:00.000Z");
    expect(ok("bis Freitagabend").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
  });

  it("reads a time within that part of the day, and a time within the morning", () => {
    expect(ok("until tomorrow evening at 7").budget.deadline).toBe("2026-10-15T16:00:00.000Z"); // 19:00, not 07:00
    expect(ok("bis Freitag Abend um 20 Uhr").budget.deadline).toBe("2026-10-16T17:00:00.000Z");
    expect(ok("work until tomorrow morning at 10").budget).toMatchObject({ preset: "custom", deadline: "2026-10-15T07:00:00.000Z" });
  });

  it("reads the day that FOLLOWS a time, rather than today's", () => {
    expect(ok("work until 6pm tomorrow").budget.deadline).toBe("2026-10-15T15:00:00.000Z");
    expect(ok("until 18:00 Friday").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
    expect(ok("bis 18 Uhr am Freitag").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
    expect(ok("до 18:00 в петък").budget.deadline).toBe("2026-10-16T15:00:00.000Z");
    expect(ok("до 18 ч. утре").budget.deadline).toBe("2026-10-15T15:00:00.000Z");
  });

  it("reads tonight and the end of the day as today's", () => {
    expect(ok("work until tonight").budget.deadline).toBe("2026-10-14T19:00:00.000Z"); // 22:00
    expect(ok("до довечера").budget.deadline).toBe("2026-10-14T19:00:00.000Z");
    const tenAm = Date.parse("2026-10-14T07:00:00Z"); // 10:00 in Sofia
    for (const text of ["work until end of day", "работи до края на деня", "bis Feierabend", "until this evening"]) {
      expect(ok(text, tenAm).budget.deadline, text).toBe("2026-10-14T15:00:00.000Z");
    }
    // Said at 18:00, the end of today has come: understood, and refused with the reason.
    expect(parseBudgetFromText("work until end of day", NOW, SOFIA)).toMatchObject({ ok: false, error: expect.stringMatching(/in the past/) });
  });
});

describe("the task's words — who they are said to", () => {
  it("does not read a verb said of the thing being built as the agent's budget", () => {
    for (const text of [
      "Add a time budget of 30 minutes to the export job",
      "The poller should work for 2 hours before retrying",
      "Make it work until 18:00",
      "The job must finish within 30 minutes",
      "The report should be done by 17:00",
      "Der Server arbeitet bis 18 Uhr",
      "Der Bericht soll fertig bis 17 Uhr sein",
    ]) {
      expect(parseBudgetFromText(text, NOW, SOFIA), text).toBeNull();
    }
  });

  it("still reads the owner telling the agent, mid-sentence or not", () => {
    expect(ok("I want you to work for 2 hours on this").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(ok("Please work for 2 hours").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(ok("You should work until tomorrow morning").budget.preset).toBe("morning");
    expect(ok("Build the scraper and keep working until morning").budget.preset).toBe("morning");
    expect(ok("Your time budget is 2 hours").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(ok("Time budget: 2 hours").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(ok("Arbeitet bis morgen früh!").budget.preset).toBe("morning");
  });

  it("reads a bare unit after \"next\", the Bulgarian plural of hours, and the words before an amount", () => {
    expect(ok("Work for the next hour on the parser").budget.preset).toBe("1h");
    expect(ok("für die nächste Stunde").budget.preset).toBe("1h");
    expect(ok("през следващия час").budget.preset).toBe("1h");
    expect(ok("за 24 часове").budget.preset).toBe("1d");
    expect(ok("имаш 3 часове").budget.deadline).toBe("2026-10-14T18:00:00.000Z");
    for (const text of ["You still have 30 minutes", "du hast noch 30 Minuten", "имаш още 30 минути"]) {
      expect(ok(text).budget.preset, text).toBe("30m");
    }
    expect(ok("you have at most 2 hours").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(ok("du hast noch etwa 2 Stunden").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
  });

  it("reads a typographic apostrophe and a decomposed umlaut like the plain ones", () => {
    expect(ok("You’ve got 2 hours").budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    // "u" and a combining diaeresis, as some keyboards and pastes send it.
    const decomposed = ok("Fu\u0308r 2 Stunden: baue die Seite");
    expect(decomposed.budget.deadline).toBe("2026-10-14T17:00:00.000Z");
    expect(decomposed.match.lang).toBe("de");
  });
});

describe("which budget wins", () => {
  const text = "You have 2 hours to build it";

  it("the picker beats the words, and the words beat the default", () => {
    const picked = resolveBudget({ explicit: "30m", text, defaultPreset: "1d" }, NOW, SOFIA);
    expect(picked).toMatchObject({ ok: true, from: "picker", budget: { preset: "30m", source: "picker" } });
    const said = resolveBudget({ text, defaultPreset: "1d" }, NOW, SOFIA);
    expect(said).toMatchObject({ ok: true, from: "text", budget: { source: "text", deadline: "2026-10-14T17:00:00.000Z" } });
    const fallback = resolveBudget({ text: "Build it", defaultPreset: "1d" }, NOW, SOFIA);
    expect(fallback).toMatchObject({ ok: true, from: "default", budget: { preset: "1d", source: "default" } });
  });

  it("\"none\" beats the words and the default; absent or null decides nothing", () => {
    expect(resolveBudget({ explicit: "none", text, defaultPreset: "1d" }, NOW, SOFIA)).toEqual({ ok: true, budget: null, from: "none", text: null });
    expect(resolveBudget({ explicit: null, text }, NOW, SOFIA)).toMatchObject({ from: "text" });
    expect(resolveBudget({ text: "Build it" }, NOW, SOFIA)).toMatchObject({ ok: true, budget: null, from: "none" });
  });

  it("refuses an explicit budget it cannot read rather than falling back", () => {
    const r = resolveBudget({ explicit: "whenever", text, defaultPreset: "1h" }, NOW, SOFIA);
    expect(r.ok).toBe(false);
  });

  it("ignores words it will not take, says so, and lets the default stand", () => {
    const r = resolveBudget({ text: "Work for 20 days on it", defaultPreset: "1h" }, NOW, SOFIA);
    expect(r).toMatchObject({ ok: true, from: "default", budget: { preset: "1h" }, text: { ok: false } });
  });

  it("ignores a default that is not a chip", () => {
    expect(resolveBudget({ text: "Build it", defaultPreset: "custom" }, NOW, SOFIA)).toMatchObject({ budget: null, from: "none" });
  });
});

describe("routing and the clock", () => {
  it("sends a budget over 30 minutes to a team, and keeps 30 minutes or less on one run", () => {
    expect(TEAM_BUDGET_THRESHOLD_MS).toBe(30 * MIN);
    expect(needsTeam(presetBudget("30m", NOW, SOFIA))).toBe(false);
    expect(needsTeam((parseBudgetToken("31m", NOW, SOFIA) as { budget: TimeBudget }).budget)).toBe(true);
    expect(needsTeam(presetBudget("1h", NOW, SOFIA))).toBe(true);
    expect(needsTeam(presetBudget("morning", NOW, SOFIA))).toBe(true);
    expect(needsTeam(null)).toBe(false);
    expect(needsTeam(undefined)).toBe(false);
  });

  it("measures a picked period from its start, not from when it was picked", () => {
    const r = customBudget("2026-10-16T09:20:00Z", NOW, "2026-10-16T09:00:00Z", { tz: "UTC" });
    expect(needsTeam((r as { budget: TimeBudget }).budget)).toBe(false);
  });

  it("says how much is left and how much is used, never negative", () => {
    const b = presetBudget("1h", NOW, SOFIA);
    expect(remainingMs(b, NOW + 20 * MIN)).toBe(40 * MIN);
    expect(elapsedMs(b, NOW + 20 * MIN)).toBe(20 * MIN);
    expect(remainingMs(b, NOW + 2 * HOUR)).toBe(0);
    expect(elapsedMs(b, NOW - MIN)).toBe(0);
    expect(MAX_BUDGET_MS).toBe(14 * DAY);
  });

  it("words spans and deadlines in English on the box's clock", () => {
    expect(formatDuration(45 * MIN)).toBe("45 minutes");
    expect(formatDuration(MIN)).toBe("1 minute");
    expect(formatDuration(2 * HOUR)).toBe("2 hours");
    expect(formatDuration(90 * MIN)).toBe("1 h 30 min");
    expect(formatDuration(3 * DAY)).toBe("3 days");
    expect(formatDuration(DAY + 4 * HOUR)).toBe("1 d 4 h");
    expect(formatLocalDeadline("2026-10-16T15:00:00.000Z", SOFIA)).toBe("Fri 16 Oct, 18:00");
    expect(describeBudget(presetBudget("1h", NOW, SOFIA), NOW + 18 * MIN, SOFIA)).toBe("1 hour, until Wed 14 Oct, 19:00 (Europe/Sofia) — 42 minutes left");
    expect(describeBudget(presetBudget("morning", NOW, SOFIA), NOW, SOFIA)).toBe("Until tomorrow morning (Thu 15 Oct, 08:00) (Europe/Sofia) — 14 hours left");
  });
});

describe("a stored budget read back", () => {
  it("round-trips what this module wrote", () => {
    const b = (parseBudgetToken("2026-10-15T09:00:00Z/2026-10-15T18:00:00Z", NOW, SOFIA) as { budget: TimeBudget }).budget;
    expect(readTimeBudget(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(readTimeBudget(presetBudget("morning", NOW, SOFIA))).toEqual(presetBudget("morning", NOW, SOFIA));
  });

  it("is no budget when the file holds anything this module could not have written", () => {
    const good = presetBudget("1h", NOW, SOFIA);
    for (const bad of [
      null, "1h", [good], { ...good, deadline: "tomorrow" }, { ...good, deadline: "2026-10-14T16:00:00+02:00" },
      { ...good, preset: "2h" }, { ...good, source: "guess" }, { ...good, label: "" }, { ...good, start: "soon" },
      { ...good, setAt: undefined },
    ]) {
      expect(readTimeBudget(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(readTimeBudget({ ...good, label: "1 hour\n\u0007rm -rf" })?.label).toBe("1 hour rm -rf");
  });
});

describe("the time records", () => {
  const budget = presetBudget("1h", NOW, SOFIA);
  const records = [
    timeRecord("budget", "1 hour, from the picker", NOW),
    timeRecord("plan", "Scraper first, then scrape", NOW + MIN, { estimateMs: 50 * MIN }),
    timeRecord("estimate", "build and test the scraper", NOW + MIN, { taskId: "t1", estimateMs: 30 * MIN }),
    timeRecord("estimate", "scrape until the deadline", NOW + MIN, { taskId: "t2", estimateMs: 20 * MIN }),
    timeRecord("skip", "e2e suite: not needed in an hour", NOW + MIN, { taskId: "t3" }),
    timeRecord("finish", "scraper built", NOW + 26 * MIN, { taskId: "t1", actualMs: 25 * MIN }),
    timeRecord("extra", "added a retry test", NOW + 40 * MIN),
    timeRecord("stop", "deadline reached; last commit kept", NOW + 59 * MIN, { reason: "time", tokensUsed: 420_000 }),
  ];

  it("sums up into the JSON artifact: estimate, per task, used, left, why it stopped", () => {
    // Out of order on purpose: the stop line first. They are sorted by time.
    const s = summarizeTimeRecords(budget, [records[7], ...records.slice(0, 7)], NOW + 2 * HOUR);
    expect(s).toMatchObject({
      estimateMs: 50 * MIN,
      startedAt: "2026-10-14T15:00:00.000Z",
      finishedAt: "2026-10-14T15:59:00.000Z",
      usedMs: 59 * MIN,
      leftMs: MIN,
      stopReason: "time",
      tokenCap: null,
      tokensUsed: 420_000,
      extras: ["added a retry test"],
      skipped: ["e2e suite: not needed in an hour"],
    });
    expect(s.tasks).toEqual([
      { taskId: "t1", estimateMs: 30 * MIN, actualMs: 25 * MIN },
      { taskId: "t2", estimateMs: 20 * MIN, actualMs: null },
      { taskId: "t3", estimateMs: null, actualMs: null },
    ]);
    expect(s.records.map((r) => r.kind)[0]).toBe("budget");
  });

  it("sums the task estimates when the plan gave none, and counts to now while it works", () => {
    const s = summarizeTimeRecords(budget, records.filter((r) => r.kind !== "plan" && r.kind !== "stop"), NOW + 30 * MIN);
    expect(s).toMatchObject({ estimateMs: 50 * MIN, finishedAt: null, usedMs: 30 * MIN, leftMs: null, stopReason: null });
  });

  it("writes one log line per record, on the box's clock", () => {
    expect(formatTimeRecordLine(records[2], SOFIA)).toBe("2026-10-14 18:01 [estimate] t1 — ~30 minutes — build and test the scraper");
    expect(formatTimeRecordLine(records[7], SOFIA)).toBe("2026-10-14 18:59 [stop] reason: time — 420000 tokens so far — deadline reached; last commit kept");
  });

  it("reads a record back strictly, and keeps its text to one line", () => {
    expect(readTimeRecord(JSON.parse(JSON.stringify(records[5])))).toEqual(records[5]);
    expect(readTimeRecord({ at: "now", kind: "stop", text: "x" })).toBeNull();
    expect(readTimeRecord({ at: "2026-10-14T15:00:00.000Z", kind: "party", text: "x" })).toBeNull();
    expect(timeRecord("note", "two\nlines", NOW).text).toBe("two lines");
    expect(readTimeRecord({ at: "2026-10-14T15:00:00.000Z", kind: "stop", text: "x", reason: "bored", estimateMs: -5 })).toEqual({ at: "2026-10-14T15:00:00.000Z", kind: "stop", text: "x" });
  });
});

describe("the spend ceiling beside the time ceiling (item 11)", () => {
  it("stops at whichever comes first, time or cost, and names which", () => {
    const b = { ...presetBudget("1d", NOW, SOFIA), tokenCap: 1_000_000 };
    expect(budgetStopReason(b, NOW + HOUR, 999_999)).toBeNull();
    expect(budgetStopReason(b, NOW + HOUR, 1_000_000)).toBe("cost");
    expect(budgetStopReason(b, NOW + DAY, 10)).toBe("time");
    // Both gone at one check: the deadline is named.
    expect(budgetStopReason(b, NOW + DAY, 5_000_000)).toBe("time");
    // No ceiling of its own: only the clock stops it.
    expect(budgetStopReason(presetBudget("1d", NOW, SOFIA), NOW + HOUR, 9e12)).toBeNull();
  });

  it("gives a budget over two hours the owner's token cap when it names none — and only then", () => {
    const day = presetBudget("1d", NOW, SOFIA);
    expect(withDefaultTokenCap(day, 500_000).tokenCap).toBe(500_000);
    expect(withDefaultTokenCap(day, null)).toEqual(day);
    expect(withDefaultTokenCap(presetBudget("1h", NOW, SOFIA), 500_000)).not.toHaveProperty("tokenCap");
    const twoHours = (parseBudgetToken("2h", NOW, SOFIA) as { budget: TimeBudget }).budget;
    expect(withDefaultTokenCap(twoHours, 500_000)).not.toHaveProperty("tokenCap"); // exactly two hours is not "over"
    expect(withDefaultTokenCap({ ...day, tokenCap: 20_000 }, 500_000).tokenCap).toBe(20_000);
    expect(resolveBudget({ explicit: "1d", defaultTokenCap: 500_000 }, NOW, SOFIA)).toMatchObject({ budget: { tokenCap: 500_000 } });
    expect(resolveBudget({ text: "Work until Friday 18:00", defaultTokenCap: 500_000 }, NOW, SOFIA)).toMatchObject({ budget: { source: "text", tokenCap: 500_000 } });
    expect(resolveBudget({ text: "Build it", defaultPreset: "morning", defaultTokenCap: 500_000 }, NOW, SOFIA)).toMatchObject({ budget: { source: "default", tokenCap: 500_000 } });
  });

  it("takes a ceiling named with the budget, and refuses one that is not whole tokens over the floor", () => {
    expect(readBudgetInput({ preset: "1d", tokenCap: 2_000_000 }, NOW, SOFIA)).toMatchObject({ ok: true, budget: { preset: "1d", tokenCap: 2_000_000 } });
    expect(readBudgetInput({ preset: "1d", tokenCap: null }, NOW, SOFIA)).toMatchObject({ ok: true, budget: { preset: "1d" } });
    for (const bad of [5_000, 1.5e6 + 0.5, "lots", -1]) {
      const r = readBudgetInput({ preset: "1d", tokenCap: bad }, NOW, SOFIA);
      expect(r.ok, String(bad)).toBe(false);
      expect((r as { error: string }).error).toMatch(/token ceiling/);
    }
  });

  it("reads a ceiling back off disk, and refuses a budget whose ceiling it could not have written", () => {
    const capped = { ...presetBudget("1d", NOW, SOFIA), tokenCap: 200_000 };
    expect(readTimeBudget(JSON.parse(JSON.stringify(capped)))).toEqual(capped);
    expect(readTimeBudget({ ...capped, tokenCap: 12 })).toBeNull();
    expect(describeBudget(capped, NOW, SOFIA)).toContain("at most 200000 tokens");
  });

  it("carries the spend so far into the summary next to the time", () => {
    const b = { ...presetBudget("1d", NOW, SOFIA), tokenCap: 900_000 };
    const s = summarizeTimeRecords(b, [
      timeRecord("start", "t1", NOW, { taskId: "t1", tokensUsed: 0 }),
      timeRecord("extra", "more tests for the parser", NOW + HOUR, { tokensUsed: 600_000 }),
      timeRecord("stop", "the spend ceiling came first", NOW + 2 * HOUR, { reason: "cost", tokensUsed: 900_000 }),
    ], NOW + 3 * HOUR);
    expect(s).toMatchObject({ stopReason: "cost", tokenCap: 900_000, tokensUsed: 900_000, extras: ["more tests for the parser"] });
    expect(readTimeRecord({ at: "2026-10-14T15:00:00.000Z", kind: "stop", text: "allowlist done", reason: "nothing_left" })?.reason).toBe("nothing_left");
  });
});

describe("the safety margin (item 13)", () => {
  it("is the larger of 10 minutes and a tenth of the budget", () => {
    expect(safetyMarginMs(presetBudget("1h", NOW, SOFIA))).toBe(10 * MIN);
    expect(safetyMarginMs(presetBudget("30m", NOW, SOFIA))).toBe(10 * MIN);
    expect(safetyMarginMs(presetBudget("1d", NOW, SOFIA))).toBe(144 * MIN);
    const threeHours = (parseBudgetToken("3h", NOW, SOFIA) as { budget: TimeBudget }).budget;
    expect(safetyMarginMs(threeHours)).toBe(18 * MIN);
    expect(marginCutoffMs(threeHours)).toBe(NOW + 3 * HOUR - 18 * MIN);
  });

  it("starts nothing after the cutoff, and nothing whose own estimate runs past it", () => {
    const b = presetBudget("1h", NOW, SOFIA); // cutoff at +50 min
    expect(fitsBeforeCutoff(b, NOW, 50 * MIN)).toBe(true);
    expect(fitsBeforeCutoff(b, NOW, 51 * MIN)).toBe(false);
    expect(fitsBeforeCutoff(b, NOW + 40 * MIN, 10 * MIN)).toBe(true);
    expect(fitsBeforeCutoff(b, NOW + 40 * MIN, 11 * MIN)).toBe(false);
    expect(fitsBeforeCutoff(b, NOW + 49 * MIN)).toBe(true); // no estimate: only the cutoff decides
    expect(fitsBeforeCutoff(b, NOW + 50 * MIN)).toBe(false);
    expect(fitsBeforeCutoff(b, NOW + 55 * MIN, 1 * MIN)).toBe(false);
  });

  it("puts the cutoff behind the start of a budget shorter than the margin", () => {
    const tiny = (parseBudgetToken("8m", NOW, SOFIA) as { budget: TimeBudget }).budget;
    expect(marginCutoffMs(tiny)).toBeLessThan(NOW);
    expect(fitsBeforeCutoff(tiny, NOW)).toBe(false);
  });
});

describe("a long or hostile text", () => {
  it("is read in linear time — runs of blank lines or spaced commas once took seconds", () => {
    for (const text of ["\n".repeat(20_000) + "x", ("," + " ".repeat(2_000)).repeat(10) + "x", "for ".repeat(5_000), "1 ".repeat(10_000)]) {
      const t = performance.now();
      parseBudgetFromText(text, NOW, SOFIA);
      expect(performance.now() - t, JSON.stringify(text.slice(0, 12))).toBeLessThan(1_000);
    }
  });

  it("reads only the first 20 000 characters", () => {
    expect(parseBudgetFromText(`${"x ".repeat(5_000)}You have 2 hours.`, NOW, SOFIA)?.ok).toBe(true);
    expect(parseBudgetFromText(`${"x ".repeat(10_000)}You have 2 hours.`, NOW, SOFIA)).toBeNull();
  });

  it("still sees a clause cue after a bullet, a bracket or a line break — and not mid-sentence", () => {
    expect(ok("Plan:\n- for 2 hours build the scraper").budget.label).toBe("2 hours");
    expect(ok("Scope (for 2 hours) is the scraper").budget.label).toBe("2 hours");
    expect(ok("Build it.\n\n   for 2 hours").budget.label).toBe("2 hours");
    expect(parseBudgetFromText("store it - for 2 hours", NOW, SOFIA)).toBeNull();
    expect(parseBudgetFromText("Build the cache:for 2 hours", NOW, SOFIA)).toBeNull();
  });
});
