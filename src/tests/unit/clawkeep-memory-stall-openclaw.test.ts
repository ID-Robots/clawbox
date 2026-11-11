import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { settledMemoryRun } from "@/tests/helpers/memory-run-state";

/**
 * TASK-2431 on the OpenClaw arm, with real processes: `openclaw memory index`
 * is a stand-in that behaves like the CLI where it matters — counts on a
 * terminal only, a SIGTERM it ends on, the error and the sign-off lines it
 * prints when memory-core's workspace lock is held.
 *
 * The stall window is shortened through CLAWKEEP_MEMORY_INDEX_STALL_MS, the
 * same knob a board check uses, so these run in seconds of real time. The
 * fake-clock half (three hours of progress, thirty minutes of silence) is
 * memory-index-stall.test.ts.
 */

// Starts real processes: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { shard } = vi.hoisted(() => ({ shard: { enabled: true } }));
vi.mock("@/lib/memory-shard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory-shard")>(),
  getMemoryShardEnabled: async () => shard.enabled,
}));
// The OpenClaw arm, whatever edition the machine running the test calls itself.
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openclaw-config")>(),
  openclawIsAbsent: () => false,
}));

const ENV = [
  "CLAWKEEP_DATA_DIR",
  "CLAWKEEP_MEMORY_EMBED_LOCK",
  "CLAWKEEP_MEMORY_OPENCLAW_BIN",
  "CLAWKEEP_MEMORY_AGENT_DB",
  "CLAWKEEP_MEMORY_PTY_HOST",
  "CLAWKEEP_MEMORY_INDEX_STALL_MS",
  "CLAWKEEP_MEMORY_LOCK_RETRY_MS",
] as const;

let tmpDir = "";

beforeEach(async () => {
  shard.enabled = true;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-stall-openclaw-"));
  process.env.CLAWKEEP_DATA_DIR = tmpDir;
  process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
  process.env.CLAWKEEP_MEMORY_AGENT_DB = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Join the status refresh behind a finished pass before its directory goes.
  await (await import("@/lib/clawkeep-memory")).memoryPassSettled();
  for (const name of ENV) delete process.env[name];
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const noTerminal = () => { process.env.CLAWKEEP_MEMORY_PTY_HOST = path.join(tmpDir, "no-such-script"); };

interface FakeIndexer {
  /** Touched when `memory index` starts, once per attempt. */
  started: string;
  /** Holds "TERM" once the indexer was sent SIGTERM. */
  termed: string;
  /** How many times `memory index` ran. */
  attempts: () => Promise<number>;
}

/**
 * A stand-in for the installed `openclaw`.
 *
 * - `memory status` fails at once: the plan runs what was asked, and the
 *   status refresh behind a finished pass touches nothing.
 * - `memory index` prints `steps` counts on a terminal (`--verbose` only, as the
 *   real reporter does), `stepMs` apart, then either finishes or hangs
 *   (`steps: 0` with `hang`) until SIGTERM, which it ends on with 143.
 * - `lockHeldTimes`: its first N attempts fail the way memory-core does when
 *   the workspace lock is held by a dead pass — the error, then the sign-off
 *   lines the CLI prints whatever happened.
 */
async function fakeIndexer(
  { steps = 0, stepMs = 400, hang = false, lockHeldTimes = 0 }:
  { steps?: number; stepMs?: number; hang?: boolean; lockHeldTimes?: number } = {},
): Promise<FakeIndexer> {
  const script = path.join(tmpDir, "fake-openclaw.mjs");
  const started = path.join(tmpDir, "started");
  const termed = path.join(tmpDir, "termed");
  const counter = path.join(tmpDir, "attempts");
  await fs.writeFile(script, [
    `#!${process.execPath}`,
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    "if (process.argv.slice(2, 4).join(' ') !== 'memory index') process.exit(1);",
    `appendFileSync(${JSON.stringify(counter)}, 'x');`,
    `const attempt = readFileSync(${JSON.stringify(counter)}, 'utf8').length;`,
    `writeFileSync(${JSON.stringify(started)}, String(attempt));`,
    `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(termed)}, 'TERM'); process.exit(143); });`,
    `if (attempt <= ${lockHeldTimes}) {`,
    "  process.stderr.write('Memory index failed (main): Timed out waiting for memory workspace lock at plugin-state:memory-core/short-term-locks/c85dd886 (held by 4242:00000000-0000-4000-8000-000000000000)\\n');",
    "  process.stderr.write('[state/agent-db] agent database clean-close receipt: active-leases\\n');",
    "  process.stderr.write('09:49:46 [state/agent-db] agent database clean-close receipt: active-leases\\n');",
    "  process.exit(1);",
    "}",
    "const say = (done) => { if (process.stderr.isTTY && process.argv.includes('--verbose')) process.stderr.write(`\\r\\x1b[2KIndexing memory files\\u2026 ${done}/" + `${Math.max(steps, 1)}` + " \\u00b7 elapsed 0:0${done % 10} 50%`); };",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    `for (let done = 0; done <= ${steps}; done += 1) { say(done); if (done < ${steps}) await sleep(${stepMs}); }`,
    `if (${JSON.stringify(hang)}) { setInterval(() => {}, 1000); } else {`,
    "  process.stderr.write('\\r\\x1b[2KMemory index updated (main): 3 files indexed.\\r\\n');",
    "  process.stderr.write('[state/agent-db] agent database clean-close receipt: active-leases\\r\\n');",
    "}",
    "",
  ].join("\n"), { mode: 0o755 });
  process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
  return {
    started,
    termed,
    attempts: async () => (await fs.readFile(counter, "utf8").catch(() => "")).length,
  };
}

async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 500 && !existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 20));
  expect(existsSync(file), `${path.basename(file)} never appeared`).toBe(true);
}

