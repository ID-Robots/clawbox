/**
 * The planning rules of a budgeted run or team (src/lib/coding-time-plan.ts):
 * the extra-work allowlist and its scope, the claims an agent writes about
 * spare time, how an estimate is read, when a task is behind, what is cut
 * when time is short, and whether the next item may start.
 *
 * Every case passes its own `now`: nothing here may depend on the machine's
 * clock or zone.
 */
import { describe, expect, it } from "vitest";
import { presetBudget, summarizeTimeRecords, timeRecord, type TimeBudget } from "@/lib/coding-time-budget";
import {
  calibrateEstimate,
  calibrationApplies,
  calibrationBrief,
  calibrationNote,
  CALIBRATION_MAX_FACTOR,
  CALIBRATION_MAX_SAMPLES,
  CALIBRATION_MIN_FACTOR,
  checkExtraItem,
  cutFromBottom,
  estimateAccuracyLine,
  estimateCalibration,
  estimateSamples,
  EXTRA_ITEM_ESTIMATE_MS,
  EXTRA_SCOPE_DIRS,
  EXTRA_WORK_KINDS,
  extraWorkPrompt,
  extraWorkScope,
  isBehindEstimate,
  lastExtraClaim,
  MAX_ESTIMATE_MS,
  MAX_EXTRA_FILES,
  MAX_EXTRA_ITEMS,
  MAX_EXTRA_SUMMARY_CHARS,
  mustHaveFits,
  nextItemAllowed,
  parseEstimateMinutes,
  parseExtraClaim,
  readExtraKind,
} from "@/lib/coding-time-plan";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 14, 15, 0);
const SOFIA = "Europe/Sofia";

/** One hour from NOW: the safety margin is 10 minutes, so no new item starts after NOW + 50 min. */
const hour = (): TimeBudget => presetBudget("1h", NOW, SOFIA);

describe("the extra-work allowlist", () => {
  it("is exactly the five kinds the prompt names", () => {
    expect(EXTRA_WORK_KINDS).toEqual(["tests", "fixes", "edge_cases", "docs", "verify"]);
  });

  it("reads a kind in any case and with a space or hyphen for the underscore", () => {
    expect(readExtraKind("Edge cases")).toBe("edge_cases");
    expect(readExtraKind("edge-cases")).toBe("edge_cases");
    expect(readExtraKind(" TESTS ")).toBe("tests");
    expect(readExtraKind("refactor")).toBeNull();
    expect(readExtraKind("constructor")).toBeNull();
    expect(readExtraKind(42)).toBeNull();
  });
});

