import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two ways a background task can end without its work running to the
 * end in this process:
 *
 *  - the owner's Cancel, for work that says it can stop safely — the work
 *    sees its signal abort, stops, and the task ends `cancelled` (not
 *    `failed`: nothing went wrong);
 *  - a restart of the web server while the task's current step is a root
 *    step — the unit runs on under systemd, so the next server follows that
 *    same run again instead of calling it lost.
 */

const h = vi.hoisted(() => ({
  followRootStep: vi.fn(),
  followRootStepRun: vi.fn(),
}));
vi.mock("@/lib/root-step-follow", () => ({
  followRootStep: (...a: unknown[]) => h.followRootStep(...a),
  followRootStepRun: (...a: unknown[]) => h.followRootStepRun(...a),
}));
// What a restarted server does at the memory-model download's ending (the
// runner reaches it through src/lib/background-task-finishers.ts).
const embed = vi.hoisted(() => ({
  finish: vi.fn<(ok: boolean) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true })),
  settle: vi.fn(async () => ({ dropped: false })),
}));
vi.mock("@/lib/embed-model-download", () => ({
  EMBED_MODEL_DONE_STATUS: "The memory-search model is on this box.",
  finishEmbedModelDownload: (ok: boolean) => embed.finish(ok),
  settleEmbedModelAside: () => embed.settle(),
}));

import {
  ADOPTED_STATUS,
  ADOPTED_UNFINISHED_MESSAGE,
  BackgroundTaskCancelled,
  CANCELLED_STATUS,
  INTERRUPTED_MESSAGE,
  backgroundTaskStream,
  cancelBackgroundTask,
  getBackgroundTask,
  resetBackgroundTasksForTests,
  runningBackgroundTask,
  startBackgroundTask,
  type BackgroundTaskView,
} from "@/lib/background-tasks";

let root: string;
const file = () => path.join(root, "data", "background-tasks.json");

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function settle(id: string): Promise<BackgroundTaskView> {
  for (let i = 0; i < 400; i += 1) {
    const task = getBackgroundTask(id);
    if (task && task.state !== "running") return task;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("task never settled");
}

async function nextTick() {
  await new Promise((r) => setImmediate(r));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bg-tasks-adopt-"));
  process.env.CLAWBOX_ROOT = root;
  resetBackgroundTasksForTests();
  h.followRootStep.mockReset();
  h.followRootStepRun.mockReset();
  embed.finish.mockReset().mockResolvedValue({ ok: true, error: undefined });
  embed.settle.mockReset().mockResolvedValue({ dropped: false });
});

