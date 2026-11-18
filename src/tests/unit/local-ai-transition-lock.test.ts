import { describe, expect, it } from "vitest";
import { localAiTransitionMark, onLocalAiTransitionStart, withLocalAiTransitionLock } from "@/lib/local-ai-transition-lock";

/**
 * One Local AI transition at a time (TASK-2376): the external engine's save
 * or remove and the Local-only switch each check the other's state, so the
 * second one must start only after the first has finished — in either order —
 * and a failure must not stop the next.
 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("withLocalAiTransitionLock", () => {
  it.each([
    ["an engine save, then a Local-only switch", "save", "local-only"],
    ["a Local-only switch, then an engine save", "local-only", "save"],
  ])("runs %s one after the other", async (_label, first, second) => {
    const order: string[] = [];
    const gate = deferred();
    const a = withLocalAiTransitionLock(async () => {
      order.push(`${first}:start`);
      await gate.promise;
      order.push(`${first}:end`);
    });
    const b = withLocalAiTransitionLock(async () => {
      order.push(`${second}:start`);
      order.push(`${second}:end`);
    });
    await Promise.resolve();
    expect(order).toEqual([`${first}:start`]);
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual([`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`]);
  });

  it("a failed transition does not stop the next one", async () => {
    const failed = withLocalAiTransitionLock(async () => { throw new Error("boom"); });
    await expect(failed).rejects.toThrow("boom");
    await expect(withLocalAiTransitionLock(async () => "next")).resolves.toBe("next");
  });
});

describe("localAiTransitionMark", () => {
  it("says a transition is running while one is, and moves its stamp when one starts and when it ends — a failed one included", async () => {
    const idle = localAiTransitionMark();
    expect(idle.running).toBe(false);
    const gate = deferred();
    let during: ReturnType<typeof localAiTransitionMark> | null = null;
    const run = withLocalAiTransitionLock(async () => {
      during = localAiTransitionMark();
      await gate.promise;
      throw new Error("save failed");
    });
    await Promise.resolve();
    expect(during).not.toBeNull();
    expect(during!.running).toBe(true);
    expect(during!.generation).not.toBe(idle.generation);
    gate.resolve();
    await expect(run).rejects.toThrow("save failed");
    const after = localAiTransitionMark();
    expect(after.running).toBe(false);
    expect(after.generation).not.toBe(during!.generation);
    expect(after.generation).not.toBe(idle.generation);
  });
});

describe("onLocalAiTransitionStart", () => {
  it("tells a listener when a transition starts, until it stops listening", async () => {
    const heard: string[] = [];
    const stop = onLocalAiTransitionStart(() => heard.push("start"));
    await withLocalAiTransitionLock(async () => {
      heard.push("inside");
    });
    expect(heard).toEqual(["start", "inside"]);
    stop();
    await withLocalAiTransitionLock(async () => {});
    expect(heard).toEqual(["start", "inside"]);
  });

  it("a listener that throws does not stop the transition", async () => {
    const stop = onLocalAiTransitionStart(() => {
      throw new Error("listener broke");
    });
    await expect(withLocalAiTransitionLock(async () => "ran")).resolves.toBe("ran");
    stop();
  });
});
