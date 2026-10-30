/**
 * A run is ANNOUNCED the moment its request arrives (src/lib/coding-start-phase.ts):
 * listed in the runs list's `starting` before the start's first await, walked
 * through its steps — the checks, its own copy of the project, the launch —
 * and handed over to its record, which carries the id the card already
 * showed. A start the box refuses stays listed with the reason; a queued one
 * keeps the id too. The owner's report this answers: minutes after asking for
 * a run, nothing on screen said one had begun.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";
import { listCodingStarts, resetCodingStartsForTests } from "@/lib/coding-run-starts";
import type { CodingStartView } from "@/lib/coding-start-phase";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));

// What the list said while the start stood at each step: read from inside the
// two steps it names — its own copy of the project, and the launch (the HEAD
// it records is read there, just before the record is written).
const seen = vi.hoisted(() => ({ worktree: [] as unknown[], launching: [] as unknown[] }));
vi.mock("@/lib/coding-run-worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-run-worktree")>()),
  addRunWorktree: vi.fn(async () => {
    const { listCodingStarts: list } = await import("@/lib/coding-run-starts");
    seen.worktree.push(list());
    return { ok: false as const, reason: "no_repository" as const, detail: "Not a git repository yet." };
  }),
}));
vi.mock("@/lib/coding-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-git")>()),
  headCommitShort: vi.fn(async () => {
    const { listCodingStarts: list } = await import("@/lib/coding-run-starts");
    seen.launching.push(list());
    return null;
  }),
}));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projects: string;
let flag: string;
let restore: () => void;

const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-1" });

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/** Every run waits for the flag file, so a run started is genuinely live until the test lets it go. */
function installWrapper(): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    ["#!/usr/bin/env bash", readFirstTurn(), `while [ ! -f "${flag}" ]; do sleep 0.05; done`, `echo '${result("done")}'`, "exit 0"].join("\n"),
    { mode: 0o755 },
  );
}

function folder(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

const one = (list: unknown, id: string) => (list as CodingStartView[]).find((s) => s.id === id);

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-announce-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  flag = path.join(base, "go");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects, coding_agent_max_parallel_runs: 1 });
  installWrapper();
  for (const name of ["alpha", "beta"]) folder(name);
  seen.worktree.length = 0;
  seen.launching.length = 0;
  resetCodingStartsForTests();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  fs.writeFileSync(flag, "go");
  await lib._resetCodingAgentStateForTests();
  resetCodingStartsForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a run's start", () => {
  it("is listed at once under the id its record takes, walks its steps, and hands over to the record", async () => {
    const asked = Date.now();
    const pending = lib.startOrQueueRun({ runId: "run-abc12345", task: "Build an invoice reader", directory: "alpha", source: "agent" });
    // Before a single await of the start has run: listed, at its first step.
    expect(one(listCodingStarts(), "run-abc12345")).toMatchObject({
      kind: "run",
      task: "Build an invoice reader",
      directory: "alpha",
      source: "agent",
      step: "checking",
      error: null,
      failedAt: null,
    });
    expect(one(listCodingStarts(), "run-abc12345")?.requestedAt).toBeGreaterThanOrEqual(asked);

    const { run, queued } = await pending;
    expect(queued).toBe(false);
    // The record carries the announced id, so the card's id never changes.
    expect(run.id).toBe("run-abc12345");
    expect(run.status).toBe("running");
    // It stood at each step while that step ran.
    expect(one(seen.worktree[0], "run-abc12345")?.step).toBe("worktree");
    expect(one(seen.launching[0], "run-abc12345")?.step).toBe("launching");
    // The record is the list's from here.
    expect(one(listCodingStarts(), "run-abc12345")).toBeUndefined();
  });

  it("takes a fresh id when none was named, and never an id a record already has", async () => {
    const first = await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    expect(first.run.id).toMatch(/^run-[0-9a-z]{8}$/);
    fs.writeFileSync(flag, "go");
    await lib.waitForRun(first.run.id, 20_000);
    const second = await lib.startOrQueueRun({ runId: first.run.id, task: "two", directory: "beta", source: "owner" });
    expect(second.run.id).not.toBe(first.run.id);
  });

  it("stays listed with the reason when the box refuses it", async () => {
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: false, coding_agent_default_directory: projects });
    await expect(lib.startOrQueueRun({ runId: "run-refused1", task: "Add a toggle", directory: "alpha", source: "agent" })).rejects.toMatchObject({ kind: "disabled" });
    const refused = one(listCodingStarts(), "run-refused1");
    expect(refused?.error).toMatch(/switched off/);
    expect(refused?.failedAt).toEqual(expect.any(Number));
    expect(lib.getRun("run-refused1")).toBeNull();
  });

  it("keeps the announced id when it is queued behind a run at work", async () => {
    const a = await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    expect(a.queued).toBe(false);
    const b = await lib.startOrQueueRun({ runId: "run-queued42", task: "two", directory: "beta", source: "agent" });
    expect(b.queued).toBe(true);
    expect(b.run.id).toBe("run-queued42");
    expect(b.run.status).toBe("queued");
    expect(one(listCodingStarts(), "run-queued42")).toBeUndefined();
  });
});
