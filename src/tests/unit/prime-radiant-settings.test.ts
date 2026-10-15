/**
 * Prime Radiant's settings file (the ingest half and the cost rates): read
 * over the defaults without creating anything, written strictly and
 * atomically, keys it does not own kept; "Skip code projects"; the
 * exclude-list grammar and its migration (an earlier default list follows
 * today's, an owner's own list is never touched); the cost rates as one
 * object with the owner's overrides laid over it.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COST_RATES,
  estimateUsd,
  mergeCostRates,
  readRateOverrides,
} from "@/lib/prime-radiant/cost-rates";
import {
  DEFAULT_INGEST_EXCLUDES,
  EXCLUDE_DEFAULTS_GENERATION,
  PREVIOUS_DEFAULT_INGEST_EXCLUDES,
  compileExcludes,
  isDefaultExcludeList,
  readExcludeList,
} from "@/lib/prime-radiant/ingest-exclude";
import {
  DEFAULT_INGEST_PARALLEL,
  SettingsError,
  effectiveCostRates,
  readSettings,
  readSettingsPatch,
  settingsPath,
  writeSettings,
} from "@/lib/prime-radiant/settings";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-settings-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let root: string;

beforeEach(() => {
  root = path.join(base, `case-${++n}`, "prime-radiant");
  process.env.PRIME_RADIANT_DIR = root;
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("readSettings", () => {
  it("answers the defaults and creates nothing on a fresh box", () => {
    const s = readSettings();
    expect(s.ingest).toEqual({ exclude: [...DEFAULT_INGEST_EXCLUDES], skipCodeProjects: true, parallel: DEFAULT_INGEST_PARALLEL, folders: [] });
    expect(DEFAULT_INGEST_PARALLEL).toBe(128);
    expect(s.costRates).toEqual({});
    expect(fs.existsSync(root)).toBe(false);
  });

  it("reads the valid sections of the file and the defaults for the rest", () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ingest: { exclude: ["drafts"], parallel: 9999 }, costRates: "nope" }));
    const s = readSettings();
    expect(s.ingest).toEqual({ exclude: ["drafts"], skipCodeProjects: true, parallel: DEFAULT_INGEST_PARALLEL, folders: [] });
    expect(s.costRates).toEqual({});
  });

  it("reads a file that is not JSON as the defaults", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(settingsPath(), "{ not json");
    expect(readSettings().ingest.parallel).toBe(DEFAULT_INGEST_PARALLEL);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("writeSettings", () => {
  it("writes each given field, keeps keys it does not own, and puts a default back on null", () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ schedule: "03:00", ingest: { other: true } }));
    const s = writeSettings({ ingest: { exclude: ["drafts", "Drafts", " archive-* "], parallel: 64 } });
    expect(s.ingest).toEqual({ exclude: ["drafts", "archive-*"], skipCodeProjects: true, parallel: 64, folders: [] });
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    expect(raw).toMatchObject({ schedule: "03:00", ingest: { other: true, parallel: 64 } });
    expect(fs.statSync(settingsPath()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const back = writeSettings({ ingest: { exclude: null, parallel: null } });
    expect(back.ingest).toEqual({ exclude: [...DEFAULT_INGEST_EXCLUDES], skipCodeProjects: true, parallel: DEFAULT_INGEST_PARALLEL, folders: [] });
  });

  it("refuses a bad field whole and writes nothing", () => {
    for (const patch of [
      { ingest: { parallel: 0 } },
      { ingest: { parallel: 1.5 } },
      { ingest: { parallel: 257 } },
      { ingest: { exclude: "node_modules" } },
      { ingest: { exclude: ["a/b"] } },
      { ingest: { exclude: [".."] } },
      { ingest: { exclude: [""] } },
      { ingest: { exclude: ["x".repeat(81)] } },
      { ingest: { exclude: Array.from({ length: 201 }, (_, i) => `d${i}`) } },
      { ingest: { skipCodeProjects: "yes" } },
      { ingest: { skipCodeProjects: 0 } },
      { costRates: { "deepseek-v4-flash": { input: -1, output: 1 } } },
      { costRates: { "bad model id!": { input: 1, output: 1 } } },
      { costRates: [] },
    ]) {
      expect(() => writeSettings(patch), JSON.stringify(patch).slice(0, 60)).toThrow(SettingsError);
    }
    expect(fs.existsSync(settingsPath())).toBe(false);
  });
});

describe("skipping code projects", () => {
  it("is on by default, and the owner's choice is stored, read back and reset", () => {
    expect(readSettings().ingest.skipCodeProjects).toBe(true);
    expect(writeSettings({ ingest: { skipCodeProjects: false } }).ingest.skipCodeProjects).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).ingest.skipCodeProjects).toBe(false);
    expect(readSettings().ingest.skipCodeProjects).toBe(false);
    expect(writeSettings({ ingest: { skipCodeProjects: null } }).ingest.skipCodeProjects).toBe(true);
    expect(readSettingsPatch({ ingest: { skipCodeProjects: true } })).toEqual({ ingest: { skipCodeProjects: true } });
  });

  it("reads a stored value that is not true or false as the default", () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ingest: { skipCodeProjects: "no" } }));
    expect(readSettings().ingest.skipCodeProjects).toBe(true);
  });
});

describe("exclude-list migration", () => {
  const [previous] = PREVIOUS_DEFAULT_INGEST_EXCLUDES;

  it("reads a stored copy of the earlier default list (what saving the form stored) as today's defaults", () => {
    fs.mkdirSync(root, { recursive: true });
    // In another order and letter case, as an owner's file may hold it.
    fs.writeFileSync(settingsPath(), JSON.stringify({ ingest: { exclude: [...previous].reverse().map((p) => p.toUpperCase()), parallel: 32 } }));
    const s = readSettings();
    expect(s.ingest.exclude).toEqual([...DEFAULT_INGEST_EXCLUDES]);
    expect(s.ingest.exclude).toEqual(expect.arrayContaining(["snap", "logs", "tests", "examples"]));
    expect(s.ingest.parallel).toBe(32);
    // Reading never rewrites the file.
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).ingest.exclude).toHaveLength(previous.length);
  });

  it("never touches an owner's own list, even one that differs from a default by one pattern", () => {
    fs.mkdirSync(root, { recursive: true });
    const custom = [...previous, "Private"];
    fs.writeFileSync(settingsPath(), JSON.stringify({ ingest: { exclude: custom } }));
    expect(readSettings().ingest.exclude).toEqual(custom);
    const trimmed = previous.filter((p) => p !== "build");
    expect(writeSettings({ ingest: { exclude: trimmed } }).ingest.exclude).toEqual(trimmed);
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).ingest.exclude).toEqual(trimmed);
  });

  it("stores nothing when the default list is saved (Restore the default list), so it keeps following ClawBox", () => {
    writeSettings({ ingest: { exclude: ["drafts"] } });
    const s = writeSettings({ ingest: { exclude: [...DEFAULT_INGEST_EXCLUDES] } });
    expect(s.ingest.exclude).toEqual([...DEFAULT_INGEST_EXCLUDES]);
    const stored = JSON.parse(fs.readFileSync(settingsPath(), "utf8")).ingest;
    expect(stored).not.toHaveProperty("exclude");
    expect(stored).not.toHaveProperty("excludeSavedWith");
  });

  it("keeps the earlier default list when the owner saves it now (removing exactly the patterns added since)", () => {
    const s = writeSettings({ ingest: { exclude: [...previous] } });
    expect(s.ingest.exclude).toEqual([...previous]);
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).ingest).toMatchObject({ exclude: [...previous], excludeSavedWith: EXCLUDE_DEFAULTS_GENERATION });
    expect(readSettings().ingest.exclude).toEqual([...previous]);
    // Put back to the defaults, the marker goes with the list.
    writeSettings({ ingest: { exclude: null } });
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).ingest).toEqual({});
  });

  it("recognises today's and every earlier default list, and nothing else", () => {
    expect(isDefaultExcludeList(DEFAULT_INGEST_EXCLUDES)).toBe(true);
    expect(isDefaultExcludeList(previous)).toBe(true);
    // Saved under today's generation, the earlier list is the owner's choice.
    expect(isDefaultExcludeList(previous, EXCLUDE_DEFAULTS_GENERATION)).toBe(false);
    expect(isDefaultExcludeList(DEFAULT_INGEST_EXCLUDES, EXCLUDE_DEFAULTS_GENERATION)).toBe(true);
    expect(isDefaultExcludeList(previous, "2")).toBe(true);
    expect(isDefaultExcludeList([])).toBe(false);
    expect(isDefaultExcludeList(["node_modules"])).toBe(false);
    // The earlier list is a frozen record: today's grew from it.
    for (const p of previous) expect(DEFAULT_INGEST_EXCLUDES).toContain(p);
    expect(Object.isFrozen(previous)).toBe(true);
  });
});

describe("the exclude list", () => {
  it("matches folder names exactly or by wildcard, without regard to case", () => {
    const match = compileExcludes(["node_modules", "*-spikes", "coding-agent-*", "cache?", "a.b"]);
    expect(match("node_modules")).toBe(true);
    expect(match("Node_Modules")).toBe(true);
    expect(match("widget-spikes")).toBe(true);
    expect(match("spikes-widget")).toBe(false);
    expect(match("coding-agent-archive")).toBe(true);
    expect(match("cache1")).toBe(true);
    expect(match("cache12")).toBe(false);
    expect(match("a.b")).toBe(true);
    expect(match("axb")).toBe(false);
  });

  it("covers version control, dependencies, caches, build output, worktrees, scratch and agent-run archives", () => {
    const match = compileExcludes(DEFAULT_INGEST_EXCLUDES);
    for (const name of [".git", "node_modules", ".venv", "__pycache__", ".cache", "dist", "worktrees", "acme-spikes", "scratch", "coding-agent-history"]) {
      expect(match(name), name).toBe(true);
    }
    for (const name of ["Documents", "invoices", "marketing", "reports"]) expect(match(name), name).toBe(false);
  });

  it("reads a caller's list strictly", () => {
    expect(readExcludeList(["a", "A", "b*"])).toEqual({ ok: true, patterns: ["a", "b*"] });
    expect(readExcludeList([1]).ok).toBe(false);
    expect(readExcludeList(["a\\b"]).ok).toBe(false);
    expect(readExcludeList(["a\u0000"]).ok).toBe(false);
  });
});

describe("cost rates", () => {
  it("are one object labelled as an estimate", () => {
    expect(DEFAULT_COST_RATES).toMatchObject({ basis: "estimate", currency: "USD", unit: "per-million-tokens" });
    expect(Object.isFrozen(DEFAULT_COST_RATES.models)).toBe(true);
  });

  it("take the owner's overrides model by model, and price a model with no rate at zero", () => {
    const rates = mergeCostRates({ "deepseek-v4-flash": { input: 1, cachedInput: 0.5, output: 2 }, "other-model": { input: 3, cachedInput: 3, output: 4 } });
    expect(estimateUsd("deepseek-v4-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 0 }, rates)).toBe(3);
    expect(estimateUsd("other-model", { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0 }, rates)).toBe(3);
    expect(estimateUsd("unpriced", { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 0 }, rates)).toBe(0);
    // The defaults are untouched.
    expect(DEFAULT_COST_RATES.models["deepseek-v4-flash"].input).toBe(0.14);
  });

  it("read an override strictly; cachedInput defaults to input", () => {
    expect(readRateOverrides({ m: { input: 1, output: 2 } })).toEqual({ ok: true, models: { m: { input: 1, cachedInput: 1, output: 2 } } });
    expect(readRateOverrides({ m: { input: "1", output: 2 } }).ok).toBe(false);
    expect(readRateOverrides(null)).toEqual({ ok: true, models: {} });
  });

  it("in force are the settings file's", () => {
    writeSettings({ costRates: { "deepseek-v4-flash": { input: 10, output: 20 } } });
    expect(effectiveCostRates().models["deepseek-v4-flash"]).toEqual({ input: 10, cachedInput: 10, output: 20 });
    writeSettings({ costRates: null });
    expect(effectiveCostRates().models["deepseek-v4-flash"]).toEqual(DEFAULT_COST_RATES.models["deepseek-v4-flash"]);
  });
});
