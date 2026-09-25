/**
 * The owner's run-history setting through the runs store itself (TASK-1178):
 * what happens to the run that leaves the newest thirty in each mode, what a
 * later mode does to runs an earlier one kept, the disk guard, the owner's
 * Clear, the setting's own door, and Claude Code's transcript period.
 *
 * Runs are SEEDED into the runs file and the trim is driven by drafting a run
 * (createDraftRun → insertRun), which spawns nothing: the thirty-first record
 * is what matters here, not a harness. One test starts a real (fake) harness,
 * for the one decision the settle makes — keeping the stream log for the
 * archive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const announce = vi.hoisted(() => vi.fn<(run: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: announce }));
const memAvailable = vi.hoisted(() => vi.fn(async (): Promise<number | null> => 8000));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: memAvailable }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

type Lib = typeof import("@/lib/coding-agent");
type History = typeof import("@/lib/coding-run-history");

let lib: Lib;
let history: History;
let base: string;
let home: string;
let root: string;
let data: string;
let project: string;
let restore: () => void;

const runsFile = () => path.join(data, "coding-agent-runs.json");
const evidenceOf = (id: string) => path.join(data, "coding-agent-artifacts", id);
const inputsOf = (id: string) => path.join(data, "coding-agent-inputs", id);
const olderFile = (id: string) => path.join(data, "coding-agent-history", `${id}.json`);
const bundleOf = (id: string) => path.join(data, "coding-agent-archive", id);
const onDisk = (): { id: string; status: string }[] => JSON.parse(fs.readFileSync(runsFile(), "utf-8"));
const idOf = (n: number) => `run-${String(n).padStart(8, "0")}`;

function writeConfig(cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify(cfg));
}

function transcriptOf(n: number): string {
  return path.join(home, ".claude-ds", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `sess-${n}.jsonl`);
}

/** A settled run as the runs file would hold it, with its evidence, inputs and transcript on disk. */
function runRecord(n: number, over: Record<string, unknown> = {}) {
  const id = idOf(n);
  fs.mkdirSync(evidenceOf(id), { recursive: true });
  fs.writeFileSync(path.join(evidenceOf(id), "shot.png"), `png ${n}`);
  fs.mkdirSync(inputsOf(id), { recursive: true });
  fs.writeFileSync(path.join(inputsOf(id), "in.txt"), `input ${n}`);
  fs.mkdirSync(path.dirname(transcriptOf(n)), { recursive: true });
  fs.writeFileSync(transcriptOf(n), `{"n":${n}}\n`);
  return {
    id,
    task: `Task number ${n}`,
    directory: project,
    status: "completed",
    // Higher n is OLDER: the runs file is newest first.
    startedAt: 10_000_000 - n * 1000,
    completedAt: 10_000_000 - n * 1000 + 500,
    sessionId: `sess-${n}`,
    provider: "clawbox-ai",
    ...over,
  };
}

/** Seed the runs file with runs `from`..`to` (inclusive), newest first. */
function seedLive(from: number, to: number, over: Record<string, unknown> = {}): string[] {
  const records = [];
  for (let n = from; n <= to; n += 1) records.push(runRecord(n, over));
  fs.writeFileSync(runsFile(), JSON.stringify(records));
  return records.map((r) => r.id);
}

/** Runs `from`..`to` already kept as older runs by an earlier mode. */
function seedOlder(from: number, to: number): string[] {
  const ids = [];
  for (let n = from; n <= to; n += 1) {
    expect(history.writeOlderRun(runRecord(n))).toBe(true);
    ids.push(idOf(n));
  }
  return ids;
}

