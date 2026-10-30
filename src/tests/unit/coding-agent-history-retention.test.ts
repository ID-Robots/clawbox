/**
 * The owner's run-history setting through the runs store itself (TASK-1178):
 * what happens to the run that leaves the newest thirty in each of the two
 * modes, what standard does to runs "keep everything" kept, the disk guard,
 * the owner's Clear, the setting's own door, the one-time rewrite of a
 * retired mode (SCA2 C1), and Claude Code's transcript period.
 *
 * Runs are SEEDED into the runs file and the trim is driven by drafting a run
 * (createDraftRun → insertRun), which spawns nothing: the thirty-first record
 * is what matters here, not a harness. One test starts a real (fake) harness,
 * for the settle's part — the stream log goes in every mode.
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
    // Nothing new on the flash: no older runs, and the transcript is Claude
    // Code's to expire, as it always was.
    expect(fs.existsSync(path.join(data, "coding-agent-history"))).toBe(false);
    expect(fs.existsSync(path.join(data, "coding-agent-archive"))).toBe(false);
    expect(fs.existsSync(transcriptOf(29))).toBe(true);
    expect(statfs).not.toHaveBeenCalled();
    expect(lib.getRun(ids[29])).toBeNull();
    expect((await lib.getCodingAgentStatus()).historyRetention).toBe("standard");
  });

  it("trims a gave-up run whose folder is gone, and keeps one whose folder is there", async () => {
    // Clear already made this exception; the trim did not, and 22 of the 40
    // gave_up records on the owner's box named folders that no longer existed —
    // nothing could resume them, and the runs file never trimmed.
    const records = [];
    for (let n = 0; n <= 29; n += 1) {
      records.push(runRecord(n, n >= 28 ? { status: "gave_up", directory: n === 29 ? path.join(data, "gone") : project } : {}));
    }
    fs.writeFileSync(runsFile(), JSON.stringify(records));
    const made = await draft();
    const list = onDisk();
    expect(list).toHaveLength(30);
    expect(list[0].id).toBe(made.id);
    expect(list.map((r) => r.id)).not.toContain(idOf(29));
    expect(list.map((r) => r.id)).toContain(idOf(28));
    expect(fs.existsSync(evidenceOf(idOf(29)))).toBe(false);
    expect(fs.existsSync(evidenceOf(idOf(28)))).toBe(true);
    // Compact: the file is rewritten every few seconds while a run streams.
    expect(fs.readFileSync(runsFile(), "utf-8")).not.toContain("\n");
  });

  it("never drops a held run, in any mode", async () => {
    for (const mode of ["standard", "everything"]) {
      writeConfig({ coding_agent_history_retention: mode });
      const ids = seedLive(0, 29, { status: "paused" });
      await lib._resetCodingAgentStateForTests();
      await draft();
      expect(onDisk()).toHaveLength(31);
      expect(fs.existsSync(evidenceOf(ids[29]))).toBe(true);
      expect(fs.existsSync(olderFile(ids[29]))).toBe(false);
    }
  });
});

describe("keep everything", () => {
  it("keeps the run leaving the live thirty as an older run, evidence and inputs in place", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
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

  it("never deletes a run", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    seedLive(0, 29);
    seedOlder(30, 200);
    await draft();
    expect(history.olderRunIndex()).toHaveLength(172);
    expect(fs.existsSync(evidenceOf(idOf(200)))).toBe(true);
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

describe("a retired mode (SCA2 C1)", () => {
  const config = () => JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf-8"));

  it("reads extended and archive as everything, and rewrites the setting once, the retired N with it", async () => {
    for (const retired of ["extended", "archive"]) {
      writeConfig({ coding_agent_history_retention: retired, coding_agent_history_limit: 300 });
      await lib._resetCodingAgentStateForTests();
      expect((await lib.getHistoryPolicy()).mode, retired).toBe("everything");
      expect(config(), retired).toEqual({ coding_agent_history_retention: "everything" });
      // And behaves as everything: the leaving run is kept, not deleted.
      const ids = seedLive(0, 29);
      await draft();
      expect(fs.existsSync(olderFile(ids[29])), retired).toBe(true);
    }
  });

  it("reads a value it does not know as standard, and clears it", async () => {
    writeConfig({ coding_agent_history_retention: "forever" });
    expect((await lib.getHistoryPolicy()).mode).toBe("standard");
    expect(config()).toEqual({});
    // Nothing to rewrite for a current value, or an absent one.
    writeConfig({ coding_agent_history_retention: "everything", other: 1 });
    expect((await lib.getHistoryPolicy()).mode).toBe("everything");
    expect(config()).toEqual({ coding_agent_history_retention: "everything", other: 1 });
  });

  it("the status reads a retired mode the same way", async () => {
    writeConfig({ coding_agent_history_retention: "archive" });
    const status = await lib.getCodingAgentStatus();
    expect(status.historyRetention).toBe("everything");
    expect((status as unknown as Record<string, unknown>).historyLimit).toBeUndefined();
  });
});

describe("leaving a mode that kept more", () => {
  it("standard deletes the older runs at the next run — not when the setting is saved", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    seedLive(0, 29);
    const older = seedOlder(30, 39);
    await lib.setHistoryRetention("standard");
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

  it("deletes the leaving run as standard would, instead of keeping it", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    const ids = seedLive(0, 29);
    const spy = lowDisk();
    await draft();
    spy.mockRestore();
    expect(fs.existsSync(olderFile(ids[29]))).toBe(false);
    expect(fs.existsSync(evidenceOf(ids[29]))).toBe(false);
  });

  it("stops the history growing without purging what is already kept", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    seedLive(0, 29);
    const older = seedOlder(30, 34);
    lowDisk();
    await draft();
    // Older runs already kept are not deleted while the disk is low: purging
    // them is not what the guard is for.
    expect(history.olderRunIndex().map((e) => e.id)).toEqual(older);
    expect((await lib.runHistorySummary()).disk.low).toBe(true);
  });
});

describe("the owner's Clear", () => {
  it("shows what it freed at once, not after the usage cache expires", async () => {
    seedLive(0, 2);
    const before = await lib.runHistorySummary();
    expect(before.usage!.evidence).toBeGreaterThan(0);
    expect(lib.clearFinishedRuns()).toBe(3);
    const after = await lib.runHistorySummary();
    expect(after.usage!.evidence).toBe(0);
    expect(after.counts.live).toBe(0);
  });

  it("deletes the finished runs, older runs included, and keeps what is held", async () => {
    writeConfig({ coding_agent_history_retention: "everything" });
    const live = seedLive(0, 3);
    const records = onDisk();
    records[0].status = "paused";
    fs.writeFileSync(runsFile(), JSON.stringify(records));
    const older = seedOlder(4, 5);
    expect(lib.clearFinishedRuns()).toBe(5);
    expect(onDisk().map((r) => r.id)).toEqual([live[0]]);
    expect(history.olderRunIndex()).toEqual([]);
    for (const id of [...live.slice(1), ...older]) expect(fs.existsSync(evidenceOf(id))).toBe(false);
    expect(fs.existsSync(evidenceOf(live[0]))).toBe(true);
  });
});

describe("the setting's door", () => {
  const ds = () => path.join(home, ".claude-ds", "settings.json");
  const own = () => path.join(home, ".claude", "settings.json");
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));

  it("refuses what the box does not offer — the retired modes included — before saving anything", async () => {
    for (const bad of ["forever", "extended", "archive", 3, undefined]) {
      await expect(lib.setHistoryRetention(bad)).rejects.toThrow(/one of: standard, everything/);
    }
    expect(JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf-8"))).toEqual({});
  });

  it("tells Claude Code to keep transcripts under keep everything, and hands the period back after", async () => {
    fs.mkdirSync(path.dirname(ds()), { recursive: true });
    fs.writeFileSync(ds(), JSON.stringify({ model: "deepseek-v4-flash" }));
    const change = await lib.setHistoryRetention("everything");
    expect(change.policy.mode).toBe("everything");
    expect(change.transcripts.map((t) => t.state)).toEqual(["kept", "kept"]);
    expect(readJson(ds())).toEqual({ model: "deepseek-v4-flash", cleanupPeriodDays: 36_500 });
    expect(readJson(own())).toEqual({ cleanupPeriodDays: 36_500 });
    const status = await lib.getCodingAgentStatus();
    expect(status).toMatchObject({ historyRetention: "everything", historyLiveKept: 30 });
    // The extended N went with its mode (SCA2 C1), its choices before it (SCA C3).
    expect((status as { historyLimit?: unknown }).historyLimit).toBeUndefined();
    expect((status as { historyLimits?: unknown }).historyLimits).toBeUndefined();

    const back = await lib.setHistoryRetention("standard");
    expect(back.policy).toEqual({ mode: "standard" });
    expect(readJson(ds())).toEqual({ model: "deepseek-v4-flash" });
    expect(readJson(own())).toEqual({});
  });

  it("start over puts the setting back and hands Claude Code its period back", async () => {
    await lib.setHistoryRetention("everything");
    await lib.resetCodingAgentSetup();
    expect((await lib.getHistoryPolicy()).mode).toBe("standard");
    expect(readJson(ds())).toEqual({});
  });
});

describe("the settle", () => {
  function readyDevice(): void {
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const init = '{"type":"system","subtype":"init","session_id":"sess-live","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
    const result = '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"done","session_id":"sess-live"}';
    fs.writeFileSync(path.join(bin, "claude-ds"), ["#!/usr/bin/env bash", readFirstTurn(), `echo '${init}'`, `echo '${result}'`, "exit 0"].join("\n"), { mode: 0o755 });
  }

  it("removes a settled run's stream log in every mode — the archive that kept it is gone", async () => {
    for (const mode of ["everything", "standard"]) {
      readyDevice();
      writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, coding_agent_history_retention: mode });
      const started = await lib.startRun({ task: `settle under ${mode}`, projectId: "site", source: "agent" });
      const done = await lib.waitForRun(started.id, 15_000);
      expect(done?.status, mode).toBe("completed");
      await lib._resetCodingAgentStateForTests();
      expect(fs.existsSync(path.join(data, "coding-agent-streams", `${started.id}.jsonl`)), mode).toBe(false);
    }
  });
});
