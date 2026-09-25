/**
 * The run-history store (src/lib/coding-run-history.ts, TASK-1178) on its own:
 * the policy parse, the disk guard, the archive move, the two self-healing
 * indexes, the Claude Code settings merge, the usage walk and the export's
 * layout. The trim that drives all of this through the runs store is pinned
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
  return { id, task: `# Task ${id}\nmore`, status: "completed", startedAt: 1_000, completedAt: 2_000, directory: "/home/x/Projects/site", ...over };
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
  it("reads anything unknown as standard, and an unoffered limit as the default", () => {
    expect(lib.historyPolicyFrom(undefined, undefined)).toEqual({ mode: "standard", limit: 100 });
    expect(lib.historyPolicyFrom("forever", 7)).toEqual({ mode: "standard", limit: 100 });
    expect(lib.historyPolicyFrom("extended", 300)).toEqual({ mode: "extended", limit: 300 });
    expect(lib.historyPolicyFrom("archive", "1000")).toEqual({ mode: "archive", limit: 100 });
  });

  it("keeps older runs only in extended and everything, and caps them at N minus the live list", () => {
    const at = (mode: string, limit = 100) => lib.historyPolicyFrom(mode, limit);
    expect(lib.keepsOlderRuns(at("standard"))).toBe(false);
    expect(lib.keepsOlderRuns(at("archive"))).toBe(false);
    expect(lib.keepsOlderRuns(at("extended"))).toBe(true);
    expect(lib.keepsOlderRuns(at("everything"))).toBe(true);
    expect(lib.olderRunsCap(at("extended", 100), 30)).toBe(70);
    expect(lib.olderRunsCap(at("extended", 100), 140)).toBe(0);
    expect(lib.olderRunsCap(at("everything"), 30)).toBe(Number.POSITIVE_INFINITY);
    expect(lib.olderRunsCap(at("standard"), 30)).toBe(0);
    expect(lib.olderRunsCap(at("archive"), 30)).toBe(0);
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
    expect(lib.writeOlderRun(record("run-aaaaaaa2", { startedAt: 30, worktree: { project: "/home/x/Projects/other" } }))).toBe(true);
    expect(lib.writeOlderRun(record("run-aaaaaaa3", { startedAt: 20 }))).toBe(true);
    const file = path.join(data, "coding-agent-history", "run-aaaaaaa1.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(lib.olderRunIndex().map((e) => e.id)).toEqual(["run-aaaaaaa2", "run-aaaaaaa3", "run-aaaaaaa1"]);
    expect(lib.olderRunIndex()[0].project).toBe("/home/x/Projects/other");
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

describe("the archive", () => {
  function parts(id: string) {
    const evidence = path.join(data, "coding-agent-artifacts", id);
    const inputs = path.join(data, "coding-agent-inputs", id);
    const streams = path.join(data, "coding-agent-streams");
    const transcriptDir = path.join(home, ".claude-ds", "projects", "-home-x-Projects-site");
    for (const d of [evidence, inputs, streams, transcriptDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(evidence, "shot.png"), "png-bytes");
    fs.writeFileSync(path.join(evidence, "report.md"), "# Done");
    fs.writeFileSync(path.join(inputs, "brief.txt"), "the brief");
    fs.writeFileSync(path.join(streams, `${id}.jsonl`), '{"type":"result"}\n');
    fs.writeFileSync(path.join(streams, `${id}.err`), "");
    const transcript = path.join(transcriptDir, "sess-1.jsonl");
    fs.writeFileSync(transcript, '{"type":"user"}\n');
    return {
      evidenceDir: evidence,
      inputsDir: inputs,
      streamLog: path.join(streams, `${id}.jsonl`),
      stderrLog: path.join(streams, `${id}.err`),
      transcript,
    };
  }

  it("moves the record, evidence, inputs and logs in, copies the transcript, and lists it", () => {
    const id = "run-bbbbbbb1";
    const sources = parts(id);
    const entry = lib.archiveRun(record(id, { startedAt: 5_000 }), sources, "trimmed", 9_000);
    expect(entry).toMatchObject({ id, title: `Task ${id}`, status: "completed", archivedAt: 9_000, evidence: 2, inputs: 1, transcript: true, stream: true, reason: "trimmed" });
    const bundle = path.join(data, "coding-agent-archive", id);
    expect(readJson(path.join(bundle, "run.json")).id).toBe(id);
    expect(fs.readFileSync(path.join(bundle, "evidence", "shot.png"), "utf-8")).toBe("png-bytes");
    expect(fs.readFileSync(path.join(bundle, "inputs", "brief.txt"), "utf-8")).toBe("the brief");
    expect(fs.existsSync(path.join(bundle, "stream.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(bundle, "stream.err"))).toBe(true);
    expect(fs.readFileSync(path.join(bundle, "transcript.jsonl"), "utf-8")).toBe('{"type":"user"}\n');
    // MOVED — not a second copy on the flash — except the transcript, which is
    // Claude Code's file and is left where Claude Code keeps it.
    expect(fs.existsSync(sources.evidenceDir)).toBe(false);
    expect(fs.existsSync(sources.inputsDir)).toBe(false);
    expect(fs.existsSync(sources.streamLog)).toBe(false);
    expect(fs.existsSync(sources.transcript)).toBe(true);
    expect(entry!.bytes).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(data, "coding-agent-archive")).filter((n) => n.startsWith("."))).toEqual([]);

    expect(lib.listArchive(0, 10)).toMatchObject({ total: 1, entries: [{ id }] });
    const detail = lib.readArchivedRun(id)!;
    expect(detail.evidence.map((f) => [f.name, f.kind])).toEqual(expect.arrayContaining([["shot.png", "image"], ["report.md", "markdown"]]));
    expect(detail.inputs).toEqual([{ name: "brief.txt", bytes: 9 }]);
    expect(detail.transcriptBytes).toBe(16);
    expect(lib.archivedEvidencePath(id, "shot.png")).toBe(fs.realpathSync(path.join(bundle, "evidence", "shot.png")));
  });

  it("archives what is there, and says so, when parts are missing", () => {
    const id = "run-bbbbbbb2";
    const entry = lib.archiveRun(record(id), { evidenceDir: path.join(data, "none"), inputsDir: null, streamLog: null, stderrLog: null, transcript: path.join(home, "gone.jsonl") }, "cleared")!;
    expect(entry).toMatchObject({ evidence: 0, inputs: 0, transcript: false, stream: false, reason: "cleared" });
    expect(lib.readArchivedRun(id)!.transcriptBytes).toBeNull();
  });

  it("never follows a link a run left where its folders should be", () => {
    const id = "run-bbbbbbb3";
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "not the run's");
    fs.mkdirSync(path.join(data, "coding-agent-artifacts"), { recursive: true });
    const evidence = path.join(data, "coding-agent-artifacts", id);
    fs.symlinkSync(outside, evidence);
    const transcriptLink = path.join(base, "t.jsonl");
    fs.symlinkSync(path.join(outside, "keep.txt"), transcriptLink);
    const entry = lib.archiveRun(record(id), { evidenceDir: evidence, inputsDir: null, streamLog: null, stderrLog: null, transcript: transcriptLink }, "trimmed")!;
    expect(entry.evidence).toBe(0);
    expect(entry.transcript).toBe(false);
    expect(fs.existsSync(evidence)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf-8")).toBe("not the run's");
  });

  it("refuses to serve anything but a plain evidence file inside the bundle", () => {
    const id = "run-bbbbbbb4";
    lib.archiveRun(record(id), parts(id), "trimmed");
    const evidence = path.join(data, "coding-agent-archive", id, "evidence");
    fs.symlinkSync(path.join(data, "config.json"), path.join(evidence, "config.json"));
    expect(lib.archivedEvidencePath(id, "config.json")).toBeNull();
    expect(lib.archivedEvidencePath(id, "../run.json")).toBeNull();
    expect(lib.archivedEvidencePath(id, ".hidden")).toBeNull();
    expect(lib.archivedEvidencePath("run-../../x", "shot.png")).toBeNull();
    expect(lib.readArchivedRun("../config")).toBeNull();
  });

  it("heals its index from the bundles, and clears", () => {
    lib.archiveRun(record("run-bbbbbbb5", { startedAt: 1 }), parts("run-bbbbbbb5"), "trimmed");
    lib.archiveRun(record("run-bbbbbbb6", { startedAt: 2 }), parts("run-bbbbbbb6"), "trimmed");
    const archive = path.join(data, "coding-agent-archive");
    fs.rmSync(path.join(archive, "index.json"));
    // A bundle that lost its archive.json is rebuilt from its run.json.
    fs.rmSync(path.join(archive, "run-bbbbbbb5", "archive.json"));
    expect(lib.archiveIndex().map((e) => [e.id, e.title])).toEqual([["run-bbbbbbb6", "Task run-bbbbbbb6"], ["run-bbbbbbb5", "Task run-bbbbbbb5"]]);
    fs.rmSync(path.join(archive, "run-bbbbbbb6"), { recursive: true });
    expect(lib.archiveIndex().map((e) => e.id)).toEqual(["run-bbbbbbb5"]);
    expect(lib.clearArchive()).toBe(1);
    expect(fs.existsSync(archive)).toBe(false);
    expect(lib.archiveIndex()).toEqual([]);
  });

  it("zips one bundle under its own name", () => {
    const id = "run-bbbbbbb7";
    lib.archiveRun(record(id), parts(id), "trimmed");
    const names = lib.archivedRunZipSources(id)!.map((s) => s.name).sort();
    expect(names).toEqual([`${id}/archive.json`, `${id}/evidence/report.md`, `${id}/evidence/shot.png`, `${id}/inputs/brief.txt`, `${id}/run.json`, `${id}/stream.err`, `${id}/stream.jsonl`, `${id}/transcript.jsonl`]);
    expect(lib.archivedRunZipSources("run-zzzzzzzz")).toBeNull();
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
    expect(usage).toMatchObject({ runsFile: 100, evidence: 1000, inputs: 10, archive: 0, olderRuns: 0, transcripts: 50, total: 1110, truncated: false });

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
    lib.archiveRun(record("run-ddddddd3"), { evidenceDir: null, inputsDir: null, streamLog: null, stderrLog: null, transcript: null }, "trimmed");
    // A half-made bundle is not the archive.
    fs.mkdirSync(path.join(data, "coding-agent-archive", ".run-ddddddd4.partial"), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-archive", ".run-ddddddd4.partial", "run.json"), "{}");
    const names: string[] = [];
    for await (const s of lib.historyExportSources({
      manifest: { kind: "test" },
      runs: [{ id: "run-ddddddd1" }],
      transcripts: [{ id: "run-ddddddd1", file: transcript }, { id: "run-ddddddd2", file: null }, { id: "../x", file: transcript }],
    })) names.push(s.name);
    // The manifest and the live list first; the rest in whatever order the walks find it.
    expect(names.slice(0, 2)).toEqual(["manifest.json", "runs.json"]);
    expect([...names].sort()).toEqual([
      "archive/run-ddddddd3/archive.json",
      "archive/run-ddddddd3/run.json",
      "evidence/run-ddddddd1/shot.png",
      "manifest.json",
      "older-runs/run-ddddddd2.json",
      "runs.json",
      "transcripts/run-ddddddd1.jsonl",
    ]);
  });
});