describe("checkExtraItem", () => {
  const scope = ["src/lib/coding-time-plan.ts", "src/tests/unit/", "docs/time-budget.md"];

  it("lets through an allowed kind touching only the task's files", () => {
    expect(checkExtraItem({ kind: "tests", files: ["src/tests/unit/coding-time-plan.test.ts"] }, scope)).toEqual({ ok: true });
    expect(checkExtraItem({ kind: "fixes", files: ["./src/lib//coding-time-plan.ts"] }, scope)).toEqual({ ok: true });
    expect(checkExtraItem({ kind: "docs", files: ["docs\\time-budget.md"] }, scope)).toEqual({ ok: true });
  });

  it("lets through an item that touches no file at all", () => {
    expect(checkExtraItem({ kind: "verify", files: [] }, scope)).toEqual({ ok: true });
    expect(checkExtraItem({ kind: "verify" }, [])).toEqual({ ok: true });
  });

  it("reads a scope directory written with /** like one written with /", () => {
    expect(checkExtraItem({ kind: "tests", files: ["src/tests/unit/a.test.ts"] }, ["src/tests/**"])).toEqual({ ok: true });
  });

  it("refuses a kind that is not on the allowlist, saying which are", () => {
    const r = checkExtraItem({ kind: "refactor", files: [] }, scope);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("tests, fixes, edge_cases, docs, verify");
      expect(r.error).toContain('"refactor"');
    }
    expect(checkExtraItem({ kind: undefined, files: [] }, scope).ok).toBe(false);
  });

  it("refuses a file outside the scope, and names it", () => {
    const r = checkExtraItem({ kind: "fixes", files: ["src/lib/coding-time-plan.ts", "src/lib/coding-agent.ts"] }, scope);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('"src/lib/coding-agent.ts" is outside') });
  });

  it("does not take a file's name as its directory: a scope file is not a prefix", () => {
    expect(checkExtraItem({ kind: "fixes", files: ["src/lib/coding-time-plan.ts.bak"] }, scope).ok).toBe(false);
    expect(checkExtraItem({ kind: "tests", files: ["src/tests/unitx/a.test.ts"] }, scope).ok).toBe(false);
  });

  it.each([
    ["a parent traversal", "src/tests/unit/../../lib/coding-agent.ts"],
    ["an absolute path", "/etc/passwd"],
    ["a drive letter", "C:/Windows/win.ini"],
    ["a directory", "src/tests/unit/"],
    ["an empty name", "  "],
    ["a NUL byte", `src/tests/unit/a${String.fromCharCode(0)}.ts`],
  ])("refuses %s", (_label, file) => {
    expect(checkExtraItem({ kind: "tests", files: [file] }, scope).ok).toBe(false);
  });

  it("refuses a scope entry that walks out of the repo instead of honouring it", () => {
    expect(checkExtraItem({ kind: "fixes", files: ["etc/passwd"] }, ["../etc/", "/etc/passwd"]).ok).toBe(false);
  });

  it("refuses an item naming more files than one step should touch", () => {
    const files = Array.from({ length: MAX_EXTRA_FILES + 1 }, (_, i) => `src/tests/unit/t${i}.test.ts`);
    expect(checkExtraItem({ kind: "tests", files }, scope)).toEqual({ ok: false, error: expect.stringContaining(`at most ${MAX_EXTRA_FILES}`) });
  });

  it("refuses files that are not a list", () => {
    expect(checkExtraItem({ kind: "tests", files: "src/tests/unit/a.ts" as unknown as string[] }, scope).ok).toBe(false);
  });

  it("lets a test or doc file sit beside a scoped file, but no other new file", () => {
    const flat = ["app.js", "lib/parse.ts"];
    expect(checkExtraItem({ kind: "tests", files: ["app.test.js"] }, flat)).toEqual({ ok: true });
    expect(checkExtraItem({ kind: "tests", files: ["lib/parse.spec.ts", "lib/test_parse.py"] }, flat)).toEqual({ ok: true });
    expect(checkExtraItem({ kind: "docs", files: ["lib/NOTES.md"] }, flat)).toEqual({ ok: true });
    expect(checkExtraItem({ kind: "fixes", files: ["server.js"] }, flat).ok).toBe(false);
    expect(checkExtraItem({ kind: "tests", files: ["other/app.test.js"] }, flat).ok).toBe(false);
  });
});

describe("extraWorkScope", () => {
  it("is the task's files, their folders, and the repo's test and doc places", () => {
    expect(extraWorkScope(["index.html", "src/lib/parse.ts", "./src/lib/parse.ts", "src/lib/fmt.ts"])).toEqual([
      "index.html",
      "src/lib/parse.ts",
      "src/lib/",
      "src/lib/fmt.ts",
      ...EXTRA_SCOPE_DIRS,
      "README.md",
      "CHANGELOG.md",
    ]);
  });

  it("adds nothing for a path outside the repo, and never the whole repo", () => {
    const scope = extraWorkScope(["/home/clawbox/.bashrc", "../up.txt", "", 42]);
    expect(scope).toEqual([...EXTRA_SCOPE_DIRS, "README.md", "CHANGELOG.md"]);
    expect(scope).not.toContain("/");
    expect(checkExtraItem({ kind: "fixes", files: ["src/app.ts"] }, scope).ok).toBe(false);
  });
});

describe("lastExtraClaim", () => {
  it("reads the claim a reply ends on, its correction over an earlier one", () => {
    expect(lastExtraClaim("Added tests.\nEXTRA: tests — covered the parser")).toEqual({ type: "extra", kind: "tests", summary: "covered the parser" });
    expect(lastExtraClaim("EXTRA: tests — first try\nOn second thought nothing helped.\nNOTHING_LEFT — all covered")).toEqual({ type: "nothing_left", reason: "all covered" });
    expect(lastExtraClaim("EXTRA: refactor — moved things")).toEqual({ type: "invalid", error: expect.stringContaining('"refactor" is not a kind') });
  });

  it("finds none in a reply that makes none, or in no reply", () => {
    expect(lastExtraClaim("Built the page. Verify by opening index.html.")).toBeNull();
    expect(lastExtraClaim("")).toBeNull();
    expect(lastExtraClaim(null)).toBeNull();
  });
});

