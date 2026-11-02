/**
 * The provider-change lock (src/lib/provider-change-lock.ts): one change to
 * the default or to a sign-in at a time, box-wide, and a failed change never
 * holds up the next.
 */
import { describe, expect, it } from "vitest";
import { withProviderChangeLock } from "@/lib/provider-change-lock";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("withProviderChangeLock", () => {
  it("runs changes one at a time, in the order they were asked for", async () => {
    const order: string[] = [];
    const first = withProviderChangeLock(async () => {
      order.push("sign-out starts");
      await tick();
      order.push("sign-out removed the key");
      return "signed out";
    });
    const second = withProviderChangeLock(async () => {
      order.push("default write");
      return "default set";
    });
    expect(await Promise.all([first, second])).toEqual(["signed out", "default set"]);
    expect(order).toEqual(["sign-out starts", "sign-out removed the key", "default write"]);
  });

  it("hands each caller its own error, and goes on with the next change", async () => {
    const failing = withProviderChangeLock(async () => {
      throw new Error("the CLI timed out");
    });
    const next = withProviderChangeLock(async () => "went ahead");
    await expect(failing).rejects.toThrow("the CLI timed out");
    expect(await next).toBe("went ahead");
  });
});