/** The lock goes just after the settled record is written, not with it. */
async function lockGone(): Promise<boolean> {
  const lock = path.join(tmpDir, "memory-index.lock");
  for (let i = 0; i < 250 && existsSync(lock); i += 1) await new Promise((r) => setTimeout(r, 20));
  return !existsSync(lock);
}

function deviceLog(warn: { mock: { calls: unknown[][] } }): string {
  return warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

describe("an OpenClaw pass that stops moving", () => {
  it("is stopped as `stalled` on a terminal, though `script` answers the SIGTERM with exit 0", async () => {
    process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS = "1500";
    const fake = await fakeIndexer({ steps: 1, hang: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    const run = await settledMemoryRun(tmpDir, { tries: 1_000 });
    expect(run).toMatchObject({ status: "failed", errorCode: "stalled" });
    expect(run.error).toBe("Indexing made no progress for a long time and was stopped. Run it again.");
    expect(await fs.readFile(fake.termed, "utf8")).toBe("TERM");
    expect(await lockGone()).toBe(true);
    expect(deviceLog(warn)).toMatch(/full index run failed \(stalled, [^)]*\): no progress for 1 min/);
  });

  it("is stopped as `stalled` off a terminal, where it has no counts at all", async () => {
    process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS = "1500";
    noTerminal();
    const fake = await fakeIndexer({ hang: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
    await waitFor(fake.started);
    expect(await settledMemoryRun(tmpDir, { tries: 1_000 })).toMatchObject({ status: "failed", errorCode: "stalled" });
    expect(await fs.readFile(fake.termed, "utf8")).toBe("TERM");
  });

  it("is never stopped while its counts keep moving, for longer than the window", async () => {
    process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS = "4000";
    const fake = await fakeIndexer({ steps: 15, stepMs: 400 });
    const { startMemoryIndex, readMemoryRunState } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    // Six seconds of a pass against a four-second window.
    const run = await settledMemoryRun(tmpDir, { tries: 1_500 });
    expect(run).toMatchObject({ status: "succeeded", errorCode: "" });
    expect(existsSync(fake.termed)).toBe(false);
    expect((await readMemoryRunState()).durationMs).toBeGreaterThan(4_000);
  });
});

describe("an OpenClaw pass the owner stops", () => {
  it("is never recorded as succeeded on a terminal, where `script` exits 0 for it", async () => {
    // Before TASK-2431 the run read the pty host's exit 0 as success.
    const fake = await fakeIndexer({ hang: true });
    const { startMemoryIndex, stopMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
    await waitFor(fake.started);
    expect((await stopMemoryIndex()).stopped).toBe(true);
    const run = await settledMemoryRun(tmpDir, { tries: 1_000 });
    expect(run).toMatchObject({ status: "failed", errorCode: "interrupted" });
    expect(run.error).toMatch(/stopped before it finished/);
  });
});

describe("the pass after one that died holding OpenClaw's memory workspace lock", () => {
  it("runs again once the lock can be taken over, and succeeds", async () => {
    process.env.CLAWKEEP_MEMORY_LOCK_RETRY_MS = "200";
    noTerminal();
    const fake = await fakeIndexer({ lockHeldTimes: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
    expect(await settledMemoryRun(tmpDir, { tries: 1_000 })).toMatchObject({ status: "succeeded", errorCode: "" });
    expect(await fake.attempts()).toBe(2);
    expect(deviceLog(warn)).toMatch(/memory workspace lock held .*running it again in 0 s \(1\/2\)/);
  });

  it("gives up after two more tries, and the device log names the lock, not the sign-off receipt", async () => {
    process.env.CLAWKEEP_MEMORY_LOCK_RETRY_MS = "100";
    noTerminal();
    const fake = await fakeIndexer({ lockHeldTimes: 99 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
    expect(await settledMemoryRun(tmpDir, { tries: 1_000 })).toMatchObject({ status: "failed", errorCode: "index_failed" });
    expect(await fake.attempts()).toBe(3);
    const failed = deviceLog(warn).split("\n").find((line) => line.includes("index run failed")) ?? "";
    expect(failed).toMatch(/incremental index run failed \(index_failed, exit 1\): Memory index failed \(main\): Timed out waiting for memory workspace lock/);
    expect(failed).not.toMatch(/clean-close receipt/);
  });

  it("is not taken for stalled while it waits, even with a window shorter than the wait", async () => {
    process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS = "2000";
    process.env.CLAWKEEP_MEMORY_LOCK_RETRY_MS = "4000";
    noTerminal();
    const fake = await fakeIndexer({ lockHeldTimes: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
    expect(await settledMemoryRun(tmpDir, { tries: 1_000 })).toMatchObject({ status: "succeeded", errorCode: "" });
    expect(await fake.attempts()).toBe(2);
  });

  it("is settled, and its lock freed, when the next attempt cannot even be spawned", async () => {
    // `spawn` throws at once for some failures (E2BIG, ENOMEM) instead of
    // emitting "error". Unhandled, the run said "running" until a restart.
    process.env.CLAWKEEP_MEMORY_LOCK_RETRY_MS = "100";
    noTerminal();
    const fake = await fakeIndexer({ lockHeldTimes: 99 });
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let indexSpawns = 0;
    vi.doMock("node:child_process", () => ({
      ...actual,
      spawn: (cmd: string, args: readonly string[], opts: object) => {
        if (args.includes("index") && ++indexSpawns === 2) {
          throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
        }
        return actual.spawn(cmd, args, opts);
      },
    }));
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { startMemoryIndex, readMemoryRunState } = await import("@/lib/clawkeep-memory");
      expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
      expect(await settledMemoryRun(tmpDir, { tries: 1_000 })).toMatchObject({ status: "failed", errorCode: "index_failed" });
      expect(indexSpawns).toBe(2);
      expect(await fake.attempts()).toBe(1);
      expect(await lockGone()).toBe(true);
      expect((await readMemoryRunState()).status).toBe("failed");
    } finally {
      vi.doUnmock("node:child_process");
    }
  });

  it("is stopped at once while it waits to try again, and does not try again", async () => {
    process.env.CLAWKEEP_MEMORY_LOCK_RETRY_MS = "60000";
    noTerminal();
    const fake = await fakeIndexer({ lockHeldTimes: 99 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMemoryIndex, stopMemoryIndex, readMemoryRunState } = await import("@/lib/clawkeep-memory");
    const startedAt = Date.now();
    expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
    await waitFor(fake.started);
    // The first attempt has failed and the pass is waiting out the lock.
    for (let i = 0; i < 250; i += 1) {
      if (vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("memory workspace lock held"))) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await readMemoryRunState()).status).toBe("running");
    expect((await stopMemoryIndex()).stopped).toBe(true);
    expect(await settledMemoryRun(tmpDir, { tries: 1_000 })).toMatchObject({ status: "failed", errorCode: "interrupted" });
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(await fake.attempts()).toBe(1);
  });
});