describe("extraWorkPrompt", () => {
  it("names the spare time, the allowlist and nothing else, the scope, what is done, and the closing line", () => {
    const prompt = extraWorkPrompt({ leftMs: 12 * MIN, cutoff: "Wed 14 Oct, 18:20 (Europe/Sofia)", scope: ["index.html", "tests/"], done: ["tests: covered the title"], n: 2 });
    expect(prompt).toContain(`EXTRA WORK, item 2 of at most ${MAX_EXTRA_ITEMS}.`);
    expect(prompt).toContain("12 minutes are left before the safety margin at Wed 14 Oct, 18:20 (Europe/Sofia)");
    for (const kind of EXTRA_WORK_KINDS) expect(prompt).toContain(`- ${kind}: `);
    expect(prompt).toContain("No new features, no unrelated refactors");
    expect(prompt).toContain("scope: index.html, tests/.");
    expect(prompt).toContain('Already done, so not again: "tests: covered the title".');
    expect(prompt).toContain('"EXTRA: <kind> — <what you did>"');
    expect(prompt).toContain('"NOTHING_LEFT — <why>"');
  });

  it("shows a long scope in part and says how much more there is", () => {
    const scope = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const prompt = extraWorkPrompt({ leftMs: 30 * MIN, cutoff: "later", scope, done: [], n: 1 });
    expect(prompt).toContain("f29.ts (and 10 more)");
    expect(prompt).not.toContain("f30.ts");
    expect(prompt).not.toContain("Already done");
  });

  it("plans one item as five minutes", () => {
    expect(EXTRA_ITEM_ESTIMATE_MS).toBe(5 * MIN);
  });
});

