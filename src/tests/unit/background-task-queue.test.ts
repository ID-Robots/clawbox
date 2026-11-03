import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every Install is accepted at once (TASK-2128). Work that may not run beside
 * what is running — a shared lane, or not enough memory or disk left — waits
 * as a QUEUED task: its own record, its own Cancel, its "starts after …", and
 * it starts by itself when what it waits for ends, however that ends. A
 * restart keeps the queue: a queued task's work is rebuilt from its kind.
 */

const h = vi.hoisted(() => ({
  followRootStep: vi.fn(),
  followRootStepRun: vi.fn(),
  startSpecFor: vi.fn(),
}));
vi.mock("@/lib/root-step-follow", () => ({
  followRootStep: (...a: unknown[]) => h.followRootStep(...a),
  followRootStepRun: (...a: unknown[]) => h.followRootStepRun(...a),
}));
vi.mock("@/lib/background-task-starters", () => ({
  startSpecFor: (...a: unknown[]) => h.startSpecFor(...a),
}));

import { decideQueue, type QueueMeasure, type QueueSubject } from "@/lib/background-task-queue";
import {
  CANCELLED_STATUS,
  INTERRUPTED_MESSAGE,
  QUEUE_LOST_MESSAGE,
  backgroundTaskStream,
  cancelBackgroundTask,
  dismissBackgroundTask,
  getBackgroundTask,
  liveBackgroundTask,
  listBackgroundTasks,
  resetBackgroundTasksForTests,
  resumeBackgroundTasks,
  setBackgroundTaskQueueMeasureForTests,
  startBackgroundTask,
  type BackgroundTaskContext,
  type BackgroundTaskView,
  type StartBackgroundTaskSpec,
} from "@/lib/background-tasks";
import { KOKORO_INSTALL_KIND } from "@/lib/background-task-kinds";

const GIB = 1024 ** 3;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(id: string, state: BackgroundTaskView["state"]): Promise<BackgroundTaskView> {
  for (let i = 0; i < 400; i += 1) {
    const task = getBackgroundTask(id);
    if (task?.state === state) return task;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`task ${id} never reached ${state} (is ${getBackgroundTask(id)?.state})`);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** A task whose work waits for the test to finish it. */
function held(over: Partial<StartBackgroundTaskSpec> & { kind: string }) {
  const done = deferred<Record<string, unknown> | void>();
  const ran = vi.fn<(ctx: BackgroundTaskContext) => void>();
  const spec: StartBackgroundTaskSpec = {
    title: `Installing ${over.kind}`,
    label: over.kind,
    status: `Working on ${over.kind}…`,
    run: async (ctx) => { ran(ctx); return done.promise; },
    ...over,
  };
  return { spec, done, ran };
}

const roomy: QueueMeasure = { availableMemory: () => 6 * GIB, freeDisk: () => 100 * GIB };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bg-queue-"));
  process.env.CLAWBOX_ROOT = root;
  resetBackgroundTasksForTests();
  setBackgroundTaskQueueMeasureForTests(roomy);
  h.followRootStep.mockReset();
  h.followRootStepRun.mockReset();
  h.startSpecFor.mockReset();
});

