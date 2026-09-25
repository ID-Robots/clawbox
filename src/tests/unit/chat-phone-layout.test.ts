// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  CHAT_FULLSCREEN_STORAGE_KEY,
  CHAT_TEXT_SCALES,
  CHAT_TEXT_SCALE_STORAGE_KEY,
  DEFAULT_CHAT_FULLSCREEN,
  DEFAULT_CHAT_TEXT_SCALE,
  chatTextScalePercent,
  isLargestChatTextScale,
  isSmallestChatTextScale,
  parseChatFullscreen,
  parseChatTextScale,
  readChatFullscreen,
  readChatTextScale,
  resetChatPhoneLayoutMemory,
  stepChatTextScale,
  subscribeChatPhoneLayout,
  writeChatFullscreen,
  writeChatTextScale,
} from "@/lib/chat-phone-layout";
import { useChatFullscreen, useChatTextScale, usePhoneViewport } from "@/lib/use-chat-phone-layout";

/**
 * The phone chat's two view settings (TASK-1157): fullscreen chat, on until the
 * owner leaves it, and the conversation's text size in fixed steps — both kept
 * in this browser's storage so a reload comes back the way the owner left it.
 */

beforeEach(() => {
  window.localStorage.clear();
  resetChatPhoneLayoutMemory();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetChatPhoneLayoutMemory();
});

describe("reading a stored choice", () => {
  it("starts a phone in fullscreen chat, and only a stored '0' leaves it", () => {
    expect(DEFAULT_CHAT_FULLSCREEN).toBe(true);
    expect(parseChatFullscreen(null)).toBe(true);
    expect(parseChatFullscreen(undefined)).toBe(true);
    expect(parseChatFullscreen("1")).toBe(true);
    expect(parseChatFullscreen("0")).toBe(false);
    // Anything else is not a choice the control made.
    expect(parseChatFullscreen("false")).toBe(true);
    expect(parseChatFullscreen("")).toBe(true);
  });

  it("reads a text size only when it is one of the steps", () => {
    expect(parseChatTextScale(null)).toBe(DEFAULT_CHAT_TEXT_SCALE);
    expect(parseChatTextScale("")).toBe(DEFAULT_CHAT_TEXT_SCALE);
    expect(parseChatTextScale("1.3")).toBe(1.3);
    expect(parseChatTextScale("0.85")).toBe(0.85);
    // A hand-edited or retired value no control could reach or undo.
    expect(parseChatTextScale("2")).toBe(DEFAULT_CHAT_TEXT_SCALE);
    expect(parseChatTextScale("1.2")).toBe(DEFAULT_CHAT_TEXT_SCALE);
    expect(parseChatTextScale("big")).toBe(DEFAULT_CHAT_TEXT_SCALE);
  });
});

describe("stepping the text size", () => {
  it("walks the steps in order and stops at either end", () => {
    expect(CHAT_TEXT_SCALES).toEqual([0.85, 1, 1.15, 1.3, 1.5]);
    expect(stepChatTextScale(1, 1)).toBe(1.15);
    expect(stepChatTextScale(1.15, 1)).toBe(1.3);
    expect(stepChatTextScale(1.3, 1)).toBe(1.5);
    expect(stepChatTextScale(1.5, 1)).toBe(1.5);
    expect(stepChatTextScale(1, -1)).toBe(0.85);
    expect(stepChatTextScale(0.85, -1)).toBe(0.85);
  });

  it("names the ends and the percentage the control shows", () => {
    expect(isSmallestChatTextScale(0.85)).toBe(true);
    expect(isSmallestChatTextScale(1)).toBe(false);
    expect(isLargestChatTextScale(1.5)).toBe(true);
    expect(isLargestChatTextScale(1.3)).toBe(false);
    expect(CHAT_TEXT_SCALES.map(chatTextScalePercent)).toEqual([85, 100, 115, 130, 150]);
  });
});

describe("the store", () => {
  it("persists both choices in localStorage and reads them back", () => {
    expect(readChatFullscreen()).toBe(true);
    writeChatFullscreen(false);
    expect(window.localStorage.getItem(CHAT_FULLSCREEN_STORAGE_KEY)).toBe("0");
    expect(readChatFullscreen()).toBe(false);
    writeChatFullscreen(true);
    expect(window.localStorage.getItem(CHAT_FULLSCREEN_STORAGE_KEY)).toBe("1");

    expect(readChatTextScale()).toBe(1);
    writeChatTextScale(1.3);
    expect(window.localStorage.getItem(CHAT_TEXT_SCALE_STORAGE_KEY)).toBe("1.3");
    expect(readChatTextScale()).toBe(1.3);
  });

  it("tells every subscriber, and stops once unsubscribed", () => {
    const listener = vi.fn();
    const off = subscribeChatPhoneLayout(listener);
    writeChatFullscreen(false);
    writeChatTextScale(1.15);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    writeChatFullscreen(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("follows a change another tab made", () => {
    const listener = vi.fn();
    const off = subscribeChatPhoneLayout(listener);
    window.localStorage.setItem(CHAT_FULLSCREEN_STORAGE_KEY, "0");
    window.dispatchEvent(new StorageEvent("storage", { key: CHAT_FULLSCREEN_STORAGE_KEY }));
    // Someone else's key is not ours to redraw for.
    window.dispatchEvent(new StorageEvent("storage", { key: "clawbox-something-else" }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readChatFullscreen()).toBe(false);
    off();
  });

  it("keeps the choice for this page when the browser refuses to store it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    writeChatFullscreen(false);
    writeChatTextScale(1.5);
    expect(readChatFullscreen()).toBe(false);
    expect(readChatTextScale()).toBe(1.5);
  });
});

describe("the hooks", () => {
  it("share one fullscreen state and redraw on a change", () => {
    const a = renderHook(() => useChatFullscreen());
    const b = renderHook(() => useChatFullscreen());
    expect(a.result.current[0]).toBe(true);
    act(() => a.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(false);
    expect(window.localStorage.getItem(CHAT_FULLSCREEN_STORAGE_KEY)).toBe("0");
  });

  it("carry the text size across a remount, which is what a reload is", () => {
    const first = renderHook(() => useChatTextScale());
    act(() => first.result.current[1](1.15));
    first.unmount();
    const second = renderHook(() => useChatTextScale());
    expect(second.result.current[0]).toBe(1.15);
  });

  it("calls a viewport under the desktop breakpoint a phone", () => {
    const original = window.matchMedia;
    const seen: string[] = [];
    window.matchMedia = ((query: string) => {
      seen.push(query);
      return {
        matches: true, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      };
    }) as unknown as typeof window.matchMedia;
    try {
      const { result } = renderHook(() => usePhoneViewport());
      expect(result.current).toBe(true);
      // The desktop's own line: 767px is a phone, 768px is not.
      expect(seen.every(q => q === "(max-width: 767.98px)")).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });

  it("falls back to the window's width, and follows a resize, where there is no query list", () => {
    const original = window.matchMedia;
    const width = window.innerWidth;
    // A test double whose mock was reset answers undefined — which must not
    // take a whole chat surface down with it.
    window.matchMedia = (() => undefined) as unknown as typeof window.matchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      const { result } = renderHook(() => usePhoneViewport());
      expect(result.current).toBe(true);
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
      act(() => { window.dispatchEvent(new Event("resize")); });
      expect(result.current).toBe(false);
    } finally {
      window.matchMedia = original;
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });
});
