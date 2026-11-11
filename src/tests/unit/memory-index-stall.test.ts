import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MEMORY_INDEX_STALL_MS,
  memoryIndexStallMs,
  progressMark,
  staleRunVerdict,
  startStallWatchdog,
} from "@/lib/memory-index-stall";
import type { LocalIndexPassOptions, LocalIndexPassResult, LocalIndexProgressReporter } from "@/lib/memory-index-local";

/**
 * TASK-2431: no cap on how long a Memory Shard pass runs, and a stall
 * watchdog instead.
 *
 * A pass used to be abandoned two hours after it started, whatever it was
 * doing, and a full pass with the on-box embedder takes 2.5 to 9 hours. So the
 * things pinned here are, in this order: a pass that keeps moving is never
 * stopped, however long it runs; a pass that stops moving is stopped, with
 * `stalled`; a record nobody here supervises is judged by liveness and the
 * same rule, never by its age; and the next pass after one that was stopped
 * starts cleanly.
 *
 * The pass itself is ClawBox's own (the arm with no OpenClaw), replaced by a
 * stand-in the test drives, under fake timers: hours of a pass in milliseconds
 * of test. The OpenClaw arm, with real processes, is
 * clawkeep-memory-stall-openclaw.test.ts.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MIN = 60_000;
const HOUR = 60 * MIN;

type PassImpl = (
  mode: "incremental" | "full",
  signal: AbortSignal,
  onProgress: LocalIndexProgressReporter,
  options: LocalIndexPassOptions,
) => Promise<LocalIndexPassResult>;

const { dataDir, pass, shard } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "memory-stall-data-")),
    /** What the stand-in pass does; each test says. */
    pass: { impl: null as PassImpl | null, calls: 0 },
    shard: { enabled: true },
  };
});

vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  const store = new Map<string, unknown>();
  return {
    ...actual,
    DATA_DIR: dataDir,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  };
});
// ClawBox's own arm: no OpenClaw on the box.
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openclaw-config")>(),
  openclawIsAbsent: () => true,
}));
vi.mock("@/lib/embed-server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/embed-server")>(),
  getEmbedProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/embed/v1",
  getEmbedProvisioningStatus: async () => ({
    installed: true, binaryAvailable: true, modelAvailable: true, modelBytes: 1, binPath: "", modelPath: "",
  }),
}));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "t".repeat(64) }));
vi.mock("@/lib/memory-shard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory-shard")>(),
  getMemoryShardEnabled: async () => shard.enabled,
}));
vi.mock("@/lib/memory-index-local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory-index-local")>();
  return {
    ...actual,
    runLocalIndexPass: vi.fn((mode: "incremental" | "full", signal: AbortSignal, onProgress: LocalIndexProgressReporter, options: LocalIndexPassOptions) => {
      pass.calls += 1;
      if (!pass.impl) throw new Error("the test did not say what the pass does");
      return pass.impl(mode, signal, onProgress, options);
    }),
  };
});

let clawkeepDir = "";
const statePath = () => path.join(clawkeepDir, "memory-index-state.json");
const lockPath = () => path.join(clawkeepDir, "memory-index.lock");

