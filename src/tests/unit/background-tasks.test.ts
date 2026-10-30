import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BackgroundTaskFailure,
  INTERRUPTED_MESSAGE,
  LOG_LIMIT,
  backgroundTaskStream,
  dismissBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  resetBackgroundTasksForTests,
  runningBackgroundTask,
  startBackgroundTask,
  subscribeBackgroundTask,
  taskEtaSeconds,
  taskPercent,
  type BackgroundTaskContext,
  type BackgroundTaskView,
} from "@/lib/background-tasks";

// The work Settings starts must not belong to the request that started it:
// it runs on when the window closes, it is persisted so a reopened Settings
// and the desktop card read one record, and a restart closes what it orphaned
// instead of drawing a bar that never moves.

let root: string;
const file = () => path.join(root, "data", "background-tasks.json");

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle(id: string): Promise<BackgroundTaskView> {
  for (let i = 0; i < 200; i += 1) {
    const task = getBackgroundTask(id);
    if (task && task.state !== "running") return task;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("task never settled");
}

async function nextTick() {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bg-tasks-"));
  process.env.CLAWBOX_ROOT = root;
  resetBackgroundTasksForTests();
});

afterEach(() => {
  resetBackgroundTasksForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("startBackgroundTask", () => {
  it("runs the work outside the caller and records how it ended", async () => {
    const gate = deferred();
    const started = startBackgroundTask({
      kind: "demo",
      title: "Demo install",
      steps: [{ id: "fetch", label: "Fetch" }, { id: "wire", label: "Wire" }],
      status: "Starting…",
      async run(ctx) {
        ctx.step("fetch", "Fetching…");
        ctx.progress(50, 100);
        await gate.promise;
        ctx.step("wire");
        ctx.log("wired");
        return { status: "Installed.", size: "base" };
      },
    });
    expect(started.started).toBe(true);
    if (!started.started) return;
    await nextTick();

    const midway = getBackgroundTask(started.task.id)!;
    expect(midway.state).toBe("running");
    expect(midway.status).toBe("Fetching…");
    expect(midway.steps.map((s) => s.state)).toEqual(["running", "pending"]);
    // Half of the first of two equal steps.
    expect(midway.percent).toBe(25);

    gate.resolve();
    const done = await settle(started.task.id);
    expect(done.state).toBe("succeeded");
    expect(done.percent).toBe(100);
    expect(done.steps.map((s) => s.state)).toEqual(["done", "done"]);
    expect(done.result).toEqual({ status: "Installed.", size: "base" });
    expect(done.log).toEqual(["Starting…", "Fetching…", "wired"]);

    // Persisted, so another reader of the file sees the same ending.
    const onDisk = JSON.parse(fs.readFileSync(file(), "utf-8")) as { tasks: Array<{ id: string; state: string }> };
    expect(onDisk.tasks.find((t) => t.id === started.task.id)?.state).toBe("succeeded");
  });

  it("answers the running task of the same group instead of starting a second one", async () => {
    const gate = deferred();
    const first = startBackgroundTask({ kind: "engine", group: "speech", title: "One", run: () => gate.promise.then(() => ({})) });
    const second = startBackgroundTask({ kind: "size", group: "speech", title: "Two", run: async () => ({}) });
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    if (!first.started || second.started) return;
    expect(second.running.id).toBe(first.task.id);
    expect(runningBackgroundTask("speech")?.id).toBe(first.task.id);

    // Another group is not held up by it.
    const other = startBackgroundTask({ kind: "voice", title: "Voice", run: async () => ({}) });
    expect(other.started).toBe(true);

    gate.resolve();
    await settle(first.task.id);
    expect(runningBackgroundTask("speech")).toBeNull();
  });

  it("fails with the work's own message and keeps the failure payload", async () => {
    const started = startBackgroundTask({
      kind: "demo",
      title: "Demo",
      steps: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      async run(ctx) {
        ctx.step("a");
        throw new BackgroundTaskFailure("Not enough space.", { code: "disk_full" });
      },
    });
    if (!started.started) throw new Error("not started");
    const done = await settle(started.task.id);
    expect(done.state).toBe("failed");
    expect(done.error).toBe("Not enough space.");
    expect(done.result).toEqual({ code: "disk_full" });
    expect(done.steps.map((s) => s.state)).toEqual(["failed", "pending"]);
    expect(done.log.at(-1)).toBe("Not enough space.");
  });

  it("marks steps the work jumped over as done", async () => {
    const started = startBackgroundTask({
      kind: "demo",
      title: "Demo",
      steps: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
      async run(ctx) {
        ctx.step("c");
        await new Promise(() => {});
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    expect(getBackgroundTask(started.task.id)!.steps.map((s) => s.state)).toEqual(["done", "done", "running"]);
  });

  it("keeps only the last lines of the log, cleaned of terminal escapes", async () => {
    let ctxRef: BackgroundTaskContext | null = null;
    const started = startBackgroundTask({
      kind: "demo",
      title: "Demo",
      async run(ctx) {
        ctxRef = ctx;
        await new Promise(() => {});
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    for (let i = 0; i < LOG_LIMIT + 25; i += 1) ctxRef!.log(`\u001b[32mline ${i}\u001b[0m`);
    const task = getBackgroundTask(started.task.id)!;
    expect(task.log).toHaveLength(LOG_LIMIT);
    expect(task.log[0]).toBe("line 25");
    expect(task.logCount).toBe(LOG_LIMIT + 25);
  });
});

describe("a restart of the web server", () => {
  it("closes a record another process left running as interrupted", async () => {
    const started = startBackgroundTask({
      kind: "demo",
      title: "Demo",
      steps: [{ id: "a", label: "A" }],
      async run(ctx) {
        ctx.step("a");
        await new Promise(() => {});
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();

    // A new process: same file, fresh registry.
    resetBackgroundTasksForTests();
    const after = getBackgroundTask(started.task.id)!;
    expect(after.state).toBe("interrupted");
    expect(after.error).toBe(INTERRUPTED_MESSAGE);
    expect(after.steps[0].state).toBe("failed");
    expect(runningBackgroundTask("demo")).toBeNull();
    // And it was written back, so the next reader agrees.
    const onDisk = JSON.parse(fs.readFileSync(file(), "utf-8")) as { tasks: Array<{ state: string }> };
    expect(onDisk.tasks[0].state).toBe("interrupted");
  });

  it("reads a corrupt file as no tasks rather than throwing", () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), "{not json");
    resetBackgroundTasksForTests();
    expect(listBackgroundTasks()).toEqual([]);
  });
});

describe("following a task again", () => {
  async function readAll(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
    const text = await new Response(stream).text();
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("streams the same NDJSON shape the install routes answer with", async () => {
    const gate = deferred();
    let ctxRef: BackgroundTaskContext | null = null;
    const started = startBackgroundTask({
      kind: "demo",
      title: "Demo",
      status: "Starting…",
      async run(ctx) {
        ctxRef = ctx;
        await gate.promise;
        return { status: "All done.", size: "small" };
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    const lines = readAll(backgroundTaskStream(started.task.id));
    await nextTick();
    ctxRef!.status("Halfway");
    ctxRef!.progress(10, 20);
    gate.resolve();
    const got = await lines;
    expect(got[0]).toMatchObject({ taskId: started.task.id, kind: "demo", status: "Starting…" });
    expect(got).toContainEqual({ status: "Halfway" });
    expect(got).toContainEqual({ completed: 10, total: 20 });
    expect(got.at(-1)).toEqual({ status: "All done.", size: "small", success: true, taskId: started.task.id });
  });

  it("answers an ended task's verdict at once", async () => {
    const started = startBackgroundTask({ kind: "demo", title: "Demo", run: async () => { throw new Error("boom"); } });
    if (!started.started) throw new Error("not started");
    await settle(started.task.id);
    const got = await readAll(backgroundTaskStream(started.task.id));
    expect(got.at(-1)).toMatchObject({ error: "boom", taskId: started.task.id });
  });

  it("cancelling a follower does not stop the work", async () => {
    const gate = deferred();
    const started = startBackgroundTask({ kind: "demo", title: "Demo", run: () => gate.promise.then(() => ({ status: "ok" })) });
    if (!started.started) throw new Error("not started");
    const reader = backgroundTaskStream(started.task.id).getReader();
    await reader.read();
    await reader.cancel();
    gate.resolve();
    expect((await settle(started.task.id)).state).toBe("succeeded");
  });

  it("refuses to subscribe to an unknown or ended task", async () => {
    expect(subscribeBackgroundTask("nope", () => {})).toBeNull();
    const started = startBackgroundTask({ kind: "demo", title: "Demo", run: async () => ({}) });
    if (!started.started) throw new Error("not started");
    await settle(started.task.id);
    expect(subscribeBackgroundTask(started.task.id, () => {})).toBeNull();
  });
});

describe("dismissing a card", () => {
  it("dismisses an ended task, never a running one", async () => {
    const gate = deferred();
    const started = startBackgroundTask({ kind: "demo", title: "Demo", run: () => gate.promise.then(() => ({})) });
    if (!started.started) throw new Error("not started");
    expect(dismissBackgroundTask(started.task.id)).toBeNull();
    gate.resolve();
    await settle(started.task.id);
    expect(dismissBackgroundTask(started.task.id)?.dismissed).toBe(true);
  });
});

describe("taskPercent / taskEtaSeconds", () => {
  const base = { state: "running" as const, completed: null, total: null, startedAt: 0, stepStartedAt: 0 };

  it("weights steps and counts the running one by its byte fraction", () => {
    const steps = [
      { id: "a", label: "A", state: "done" as const, weight: 1 },
      { id: "b", label: "B", state: "running" as const, weight: 3 },
    ];
    expect(taskPercent({ ...base, steps, completed: 1, total: 3 })).toBe(50);
    expect(taskPercent({ ...base, steps })).toBe(25);
  });

  it("is the byte fraction alone without steps, and unknown without either", () => {
    expect(taskPercent({ ...base, steps: [], completed: 25, total: 100 })).toBe(25);
    expect(taskPercent({ ...base, steps: [] })).toBeNull();
  });

  it("gives no ETA before there is a rate to read, nor after the end", () => {
    expect(taskEtaSeconds({ ...base, steps: [], completed: 1, total: 1000 }, 60_000)).toBeNull();
    expect(taskEtaSeconds({ ...base, steps: [], completed: 500, total: 1000 }, 2_000)).toBeNull();
    expect(taskEtaSeconds({ ...base, state: "succeeded", steps: [], completed: 500, total: 1000 }, 60_000)).toBeNull();
  });

  it("reads the time left off the byte rate of the last step", () => {
    // Half of it in 60 s: another 60 s to go.
    expect(taskEtaSeconds({ ...base, steps: [], completed: 500, total: 1000, stepStartedAt: 0 }, 60_000)).toBe(60);
    const steps = [
      { id: "a", label: "A", state: "done" as const, weight: 1 },
      { id: "b", label: "B", state: "running" as const, weight: 1 },
    ];
    expect(taskEtaSeconds({ ...base, steps, completed: 250, total: 1000, stepStartedAt: 30_000 }, 60_000)).toBe(90);
  });

  it("falls back to the whole task's rate when later steps still weigh", () => {
    const steps = [
      { id: "a", label: "A", state: "done" as const, weight: 1 },
      { id: "b", label: "B", state: "running" as const, weight: 1 },
      { id: "c", label: "C", state: "pending" as const, weight: 2 },
    ];
    // 25 % in 100 s: 300 s to go.
    expect(taskEtaSeconds({ ...base, steps }, 100_000)).toBe(300);
  });
});
