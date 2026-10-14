/**
 * The persistent time record (src/lib/coding-time-record.ts): the text log and
 * the JSON a budgeted run or team keeps in its evidence folder.
 *
 * What matters most: a record survives — a restart reads it back exactly,
 * records landing together are all kept — and nothing a run planted in its
 * own folder (a damaged JSON, a link out of the folder) is trusted, followed
 * or thrown on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { presetBudget, summarizeTimeRecords, timeRecord, type TimeBudget, type TimeRecord } from "@/lib/coding-time-budget";

vi.mock("@/lib/timezone", () => ({ readOsTimeZone: async () => "Europe/Sofia" }));

type Lib = typeof import("@/lib/coding-time-record");

let lib: Lib;
let base: string;
let root: string;
let restore: () => void;

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 14, 15, 0);
const RUN_ID = "run-abc12345";
const TEAM_ID = "team-0aezpvrw";

const budget = (): TimeBudget => presetBudget("1h", NOW, "Europe/Sofia");
const evidence = (id: string) => path.join(root, "data", "coding-agent-artifacts", id);
const readLog = (id: string) => fs.readFileSync(path.join(evidence(id), "time-record.log"), "utf8");
const readJson = (id: string) => JSON.parse(fs.readFileSync(path.join(evidence(id), "time-record.json"), "utf8"));

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-time-record-"));
  root = path.join(base, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  lib = await import("@/lib/coding-time-record");
});

afterEach(() => {
  vi.restoreAllMocks();
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("appendTimeRecord", () => {
  it("appends a line on the box's wall clock and writes the summary as JSON", async () => {
    const b = budget();
    const s1 = await lib.appendTimeRecord(RUN_ID, b, timeRecord("budget", "1 hour, from the picker", NOW));
    const s2 = await lib.appendTimeRecord(RUN_ID, b, timeRecord("estimate", "build and test the scraper", NOW + MIN, { taskId: "t1", estimateMs: 30 * MIN }));
    expect(s1?.records).toHaveLength(1);
    expect(s2?.records).toHaveLength(2);
    expect(s2?.tasks).toEqual([{ taskId: "t1", estimateMs: 30 * MIN, actualMs: null }]);

    expect(readLog(RUN_ID)).toBe(
      "2026-10-14 18:00 [budget] 1 hour, from the picker\n"
        + "2026-10-14 18:01 [estimate] t1 — ~30 minutes — build and test the scraper\n",
    );
    const json = readJson(RUN_ID);
    expect(json.budget).toEqual(b);
    expect(json.records.map((r: TimeRecord) => r.kind)).toEqual(["budget", "estimate"]);
    expect(json.estimateMs).toBe(30 * MIN);
  });

  it("keeps a team's record in a folder of its own, at the folder mode the store owns", async () => {
    await lib.appendTimeRecord(TEAM_ID, budget(), timeRecord("plan", "scraper first, then scrape", NOW, { estimateMs: 50 * MIN }));
    expect(readJson(TEAM_ID).estimateMs).toBe(50 * MIN);
    expect(fs.statSync(evidence(TEAM_ID)).mode & 0o777).toBe(0o700);
  });

  it("keeps every record when many land at once — one writer per owner at a time", async () => {
    const b = budget();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        lib.appendTimeRecord(RUN_ID, b, timeRecord("note", `checkpoint ${i}`, NOW + i * MIN, { tokensUsed: i * 1000 }))),
    );
    expect(readJson(RUN_ID).records).toHaveLength(25);
    expect(readLog(RUN_ID).trim().split("\n")).toHaveLength(25);
    expect(readJson(RUN_ID).tokensUsed).toBe(24_000);
  });

  it("writes through a temp file it then removes: no dotfile is left in the folder", async () => {
    await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "one", NOW));
    expect(fs.readdirSync(evidence(RUN_ID)).sort()).toEqual(["time-record.json", "time-record.log"]);
  });

  it("goes on with the budget it is given — a re-plan's new one replaces the old", async () => {
    await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("budget", "1 hour", NOW));
    const longer = presetBudget("1d", NOW + 5 * MIN, "Europe/Sofia");
    await lib.appendTimeRecord(RUN_ID, longer, timeRecord("budget", "changed to 1 day", NOW + 5 * MIN));
    expect(lib.loadTimeRecords(RUN_ID)?.budget).toEqual(longer);
  });

  it("keeps a log line one line, whatever the task id carried", async () => {
    const r = { ...timeRecord("start", "go", NOW), taskId: "t1\nFAKE [stop] reason: done" };
    await lib.appendTimeRecord(RUN_ID, budget(), r);
    expect(readLog(RUN_ID).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it.each([
    ["a malformed id", "run-../../etc"],
    ["a traversal", `run-..${path.sep}escaped`],
    ["a dotted team id", "team-......../"],
    ["an id of neither kind", "proj-abc12345"],
  ])("refuses %s without touching the disk", async (_label, id) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await lib.appendTimeRecord(id, budget(), timeRecord("note", "x", NOW))).toBeNull();
    expect(fs.existsSync(path.join(root, "data", "coding-agent-artifacts"))).toBe(false);
    expect(fs.existsSync(path.join(base, "escaped"))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("refuses a budget or a record this box would not have written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await lib.appendTimeRecord(RUN_ID, { ...budget(), deadline: "tomorrow" }, timeRecord("note", "x", NOW))).toBeNull();
    expect(await lib.appendTimeRecord(RUN_ID, budget(), { at: "now", kind: "note", text: "x" } as TimeRecord)).toBeNull();
    expect(await lib.appendTimeRecord(RUN_ID, budget(), { ...timeRecord("note", "x", NOW), kind: "lunch" } as unknown as TimeRecord)).toBeNull();
    expect(fs.existsSync(evidence(RUN_ID))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("sets a damaged JSON aside and starts a clean one, never throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fs.mkdirSync(evidence(RUN_ID), { recursive: true });
    fs.writeFileSync(path.join(evidence(RUN_ID), "time-record.json"), '{"budget": {"deadline": "2026-');
    const s = await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "after the damage", NOW));
    expect(s?.records.map((r) => r.text)).toEqual(["after the damage"]);
    expect(fs.readFileSync(path.join(evidence(RUN_ID), lib.TIME_RECORD_CORRUPT_JSON), "utf8")).toBe('{"budget": {"deadline": "2026-');
    expect(lib.loadTimeRecords(RUN_ID)?.records).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  // Root reads a 000 file anyway, so the case only means something as a user.
  it.skipIf(process.getuid?.() === 0)("leaves a JSON it cannot open alone, and writes nothing over it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "kept", NOW));
    const jsonFile = path.join(evidence(RUN_ID), "time-record.json");
    const before = fs.readFileSync(jsonFile, "utf8");
    fs.chmodSync(jsonFile, 0o000);
    try {
      expect(await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "lost", NOW + MIN))).toBeNull();
    } finally {
      fs.chmodSync(jsonFile, 0o644);
    }
    expect(fs.readFileSync(jsonFile, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(evidence(RUN_ID), lib.TIME_RECORD_CORRUPT_JSON))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("does not follow a log the run swapped for a link out of the folder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outside = path.join(base, "outside.txt");
    fs.writeFileSync(outside, "keep me\n");
    fs.mkdirSync(evidence(RUN_ID), { recursive: true });
    fs.symlinkSync(outside, path.join(evidence(RUN_ID), "time-record.log"));
    const s = await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "x", NOW));
    expect(fs.readFileSync(outside, "utf8")).toBe("keep me\n");
    // The JSON — what a resume reads — is still written.
    expect(s?.records).toHaveLength(1);
    expect(lib.loadTimeRecords(RUN_ID)?.records).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it("does not read or write through a JSON the run swapped for a link", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outside = path.join(base, "other.json");
    const other = summarizeTimeRecords(budget(), [timeRecord("note", "someone else's", NOW)], NOW);
    fs.writeFileSync(outside, JSON.stringify(other));
    fs.mkdirSync(evidence(RUN_ID), { recursive: true });
    fs.symlinkSync(outside, path.join(evidence(RUN_ID), "time-record.json"));
    expect(lib.loadTimeRecords(RUN_ID)).toBeNull();
    await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "mine", NOW));
    expect(JSON.parse(fs.readFileSync(outside, "utf8"))).toEqual(other);
    expect(fs.lstatSync(path.join(evidence(RUN_ID), "time-record.json")).isSymbolicLink()).toBe(false);
    expect(lib.loadTimeRecords(RUN_ID)?.records.map((r) => r.text)).toEqual(["mine"]);
    expect(fs.existsSync(path.join(evidence(RUN_ID), lib.TIME_RECORD_CORRUPT_JSON))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("refuses an evidence folder that is itself a link", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const elsewhere = path.join(base, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.dirname(evidence(RUN_ID)), { recursive: true });
    fs.symlinkSync(elsewhere, evidence(RUN_ID));
    expect(await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "x", NOW))).toBeNull();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(lib.loadTimeRecords(RUN_ID)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("keeps the JSON bounded, dropping the oldest checkpoints first", async () => {
    const b = budget();
    const max = lib.MAX_STORED_TIME_RECORDS;
    const seeded = [
      timeRecord("budget", "1 hour", NOW),
      timeRecord("estimate", "scraper", NOW, { taskId: "t1", estimateMs: 30 * MIN }),
      ...Array.from({ length: max - 2 }, (_, i) => timeRecord("note", `checkpoint ${i}`, NOW + 1000 + i)),
    ];
    fs.mkdirSync(evidence(RUN_ID), { recursive: true });
    fs.writeFileSync(path.join(evidence(RUN_ID), "time-record.json"), JSON.stringify(summarizeTimeRecords(b, seeded, NOW)));
    const s = await lib.appendTimeRecord(RUN_ID, b, timeRecord("finish", "scraper", NOW + HOUR, { taskId: "t1", actualMs: 40 * MIN }));
    expect(s?.records).toHaveLength(max);
    expect(s?.records.map((r) => r.text)).not.toContain("checkpoint 0");
    expect(s?.records.map((r) => r.text)).toContain("checkpoint 1");
    expect(s?.records[0].kind).toBe("budget");
    expect(s?.tasks).toEqual([{ taskId: "t1", estimateMs: 30 * MIN, actualMs: 40 * MIN }]);
  });

  it("stops filling a full log with checkpoints, but still takes the stop line", async () => {
    fs.mkdirSync(evidence(RUN_ID), { recursive: true });
    const logFile = path.join(evidence(RUN_ID), "time-record.log");
    fs.writeFileSync(logFile, "x".repeat(lib.MAX_TIME_RECORD_LOG_BYTES - 10));
    await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "fills it", NOW));
    await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "dropped from the log", NOW + MIN));
    await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("stop", "deadline", NOW + 2 * MIN, { reason: "time" }));
    const tail = fs.readFileSync(logFile, "utf8").slice(lib.MAX_TIME_RECORD_LOG_BYTES - 10);
    expect(tail).toContain("fills it");
    expect(tail).toContain("The log is full");
    expect(tail).not.toContain("dropped from the log");
    expect(tail).toContain("[stop] reason: time");
    expect(lib.loadTimeRecords(RUN_ID)?.records).toHaveLength(3);
  });
});

describe("loadTimeRecords", () => {
  it("answers null when there is no record", () => {
    expect(lib.loadTimeRecords(RUN_ID)).toBeNull();
    expect(lib.loadTimeRecords(TEAM_ID)).toBeNull();
    expect(lib.loadTimeRecords("../../etc")).toBeNull();
  });

  it("reads back exactly what was written — what a resumed run continues against", async () => {
    const b = { ...budget(), tokenCap: 500_000 };
    const r1 = timeRecord("budget", "1 hour", NOW);
    const r2 = timeRecord("estimate", "scraper", NOW + MIN, { taskId: "t1", estimateMs: 30 * MIN, tokensUsed: 1200 });
    await lib.appendTimeRecord(TEAM_ID, b, r1);
    await lib.appendTimeRecord(TEAM_ID, b, r2);
    // A restart: the module is loaded afresh and reads only the disk.
    vi.resetModules();
    const fresh = await import("@/lib/coding-time-record");
    expect(fresh.loadTimeRecords(TEAM_ID)).toEqual({ budget: b, records: [r1, r2] });
  });

  it("drops a record line it would not have written, and keeps the rest", () => {
    const good = timeRecord("note", "fine", NOW);
    fs.mkdirSync(evidence(RUN_ID), { recursive: true });
    fs.writeFileSync(path.join(evidence(RUN_ID), "time-record.json"), JSON.stringify({
      budget: budget(),
      records: [good, { at: "yesterday", kind: "note", text: "bad time" }, { ...good, kind: "nap" }, null, "text"],
    }));
    expect(lib.loadTimeRecords(RUN_ID)?.records).toEqual([good]);
  });

  it.each([
    ["not JSON", "{{{"],
    ["an array", "[]"],
    ["no budget", JSON.stringify({ records: [] })],
    ["a budget that is not one", JSON.stringify({ budget: { deadline: "soon" }, records: [] })],
    ["records that are not a list", JSON.stringify({ budget: budget(), records: "many" })],
    ["empty", ""],
  ])("answers null for a file holding %s", (_label, body) => {
    fs.mkdirSync(evidence(RUN_ID), { recursive: true });
    fs.writeFileSync(path.join(evidence(RUN_ID), "time-record.json"), body);
    expect(lib.loadTimeRecords(RUN_ID)).toBeNull();
  });

  it("answers null for a file too large to be one it wrote", () => {
    fs.mkdirSync(evidence(RUN_ID), { recursive: true });
    fs.writeFileSync(path.join(evidence(RUN_ID), "time-record.json"), " ".repeat(lib.MAX_TIME_RECORD_JSON_BYTES + 1));
    expect(lib.loadTimeRecords(RUN_ID)).toBeNull();
  });

  it("answers null for a folder in place of the file", () => {
    fs.mkdirSync(path.join(evidence(RUN_ID), "time-record.json"), { recursive: true });
    expect(lib.loadTimeRecords(RUN_ID)).toBeNull();
  });
});

describe("readTimeRecordSummary", () => {
  it("summarizes afresh at the time asked, with the latest records only", async () => {
    const b = budget();
    for (let i = 0; i < 6; i++) await lib.appendTimeRecord(RUN_ID, b, timeRecord("note", `checkpoint ${i}`, NOW + i * MIN));
    const s = lib.readTimeRecordSummary(RUN_ID, NOW + 30 * MIN, 2);
    expect(s?.records.map((r) => r.text)).toEqual(["checkpoint 4", "checkpoint 5"]);
    expect(s?.omittedRecords).toBe(4);
    expect(s?.usedMs).toBe(30 * MIN);
    expect(s?.startedAt).toBe(new Date(NOW).toISOString());
  });

  it("carries up to 200 records by default, and none when asked for none", async () => {
    await lib.appendTimeRecord(RUN_ID, budget(), timeRecord("note", "one", NOW));
    expect(lib.readTimeRecordSummary(RUN_ID, NOW)?.records).toHaveLength(1);
    expect(lib.DEFAULT_PAYLOAD_RECORDS).toBe(200);
    expect(lib.readTimeRecordSummary(RUN_ID, NOW, 0)).toMatchObject({ records: [], omittedRecords: 1 });
    expect(lib.readTimeRecordSummary(RUN_ID, NOW, -3)?.records).toHaveLength(1);
  });

  it("answers null without a record, so a payload carries no key for one", () => {
    expect(lib.readTimeRecordSummary(RUN_ID, NOW)).toBeNull();
  });
});

describe("calibration across this box's records", () => {
  /** A finished budgeted team with one task per [estimate, took] pair, minutes; `factor` is what its plan was scaled by. */
  const finishedTeam = async (id: string, pairs: [number, number][], factor?: number) => {
    const b = budget();
    await lib.appendTimeRecord(id, b, timeRecord("plan", "planned", NOW, { estimateMs: 60 * MIN, ...(factor ? { calibration: factor } : {}) }));
    for (const [i, [est, took]] of pairs.entries()) {
      await lib.appendTimeRecord(id, b, timeRecord("estimate", `task ${i + 1}`, NOW, { taskId: `t${i + 1}`, estimateMs: est * MIN }));
      await lib.appendTimeRecord(id, b, timeRecord("finish", "The worker ended completed", NOW + took * MIN, { taskId: `t${i + 1}`, actualMs: took * MIN }));
    }
  };

  it("reads the finished estimates of every run and team, and works out the factor from them", async () => {
    await finishedTeam("team-aaaaaaaa", [[10, 20], [10, 20]]);
    await finishedTeam("team-bbbbbbbb", [[20, 30]], 1.5);
    const samples = lib.recentEstimateSamples();
    expect(samples).toHaveLength(3);
    // team-bbbbbbbb's 20 minutes were the planner's 13⅓ scaled ×1.5.
    expect(samples).toContainEqual({ estimateMs: (20 * MIN) / 1.5, actualMs: 30 * MIN });
    expect(lib.currentEstimateCalibration(NOW)).toEqual({ factor: 2, samples: 3 });
  });

  it("is null without enough finished estimates, and with no evidence folder at all", async () => {
    expect(lib.recentEstimateSamples()).toEqual([]);
    expect(lib.currentEstimateCalibration(NOW)).toBeNull();
    await finishedTeam("team-aaaaaaaa", [[10, 20]]);
    lib._resetCalibrationCacheForTests();
    expect(lib.currentEstimateCalibration(NOW)).toBeNull();
  });

  it("is worked out once a minute, not at every ask", async () => {
    expect(lib.currentEstimateCalibration(NOW)).toBeNull();
    await finishedTeam("team-aaaaaaaa", [[10, 20], [10, 20], [10, 20]]);
    expect(lib.currentEstimateCalibration(NOW + 30_000)).toBeNull();
    expect(lib.currentEstimateCalibration(NOW + lib.CALIBRATION_TTL_MS)).toEqual({ factor: 2, samples: 3 });
  });

  it("reads a run's folder as a run's record: task lines a run planted there count for nothing", async () => {
    await finishedTeam("team-aaaaaaaa", [[10, 20], [10, 20], [10, 20]]);
    // A run's own folder — one the run can write — made to look like a team of ten tasks, each done in a tenth of its estimate.
    await finishedTeam(RUN_ID, Array.from({ length: 10 }, (): [number, number] => [10, 1]));
    expect(lib.recentEstimateSamples()).toHaveLength(3);
    expect(lib.currentEstimateCalibration(NOW)).toEqual({ factor: 2, samples: 3 });
  });

  it("passes over what is not a record this box wrote: a link, a folder not named like a run or team, a record too large", async () => {
    await finishedTeam("team-aaaaaaaa", [[10, 20], [10, 20], [10, 20]]);
    const artifacts = path.join(root, "data", "coding-agent-artifacts");
    // A folder named like no run or team, holding a record that would say 3× otherwise.
    fs.cpSync(evidence("team-aaaaaaaa"), path.join(artifacts, "not-a-team"), { recursive: true });
    // A team folder that is a link to another one.
    fs.symlinkSync(evidence("team-aaaaaaaa"), path.join(artifacts, "team-cccccccc"));
    // A record padded past the calibration's size bound.
    await finishedTeam("team-dddddddd", [[10, 30], [10, 30], [10, 30]]);
    fs.appendFileSync(path.join(evidence("team-dddddddd"), "time-record.json"), " ".repeat(lib.CALIBRATION_MAX_RECORD_BYTES));
    expect(lib.recentEstimateSamples()).toHaveLength(3);
    expect(lib.currentEstimateCalibration(NOW)).toEqual({ factor: 2, samples: 3 });
  });
});