const draft = () => lib.createDraftRun({ task: "a new run", projectId: "site", source: "owner" });

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "CLAUDE_DS_CONFIG_DIR");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "history-retention-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  data = path.join(root, "data");
  fs.mkdirSync(data, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  delete process.env.CLAUDE_DS_CONFIG_DIR;
  project = path.join(data, "code-projects", "site");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ projectId: "site", name: "site" }));
  writeConfig({});
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  history = await import("@/lib/coding-run-history");
  history.invalidateUsage();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("standard — the default", () => {
  it("trims a box that never touched the setting exactly as before, without asking the disk", async () => {
    const ids = seedLive(0, 29);
    const statfs = vi.spyOn(fs, "statfsSync");
    const made = await draft();
    const list = onDisk();
    expect(list).toHaveLength(30);
    expect(list[0].id).toBe(made.id);
    expect(list.map((r) => r.id)).not.toContain(ids[29]);
    expect(fs.existsSync(evidenceOf(ids[29]))).toBe(false);
    expect(fs.existsSync(inputsOf(ids[29]))).toBe(false);
    expect(fs.existsSync(evidenceOf(ids[28]))).toBe(true);
    // Nothing new on the flash: no older runs, no archive, and the transcript
    // is Claude Code's to expire, as it always was.
    expect(fs.existsSync(path.join(data, "coding-agent-history"))).toBe(false);
    expect(fs.existsSync(path.join(data, "coding-agent-archive"))).toBe(false);
    expect(fs.existsSync(transcriptOf(29))).toBe(true);
    expect(statfs).not.toHaveBeenCalled();
    expect(lib.getRun(ids[29])).toBeNull();
    expect((await lib.getCodingAgentStatus()).historyRetention).toBe("standard");
  });

  it("never drops a held run, in any mode", async () => {
    for (const mode of ["standard", "extended", "archive"]) {
      writeConfig({ coding_agent_history_retention: mode });
      const ids = seedLive(0, 29, { status: "paused" });
      await lib._resetCodingAgentStateForTests();
      await draft();
      expect(onDisk()).toHaveLength(31);
      expect(fs.existsSync(evidenceOf(ids[29]))).toBe(true);
      expect(fs.existsSync(bundleOf(ids[29]))).toBe(false);
      expect(fs.existsSync(olderFile(ids[29]))).toBe(false);
    }
  });
});

describe("extended", () => {
  it("keeps the run leaving the live thirty as an older run, evidence and inputs in place", async () => {
    writeConfig({ coding_agent_history_retention: "extended", coding_agent_history_limit: 100 });
    const ids = seedLive(0, 29);
    await draft();
    // The runs file is still thirty records: the older run is in a file of its own.
    expect(onDisk()).toHaveLength(30);
    expect(onDisk().map((r) => r.id)).not.toContain(ids[29]);
    expect(fs.existsSync(olderFile(ids[29]))).toBe(true);
    expect(fs.statSync(olderFile(ids[29])).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(evidenceOf(ids[29]))).toBe(true);
    expect(fs.existsSync(inputsOf(ids[29]))).toBe(true);
    // It opens like any other run.
    expect(lib.getRun(ids[29])).toMatchObject({ id: ids[29], status: "completed", task: "Task number 29" });
    expect(lib.listOlderRuns()).toMatchObject({ total: 1, runs: [{ id: ids[29] }] });
  });

  it("trims the older runs to N, oldest first, with their evidence", async () => {
    writeConfig({ coding_agent_history_retention: "extended", coding_agent_history_limit: 100 });
    seedLive(0, 29);
    const older = seedOlder(30, 100);
    expect(history.olderRunIndex()).toHaveLength(71);
    await draft();
    // 30 in the runs file + 70 older = the 100 the owner chose.
    const index = history.olderRunIndex();
    expect(index).toHaveLength(70);
    expect(index[0].id).toBe(idOf(29));
    for (const gone of older.slice(-2)) {
      expect(fs.existsSync(olderFile(gone))).toBe(false);
      expect(fs.existsSync(evidenceOf(gone))).toBe(false);
      expect(fs.existsSync(inputsOf(gone))).toBe(false);
    }
    expect(fs.existsSync(evidenceOf(older[older.length - 3]))).toBe(true);
  });

  it("pages the older runs newest first and narrows them to a project", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    seedLive(0, 29);
    seedOlder(30, 44);
    const other = path.join(base, "elsewhere");
    history.writeOlderRun(runRecord(45, { directory: path.join(other, ".clawbox", "worktrees", "run-x"), worktree: { path: path.join(other, ".clawbox", "worktrees", "run-x"), branch: "b", base: "main", project: other } }));
    const page = lib.listOlderRuns({ offset: 5, limit: 5 });
    expect(page.total).toBe(16);
    expect(page.runs.map((r) => r.id)).toEqual([35, 36, 37, 38, 39].map(idOf));
    expect(lib.listOlderRuns({ project: other })).toMatchObject({ total: 1, runs: [{ id: idOf(45) }] });
    expect(lib.listOlderRuns({ project })).toMatchObject({ total: 15 });
  });
});

describe("keep everything", () => {
  it("never deletes a run", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    seedLive(0, 29);
    seedOlder(30, 200);
    await draft();
    expect(history.olderRunIndex()).toHaveLength(172);
    expect(fs.existsSync(evidenceOf(idOf(200)))).toBe(true);
  });
});