beforeEach(async () => {
  shard.enabled = true;
  pass.impl = null;
  pass.calls = 0;
  clawkeepDir = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-stall-clawkeep-"));
  process.env.CLAWKEEP_DATA_DIR = clawkeepDir;
  delete process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS;
  // CLAWKEEP_DATA_DIR is read once at module load.
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  // Join the status refresh a finished pass starts, before its directory goes.
  await (await lib()).memoryPassSettled();
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS;
  await fsp.rm(clawkeepDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function lib() {
  return await import("@/lib/clawkeep-memory");
}

async function readState(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(statePath(), "utf8").catch(() => "{}")) as Record<string, unknown>;
}

/**
 * Lets real I/O land — the run record is a real file — without moving the
 * fake clock: `setImmediate` is not faked, and yields to the threadpool.
 */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  // Real time, which the fake clock does not move: `performance` is not faked.
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never happened: ${what}`);
}

const settled = () => until(readState, (s) => s.status !== undefined && s.status !== "running", "the run settled");

/** A few milliseconds of REAL time, for the run record's writes to land. */
async function letIoLand(ms = 5): Promise<void> {
  const until = performance.now() + ms;
  while (performance.now() < until) await new Promise((resolve) => setImmediate(resolve));
}

/** Hours of fake clock, a minute at a time, with real I/O let through between. */
async function advance(ms: number, stepMs = MIN): Promise<void> {
  for (let left = ms; left > 0; left -= stepMs) {
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, left));
    await letIoLand();
  }
}

const lockGone = () => until(async () => fs.existsSync(lockPath()), (present) => !present, "the lock was freed");

function useFakeClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    now: new Date("2026-11-11T01:00:00Z"),
  });
}

/** A pass that ends when it is told to — the way the real one honours its signal. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = async () => {
      const { IndexPassAbortedError } = await import("@/lib/memory-index-local");
      reject(new IndexPassAbortedError());
    };
    if (signal.aborted) void abort();
    else signal.addEventListener("abort", () => { void abort(); }, { once: true });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RESULT: LocalIndexPassResult = { mode: "full", files: 36, chunks: 360, failures: 0, capped: false };

describe("the stall window", () => {
  it("is thirty minutes unless CLAWKEEP_MEMORY_INDEX_STALL_MS says otherwise", () => {
    expect(DEFAULT_MEMORY_INDEX_STALL_MS).toBe(30 * MIN);
    expect(memoryIndexStallMs(undefined)).toBe(30 * MIN);
    expect(memoryIndexStallMs("")).toBe(30 * MIN);
    expect(memoryIndexStallMs(" 120000 ")).toBe(2 * MIN);
    expect(memoryIndexStallMs("1000")).toBe(1_000);
  });

  it("never lets a typo switch the watchdog off or make it fire at once", () => {
    for (const bad of ["0", "-5", "999", "1.5e3x", "abc", "1800000.5", String(25 * HOUR)]) {
      expect(memoryIndexStallMs(bad)).toBe(30 * MIN);
    }
  });
});

describe("what counts as progress", () => {
  it("is any of the counts a pass reports moving, the bar's fraction or not", () => {
    const base = { filesDone: 3, filesTotal: 10, chunks: 40 };
    expect(progressMark(base)).toBe(progressMark({ ...base }));
    expect(progressMark({ ...base, filesDone: 4 })).not.toBe(progressMark(base));
    expect(progressMark({ ...base, filesTotal: 11 })).not.toBe(progressMark(base));
    // A large file on the OpenClaw arm: the same file count, chunks climbing.
    expect(progressMark({ ...base, chunks: 41 })).not.toBe(progressMark(base));
  });
});

describe("the watchdog", () => {
  beforeEach(() => useFakeClock());

  it("never fires while the pass keeps moving, however long it runs", async () => {
    const onStall = vi.fn();
    const dog = startStallWatchdog(30 * MIN, onStall);
    for (let elapsed = 0; elapsed < 9 * HOUR; elapsed += 10 * MIN) {
      dog.touch();
      await vi.advanceTimersByTimeAsync(10 * MIN);
    }
    expect(onStall).not.toHaveBeenCalled();
    dog.stop();
  });

  it("fires once the pass has not moved for the window — never before it", async () => {
    const onStall = vi.fn();
    const dog = startStallWatchdog(30 * MIN, onStall);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    dog.touch();
    // Twenty-nine minutes after the last progress: still going.
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(onStall).not.toHaveBeenCalled();
    // At most one tick (a minute, for a 30-minute window) past the window.
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toBeGreaterThanOrEqual(30 * MIN);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(onStall).toHaveBeenCalledTimes(1);
    dog.stop();
  });

  it("is not fooled by the wall clock jumping, which a box with no clock battery does at boot", async () => {
    const onStall = vi.fn();
    const dog = startStallWatchdog(30 * MIN, onStall);
    // NTP moves the date by days; the timers it counts do not move at all.
    vi.setSystemTime(new Date("2026-11-14T01:00:00Z"));
    await vi.advanceTimersByTimeAsync(MIN);
    expect(onStall).not.toHaveBeenCalled();
    dog.stop();
  });

  it("does nothing once stopped", async () => {
    const onStall = vi.fn();
    const dog = startStallWatchdog(30 * MIN, onStall);
    dog.stop();
    dog.stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe("a record nobody here is supervising", () => {
  const now = Date.UTC(2026, 10, 11, 9, 0);

  it("is lost when its process is gone, whatever its age or progress", () => {
    expect(staleRunVerdict({ startedAtMs: now - MIN, progressAtMs: now, alive: false }, now, 30 * MIN)).toBe("lost");
  });

  it("is going at hour nine as at minute one, as long as it moved inside the window", () => {
    expect(staleRunVerdict({ startedAtMs: now - 9 * HOUR, progressAtMs: now - 29 * MIN, alive: true }, now, 30 * MIN)).toBe("going");
  });

  it("is stalled when it has not moved for the window, and judged from its start when it never reported", () => {
    expect(staleRunVerdict({ startedAtMs: now - 3 * HOUR, progressAtMs: now - 31 * MIN, alive: true }, now, 30 * MIN)).toBe("stalled");
    expect(staleRunVerdict({ startedAtMs: now - 31 * MIN, progressAtMs: 0, alive: true }, now, 30 * MIN)).toBe("stalled");
    expect(staleRunVerdict({ startedAtMs: now - 29 * MIN, progressAtMs: 0, alive: true }, now, 30 * MIN)).toBe("going");
  });
});

describe("a pass that keeps moving", () => {
  beforeEach(() => useFakeClock());

  it("is never abandoned at two hours: three hours of progress every five minutes end succeeded", async () => {
    let aborted = false;
    pass.impl = async (_mode, signal, onProgress) => {
      signal.addEventListener("abort", () => { aborted = true; });
      for (let done = 0; done < 36; done += 1) {
        onProgress({ filesDone: done, filesTotal: 36, chunks: done * 10 });
        await sleep(5 * MIN);
      }
      onProgress({ filesDone: 36, filesTotal: 36, chunks: 360 });
      return RESULT;
    };
    const { startMemoryIndex, readMemoryRunState } = await lib();
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);

    await advance(2 * HOUR + 10 * MIN);
    // Past the old two-hour budget, still going, the bar still moving.
    expect((await readMemoryRunState()).status).toBe("running");
    await until(readState, (s) => Number((s.progress as { filesDone?: number } | null)?.filesDone) > 20, "the bar past file 20");
    expect(aborted).toBe(false);

    await advance(HOUR);
    const run = await settled();
    expect(run).toMatchObject({ status: "succeeded", error: "", errorCode: "", progress: null });
    expect(Number(run.durationMs)).toBeGreaterThanOrEqual(3 * HOUR);
    expect(aborted).toBe(false);
  });

  it("is not stalled while it embeds one large document: heartbeats are progress though no count moves", async () => {
    // The local arm reports files once each, so a single document of many
    // thousands of passages holds `filesDone` still for as long as it embeds;
    // it says so with a heartbeat per batch.
    pass.impl = async (_mode, signal, onProgress, options) => {
      onProgress({ filesDone: 0, filesTotal: 1, chunks: 0 });
      for (let batch = 0; batch < 24; batch += 1) {
        await sleep(5 * MIN);
        if (signal.aborted) return untilAborted(signal);
        options.onHeartbeat?.();
      }
      onProgress({ filesDone: 1, filesTotal: 1, chunks: 4_800 });
      return { ...RESULT, files: 1, chunks: 4_800 };
    };
    const { startMemoryIndex } = await lib();
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    await advance(2 * HOUR + 5 * MIN);
    expect(await settled()).toMatchObject({ status: "succeeded", errorCode: "" });
  });

  it("writes when it last moved on the running record, and only there", async () => {
    pass.impl = async (_mode, signal, onProgress) => {
      onProgress({ filesDone: 0, filesTotal: 2, chunks: 0 });
      await sleep(10 * MIN);
      // Moved once, then the same reading again every 30 s, the way the
      // OpenClaw arm's poll repeats itself: a repeat is not progress, but it
      // is what carries a write the throttle held back.
      while (!signal.aborted) {
        onProgress({ filesDone: 1, filesTotal: 2, chunks: 5 });
        await Promise.race([sleep(30_000), new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))]);
      }
      return untilAborted(signal);
    };
    const { startMemoryIndex, readMemoryRunState, stopMemoryIndex } = await lib();
    const startedAtMs = Date.now();
    await startMemoryIndex("full", "manual");
    await advance(11 * MIN);
    const onDisk = await until(readState, (s) => Number(s.progressAtMs) >= startedAtMs + 10 * MIN, "progressAtMs written");
    expect(onDisk.progress).toEqual({ filesDone: 1, filesTotal: 2, chunks: 5 });
    // Internal, like the pid: never handed to a screen.
    const run = await readMemoryRunState();
    expect("progressAtMs" in run).toBe(false);
    expect("childPid" in run).toBe(false);
    expect((await stopMemoryIndex()).stopped).toBe(true);
    const final = await settled();
    expect(final.progressAtMs).toBe(0);
  });
});

describe("a pass that stops moving", () => {
  beforeEach(() => useFakeClock());

  it("is stopped as `stalled` once it has not moved for thirty minutes, and says so in plain words", async () => {
    let abortedAtMs = 0;
    pass.impl = async (_mode, signal, onProgress) => {
      signal.addEventListener("abort", () => { abortedAtMs = Date.now(); });
      onProgress({ filesDone: 4, filesTotal: 50, chunks: 31 });
      // Hung: an embedder that stopped answering, a conversion that never returns.
      return untilAborted(signal);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { startMemoryIndex, readMemoryRunState } = await lib();
      const startedAtMs = Date.now();
      expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);

      await advance(29 * MIN);
      expect((await readMemoryRunState()).status).toBe("running");
      expect(abortedAtMs).toBe(0);

      await advance(2 * MIN);
      const run = await settled();
      expect(run).toMatchObject({
        status: "failed",
        errorCode: "stalled",
        error: "Indexing made no progress for a long time and was stopped. Run it again.",
        progress: null,
      });
      expect(abortedAtMs - startedAtMs).toBeGreaterThanOrEqual(30 * MIN);
      expect(abortedAtMs - startedAtMs).toBeLessThanOrEqual(31 * MIN + 1_000);
      // The lock went with it (just after the record): the next pass is not refused.
      await lockGone();
      // The device log says why, with the window.
      const said = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(said).toMatch(/full index run failed \(stalled, threw\): no progress for 30 min/);
    } finally {
      warn.mockRestore();
    }
  });

  it("is stopped after the window CLAWKEEP_MEMORY_INDEX_STALL_MS sets", async () => {
    process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS = String(2 * MIN);
    pass.impl = async (_mode, signal, onProgress) => {
      onProgress({ filesDone: 0, filesTotal: 9, chunks: 0 });
      return untilAborted(signal);
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMemoryIndex } = await lib();
    await startMemoryIndex("full", "manual");
    await advance(3 * MIN, 10_000);
    expect(await settled()).toMatchObject({ status: "failed", errorCode: "stalled" });
    vi.mocked(console.warn).mockRestore();
  });

  it("is settled even when it never ends, so a hung pass cannot hold the lock for ever", async () => {
    // A pass that does not honour its signal at all: the watchdog gives up on
    // it, and two minutes later the run is settled without it.
    pass.impl = async (_mode, _signal, onProgress) => {
      onProgress({ filesDone: 1, filesTotal: 9, chunks: 3 });
      return new Promise<never>(() => {});
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { startMemoryIndex, readMemoryRunState } = await lib();
      await startMemoryIndex("full", "manual");
      // The watchdog gives up between 30 and 31 min; the grace runs 2 min more.
      await advance(31 * MIN + 30_000, 30_000);
      // Given up on, not yet settled: still the pass's record.
      expect((await readMemoryRunState()).status).toBe("running");
      await advance(2 * MIN, 30_000);
      expect(await settled()).toMatchObject({ status: "failed", errorCode: "stalled" });
      await lockGone();
      expect(warn.mock.calls.flat().map(String).join("\n")).toMatch(/had not ended 120 s after it was given up on/);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves the next pass to start cleanly and finish", async () => {
    pass.impl = async (_mode, signal, onProgress) => {
      onProgress({ filesDone: 0, filesTotal: 3, chunks: 0 });
      return untilAborted(signal);
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMemoryIndex } = await lib();
    await startMemoryIndex("full", "manual");
    await advance(31 * MIN);
    expect(await settled()).toMatchObject({ status: "failed", errorCode: "stalled" });

    pass.impl = async (_mode, _signal, onProgress) => {
      onProgress({ filesDone: 3, filesTotal: 3, chunks: 12 });
      return { ...RESULT, files: 3, chunks: 12 };
    };
    const next = await startMemoryIndex("full", "manual");
    expect(next.accepted).toBe(true);
    await advance(MIN);
    expect(await until(readState, (s) => s.status === "succeeded", "the next pass succeeded")).toMatchObject({ errorCode: "" });
    expect(pass.calls).toBe(2);
    vi.mocked(console.warn).mockRestore();
  });
});

describe("a running record this process is not supervising", () => {
  /** A pid that is certainly gone: a process that has already exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    return Number(child.stdout);
  }

  async function writeRunning(fields: Record<string, unknown>): Promise<void> {
    await fsp.writeFile(statePath(), JSON.stringify({
      status: "running", mode: "full", trigger: "manual",
      finishedAtMs: 0, durationMs: 0, error: "", errorCode: "", progress: null,
      ...fields,
    }));
    await fsp.mkdir(lockPath(), { recursive: true });
  }

  it("keeps a live one that moved recently, however long ago it started — no age rule", async () => {
    // Five hours in, last moved a minute ago: the two-hour rule called this
    // interrupted and freed the lock under a working pass.
    await writeRunning({ startedAtMs: Date.now() - 5 * HOUR, progressAtMs: Date.now() - MIN, childPid: process.pid });
    const { readMemoryRunState, startMemoryIndex } = await lib();
    expect((await readMemoryRunState()).status).toBe("running");
    expect((await startMemoryIndex("full", "manual")).declined).toBe("running");
    expect(pass.calls).toBe(0);
  });

  it("calls a live one that has not moved for the window stalled, and frees the lock for the next pass", async () => {
    await writeRunning({ startedAtMs: Date.now() - 3 * HOUR, progressAtMs: Date.now() - 31 * MIN, childPid: process.pid });
    const { readMemoryRunState } = await lib();
    const run = await readMemoryRunState();
    expect(run).toMatchObject({ status: "failed", errorCode: "stalled" });
    expect(run.error).toMatch(/no progress for a long time/);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("judges one an older build wrote — no progress on record — from its start", async () => {
    await writeRunning({ startedAtMs: Date.now() - 31 * MIN, childPid: process.pid });
    const { readMemoryRunState } = await lib();
    expect(await readMemoryRunState()).toMatchObject({ status: "failed", errorCode: "stalled" });
  });

  it("uses the configured window", async () => {
    process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS = String(10 * MIN);
    await writeRunning({ startedAtMs: Date.now() - HOUR, progressAtMs: Date.now() - 11 * MIN, childPid: process.pid });
    const { readMemoryRunState } = await lib();
    expect((await readMemoryRunState()).errorCode).toBe("stalled");
  });

  it("calls one whose process is gone interrupted, however recently it moved", async () => {
    await writeRunning({ startedAtMs: Date.now() - MIN, progressAtMs: Date.now(), childPid: deadPid() });
    const { readMemoryRunState } = await lib();
    expect(await readMemoryRunState()).toMatchObject({ status: "failed", errorCode: "interrupted" });
  });

  it("lets a new pass take over from a stalled record at once", async () => {
    await writeRunning({ startedAtMs: Date.now() - HOUR, progressAtMs: Date.now() - 40 * MIN, childPid: process.pid });
    pass.impl = async () => RESULT;
    const { startMemoryIndex } = await lib();
    // The pre-lock read reconciles it; the lock is then free to take.
    const started = await startMemoryIndex("full", "manual");
    expect(started.accepted).toBe(true);
    expect((await settled()).status).toBe("succeeded");
  });

  it("still reads a `timed_out` record an older build wrote", async () => {
    await fsp.writeFile(statePath(), JSON.stringify({
      status: "failed", mode: "full", trigger: "manual", startedAtMs: 1, finishedAtMs: 2 * HOUR, durationMs: 2 * HOUR,
      error: "Indexing timed out. Try again after the device is idle.", errorCode: "timed_out", childPid: 0,
    }));
    const { readMemoryRunState } = await lib();
    expect(await readMemoryRunState()).toMatchObject({ status: "failed", errorCode: "timed_out" });
  });
});
