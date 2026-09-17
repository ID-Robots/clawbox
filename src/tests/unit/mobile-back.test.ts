import { describe, expect, it, beforeEach } from "vitest";
import { registerMobileBack, runMobileBack, mobileBackDepth, resetMobileBackForTests } from "@/lib/mobile-back";

describe("mobile-back stack", () => {
  beforeEach(() => resetMobileBackForTests());

  it("returns false when nothing claimed Back", () => {
    expect(runMobileBack()).toBe(false);
    expect(mobileBackDepth()).toBe(0);
  });

  it("runs the most recently registered handler first", () => {
    const calls: string[] = [];
    const offA = registerMobileBack(() => calls.push("a"));
    const offB = registerMobileBack(() => calls.push("b"));
    expect(mobileBackDepth()).toBe(2);
    expect(runMobileBack()).toBe(true);
    expect(calls).toEqual(["b"]);
    offB();
    runMobileBack();
    expect(calls).toEqual(["b", "a"]);
    offA();
    expect(mobileBackDepth()).toBe(0);
  });

  it("unregistering twice is harmless", () => {
    const off = registerMobileBack(() => {});
    off(); off();
    expect(mobileBackDepth()).toBe(0);
  });
});
