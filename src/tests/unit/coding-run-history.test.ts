/**
 * The run-history store (src/lib/coding-run-history.ts, TASK-1178) on its own:
 * the policy parse, the disk guard, the self-healing older-runs index, the
 * Claude Code settings merge, the usage walk and the export's layout. The trim that drives all of this through the runs store is pinned
 * in coding-agent-history-retention.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

type Lib = typeof import("@/lib/coding-run-history");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let data: string;
let restore: () => void;

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));
const config = () => readJson(path.join(data, "config.json"));

function record(id: string, over: Record<string, unknown> = {}) {
  return { id, task: `# Task ${id}\nmore`, status: "completed", startedAt: 1_000, completedAt: 2_000, directory: "/home/x/Projects/site", ...over }; // public-hygiene: allow synthetic test fixture, not a real host/account/credential
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "CLAUDE_DS_CONFIG_DIR");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "run-history-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  data = path.join(root, "data");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "config.json"), "{}");
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  delete process.env.CLAUDE_DS_CONFIG_DIR;
  vi.resetModules();
  lib = await import("@/lib/coding-run-history");
  lib.invalidateUsage();
});

afterEach(() => {
  vi.restoreAllMocks();
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the setting", () => {
  it("offers two modes, reads anything unknown as standard, and a retired mode as the one that keeps", () => {
    expect(lib.HISTORY_RETENTION_MODES).toEqual(["standard", "everything"]);
    expect(lib.historyPolicyFrom(undefined)).toEqual({ mode: "standard" });
    expect(lib.historyPolicyFrom("forever")).toEqual({ mode: "standard" });
    expect(lib.historyPolicyFrom(7)).toEqual({ mode: "standard" });
    expect(lib.historyPolicyFrom("everything")).toEqual({ mode: "everything" });
    // `extended` kept the newest N and `archive` moved a leaving run into a
    // bundle: both kept rather than deleted, so both read as "everything".
    expect(lib.historyPolicyFrom("extended")).toEqual({ mode: "everything" });
    expect(lib.historyPolicyFrom("archive")).toEqual({ mode: "everything" });
    // A property of Object.prototype is not a retired mode.
    expect(lib.historyPolicyFrom("constructor")).toEqual({ mode: "standard" });
    expect(lib.historyPolicyFrom("__proto__")).toEqual({ mode: "standard" });
  });

  it("keeps older runs under everything alone", () => {
    expect(lib.keepsOlderRuns(lib.historyPolicyFrom("standard"))).toBe(false);
    expect(lib.keepsOlderRuns(lib.historyPolicyFrom("everything"))).toBe(true);
  });
});

describe("the disk guard", () => {
  it("is low only below the threshold, and never on a statfs that failed", () => {
    expect(lib.isDiskLow({ freeBytes: lib.HISTORY_MIN_FREE_BYTES - 1, totalBytes: 1 })).toBe(true);
    expect(lib.isDiskLow({ freeBytes: lib.HISTORY_MIN_FREE_BYTES, totalBytes: 1 })).toBe(false);
    expect(lib.isDiskLow({ freeBytes: null, totalBytes: null })).toBe(false);
  });

  it("asks the nearest folder that exists, and answers nulls when statfs fails", () => {
    const space = lib.diskSpace(path.join(data, "not", "made", "yet"));
    expect(space.freeBytes).toBeGreaterThan(0);
    expect(space.totalBytes).toBeGreaterThanOrEqual(space.freeBytes!);
    vi.spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("EIO"); });
    expect(lib.diskSpace()).toEqual({ freeBytes: null, totalBytes: null });
  });
});

describe("older runs", () => {
  it("keeps a record in a file of its own and pages it newest first", () => {
    expect(lib.hasOlderRuns()).toBe(false);
    expect(lib.writeOlderRun(record("run-aaaaaaa1", { startedAt: 10 }))).toBe(true);
    expect(lib.writeOlderRun(record("run-aaaaaaa2", { startedAt: 30, worktree: { project: "/home/x/Projects/other" } }))).toBe(true); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(lib.writeOlderRun(record("run-aaaaaaa3", { startedAt: 20 }))).toBe(true);
    const file = path.join(data, "coding-agent-history", "run-aaaaaaa1.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(lib.olderRunIndex().map((e) => e.id)).toEqual(["run-aaaaaaa2", "run-aaaaaaa3", "run-aaaaaaa1"]);
    expect(lib.olderRunIndex()[0].project).toBe("/home/x/Projects/other"); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect((lib.readOlderRunRecord("run-aaaaaaa3") as { task: string }).task).toContain("Task run-aaaaaaa3");
  });

  it("refuses a record it could not index, and ids that are not run ids", () => {
    expect(lib.writeOlderRun({ id: "../../etc", startedAt: 1 })).toBe(false);
    expect(lib.writeOlderRun({ id: "run-aaaaaaa1" })).toBe(false);
    expect(lib.readOlderRunRecord("../config")).toBeUndefined();
  });

  it("heals its index against the folder", () => {
    lib.writeOlderRun(record("run-aaaaaaa1", { startedAt: 10 }));
    lib.writeOlderRun(record("run-aaaaaaa2", { startedAt: 20 }));
    const dir = path.join(data, "coding-agent-history");
    // A file the index does not name (a crash between the two writes), and a
    // named entry whose file is gone.
    fs.writeFileSync(path.join(dir, "run-aaaaaaa3.json"), JSON.stringify(record("run-aaaaaaa3", { startedAt: 30 })));
    fs.rmSync(path.join(dir, "run-aaaaaaa1.json"));
    expect(lib.olderRunIndex().map((e) => e.id)).toEqual(["run-aaaaaaa3", "run-aaaaaaa2"]);
    expect(readJson(path.join(dir, "index.json")).map((e: { id: string }) => e.id)).toEqual(["run-aaaaaaa3", "run-aaaaaaa2"]);
    fs.writeFileSync(path.join(dir, "index.json"), "not json");
    expect(lib.olderRunIndex()).toHaveLength(2);
    lib.removeOlderRun("run-aaaaaaa2");
    expect(lib.olderRunIndex().map((e) => e.id)).toEqual(["run-aaaaaaa3"]);
  });
});

describe("a stored team role", () => {
  it("reads as one of the roles a choice is made for, or none", () => {
    for (const role of ["planner", "worker", "reviewer"]) expect(lib.readModelRole(role)).toBe(role);
    // A record from before 2026-10-30 may still say "bulk": it was a worker's run.
    expect(lib.readModelRole("bulk")).toBe("worker");
    for (const junk of ["lead", "Planner", "", 1, null, undefined, {}]) expect(lib.readModelRole(junk)).toBeNull();
  });
});

describe("Claude Code's transcript period", () => {
  const ds = () => path.join(home, ".claude-ds", "settings.json");
  const own = () => path.join(home, ".claude", "settings.json");

  it("merges the period into each file, remembers what was there, and hands it back", async () => {
    fs.mkdirSync(path.dirname(ds()), { recursive: true });
    fs.writeFileSync(ds(), JSON.stringify({ model: "deepseek", env: { A: "1" }, cleanupPeriodDays: 14 }), { mode: 0o640 });
    const kept = await lib.keepHarnessTranscripts([ds(), own(), ds()]);
    expect(kept).toEqual([{ file: ds(), state: "kept" }, { file: own(), state: "kept" }]);
    expect(readJson(ds())).toEqual({ model: "deepseek", env: { A: "1" }, cleanupPeriodDays: lib.HARNESS_KEEP_TRANSCRIPT_DAYS });
    expect(fs.statSync(ds()).mode & 0o777).toBe(0o640);
    // A file that did not exist is made with only the key, 0600.
    expect(readJson(own())).toEqual({ cleanupPeriodDays: lib.HARNESS_KEEP_TRANSCRIPT_DAYS });
    expect(fs.statSync(own()).mode & 0o777).toBe(0o600);
    expect(config()[lib.CODING_AGENT_HISTORY_PINS_CONFIG_KEY]).toEqual({ [ds()]: { present: true, value: 14 }, [own()]: { present: false } });
    expect(lib.harnessTranscriptState([ds(), own()]).map((s) => [s.label, s.kept])).toEqual([["~/.claude-ds/settings.json", true], ["~/.claude/settings.json", true]]);

    // Asking again changes nothing and forgets nothing.
    expect(await lib.keepHarnessTranscripts([ds()])).toEqual([{ file: ds(), state: "already" }]);

    const released = await lib.releaseHarnessTranscripts();
    expect(released).toEqual([{ file: ds(), state: "restored" }, { file: own(), state: "restored" }]);
    expect(readJson(ds())).toEqual({ model: "deepseek", env: { A: "1" }, cleanupPeriodDays: 14 });
    expect(readJson(own())).toEqual({});
    expect(config()[lib.CODING_AGENT_HISTORY_PINS_CONFIG_KEY]).toBeUndefined();
    expect(await lib.releaseHarnessTranscripts()).toEqual([]);
  });

  it("never overwrites a file it cannot read, and leaves a period someone changed since", async () => {
    fs.mkdirSync(path.dirname(ds()), { recursive: true });
    fs.writeFileSync(ds(), "{ this is not json");
    fs.mkdirSync(path.dirname(own()), { recursive: true });
    fs.writeFileSync(own(), JSON.stringify({ theme: "dark" }));
    expect(await lib.keepHarnessTranscripts([ds(), own()])).toEqual([{ file: ds(), state: "unreadable" }, { file: own(), state: "kept" }]);
    expect(fs.readFileSync(ds(), "utf-8")).toBe("{ this is not json");
    expect(lib.harnessTranscriptState([ds()])[0]).toMatchObject({ readable: false, kept: false });

    // The owner sets their own period while "keep everything" is on.
    fs.writeFileSync(own(), JSON.stringify({ theme: "dark", cleanupPeriodDays: 90 }));
    expect(await lib.releaseHarnessTranscripts()).toEqual([{ file: own(), state: "left" }]);
    expect(readJson(own())).toEqual({ theme: "dark", cleanupPeriodDays: 90 });
  });

  it("treats an array or a string as unreadable, not as settings", async () => {
    fs.mkdirSync(path.dirname(ds()), { recursive: true });
    fs.writeFileSync(ds(), "[1,2]");
    expect(await lib.keepHarnessTranscripts([ds()])).toEqual([{ file: ds(), state: "unreadable" }]);
    expect(fs.readFileSync(ds(), "utf-8")).toBe("[1,2]");
  });
});

describe("usage and export", () => {
  it("adds up what the history weighs, leaving the owner's shared inputs out", async () => {
    const runsFile = path.join(data, "coding-agent-runs.json");
    fs.writeFileSync(runsFile, "x".repeat(100));
    fs.mkdirSync(path.join(data, "coding-agent-artifacts", "run-ccccccc1"), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-artifacts", "run-ccccccc1", "a.png"), "y".repeat(1000));
    fs.mkdirSync(path.join(data, "coding-agent-inputs", "shared"), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-inputs", "shared", "big.bin"), "z".repeat(5000));
    fs.mkdirSync(path.join(data, "coding-agent-inputs", "run-ccccccc1"), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-inputs", "run-ccccccc1", "in.txt"), "w".repeat(10));
    const transcripts = path.join(home, ".claude-ds", "projects");
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, "t.jsonl"), "t".repeat(50));
    const usage = await lib.historyUsage({ runsFile, streamsDir: path.join(data, "coding-agent-streams"), transcriptDirs: [transcripts, transcripts] });
    expect(usage).toMatchObject({ runsFile: 100, evidence: 1000, inputs: 10, olderRuns: 0, transcripts: 50, total: 1110, truncated: false });
    expect(usage).not.toHaveProperty("archive");

    // Cached until something changes it.
    fs.writeFileSync(path.join(data, "coding-agent-artifacts", "run-ccccccc1", "b.png"), "y".repeat(1000));
    expect((await lib.historyUsage({ runsFile, streamsDir: "/nonexistent", transcriptDirs: [] })).evidence).toBe(1000);
    lib.invalidateUsage();
    expect((await lib.historyUsage({ runsFile, streamsDir: "/nonexistent", transcriptDirs: [] })).evidence).toBe(2000);
  });

  it("lays the whole history out under one tree for the export", async () => {
    fs.mkdirSync(path.join(data, "coding-agent-artifacts", "run-ddddddd1"), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-artifacts", "run-ddddddd1", "shot.png"), "p");
    fs.mkdirSync(path.join(data, "coding-agent-inputs", "shared"), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-inputs", "shared", "mine.txt"), "owner's");
    lib.writeOlderRun(record("run-ddddddd2"));
    const transcript = path.join(base, "t.jsonl");
    fs.writeFileSync(transcript, "{}");
    // An archive an earlier build filled is not the history any more: left
    // on the flash, not exported.
    fs.mkdirSync(path.join(data, "coding-agent-archive", "run-ddddddd3"), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-archive", "run-ddddddd3", "run.json"), "{}");
    const names: string[] = [];
    for await (const s of lib.historyExportSources({
      manifest: { kind: "test" },
      runs: [{ id: "run-ddddddd1" }],
      transcripts: [{ id: "run-ddddddd1", file: transcript }, { id: "run-ddddddd2", file: null }, { id: "../x", file: transcript }],
    })) names.push(s.name);
    // The manifest and the live list first; the rest in whatever order the walks find it.
    expect(names.slice(0, 2)).toEqual(["manifest.json", "runs.json"]);
    expect([...names].sort()).toEqual([
      "evidence/run-ddddddd1/shot.png",
      "manifest.json",
      "older-runs/run-ddddddd2.json",
      "runs.json",
      "transcripts/run-ddddddd1.jsonl",
    ]);
  });
});
