/**
 * A settled run that a HELD record still names is not history yet (F-N2a,
 * night 2026-10-20/21). Held runs are never trimmed (#839), so with the live
 * list full of them the only finished run left to make room was the very run a
 * queued continuation named: the queue's own insert deleted it, and when its
 * turn came the continuation failed with "There is no coding run with that id
 * to resume." The same hold covers the origin a review pass reports to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let root: string;
let projects: string;
let flag: string;
let restore: () => void;

const CONTINUED = "run-continued1";
const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", session_id: "sess-1" });

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/**
 * The runs file as the night left it: `gaveUp` runs holding a resumable
 * session (never trimmed), oldest last, behind the given newer records.
 */
async function seedRuns(gaveUp: number, newer: Record<string, unknown>[]): Promise<void> {
  const stamp = Date.now() - 10_000_000;
  const held = Array.from({ length: gaveUp }, (_, i) => ({
    id: `run-gaveup${String(i).padStart(4, "0")}`,
    task: `refuter ${i}`,
    directory: path.join(projects, "delta"),
    status: "gave_up",
    startedAt: stamp - i * 1000,
    completedAt: stamp - i * 1000 + 500,
    sessionId: `sess-gaveup-${i}`,
    resumable: true,
  }));
  fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([...newer, ...held]));
  await lib._resetCodingAgentStateForTests();
}

const settledRun = (id: string, folder: string, extra: Record<string, unknown> = {}) => ({
  id,
  task: `the work of ${id}`,
  directory: path.join(projects, folder),
  status: "completed",
  startedAt: Date.now() - 60_000,
  completedAt: Date.now() - 30_000,
  sessionId: `sess-${id}`,
  ...extra,
});

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-trim-held-"));
  const home = path.join(base, "home");
  root = path.join(home, "clawbox");
  const binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  flag = path.join(base, "go");
  fs.mkdirSync(binDir, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  // One slot: the continuation is queued behind the live run, as it was at night.
  writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects, coding_agent_max_parallel_runs: 1 });
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    ["#!/usr/bin/env bash", readFirstTurn(), `while [ ! -f "${flag}" ]; do sleep 0.05; done`, `echo '${result}'`, "exit 0"].join("\n"),
    { mode: 0o755 },
  );
  for (const name of ["alpha", "beta", "gamma", "delta"]) {
    fs.mkdirSync(path.join(projects, name), { recursive: true });
    fs.writeFileSync(path.join(projects, name, "README.md"), `# ${name}\n`);
  }
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  fs.writeFileSync(flag, "go");
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a queued continuation", () => {
  it("keeps the run it continues when its own insert trims the list, and starts into it when its turn comes", async () => {
    // 28 held + X = 29; the live run below makes 30, so nothing is trimmed
    // until the continuation's own insert takes the list to 31 — and X is the
    // only record in it that is neither held nor watched.
    await seedRuns(28, [settledRun(CONTINUED, "alpha")]);
    const live = await lib.startOrQueueRun({ task: "one", directory: "beta", source: "owner" });
    expect(live.queued).toBe(false);
    expect(lib.getRun(CONTINUED)).not.toBeNull();

    const next = await lib.startOrQueueRun({ task: "carry on", resumeRunId: CONTINUED, source: "agent" });
    expect(next.queued).toBe(true);
    expect.soft(lib.getRun(CONTINUED), "the run the queued continuation names was trimmed").not.toBeNull();

    // Its turn: the live run ends, the queue starts the continuation.
    fs.writeFileSync(flag, "go");
    await vi.waitFor(() => { expect(lib.getRun(next.run.id)?.status).not.toBe("queued"); }, { timeout: 15_000 });
    const done = await lib.waitForRun(next.run.id, 20_000);
    expect(done?.error ?? null).toBeNull();
    expect(done?.status).toBe("completed");
  });

  it("keeps the run it continues through the owner's Clear history while it waits", async () => {
    // Clear history shares the trim's hold rule: deleting the run a queued
    // continuation names fails that continuation the same way, hours later.
    await seedRuns(0, [settledRun(CONTINUED, "alpha")]);
    await lib.startOrQueueRun({ task: "one", directory: "beta", source: "owner" });
    const next = await lib.startOrQueueRun({ task: "carry on", resumeRunId: CONTINUED, source: "agent" });
    expect(next.queued).toBe(true);

    expect(lib.clearFinishedRuns()).toBe(0);
    expect(lib.getRun(CONTINUED)).not.toBeNull();
  });
});

describe("a review pass that is still held", () => {
  it("keeps the run it reviews when a new run trims the list", async () => {
    // The pass reads its origin back when it settles (pull request, deliverable,
    // pipeline). An origin with no pull request is not watched, so before this
    // hold the trim took it as soon as the list was full.
    await seedRuns(28, [
      settledRun("run-reviewpass", "gamma", { status: "paused", reviewOf: "run-reviewed1", resumable: true }),
      settledRun("run-reviewed1", "gamma"),
    ]);
    const started = await lib.startOrQueueRun({ task: "something new", directory: "beta", source: "owner" });
    expect(started.queued).toBe(false);
    expect(lib.getRun("run-reviewed1")).not.toBeNull();
  });
});
