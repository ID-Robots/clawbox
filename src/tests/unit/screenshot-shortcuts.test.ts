/**
 * The Screenshot app's desktop-wide keys and its hand-offs (TASK-1475): which
 * key event asks for which capture, and how a finished capture waits for the
 * app window that takes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type IncomingImage,
  offerImage,
  overlayMounted,
  registerOverlay,
  subscribeImages,
  takeImage,
} from "@/lib/screenshot/session";
import {
  type KeyLike,
  CAPTURE_SHORTCUTS,
  captureShortcut,
  captureShortcutKeys,
  createShortcutState,
  isCaptureShortcutKey,
} from "@/lib/screenshot/shortcuts";
import { screenshotEn } from "@/lib/screenshot-translations";

function key(type: "keydown" | "keyup", name: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { type, key: name, code: name, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, repeat: false, ...mods };
}

describe("capture shortcuts", () => {
  it("Print Screen captures the full screen, on release", () => {
    const state = createShortcutState();
    expect(captureShortcut(key("keydown", "PrintScreen"), state)).toBeNull();
    expect(captureShortcut(key("keyup", "PrintScreen"), state)).toBe("full");
  });

  it("works on Windows, which delivers only the keyup", () => {
    expect(captureShortcut(key("keyup", "PrintScreen"), createShortcutState())).toBe("full");
    expect(captureShortcut(key("keyup", "PrintScreen", { shiftKey: true }), createShortcutState())).toBe("region");
  });

  it("Shift + Print Screen captures a region, also when Shift is let go first", () => {
    const state = createShortcutState();
    captureShortcut(key("keydown", "PrintScreen", { shiftKey: true }), state);
    expect(captureShortcut(key("keyup", "PrintScreen"), state)).toBe("region");
    // The remembered Shift does not leak into the next press.
    captureShortcut(key("keydown", "PrintScreen"), state);
    expect(captureShortcut(key("keyup", "PrintScreen"), state)).toBe("full");
  });

  it("leaves the operating system's own Print Screen combinations alone", () => {
    for (const mods of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      const state = createShortcutState();
      expect(captureShortcut(key("keydown", "PrintScreen", mods), state)).toBeNull();
      expect(captureShortcut(key("keyup", "PrintScreen", mods), state)).toBeNull();
      expect(isCaptureShortcutKey(key("keyup", "PrintScreen", mods))).toBe(false);
    }
  });

  it("Alt + Shift + S captures a region, once per press", () => {
    const state = createShortcutState();
    const combo = { altKey: true, shiftKey: true };
    expect(captureShortcut({ ...key("keydown", "S", combo), code: "KeyS" }, state)).toBe("region");
    expect(captureShortcut({ ...key("keydown", "S", combo), code: "KeyS", repeat: true }, state)).toBeNull();
    expect(captureShortcut({ ...key("keyup", "S", combo), code: "KeyS" }, state)).toBeNull();
  });

  it("reads the physical key, because Option+Shift+S types a character on a Mac", () => {
    expect(captureShortcut({ ...key("keydown", "Í", { altKey: true, shiftKey: true }), code: "KeyS" }, createShortcutState())).toBe("region");
    expect(captureShortcut({ ...key("keydown", "s", { altKey: true, shiftKey: true }), code: undefined }, createShortcutState())).toBe("region");
  });

  it("ignores neighbouring combinations", () => {
    const state = createShortcutState();
    const s = (mods: Partial<KeyLike>) => ({ ...key("keydown", "s", mods), code: "KeyS" });
    expect(captureShortcut(s({}), state)).toBeNull();
    expect(captureShortcut(s({ altKey: true }), state)).toBeNull();
    expect(captureShortcut(s({ shiftKey: true }), state)).toBeNull();
    expect(captureShortcut(s({ altKey: true, shiftKey: true, ctrlKey: true }), state)).toBeNull();
    expect(captureShortcut(s({ altKey: true, shiftKey: true, metaKey: true }), state)).toBeNull();
    expect(captureShortcut({ ...key("keydown", "a", { altKey: true, shiftKey: true }), code: "KeyA" }, state)).toBeNull();
    expect(isCaptureShortcutKey(s({ altKey: true, shiftKey: true }))).toBe(true);
    expect(isCaptureShortcutKey(s({ shiftKey: true }))).toBe(false);
  });

  it("lists every shortcut for help, with a label that exists", () => {
    expect(CAPTURE_SHORTCUTS.map((s) => s.keys)).toEqual([["Print Screen"], ["Shift+Print Screen", "Alt+Shift+S"]]);
    for (const shortcut of CAPTURE_SHORTCUTS) expect(screenshotEn[shortcut.labelKey], shortcut.labelKey).toBeTruthy();
    expect(captureShortcutKeys("full")).toEqual(["Print Screen"]);
    expect(captureShortcutKeys("region")).toEqual(["Shift+Print Screen", "Alt+Shift+S"]);
  });
});

describe("capture hand-off", () => {
  const file = (name: string): IncomingImage => ({ kind: "file", relPath: `Pictures/${name}`, name });

  afterEach(() => {
    takeImage();
  });

  it("holds an image until the app window takes it, once", () => {
    expect(takeImage()).toBeNull();
    offerImage(file("a.png"));
    expect(takeImage()).toEqual(file("a.png"));
    expect(takeImage()).toBeNull();
  });

  it("keeps only the newest image nobody took", () => {
    offerImage(file("a.png"));
    offerImage(file("b.png"));
    expect(takeImage()).toEqual(file("b.png"));
  });

  it("tells subscribers, and only the first to ask gets the image", () => {
    const got: Array<IncomingImage | null> = [];
    const first = vi.fn(() => got.push(takeImage()));
    const second = vi.fn(() => got.push(takeImage()));
    const offFirst = subscribeImages(first);
    const offSecond = subscribeImages(second);
    offerImage(file("a.png"));
    expect(got).toEqual([file("a.png"), null]);

    offFirst();
    offerImage(file("b.png"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
  });

  it("knows whether the desktop's overlay is mounted", () => {
    expect(overlayMounted()).toBe(false);
    const release = registerOverlay();
    const releaseSecond = registerOverlay();
    expect(overlayMounted()).toBe(true);
    release();
    release();
    expect(overlayMounted()).toBe(true);
    releaseSecond();
    expect(overlayMounted()).toBe(false);
  });
});