describe("parseExtraClaim", () => {
  it("reads an extra item with an em dash, an en dash, a hyphen or a colon", () => {
    expect(parseExtraClaim("EXTRA: tests — added a retry test for the scraper")).toEqual({ type: "extra", kind: "tests", summary: "added a retry test for the scraper" });
    expect(parseExtraClaim("EXTRA: fixes – guarded the empty page")).toEqual({ type: "extra", kind: "fixes", summary: "guarded the empty page" });
    expect(parseExtraClaim("EXTRA: docs - wrote the README section")).toEqual({ type: "extra", kind: "docs", summary: "wrote the README section" });
    expect(parseExtraClaim("EXTRA: verify: ran the suite again")).toEqual({ type: "extra", kind: "verify", summary: "ran the suite again" });
    expect(parseExtraClaim("EXTRA:tests—tight")).toEqual({ type: "extra", kind: "tests", summary: "tight" });
  });

  it("reads the kind in its spoken spellings", () => {
    expect(parseExtraClaim("EXTRA: edge cases — empty input")).toEqual({ type: "extra", kind: "edge_cases", summary: "empty input" });
    expect(parseExtraClaim("EXTRA: edge-cases — empty input")).toMatchObject({ kind: "edge_cases" });
    expect(parseExtraClaim("EXTRA: edge_cases — empty input")).toMatchObject({ kind: "edge_cases" });
  });

  it("reads a claim behind a bullet, a quote or markdown emphasis", () => {
    expect(parseExtraClaim("- **EXTRA:** tests — two more cases**")).toEqual({ type: "extra", kind: "tests", summary: "two more cases" });
    expect(parseExtraClaim("> EXTRA: docs — usage")).toMatchObject({ type: "extra", kind: "docs" });
    expect(parseExtraClaim("`EXTRA: verify — lint clean`")).toEqual({ type: "extra", kind: "verify", summary: "lint clean" });
    expect(parseExtraClaim("  * NOTHING_LEFT  ")).toEqual({ type: "nothing_left" });
  });

  it("reads NOTHING_LEFT, with or without a reason", () => {
    expect(parseExtraClaim("NOTHING_LEFT")).toEqual({ type: "nothing_left" });
    expect(parseExtraClaim("NOTHING_LEFT.")).toEqual({ type: "nothing_left" });
    expect(parseExtraClaim("NOTHING_LEFT — every check passes and the edge cases are covered")).toEqual({
      type: "nothing_left",
      reason: "every check passes and the edge cases are covered",
    });
  });

  it("is not fooled by prose that merely says the words", () => {
    expect(parseExtraClaim("I added extra tests: two of them")).toBeNull();
    expect(parseExtraClaim("Extra: tests — lower case is prose")).toBeNull();
    expect(parseExtraClaim("There is nothing left to do.")).toBeNull();
    expect(parseExtraClaim("NOTHING_LEFTOVER")).toBeNull();
    expect(parseExtraClaim("We wrote EXTRA: tests — mid-sentence")).toBeNull();
    expect(parseExtraClaim("")).toBeNull();
    expect(parseExtraClaim(undefined as unknown as string)).toBeNull();
  });

  it("answers why a line that starts like a claim is not one", () => {
    expect(parseExtraClaim("EXTRA: refactor — moved things around")).toEqual({ type: "invalid", error: expect.stringContaining('"refactor" is not a kind') });
    expect(parseExtraClaim("EXTRA: added more tests")).toEqual({ type: "invalid", error: expect.stringContaining("EXTRA: <kind> — <summary>") });
    expect(parseExtraClaim("EXTRA: tests —   ")).toEqual({ type: "invalid", error: expect.stringContaining("does not say what was done") });
  });

  it("keeps the summary to one bounded line", () => {
    const r = parseExtraClaim(`EXTRA: tests — ${"x".repeat(5_000)}`);
    expect(r).toMatchObject({ type: "extra" });
    if (r?.type === "extra") expect(r.summary.length).toBe(MAX_EXTRA_SUMMARY_CHARS);
    expect(parseExtraClaim("EXTRA: tests — a\tb\u0007c")).toEqual({ type: "extra", kind: "tests", summary: "a b c" });
  });

  it("stays fast on a hostile line", () => {
    const started = performance.now();
    parseExtraClaim(`EXTRA: ${"a ".repeat(50_000)}`);
    parseExtraClaim(`EXTRA: tests${" ".repeat(50_000)}x`);
    parseExtraClaim(`${"- ".repeat(50_000)}EXTRA: tests — x`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("parseEstimateMinutes", () => {
  it.each([
    [40, 40 * MIN],
    ["40", 40 * MIN],
    ["40.", 40 * MIN],
    ["90m", 90 * MIN],
    ["45 min", 45 * MIN],
    ["1.5 hours", 90 * MIN],
    ["2h", 2 * HOUR],
    ["1 h 30 min", 90 * MIN],
    ["1h30m", 90 * MIN],
    ["2 hours and 15 minutes", 135 * MIN],
    ["1d, 4h", 28 * HOUR],
    ["~45 min", 45 * MIN],
    ["about 2 hours", 2 * HOUR],
    ["PT2H", 2 * HOUR],
    ["1,5h", 90 * MIN],
    [0.4, MIN],
    [40.4, 40 * MIN],
    ["14d", 14 * DAY],
  ])("reads %j", (raw, ms) => {
    expect(parseEstimateMinutes(raw)).toBe(ms);
  });

  it.each([
    ["zero", 0],
    ["a negative", -5],
    ["a negative string", "-5"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["an empty string", ""],
    ["words", "soon"],
    ["a unit alone", "minutes"],
    ["trailing junk", "40 minutes or so"],
    ["longer than the longest budget", "15 days"],
    ["a huge number of minutes", 10_000_000],
    ["a long string", `${"1".repeat(80)}`],
    ["null", null],
    ["an object", { minutes: 40 }],
  ])("refuses %s", (_label, raw) => {
    expect(parseEstimateMinutes(raw)).toBeNull();
  });

  it("is bounded by the longest budget there is", () => {
    expect(parseEstimateMinutes(MAX_ESTIMATE_MS / MIN)).toBe(MAX_ESTIMATE_MS);
    expect(parseEstimateMinutes(MAX_ESTIMATE_MS / MIN + 1)).toBeNull();
  });
});

describe("isBehindEstimate", () => {
  it("is behind only past 25% over", () => {
    expect(isBehindEstimate(40 * MIN, 50 * MIN)).toBe(false);
    expect(isBehindEstimate(40 * MIN, 50 * MIN + 1)).toBe(true);
    expect(isBehindEstimate(40 * MIN, 20 * MIN)).toBe(false);
  });

  it("is never behind without a usable estimate or time", () => {
    expect(isBehindEstimate(null, 5 * HOUR)).toBe(false);
    expect(isBehindEstimate(0, 5 * HOUR)).toBe(false);
    expect(isBehindEstimate(-1, 5 * HOUR)).toBe(false);
    expect(isBehindEstimate(40 * MIN, NaN)).toBe(false);
    expect(isBehindEstimate(40 * MIN, undefined)).toBe(false);
  });
});

describe("cutFromBottom", () => {
  const tasks = [
    { id: "t1", estimateMs: 30 * MIN },
    { id: "t2", estimateMs: 20 * MIN },
    { id: "t3", estimateMs: 10 * MIN },
  ];

  it("cuts the least important first, only as far as needed", () => {
    expect(cutFromBottom(tasks, 5 * MIN)).toEqual(["t3"]);
    expect(cutFromBottom(tasks, 10 * MIN)).toEqual(["t3"]);
    expect(cutFromBottom(tasks, 25 * MIN)).toEqual(["t3", "t2"]);
    expect(cutFromBottom(tasks, 31 * MIN)).toEqual(["t3", "t2", "t1"]);
  });

  it("cuts nothing when nothing is needed", () => {
    expect(cutFromBottom(tasks, 0)).toEqual([]);
    expect(cutFromBottom(tasks, -MIN)).toEqual([]);
    expect(cutFromBottom(tasks, NaN)).toEqual([]);
    expect(cutFromBottom([], HOUR)).toEqual([]);
  });

  it("names every estimated task when even all of them are not enough", () => {
    expect(cutFromBottom(tasks, 10 * HOUR)).toEqual(["t3", "t2", "t1"]);
  });

  it("passes over a task with no estimate, which frees no time anyone can count on", () => {
    const withUnknown = [...tasks, { id: "t4", estimateMs: null }, { id: "t5", estimateMs: 0 }];
    expect(cutFromBottom(withUnknown, 5 * MIN)).toEqual(["t3"]);
  });

  it("cuts a task named twice only once", () => {
    expect(cutFromBottom([{ id: "t1", estimateMs: 30 * MIN }, { id: "t2", estimateMs: 5 * MIN }, { id: "t2", estimateMs: 5 * MIN }], 20 * MIN)).toEqual(["t2", "t1"]);
  });
});

describe("mustHaveFits", () => {
  it("measures the must-haves against the time before the safety margin", () => {
    expect(mustHaveFits(hour(), NOW, [20 * MIN, 30 * MIN])).toEqual({ fits: true, availableMs: 50 * MIN, shortByMs: 0, neededMs: 50 * MIN });
    expect(mustHaveFits(hour(), NOW, [30 * MIN, 30 * MIN])).toEqual({ fits: false, availableMs: 50 * MIN, shortByMs: 10 * MIN, neededMs: 60 * MIN });
  });

  it("counts the time already gone", () => {
    expect(mustHaveFits(hour(), NOW + 40 * MIN, [15 * MIN])).toMatchObject({ fits: false, availableMs: 10 * MIN, shortByMs: 5 * MIN });
    expect(mustHaveFits(hour(), new Date(NOW + 2 * HOUR), [MIN])).toMatchObject({ fits: false, availableMs: 0, shortByMs: MIN });
  });

  it("counts an estimate that is not a positive number as nothing", () => {
    expect(mustHaveFits(hour(), NOW, [null, undefined, -MIN, NaN, 10 * MIN])).toMatchObject({ fits: true, neededMs: 10 * MIN });
    expect(mustHaveFits(hour(), NOW, [])).toMatchObject({ fits: true, neededMs: 0 });
  });
});

describe("nextItemAllowed", () => {
  const capped = (): TimeBudget => ({ ...hour(), tokenCap: 100_000 });

  it("lets an item start that fits before the safety margin", () => {
    expect(nextItemAllowed(hour(), NOW, 0)).toEqual({ ok: true });
    expect(nextItemAllowed(hour(), NOW, 0, 50 * MIN)).toEqual({ ok: true });
    expect(nextItemAllowed(capped(), NOW, 99_999, 10 * MIN)).toEqual({ ok: true });
  });

  it("refuses for time an item that would run into the margin, or starts inside it", () => {
    expect(nextItemAllowed(hour(), NOW, 0, 51 * MIN)).toEqual({ ok: false, reason: "time" });
    expect(nextItemAllowed(hour(), NOW + 50 * MIN, 0)).toEqual({ ok: false, reason: "time" });
    expect(nextItemAllowed(hour(), NOW + HOUR, 0)).toEqual({ ok: false, reason: "time" });
  });

  it("refuses for cost once the budget's own spend ceiling is reached", () => {
    expect(nextItemAllowed(capped(), NOW, 100_000)).toEqual({ ok: false, reason: "cost" });
    expect(nextItemAllowed(capped(), NOW + 55 * MIN, 100_000)).toEqual({ ok: false, reason: "cost" });
  });

  it("names the deadline when time and cost are both gone", () => {
    expect(nextItemAllowed(capped(), NOW + HOUR, 500_000)).toEqual({ ok: false, reason: "time" });
  });

  it("ignores the spend of a budget with no ceiling of its own", () => {
    expect(nextItemAllowed(hour(), NOW, 10_000_000)).toEqual({ ok: true });
  });
});

describe("estimateAccuracyLine", () => {
  const budget = presetBudget("1d", NOW, SOFIA);

  it("says how the estimates held, as the timeline shows it", () => {
    const s = summarizeTimeRecords(budget, [
      timeRecord("estimate", "scraper", NOW, { taskId: "t1", estimateMs: 30 * MIN }),
      timeRecord("estimate", "parser", NOW, { taskId: "t2", estimateMs: 30 * MIN }),
      timeRecord("estimate", "report", NOW, { taskId: "t3", estimateMs: 30 * MIN }),
      timeRecord("finish", "scraper", NOW + HOUR, { taskId: "t1", actualMs: 40 * MIN }),
      timeRecord("finish", "parser", NOW + HOUR, { taskId: "t2", actualMs: 40 * MIN }),
      timeRecord("finish", "report", NOW + 2 * HOUR, { taskId: "t3", actualMs: 32 * MIN }),
    ], NOW + 2 * HOUR);
    expect(estimateAccuracyLine(s)).toBe("Estimates: 3 tasks, estimated 1 h 30 min, took 1 h 52 min (+24%)");
  });

  it("says when the work was quicker, on the dot, or still open", () => {
    const tasks = (actual: number | null) => [
      { taskId: "t1", estimateMs: HOUR, actualMs: actual },
      { taskId: "t2", estimateMs: 20 * MIN, actualMs: null },
    ];
    const base = { estimateMs: null, usedMs: 0, finishedAt: null };
    expect(estimateAccuracyLine({ ...base, tasks: tasks(54 * MIN) })).toBe("Estimates: 1 task, estimated 1 hour, took 54 minutes (-10%); 1 more not finished");
    expect(estimateAccuracyLine({ ...base, tasks: tasks(HOUR) })).toBe("Estimates: 1 task, estimated 1 hour, took 1 hour (±0%); 1 more not finished");
    expect(estimateAccuracyLine({ ...base, tasks: tasks(null) })).toBe("Estimates: 2 tasks, estimated 1 h 20 min; none finished yet");
  });

  it("measures a run without task estimates by its overall one, once it has stopped", () => {
    expect(estimateAccuracyLine({ tasks: [], estimateMs: 50 * MIN, usedMs: 59 * MIN, finishedAt: new Date(NOW).toISOString() }))
      .toBe("Estimates: the whole work, estimated 50 minutes, took 59 minutes (+18%)");
    expect(estimateAccuracyLine({ tasks: [], estimateMs: 50 * MIN, usedMs: 10 * MIN, finishedAt: null }))
      .toBe("Estimates: the whole work, estimated 50 minutes; not finished yet");
  });

  it("says so when no estimate was given", () => {
    expect(estimateAccuracyLine({ tasks: [{ taskId: "t1", estimateMs: null, actualMs: HOUR }], estimateMs: null, usedMs: HOUR, finishedAt: null }))
      .toBe("Estimates: none given");
  });
});

describe("estimate calibration", () => {
  const sample = (estimateMin: number, tookMin: number) => ({ estimateMs: estimateMin * MIN, actualMs: tookMin * MIN });

  it("reads a team's finished tasks, each estimate divided back by the factor the plan was scaled by", () => {
    const records = [
      timeRecord("plan", "2 tasks planned", NOW, { estimateMs: 60 * MIN, calibration: 1.5 }),
      timeRecord("estimate", "build", NOW, { taskId: "t1", estimateMs: 30 * MIN }),
      timeRecord("estimate", "test", NOW, { taskId: "t2", estimateMs: 30 * MIN }),
      timeRecord("finish", "The worker ended completed", NOW + 40 * MIN, { taskId: "t1", actualMs: 40 * MIN }),
    ];
    const summary = summarizeTimeRecords(hour(), records, NOW + HOUR);
    // t2 has no time taken: it is no sample. t1 was planned at 30 minutes scaled ×1.5 — the planner said 20.
    expect(estimateSamples(summary)).toEqual([{ estimateMs: 20 * MIN, actualMs: 40 * MIN }]);
  });

  it("reads a run's whole-work estimate against the time it worked — only when it was done and did nothing else", () => {
    const run = (stop: "done" | "nothing_left", extra: boolean) => summarizeTimeRecords(hour(), [
      timeRecord("plan", "Estimate for the must-have work", NOW, { runId: "run-abc12345", estimateMs: 20 * MIN }),
      ...(extra ? [timeRecord("extra", "tests — covered the parser", NOW + 25 * MIN, { actualMs: 5 * MIN })] : []),
      timeRecord("finish", "The run ended completed", NOW + 30 * MIN, { runId: "run-abc12345", actualMs: 30 * MIN }),
      timeRecord("stop", "the work was done", NOW + 30 * MIN, { runId: "run-abc12345", reason: stop }),
    ], NOW + 30 * MIN);
    expect(estimateSamples(run("done", false))).toEqual([{ estimateMs: 20 * MIN, actualMs: 30 * MIN }]);
    // Extra work is in the time it worked: not like for like.
    expect(estimateSamples(run("nothing_left", true))).toEqual([]);
    expect(estimateSamples(run("done", true))).toEqual([]);
  });

  it("finds nothing in a record with no estimate or no finish", () => {
    expect(estimateSamples(summarizeTimeRecords(hour(), [timeRecord("budget", "1 hour", NOW)], NOW))).toEqual([]);
    const unfinished = summarizeTimeRecords(hour(), [timeRecord("plan", "Estimate", NOW, { estimateMs: 20 * MIN })], NOW + MIN);
    expect(estimateSamples(unfinished)).toEqual([]);
  });

  it("is the median of took ÷ estimated — none under three finished estimates", () => {
    expect(estimateCalibration([])).toBeNull();
    expect(estimateCalibration([sample(10, 20), sample(10, 20)])).toBeNull();
    expect(estimateCalibration([sample(10, 20), sample(10, 12), sample(20, 30)])).toEqual({ factor: 1.5, samples: 3 });
    // An even count: the mean of the middle two.
    expect(estimateCalibration([sample(10, 10), sample(10, 12), sample(10, 14), sample(10, 40)])).toEqual({ factor: 1.3, samples: 4 });
  });

  it("is bounded: one wild overrun, a zero or a forged record moves it no further than the bounds", () => {
    expect(estimateCalibration([sample(1, 600), sample(1, 600), sample(1, 600)])?.factor).toBe(CALIBRATION_MAX_FACTOR);
    expect(estimateCalibration([sample(60, 0), sample(60, 0), sample(60, 1)])?.factor).toBe(CALIBRATION_MIN_FACTOR);
    // A median: two honest estimates outvote one wild one.
    expect(estimateCalibration([sample(10, 11), sample(10, 11), sample(1, 600)])?.factor).toBe(1.1);
    // What is not a sample is not counted.
    const bad = [{ estimateMs: 0, actualMs: MIN }, { estimateMs: NaN, actualMs: MIN }, { estimateMs: MIN, actualMs: -1 }];
    expect(estimateCalibration([...bad, sample(10, 20), sample(10, 20)])).toBeNull();
  });

  it("reads only the latest CALIBRATION_MAX_SAMPLES", () => {
    const latest = Array.from({ length: CALIBRATION_MAX_SAMPLES }, () => sample(10, 20));
    const older = Array.from({ length: 50 }, () => sample(10, 5));
    expect(estimateCalibration([...latest, ...older])).toEqual({ factor: 2, samples: CALIBRATION_MAX_SAMPLES });
  });

  it("scales an estimate only when past ones were off by 10% or more, to whole minutes, inside the estimate bounds", () => {
    expect(calibrationApplies(null)).toBe(false);
    expect(calibrationApplies({ factor: 1.05, samples: 9 })).toBe(false);
    expect(calibrationApplies({ factor: 0.9, samples: 9 })).toBe(true);
    expect(calibrateEstimate(20 * MIN, null)).toBe(20 * MIN);
    expect(calibrateEstimate(20 * MIN, { factor: 1.05, samples: 9 })).toBe(20 * MIN);
    expect(calibrateEstimate(20 * MIN, { factor: 1.4, samples: 9 })).toBe(28 * MIN);
    expect(calibrateEstimate(7 * MIN, { factor: 1.5, samples: 9 })).toBe(11 * MIN);
    expect(calibrateEstimate(MIN, { factor: 0.5, samples: 9 })).toBe(MIN);
    expect(calibrateEstimate(MAX_ESTIMATE_MS, { factor: 3, samples: 9 })).toBe(MAX_ESTIMATE_MS);
  });

  it("says what it does on the log and in a brief — nothing when it scales nothing", () => {
    expect(calibrationNote({ factor: 1.02, samples: 5 })).toBeNull();
    expect(calibrationBrief(null)).toBeNull();
    expect(calibrationNote({ factor: 1.4, samples: 7 })).toBe(
      "Calibration: on this box, past estimates took 1.4× the time estimated (the median of 7 finished estimates), so the estimates here are scaled by 1.4× before they are fitted to the time.",
    );
    const brief = calibrationBrief({ factor: 0.75, samples: 3 });
    expect(brief).toContain("took 0.75× the time estimated (the median of 3 finished estimates)");
    expect(brief).toContain("do not add to them or cut them yourself");
  });
});

describe("estimate samples, read as their owner's record", () => {
  const RUN = "run-abc12345";
  const mixed = summarizeTimeRecords(hour(), [
    timeRecord("plan", "Estimate for the must-have work", NOW, { runId: RUN, estimateMs: 20 * MIN }),
    timeRecord("estimate", "a planted task", NOW, { taskId: "t1", estimateMs: 10 * MIN }),
    timeRecord("finish", "a planted finish", NOW + MIN, { taskId: "t1", actualMs: 100 * MIN }),
    timeRecord("finish", "The run ended completed", NOW + 30 * MIN, { runId: RUN, actualMs: 30 * MIN }),
    timeRecord("stop", "the work was done", NOW + 30 * MIN, { runId: RUN, reason: "done" }),
  ], NOW + 30 * MIN);

  it("takes a run's record as one whole-work pair at most — task lines in it count for nothing", () => {
    expect(estimateSamples(mixed, "run")).toEqual([{ estimateMs: 20 * MIN, actualMs: 30 * MIN }]);
  });

  it("takes a team's record as its tasks only", () => {
    expect(estimateSamples(mixed, "team")).toEqual([{ estimateMs: 10 * MIN, actualMs: 100 * MIN }]);
    const noTasks = summarizeTimeRecords(hour(), mixed.records.filter((r) => !r.taskId), NOW + 30 * MIN);
    expect(estimateSamples(noTasks, "team")).toEqual([]);
    expect(estimateSamples(noTasks)).toEqual([{ estimateMs: 20 * MIN, actualMs: 30 * MIN }]);
  });
});