afterEach(() => {
  resetBackgroundTasksForTests();
  setBackgroundTaskQueueMeasureForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("decideQueue", () => {
  const subject = (id: string, lanes: string[], memoryBytes = 0, diskBytes = 0): QueueSubject => ({
    id,
    lanes,
    needs: memoryBytes || diskBytes ? { memoryBytes, diskBytes, diskPath: "/data" } : null,
  });

  it("starts work that shares no lane and fits", () => {
    expect(decideQueue(subject("b", ["x"], GIB, GIB), [subject("a", ["y"], GIB, GIB)], [], roomy)).toEqual({ start: true });
  });

  it("waits behind the running task it shares a lane with", () => {
    const running = subject("a", ["system"]);
    expect(decideQueue(subject("b", ["system", "cache"]), [running], [], roomy)).toEqual({ start: false, behind: running, reason: "lane" });
  });

  it("keeps a lane's order: waits behind the one queued ahead in it, even with nothing running", () => {
    const ahead = subject("a", ["cache"]);
    expect(decideQueue(subject("b", ["cache"]), [], [ahead], roomy)).toEqual({ start: false, behind: ahead, reason: "lane" });
  });

  it("waits for memory: what the running work said it needs is spoken for", () => {
    const big = subject("a", [], 3 * GIB);
    const small = subject("s", [], GIB / 4);
    const tight: QueueMeasure = { availableMemory: () => 4 * GIB, freeDisk: () => null };
    // 4 GiB available, 3.25 promised: 0.75 left, 2 asked.
    expect(decideQueue(subject("b", [], 2 * GIB), [small, big], [], tight)).toEqual({ start: false, behind: big, reason: "memory" });
    expect(decideQueue(subject("c", [], GIB / 2), [small, big], [], tight)).toEqual({ start: true });
  });

  it("waits for disk, keeping the box's own reserve free", () => {
    const running = subject("a", [], 0, 5 * GIB);
    const disk: QueueMeasure = { availableMemory: () => null, freeDisk: () => 8 * GIB };
    // 8 GiB free, 0.5 reserved, 5 promised: 2.5 left.
    expect(decideQueue(subject("b", [], 0, 3 * GIB), [running], [], disk)).toMatchObject({ start: false, reason: "disk" });
    expect(decideQueue(subject("c", [], 0, 2 * GIB), [running], [], disk)).toEqual({ start: true });
  });

  it("never waits on room with nothing running, nor on a figure the box would not give", () => {
    const empty: QueueMeasure = { availableMemory: () => 0, freeDisk: () => 0 };
    expect(decideQueue(subject("b", [], 2 * GIB, 2 * GIB), [], [], empty)).toEqual({ start: true });
    const unknown: QueueMeasure = { availableMemory: () => null, freeDisk: () => null };
    expect(decideQueue(subject("b", [], 2 * GIB, 2 * GIB), [subject("a", [], 2 * GIB)], [], unknown)).toEqual({ start: true });
  });
});

describe("the queue", () => {
  it("accepts a second install that shares a lane, queued behind the first, and starts it when the first ends", async () => {
    const kokoro = held({ kind: "kokoro", label: "Kokoro", lanes: ["system"] });
    const whisper = held({ kind: "whisper", label: "Whisper", lanes: ["system", "cache"] });
    const a = startBackgroundTask(kokoro.spec);
    const b = startBackgroundTask(whisper.spec);
    if (!a.started || !b.started) throw new Error("both are accepted");
    expect(a.queued).toBe(false);
    expect(b.queued).toBe(true);
    expect(b.task).toMatchObject({
      state: "queued",
      status: "Queued — starts after Kokoro",
      queuedBehind: { id: a.task.id, kind: "kokoro", label: "Kokoro" },
    });
    const followed = readAll(backgroundTaskStream(b.task.id));
    await new Promise((r) => setImmediate(r));
    expect(kokoro.ran).toHaveBeenCalledTimes(1);
    expect(whisper.ran).not.toHaveBeenCalled();

    kokoro.done.resolve({ status: "Kokoro is installed." });
    await until(b.task.id, "running");
    await vi.waitFor(() => expect(whisper.ran).toHaveBeenCalledTimes(1));
    expect(whisper.ran.mock.calls[0][0].waited).toBe(true);
    expect(getBackgroundTask(b.task.id)).toMatchObject({ status: "Working on whisper…", queuedBehind: null });
    whisper.done.resolve({ status: "Whisper is installed." });

    const lines = await followed;
    expect(lines[0]).toMatchObject({ taskId: b.task.id, queued: true, behind: { kind: "kokoro", label: "Kokoro" } });
    expect(lines).toContainEqual({ status: "Working on whisper…", queued: false });
    expect(lines.at(-1)).toMatchObject({ success: true, status: "Whisper is installed." });
  });

  it("runs installs that share no lane side by side", async () => {
    const a = held({ kind: "kokoro", lanes: ["system"] });
    const b = held({ kind: "embed", lanes: [] });
    const first = startBackgroundTask(a.spec);
    const second = startBackgroundTask(b.spec);
    expect(first.started && first.queued).toBe(false);
    expect(second.started && second.queued).toBe(false);
    await vi.waitFor(() => {
      expect(a.ran).toHaveBeenCalled();
      expect(b.ran).toHaveBeenCalled();
    });
    expect(b.ran.mock.calls[0][0].waited).toBe(false);
    a.done.resolve();
    b.done.resolve();
  });

  it("starts the next one whatever the first's ending: a failure moves the queue too", async () => {
    const a = held({ kind: "kokoro", lanes: ["system"] });
    const b = held({ kind: "whisper", lanes: ["system"] });
    const first = startBackgroundTask(a.spec);
    const second = startBackgroundTask(b.spec);
    if (!first.started || !second.started) throw new Error("accepted");
    await vi.waitFor(() => expect(a.ran).toHaveBeenCalled());
    a.done.reject(new Error("No network."));
    expect(await until(first.task.id, "failed")).toMatchObject({ error: "No network." });
    await until(second.task.id, "running");
    b.done.resolve();
    await until(second.task.id, "succeeded");
  });

  it("follows the SAME install on a second press, whether it runs or waits", () => {
    const a = held({ kind: "kokoro", group: "voice", lanes: ["system"] });
    const b = held({ kind: "whisper", group: "speech", lanes: ["system"] });
    startBackgroundTask(a.spec);
    const queued = startBackgroundTask(b.spec);
    if (!queued.started) throw new Error("accepted");
    const again = startBackgroundTask(held({ kind: "whisper", group: "speech", lanes: ["system"] }).spec);
    expect(again).toMatchObject({ started: false, running: { id: queued.task.id, state: "queued" } });
    expect(liveBackgroundTask("speech")?.id).toBe(queued.task.id);
  });

  it("cancels a queued install at once — it never runs — and moves the one behind it up", async () => {
    const a = held({ kind: "kokoro", label: "Kokoro", lanes: ["system"] });
    const b = held({ kind: "whisper", label: "Whisper", lanes: ["system"] });
    const c = held({ kind: "gemma", label: "Gemma 4", lanes: ["system"] });
    const first = startBackgroundTask(a.spec);
    const second = startBackgroundTask(b.spec);
    const third = startBackgroundTask(c.spec);
    if (!first.started || !second.started || !third.started) throw new Error("accepted");
    expect(third.task.queuedBehind?.label).toBe("Whisper");
    const followed = readAll(backgroundTaskStream(second.task.id));

    const cancelled = cancelBackgroundTask(second.task.id);
    expect(cancelled).toMatchObject({ ok: true, task: { state: "cancelled" } });
    expect(getBackgroundTask(third.task.id)).toMatchObject({ state: "queued", queuedBehind: { label: "Kokoro" } });
    expect((await followed).at(-1)).toMatchObject({ cancelled: true, status: CANCELLED_STATUS });

    a.done.resolve();
    await until(third.task.id, "running");
    c.done.resolve();
    await until(third.task.id, "succeeded");
    expect(b.ran).not.toHaveBeenCalled();
  });

  it("waits for room when the box is short of memory, and starts once the running work gives it back", async () => {
    setBackgroundTaskQueueMeasureForTests({ availableMemory: () => 3 * GIB, freeDisk: () => null });
    const big = held({ kind: "gemma", label: "Gemma 4", needs: { memoryBytes: 2 * GIB, diskBytes: 0, diskPath: null } });
    const other = held({ kind: "embed", needs: { memoryBytes: 2 * GIB, diskBytes: 0, diskPath: null } });
    const first = startBackgroundTask(big.spec);
    const second = startBackgroundTask(other.spec);
    if (!first.started || !second.started) throw new Error("accepted");
    expect(second.task).toMatchObject({ state: "queued", queuedBehind: { label: "Gemma 4" } });
    big.done.resolve();
    await until(second.task.id, "running");
    other.done.resolve();
  });

  it("is a live task: never pruned, never dismissed, listed with the rest", () => {
    startBackgroundTask(held({ kind: "kokoro", lanes: ["system"] }).spec);
    const queued = startBackgroundTask(held({ kind: "whisper", lanes: ["system"] }).spec);
    if (!queued.started) throw new Error("accepted");
    expect(dismissBackgroundTask(queued.task.id)).toBeNull();
    expect(listBackgroundTasks().map((t) => t.state).sort()).toEqual(["queued", "running"]);
  });
});

describe("the queue across a restart of the web server", () => {
  it("keeps the queued install queued and starts it, rebuilt from its kind, once what it waited for is gone", async () => {
    const a = held({ kind: "kokoro-other", lanes: ["system"] });
    const first = startBackgroundTask(a.spec);
    const second = startBackgroundTask({ ...held({ kind: KOKORO_INSTALL_KIND, lanes: ["system"] }).spec, meta: { from: "test" } });
    if (!first.started || !second.started) throw new Error("accepted");
    const rebuilt = held({ kind: KOKORO_INSTALL_KIND, lanes: ["system"], status: "Installing the voice on this box (Kokoro)…" });
    h.startSpecFor.mockResolvedValue(rebuilt.spec);

    // The restart: this process's registry is gone; the file is not.
    resetBackgroundTasksForTests();
    resumeBackgroundTasks();

    // The running one was not a root step: nothing to follow, so it is closed.
    expect(getBackgroundTask(first.task.id)).toMatchObject({ state: "interrupted", error: INTERRUPTED_MESSAGE });
    await until(second.task.id, "running");
    expect(h.startSpecFor).toHaveBeenCalledWith(KOKORO_INSTALL_KIND, { from: "test" });
    await vi.waitFor(() => expect(rebuilt.ran).toHaveBeenCalledTimes(1));
    expect(rebuilt.ran.mock.calls[0][0].waited).toBe(true);
    rebuilt.done.resolve({ status: "The voice on this box is installed." });
    expect(await until(second.task.id, "succeeded")).toMatchObject({ result: { status: "The voice on this box is installed." } });
  });

  it("waits behind a root step the new server adopted, and starts when that run ends", async () => {
    const run = deferred<{ ok: boolean }>();
    h.followRootStep.mockImplementation(async (_step: string, opts: { onRunning?: (r: unknown) => void }) => {
      opts.onRunning?.({ step: "voice_whisper_install", sinceMs: Date.now(), invocationId: "0123456789abcdef0123456789abcdef" });
      return new Promise(() => {});
    });
    const first = startBackgroundTask({
      kind: "whisper-engine-install",
      title: "Installing speech (Whisper)",
      label: "Whisper",
      lanes: ["system"],
      steps: [{ id: "install", label: "Build" }],
      async run(ctx) {
        ctx.step("install");
        await ctx.rootStep("voice_whisper_install", { timeoutMs: 1000, label: "the speech install", finishes: { status: "Speech is installed." } });
      },
    });
    const second = startBackgroundTask({ ...held({ kind: KOKORO_INSTALL_KIND, lanes: ["system"] }).spec });
    if (!first.started || !second.started) throw new Error("accepted");
    await vi.waitFor(() => expect(getBackgroundTask(first.task.id)?.unit).not.toBeNull());
    const rebuilt = held({ kind: KOKORO_INSTALL_KIND, lanes: ["system"] });
    h.startSpecFor.mockResolvedValue(rebuilt.spec);
    h.followRootStepRun.mockReturnValue(run.promise);

    resetBackgroundTasksForTests();
    resumeBackgroundTasks();
    await new Promise((r) => setTimeout(r, 20));
    expect(getBackgroundTask(first.task.id)?.state).toBe("running");
    expect(getBackgroundTask(second.task.id)).toMatchObject({ state: "queued", queuedBehind: { id: first.task.id, label: "Whisper" } });
    expect(h.startSpecFor).not.toHaveBeenCalled();

    run.resolve({ ok: true });
    await until(first.task.id, "succeeded");
    await vi.waitFor(() => expect(rebuilt.ran).toHaveBeenCalledTimes(1));
    rebuilt.done.resolve();
    await until(second.task.id, "succeeded");
  });

  it("ends a queued task whose kind this build cannot rebuild, saying to start it again", async () => {
    startBackgroundTask(held({ kind: "a", lanes: ["system"] }).spec);
    const queued = startBackgroundTask(held({ kind: "retired-kind", lanes: ["system"] }).spec);
    if (!queued.started) throw new Error("accepted");
    h.startSpecFor.mockResolvedValue(null);
    resetBackgroundTasksForTests();
    resumeBackgroundTasks();
    expect(await until(queued.task.id, "interrupted")).toMatchObject({ error: QUEUE_LOST_MESSAGE });
  });
});

describe("a task's headline", () => {
  it("never shows a root step's plumbing — su and PAM lines go to the log only", async () => {
    const work = deferred();
    let ctx!: BackgroundTaskContext;
    const start = startBackgroundTask({
      kind: "whisper",
      title: "Installing speech (Whisper)",
      status: "Installing speech on this box (faster-whisper)…",
      async run(c) { ctx = c; await work.promise; },
    });
    if (!start.started) throw new Error("accepted");
    await vi.waitFor(() => expect(ctx).toBeDefined());
    ctx.status("  Building CTranslate2 with CUDA for sm_87...");
    ctx.status("pam_unix(su-l:session): session closed for user clawbox");
    ctx.status("(to clawbox) root on none");
    const task = getBackgroundTask(start.task.id)!;
    expect(task.status).toBe("  Building CTranslate2 with CUDA for sm_87...");
    expect(task.log).toContain("pam_unix(su-l:session): session closed for user clawbox");
    expect(task.log).toContain("(to clawbox) root on none");
    work.resolve();
  });
});
