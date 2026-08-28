import { describe, expect, it } from "vitest";
import { createSerialLock } from "@/lib/serial-lock";

/**
 * The lock behind every read-modify-write of a settings file: tasks run one
 * after another, a failure releases the lock, and each caller gets its own
 * task's answer — not the previous one's.
 */

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("createSerialLock", () => {
  it("runs tasks one after another, in the order they were queued", async () => {
    const lock = createSerialLock();
    const order: string[] = [];
    const first = lock(async () => { order.push("a:start"); await tick(20); order.push("a:end"); return "a"; });
    const second = lock(async () => { order.push("b:start"); await tick(1); order.push("b:end"); return "b"; });
    expect(await Promise.all([first, second])).toEqual(["a", "b"]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("releases the lock when a task throws, and hands the throw to that caller only", async () => {
    const lock = createSerialLock();
    const failing = lock(async () => { throw new Error("disk full"); });
    const next = lock(async () => "still runs");
    await expect(failing).rejects.toThrow("disk full");
    expect(await next).toBe("still runs");
  });
});
