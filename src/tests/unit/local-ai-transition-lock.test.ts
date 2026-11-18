import { describe, expect, it } from "vitest";
import { withLocalAiTransitionLock } from "@/lib/local-ai-transition-lock";

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
