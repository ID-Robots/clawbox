import { describe, expect, it, beforeEach } from "vitest";
import { CHAT_MOBILE_BACK, registerMobileBack, runMobileBack, mobileBackDepth, resetMobileBackForTests } from "@/lib/mobile-back";

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

  // TASK-2778: page.tsx closes the phone chat on Back, unless the chat's own
  // menu or sheet is open — and an app's level behind the chat is never run in
  // its place.
  it("runs an owner's Back only when that owner holds the deepest level", () => {
    const calls: string[] = [];
    const offApp = registerMobileBack(() => calls.push("settings"));
    expect(runMobileBack(CHAT_MOBILE_BACK)).toBe(false);
    expect(calls).toEqual([]);

    const offChat = registerMobileBack(() => calls.push("chat-menu"), CHAT_MOBILE_BACK);
    expect(mobileBackDepth()).toBe(2);
    expect(runMobileBack(CHAT_MOBILE_BACK)).toBe(true);
    expect(calls).toEqual(["chat-menu"]);
    offChat();

    expect(runMobileBack(CHAT_MOBILE_BACK)).toBe(false);
    // Without an owner, the deepest level runs whoever registered it.
    expect(runMobileBack()).toBe(true);
    expect(calls).toEqual(["chat-menu", "settings"]);
    offApp();
  });
});