afterEach(() => {
  resetBackgroundTasksForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cancelBackgroundTask", () => {
  it("aborts a cancellable task's work and ends it cancelled, not failed", async () => {
    let sawAbort = false;
    const started = startBackgroundTask({
      kind: "fetch",
      title: "Downloading",
      cancellable: true,
      steps: [{ id: "fetch", label: "Fetch" }, { id: "switch", label: "Switch" }],
      run: (ctx) => new Promise((_, reject) => {
        ctx.step("fetch");
        ctx.signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new BackgroundTaskCancelled());
        });
      }),
    });
    if (!started.started) throw new Error("not started");
    await nextTick();

    const asked = cancelBackgroundTask(started.task.id);
    expect(asked.ok).toBe(true);
    const ended = await settle(started.task.id);

    expect(sawAbort).toBe(true);
    expect(ended.state).toBe("cancelled");
    expect(ended.error).toBeNull();
    expect(ended.result).toEqual({ status: CANCELLED_STATUS });
    // Stopped where the owner stopped it: neither failed nor done.
    expect(ended.steps.map((s) => s.state)).toEqual(["pending", "pending"]);
    expect(runningBackgroundTask("fetch")).toBeNull();
  });

  it("says `cancelRequested` until the work has really stopped", async () => {
    const stop = deferred();
    const started = startBackgroundTask({
      kind: "slow-stop",
      title: "Slow to stop",
      cancellable: true,
      run: async (ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
        await stop.promise;
        throw new BackgroundTaskCancelled();
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();

    cancelBackgroundTask(started.task.id);
    const stopping = getBackgroundTask(started.task.id)!;
    expect(stopping.state).toBe("running");
    expect(stopping.cancelRequested).toBe(true);
    // A second press is the same request, not a second abort.
    expect(cancelBackgroundTask(started.task.id).ok).toBe(true);

    stop.resolve();
    expect((await settle(started.task.id)).state).toBe("cancelled");
  });

  it("refuses work that cannot stop safely, an ended task and an unknown one", async () => {
    const gate = deferred();
    const fixed = startBackgroundTask({ kind: "root", title: "Root step", run: async () => { await gate.promise; } });
    if (!fixed.started) throw new Error("not started");
    await nextTick();

    expect(cancelBackgroundTask(fixed.task.id)).toEqual({ ok: false, code: "not_cancellable" });
    expect(getBackgroundTask(fixed.task.id)!.cancelRequested).toBe(false);
    gate.resolve();
    await settle(fixed.task.id);
    expect(cancelBackgroundTask(fixed.task.id)).toEqual({ ok: false, code: "not_running" });
    expect(cancelBackgroundTask("nope")).toEqual({ ok: false, code: "unknown_task" });
  });

  it("ends a follower's stream with a closing line every reader can tell apart", async () => {
    const started = startBackgroundTask({
      kind: "fetch",
      title: "Downloading",
      cancellable: true,
      run: (ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
    });
    if (!started.started) throw new Error("not started");
    const lines = readAll(backgroundTaskStream(started.task.id));
    await nextTick();
    cancelBackgroundTask(started.task.id);

    const all = await lines;
    expect(all.at(-1)).toMatchObject({ cancelled: true, code: "cancelled", error: CANCELLED_STATUS, taskId: started.task.id });
  });

  it("keeps a failure that was not the cancellation a failure, said as such", async () => {
    const started = startBackgroundTask({
      kind: "switching",
      title: "Switching",
      cancellable: true,
      run: async (ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
        throw new Error("Could not switch to that speech model.");
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    cancelBackgroundTask(started.task.id);
    const ended = await settle(started.task.id);
    expect(ended.state).toBe("failed");
    expect(ended.error).toBe("Could not switch to that speech model.");
  });

  it("stops offering Cancel once the work says it must not be stopped", async () => {
    const gate = deferred();
    const started = startBackgroundTask({
      kind: "two-part",
      title: "Two parts",
      cancellable: true,
      run: async (ctx) => {
        ctx.cancellable(false);
        await gate.promise;
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    expect(getBackgroundTask(started.task.id)!.cancellable).toBe(false);
    expect(cancelBackgroundTask(started.task.id)).toEqual({ ok: false, code: "not_cancellable" });
    gate.resolve();
    expect((await settle(started.task.id)).state).toBe("succeeded");
  });

  it("keeps a success that landed after the press a success", async () => {
    const started = startBackgroundTask({
      kind: "late",
      title: "Nearly done",
      cancellable: true,
      run: async (ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
        return { status: "Finished anyway." };
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    cancelBackgroundTask(started.task.id);
    const ended = await settle(started.task.id);
    expect(ended.state).toBe("succeeded");
    expect(ended.result).toEqual({ status: "Finished anyway." });
  });
});

describe("a root step outlives a restart of the web server", () => {
  /** Start a task whose current step is a root step that never ends in this process. */
  async function startRootStepTask(opts: { finishes?: Record<string, unknown>; afterStep?: boolean } = {}) {
    h.followRootStep.mockImplementation((step: string, o: { onRunning?: (run: unknown) => void }) => {
      o.onRunning?.({ step, sinceMs: 1_000, invocationId: "a".repeat(32) });
      return new Promise(() => {});
    });
    const started = startBackgroundTask({
      kind: "voice",
      title: "Installing the voice",
      steps: [{ id: "install", label: "Install" }, { id: "wire", label: "Wire" }],
      async run(ctx) {
        ctx.step("install");
        if (opts.afterStep) {
          h.followRootStep.mockResolvedValueOnce({ ok: true });
          await ctx.rootStep("voice_install", { timeoutMs: 1000, label: "the voice install" });
          ctx.step("wire");
          await new Promise(() => {});
        }
        await ctx.rootStep("voice_install", { timeoutMs: 1000, label: "the voice install", finishes: opts.finishes });
      },
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    await nextTick();
    return started.task.id;
  }

  it("records which run of the unit the current step is, at once", async () => {
    const id = await startRootStepTask({ finishes: { status: "Installed." } });
    const onDisk = JSON.parse(fs.readFileSync(file(), "utf-8")) as { tasks: Array<{ id: string; unit: unknown }> };
    expect(onDisk.tasks.find((t) => t.id === id)?.unit).toEqual({
      step: "voice_install",
      sinceMs: 1_000,
      invocationId: "a".repeat(32),
      taskStep: "install",
      finishes: { status: "Installed." },
      bootId: expect.any(String),
    });
  });

  it("adopts the run and closes the task the way the unit ended", async () => {
    const id = await startRootStepTask({ finishes: { status: "Installed." } });
    const done = deferred<{ ok: boolean }>();
    h.followRootStepRun.mockImplementation((_run: unknown, o: { onStatus: (line: string) => void }) => {
      o.onStatus("  Registering the voice...");
      return done.promise;
    });

    resetBackgroundTasksForTests();
    const adopted = getBackgroundTask(id)!;
    expect(adopted.state).toBe("running");
    expect(adopted.adoptedAt).not.toBeNull();
    await vi.waitFor(() => expect(h.followRootStepRun).toHaveBeenCalledWith(
      { step: "voice_install", sinceMs: 1_000, invocationId: "a".repeat(32) },
      expect.objectContaining({ label: "Installing the voice" }),
    ));
    await nextTick();
    const live = getBackgroundTask(id)!;
    expect(live.log).toContain(ADOPTED_STATUS);
    // As the unit said it: the installer's indent is how its own sub-steps read.
    expect(live.status).toBe("  Registering the voice...");

    done.resolve({ ok: true });
    const ended = await settle(id);
    expect(ended.state).toBe("succeeded");
    expect(ended.result).toEqual({ status: "Installed." });
  });

  it("says the work after the unit did not run when the unit was not the last of it", async () => {
    const id = await startRootStepTask();
    h.followRootStepRun.mockResolvedValue({ ok: true });
    resetBackgroundTasksForTests();
    const ended = await settle(id);
    expect(ended.state).toBe("interrupted");
    expect(ended.error).toBe(ADOPTED_UNFINISHED_MESSAGE);
  });

  it("reports the unit's own failure", async () => {
    const id = await startRootStepTask({ finishes: { status: "Installed." } });
    h.followRootStepRun.mockResolvedValue({ ok: false, error: "Error: pip failed" });
    resetBackgroundTasksForTests();
    const ended = await settle(id);
    expect(ended.state).toBe("failed");
    expect(ended.error).toBe("Error: pip failed");
  });

  it("falls back to interrupted when the run cannot be found again", async () => {
    const id = await startRootStepTask({ finishes: { status: "Installed." } });
    h.followRootStepRun.mockResolvedValue({ ok: false, lost: true, error: "not running" });
    resetBackgroundTasksForTests();
    const ended = await settle(id);
    expect(ended.state).toBe("interrupted");
    expect(ended.error).toBe(INTERRUPTED_MESSAGE);
  });

  it("does not adopt a task that had moved past its unit to work of the dead process", async () => {
    const id = await startRootStepTask({ afterStep: true, finishes: { status: "Installed." } });
    expect(getBackgroundTask(id)!.steps.map((s) => s.state)).toEqual(["done", "running"]);
    resetBackgroundTasksForTests();
    const after = getBackgroundTask(id)!;
    expect(after.state).toBe("interrupted");
    expect(h.followRootStepRun).not.toHaveBeenCalled();
  });

  it("does not follow a unit across a reboot: systemd's answer then is a never-run instance's", async () => {
    const id = await startRootStepTask({ finishes: { status: "Installed." } });
    const raw = JSON.parse(fs.readFileSync(file(), "utf-8")) as { tasks: Array<{ id: string; unit: { bootId: string } }> };
    raw.tasks.find((t) => t.id === id)!.unit.bootId = "another-boot";
    fs.writeFileSync(file(), JSON.stringify(raw));
    resetBackgroundTasksForTests();
    const ended = await settle(id);
    expect(ended.state).toBe("interrupted");
    expect(h.followRootStepRun).not.toHaveBeenCalled();
  });

  it("asks the kind what a well-ended unit means: a memory-model step that left no model is a failure", async () => {
    h.followRootStep.mockImplementation((step: string, o: { onRunning?: (run: unknown) => void }) => {
      o.onRunning?.({ step, sinceMs: 1_000, invocationId: "c".repeat(32) });
      return new Promise(() => {});
    });
    const started = startBackgroundTask({
      kind: "embed-model-download",
      title: "Downloading the memory-search model",
      run: (ctx) => ctx.rootStep("embed_model", { timeoutMs: 1000, label: "the memory model download" }).then(() => undefined),
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    await nextTick();
    h.followRootStepRun.mockResolvedValue({ ok: true });
    embed.finish.mockResolvedValueOnce({ ok: false, error: "The download finished but the memory-search model is not on this box." });

    resetBackgroundTasksForTests();
    const ended = await settle(started.task.id);
    expect(embed.finish).toHaveBeenCalledWith(true);
    expect(ended.state).toBe("failed");
    expect(ended.error).toContain("not on this box");
  });

  it("settles what a cut-off memory-model download left aside, adopted or not", async () => {
    const started = startBackgroundTask({
      kind: "embed-model-download",
      title: "Downloading the memory-search model",
      // Cut off before its unit was seen running: nothing to adopt.
      run: () => new Promise(() => {}),
    });
    if (!started.started) throw new Error("not started");
    await nextTick();
    resetBackgroundTasksForTests();
    expect(getBackgroundTask(started.task.id)!.state).toBe("interrupted");
    await vi.waitFor(() => expect(embed.settle).toHaveBeenCalled());
  });

  it("adopts once per process, however often the record is read", async () => {
    const id = await startRootStepTask({ finishes: { status: "Installed." } });
    h.followRootStepRun.mockImplementation(() => new Promise(() => {}));
    resetBackgroundTasksForTests();
    getBackgroundTask(id);
    getBackgroundTask(id);
    await vi.waitFor(() => expect(h.followRootStepRun).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.followRootStepRun).toHaveBeenCalledTimes(1);
    // And the group is held: a second install follows this one.
    const again = startBackgroundTask({ kind: "voice", title: "x", run: async () => {} });
    expect(again.started).toBe(false);
  });
});
