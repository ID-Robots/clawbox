import { describe, expect, it } from "vitest";
import {
  PHONE_MAX_WIDTH,
  isPhoneViewport,
  readChatFirstEnvironment,
  shouldAutoFocusChatInput,
  shouldOpenChatFirst,
} from "@/lib/mobile-chat-first";

/**
 * Where the page lands: the chat on a phone and in the installed home-screen
 * app on a touch device, the desktop everywhere else — a big screen with a
 * mouse, installed or not, must not change.
 */
describe("shouldOpenChatFirst", () => {
  it("opens the chat on a phone-sized viewport, whatever else is true", () => {
    expect(shouldOpenChatFirst({ width: 390, standalone: false, coarsePointer: true })).toBe(true);
    expect(shouldOpenChatFirst({ width: 390, standalone: false, coarsePointer: false })).toBe(true);
    // A phone in landscape is still a phone.
    expect(shouldOpenChatFirst({ width: 740, standalone: false, coarsePointer: true })).toBe(true);
  });

  it("keeps the desktop on a big screen in a browser", () => {
    expect(shouldOpenChatFirst({ width: 1440, standalone: false, coarsePointer: false })).toBe(false);
    // A touch laptop or tablet in the browser tab keeps its desktop.
    expect(shouldOpenChatFirst({ width: 1024, standalone: false, coarsePointer: true })).toBe(false);
  });

  it("opens the chat when launched from the home screen on a touch device wider than a phone", () => {
    expect(shouldOpenChatFirst({ width: 1024, standalone: true, coarsePointer: true })).toBe(true);
  });

  it("keeps the desktop for a desktop browser's installed app (fine pointer)", () => {
    expect(shouldOpenChatFirst({ width: 1440, standalone: true, coarsePointer: false })).toBe(false);
  });

  it("uses the same breakpoint as the desktop's phone layout", () => {
    expect(PHONE_MAX_WIDTH).toBe(768);
    expect(isPhoneViewport(767)).toBe(true);
    expect(isPhoneViewport(768)).toBe(false);
  });

  it("does not call a missing or nonsense width a phone", () => {
    expect(isPhoneViewport(0)).toBe(false);
    expect(isPhoneViewport(Number.NaN)).toBe(false);
    expect(shouldOpenChatFirst({ width: 0, standalone: false, coarsePointer: false })).toBe(false);
  });
});

/**
 * Whether opening the chat may focus its message box by itself: a focused
 * input on a phone or a touch screen is a soft keyboard nobody asked for, and
 * the app jumped up under it (TASK-1317). A big screen with a mouse keeps it.
 */
describe("shouldAutoFocusChatInput", () => {
  it("focuses on a big screen with a mouse", () => {
    expect(shouldAutoFocusChatInput({ width: 1440, coarsePointer: false })).toBe(true);
    expect(shouldAutoFocusChatInput({ width: PHONE_MAX_WIDTH, coarsePointer: false })).toBe(true);
  });

  it("leaves the keyboard closed on a phone-sized viewport, whatever the pointer", () => {
    expect(shouldAutoFocusChatInput({ width: 390, coarsePointer: true })).toBe(false);
    expect(shouldAutoFocusChatInput({ width: 390, coarsePointer: false })).toBe(false);
    expect(shouldAutoFocusChatInput({ width: PHONE_MAX_WIDTH - 1, coarsePointer: false })).toBe(false);
  });

  it("leaves it closed on a touch screen wider than a phone", () => {
    expect(shouldAutoFocusChatInput({ width: 1024, coarsePointer: true })).toBe(false);
  });

  it("treats a missing width as no phone, so a mouse still gets the caret", () => {
    expect(shouldAutoFocusChatInput({ width: 0, coarsePointer: false })).toBe(true);
    expect(shouldAutoFocusChatInput({ width: Number.NaN, coarsePointer: true })).toBe(false);
  });

  it("reads the live window through readChatFirstEnvironment", () => {
    const win = (width: number, coarse: boolean) => ({
      innerWidth: width,
      matchMedia: (query: string) => ({ matches: coarse && query === "(pointer: coarse)" }),
    });
    expect(shouldAutoFocusChatInput(readChatFirstEnvironment(win(1440, false)))).toBe(true);
    expect(shouldAutoFocusChatInput(readChatFirstEnvironment(win(390, true)))).toBe(false);
    expect(shouldAutoFocusChatInput(readChatFirstEnvironment(win(1024, true)))).toBe(false);
  });
});

describe("readChatFirstEnvironment", () => {
  const fakeWindow = (width: number, matching: string[], extra: Record<string, unknown> = {}) => ({
    innerWidth: width,
    matchMedia: (query: string) => ({ matches: matching.includes(query) }),
    ...extra,
  });

  it("reads a home-screen launch from any installed display mode", () => {
    for (const mode of ["standalone", "fullscreen", "minimal-ui"]) {
      const env = readChatFirstEnvironment(fakeWindow(1024, [`(display-mode: ${mode})`, "(pointer: coarse)"]));
      expect(env).toEqual({ width: 1024, standalone: true, coarsePointer: true });
    }
  });

  it("reads a browser tab as not installed", () => {
    expect(readChatFirstEnvironment(fakeWindow(1440, ["(display-mode: browser)"]))).toEqual({
      width: 1440,
      standalone: false,
      coarsePointer: false,
    });
  });

  it("recognises iOS Safari's home-screen flag", () => {
    const env = readChatFirstEnvironment(fakeWindow(1024, [], { navigator: { standalone: true } }));
    expect(env.standalone).toBe(true);
  });

  it("survives a browser with no matchMedia, or one that throws", () => {
    expect(readChatFirstEnvironment({ innerWidth: 390 })).toEqual({ width: 390, standalone: false, coarsePointer: false });
    const throwing = { innerWidth: 390, matchMedia: () => { throw new Error("nope"); } };
    expect(readChatFirstEnvironment(throwing)).toEqual({ width: 390, standalone: false, coarsePointer: false });
  });
});