describe("archive", () => {
  it("moves the leaving run into the archive with its evidence, inputs, stream log and a transcript copy", async () => {
    writeConfig({ coding_agent_history_retention: "archive" });
    const ids = seedLive(0, 29);
    const streams = path.join(data, "coding-agent-streams");
    fs.mkdirSync(streams, { recursive: true });
    fs.writeFileSync(path.join(streams, `${ids[29]}.jsonl`), '{"type":"result"}\n');
    await draft();
    expect(onDisk()).toHaveLength(30);
    const bundle = bundleOf(ids[29]);
    expect(JSON.parse(fs.readFileSync(path.join(bundle, "run.json"), "utf-8"))).toMatchObject({ id: ids[29], task: "Task number 29", status: "completed" });
    expect(fs.readFileSync(path.join(bundle, "evidence", "shot.png"), "utf-8")).toBe("png 29");
    expect(fs.readFileSync(path.join(bundle, "inputs", "in.txt"), "utf-8")).toBe("input 29");
    expect(fs.readFileSync(path.join(bundle, "stream.jsonl"), "utf-8")).toBe('{"type":"result"}\n');
    expect(fs.readFileSync(path.join(bundle, "transcript.jsonl"), "utf-8")).toBe('{"n":29}\n');
    expect(fs.existsSync(evidenceOf(ids[29]))).toBe(false);
    expect(fs.existsSync(inputsOf(ids[29]))).toBe(false);
    expect(fs.existsSync(transcriptOf(29))).toBe(true);
    expect(history.archiveIndex().map((e) => e.id)).toEqual([ids[29]]);
    // Off the live list — the archive is where it is read now.
    expect(lib.getRun(ids[29])).toBeNull();
    expect(history.readArchivedRun(ids[29])!.entry.reason).toBe("trimmed");
  });

  it("archives the older runs an earlier mode kept, at the next run", async () => {
    writeConfig({ coding_agent_history_retention: "archive" });
    seedLive(0, 29);
    const older = seedOlder(30, 34);
    await draft();
    expect(fs.existsSync(path.join(data, "coding-agent-history", "index.json")) ? history.olderRunIndex() : []).toEqual([]);
    expect(history.archiveIndex().map((e) => e.id).sort()).toEqual([idOf(29), ...older].sort());
    for (const id of older) {
      expect(fs.existsSync(path.join(bundleOf(id), "evidence", "shot.png"))).toBe(true);
      expect(fs.existsSync(olderFile(id))).toBe(false);
    }
  });
});

describe("leaving a mode that kept more", () => {
  it("standard deletes the older runs at the next run — not when the setting is saved", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    seedLive(0, 29);
    const older = seedOlder(30, 39);
    await lib.setHistoryRetention({ mode: "standard" });
    // Saved, and nothing deleted yet: a mis-tap can still be taken back.
    expect(history.olderRunIndex()).toHaveLength(10);
    await draft();
    expect(history.olderRunIndex()).toHaveLength(0);
    for (const id of older) expect(fs.existsSync(evidenceOf(id))).toBe(false);
    expect(fs.existsSync(path.join(data, "coding-agent-archive"))).toBe(false);
  });
});

describe("the disk guard", () => {
  function lowDisk() {
    return vi.spyOn(fs, "statfsSync").mockImplementation((() => ({
      type: 0, bsize: 4096, blocks: 1_000_000, bfree: 10, bavail: 10, files: 0, ffree: 0,
    })) as unknown as typeof fs.statfsSync);
  }

  it("deletes the leaving run as standard would, instead of keeping or archiving it", async () => {
    for (const mode of ["extended", "everything", "archive"]) {
      writeConfig({ coding_agent_history_retention: mode, coding_agent_history_limit: 1000 });
      const ids = seedLive(0, 29);
      await lib._resetCodingAgentStateForTests();
      const spy = lowDisk();
      await draft();
      spy.mockRestore();
      expect(fs.existsSync(olderFile(ids[29])), mode).toBe(false);
      expect(fs.existsSync(bundleOf(ids[29])), mode).toBe(false);
      expect(fs.existsSync(evidenceOf(ids[29])), mode).toBe(false);
    }
  });

  it("stops the history growing without purging what is already kept", async () => {
    writeConfig({ coding_agent_history_retention: "archive" });
    seedLive(0, 29);
    const older = seedOlder(30, 34);
    lowDisk();
    await draft();
    // Older runs a previous mode kept are neither archived nor deleted while
    // the disk is low: moving them is not what the guard is for.
    expect(history.olderRunIndex().map((e) => e.id)).toEqual(older);
    expect(history.archiveIndex()).toEqual([]);
    expect((await lib.runHistorySummary()).disk.low).toBe(true);
  });
});

