import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTaskStream } from "@/lib/background-task-client";

/**
 * A background task's stream that is cut short is not the work's ending: the
 * web server restarting mid-install is exactly when a root step's task is
 * adopted by the next one, and a dropped tunnel ends only the stream. The
 * reader follows the TASK again until it has a verdict, instead of painting a
 * running (or adopted) install as failed.
 */

const ndjson = (lines: unknown[]) => new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { status: 200 });

let follows: string[] = [];

function stubFollow(answers: Array<Response | Error>) {
  follows = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    follows.push(input.toString());
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  }));
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.finally(() => { done = true; });
  for (let i = 0; i < 40 && !done; i += 1) await vi.advanceTimersByTimeAsync(5_000);
  return promise;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readTaskStream", () => {
  it("follows the task again when its stream ends without a verdict, through a server still coming back", async () => {
    stubFollow([
      new Error("connection refused"),
      new Response("Bad Gateway", { status: 502 }),
      ndjson([{ taskId: "t1", status: "The ClawBox web server restarted; following the same run again." }, { success: true, taskId: "t1" }]),
    ]);
    const lines: string[] = [];
    const outcome = await settle(readTaskStream(
      ndjson([{ taskId: "t1", status: "Downloading…" }]),
      (p) => { if (p.status) lines.push(p.status); },
    ));
    expect(outcome).toEqual({ ok: true });
    expect(follows).toEqual(Array(3).fill("/setup-api/background-jobs/tasks/follow?id=t1"));
    expect(lines.at(-1)).toContain("following the same run again");
  });

  it("follows again when the stream breaks mid-read, not only when it ends", async () => {
    // The line arrives; the next read breaks (error() would drop a queued line).
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"taskId":"t2","status":"Building…"}\n'));
        else controller.error(new TypeError("network error"));
      },
    });
    stubFollow([ndjson([{ error: "pip failed", taskId: "t2" }])]);
    const outcome = await settle(readTaskStream(new Response(broken), () => {}));
    expect(outcome).toEqual({ ok: false, error: "pip failed" });
  });

  it("gives up with the cut-short outcome once the box no longer knows the task", async () => {
    stubFollow([new Response(JSON.stringify({ code: "unknown_task" }), { status: 404 })]);
    const outcome = await settle(readTaskStream(ndjson([{ taskId: "t3", status: "…" }]), () => {}));
    expect(outcome).toEqual({ ok: false, lost: true });
    expect(follows).toHaveLength(1);
  });

  it("gives up after a while of no answer at all", async () => {
    stubFollow(Array.from({ length: 30 }, () => new Error("down")));
    const outcome = await settle(readTaskStream(ndjson([{ taskId: "t4" }]), () => {}));
    expect(outcome).toEqual({ ok: false, lost: true });
    expect(follows.length).toBeGreaterThan(5);
    expect(follows.length).toBeLessThan(30);
  });

  it("reads a stream that never named a task exactly as before: no follow", async () => {
    stubFollow([]);
    const outcome = await settle(readTaskStream(ndjson([{ status: "halfway" }]), () => {}));
    expect(outcome).toEqual({ ok: false, lost: true });
    expect(follows).toEqual([]);
  });

  it("stops following when its reader is aborted", async () => {
    stubFollow(Array.from({ length: 30 }, () => new Error("down")));
    const controller = new AbortController();
    const pending = readTaskStream(ndjson([{ taskId: "t5" }]), () => {}, undefined, controller.signal);
    await vi.advanceTimersByTimeAsync(1_500);
    controller.abort();
    const outcome = await settle(pending);
    expect(outcome.ok).toBe(false);
    expect(follows.length).toBeLessThanOrEqual(1);
  });
});