describe("the owner's Clear", () => {
  it("archives the finished runs — live and older — under archive, and keeps what is held", async () => {
    writeConfig({ coding_agent_history_retention: "archive" });
    const live = seedLive(0, 3);
    const records = onDisk();
    records[0].status = "paused";
    fs.writeFileSync(runsFile(), JSON.stringify(records));
    const older = seedOlder(4, 5);
    await lib.getHistoryPolicy();
    expect(lib.clearFinishedRuns(await lib.getHistoryPolicy())).toBe(5);
    expect(onDisk().map((r) => r.id)).toEqual([live[0]]);
    expect(history.archiveIndex().map((e) => e.id).sort()).toEqual([...live.slice(1), ...older].sort());
    expect(history.readArchivedRun(live[1])!.entry.reason).toBe("cleared");
  });

  it("deletes them, older runs included, under the other modes", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    const live = seedLive(0, 2);
    const older = seedOlder(3, 4);
    expect(lib.clearFinishedRuns(await lib.getHistoryPolicy())).toBe(5);
    expect(onDisk()).toEqual([]);
    expect(history.olderRunIndex()).toEqual([]);
    for (const id of [...live, ...older]) expect(fs.existsSync(evidenceOf(id))).toBe(false);
    expect(fs.existsSync(path.join(data, "coding-agent-archive"))).toBe(false);
  });
});

describe("the setting's door", () => {
  const ds = () => path.join(home, ".claude-ds", "settings.json");
  const own = () => path.join(home, ".claude", "settings.json");
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));

  it("refuses what the box does not offer, before saving anything", async () => {
    await expect(lib.setHistoryRetention({ mode: "forever" })).rejects.toThrow(/one of: standard, extended, everything, archive/);
    await expect(lib.setHistoryRetention({ mode: "extended", limit: 50 })).rejects.toThrow(/one of: 100, 300, 1000/);
    expect(JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf-8"))).toEqual({});
  });

  it("tells Claude Code to keep transcripts under keep everything, and hands the period back after", async () => {
    fs.mkdirSync(path.dirname(ds()), { recursive: true });
    fs.writeFileSync(ds(), JSON.stringify({ model: "deepseek-v4-flash" }));
    const change = await lib.setHistoryRetention({ mode: "everything" });
    expect(change.policy.mode).toBe("everything");
    expect(change.transcripts.map((t) => t.state)).toEqual(["kept", "kept"]);
    expect(readJson(ds())).toEqual({ model: "deepseek-v4-flash", cleanupPeriodDays: 36_500 });
    expect(readJson(own())).toEqual({ cleanupPeriodDays: 36_500 });
    const status = await lib.getCodingAgentStatus();
    expect(status).toMatchObject({ historyRetention: "everything", historyLimit: 100, historyLimits: [100, 300, 1000], historyLiveKept: 30 });

    const back = await lib.setHistoryRetention({ mode: "extended", limit: 300 });
    expect(back.policy).toEqual({ mode: "extended", limit: 300 });
    expect(readJson(ds())).toEqual({ model: "deepseek-v4-flash" });
    expect(readJson(own())).toEqual({});
  });

  it("start over puts the setting back and hands Claude Code its period back", async () => {
    await lib.setHistoryRetention({ mode: "everything" });
    await lib.resetCodingAgentSetup();
    expect((await lib.getHistoryPolicy()).mode).toBe("standard");
    expect(readJson(ds())).toEqual({});
  });
});

describe("the settle under archive", () => {
  function readyDevice(): void {
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const init = '{"type":"system","subtype":"init","session_id":"sess-live","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
    const result = '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"done","session_id":"sess-live"}';
    fs.writeFileSync(path.join(bin, "claude-ds"), ["#!/usr/bin/env bash", readFirstTurn(), `echo '${init}'`, `echo '${result}'`, "exit 0"].join("\n"), { mode: 0o755 });
  }

  it("keeps a settled run's stream log for the archive, and only under archive", async () => {
    for (const mode of ["archive", "standard"]) {
      readyDevice();
      writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, coding_agent_history_retention: mode });
      const started = await lib.startRun({ task: `settle under ${mode}`, projectId: "site", source: "agent" });
      const done = await lib.waitForRun(started.id, 15_000);
      expect(done?.status, mode).toBe("completed");
      await lib._resetCodingAgentStateForTests();
      expect(fs.existsSync(path.join(data, "coding-agent-streams", `${started.id}.jsonl`)), mode).toBe(mode === "archive");
    }
  });
});
