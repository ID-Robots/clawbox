/**
 * The Screenshot app's desktop-wide keys and its hand-offs (TASK-1475): which
 * key event asks for which capture, and how a finished capture waits for the
 * app window that takes it. Ctrl+Shift+S and the typing check are TASK-1491.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type IncomingImage,
  desktopOverlayMounted,
  offerImage,
  overlayMounted,
  primaryOverlayId,
  quickCaptureRequest,
  registerOverlay,
  subscribeImages,
  subscribeOverlays,
  takeImage,
} from "@/lib/screenshot/session";
import {
  type KeyLike,
  CAPTURE_SHORTCUTS,
  captureShortcut,
  captureShortcutKeys,
  type TargetLike,
  TERMINAL_SELECTOR,
  createShortcutState,
  isCaptureShortcutKey,
  isTypingTarget,
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

  it("Ctrl + Shift + S captures the full screen, once per press — for where Print Screen never arrives", () => {
    const state = createShortcutState();
    const combo = { ctrlKey: true, shiftKey: true };
    expect(captureShortcut({ ...key("keydown", "S", combo), code: "KeyS" }, state)).toBe("full");
    expect(captureShortcut({ ...key("keydown", "S", combo), code: "KeyS", repeat: true }, state)).toBeNull();
    expect(captureShortcut({ ...key("keyup", "S", combo), code: "KeyS" }, state)).toBeNull();
    expect(isCaptureShortcutKey({ ...key("keydown", "S", combo), code: "KeyS" })).toBe(true);
    // A Cyrillic layout reports its own letter; the physical key is still S.
    expect(captureShortcut({ ...key("keydown", "Ы", combo), code: "KeyS" }, createShortcutState())).toBe("full");
  });

  it("ignores neighbouring combinations", () => {
    const state = createShortcutState();
    const s = (mods: Partial<KeyLike>) => ({ ...key("keydown", "s", mods), code: "KeyS" });
    expect(captureShortcut(s({}), state)).toBeNull();
    expect(captureShortcut(s({ altKey: true }), state)).toBeNull();
    expect(captureShortcut(s({ shiftKey: true }), state)).toBeNull();
    // Plain Ctrl+S is an editor's Save, never a capture.
    expect(captureShortcut(s({ ctrlKey: true }), state)).toBeNull();
    expect(captureShortcut(s({ altKey: true, shiftKey: true, ctrlKey: true }), state)).toBeNull();
    expect(captureShortcut(s({ altKey: true, shiftKey: true, metaKey: true }), state)).toBeNull();
    expect(captureShortcut(s({ ctrlKey: true, shiftKey: true, metaKey: true }), state)).toBeNull();
    expect(captureShortcut(s({ metaKey: true, shiftKey: true }), state)).toBeNull();
    expect(captureShortcut({ ...key("keydown", "a", { altKey: true, shiftKey: true }), code: "KeyA" }, state)).toBeNull();
    expect(captureShortcut({ ...key("keydown", "a", { ctrlKey: true, shiftKey: true }), code: "KeyA" }, state)).toBeNull();
    expect(isCaptureShortcutKey(s({ altKey: true, shiftKey: true }))).toBe(true);
    expect(isCaptureShortcutKey(s({ shiftKey: true }))).toBe(false);
    expect(isCaptureShortcutKey(s({ ctrlKey: true }))).toBe(false);
    expect(isCaptureShortcutKey(s({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it("does not collide with the Terminal's own Ctrl+Shift and Alt+Shift keys", () => {
    const state = createShortcutState();
    for (const letter of ["C", "V", "T", "W"]) {
      for (const mods of [{ ctrlKey: true, shiftKey: true }, { altKey: true, shiftKey: true }]) {
        const event = { ...key("keydown", letter, mods), code: `Key${letter}` };
        expect(captureShortcut(event, state), `${JSON.stringify(mods)} ${letter}`).toBeNull();
        expect(isCaptureShortcutKey(event)).toBe(false);
      }
    }
  });

  it("lists every shortcut for help, with a label that exists", () => {
    expect(CAPTURE_SHORTCUTS.map((s) => s.keys)).toEqual([["Print Screen", "Ctrl+Shift+S"], ["Shift+Print Screen", "Alt+Shift+S"]]);
    for (const shortcut of CAPTURE_SHORTCUTS) expect(screenshotEn[shortcut.labelKey], shortcut.labelKey).toBeTruthy();
    expect(captureShortcutKeys("full")).toEqual(["Print Screen", "Ctrl+Shift+S"]);
    expect(captureShortcutKeys("region")).toEqual(["Shift+Print Screen", "Alt+Shift+S"]);
  });

  it("asks the desktop's quick capture: no delay, the built-in renderer, nothing hidden", () => {
    expect(quickCaptureRequest("full")).toEqual({ mode: "full", delay: 0, engine: "dom", hide: null });
    expect(quickCaptureRequest("region")).toEqual({ mode: "region", delay: 0, engine: "dom", hide: null });
  });
});

describe("typing: where the capture keys stand aside", () => {
  /** An element as the check sees it; `inside` lists the selectors an ancestor would match. */
  function el(tagName: string, extra: Partial<TargetLike> = {}, inside: string[] = []): TargetLike {
    return {
      tagName,
      closest: (selectors: string) => (selectors.split(",").some((s) => inside.includes(s.trim())) ? {} : null),
      ...extra,
    };
  }

  it("counts text fields, text areas and editable elements as typing", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    for (const type of ["text", "search", "email", "url", "password", "number", "tel", "date"]) {
      expect(isTypingTarget(el("INPUT", { type })), type).toBe(true);
    }
    expect(isTypingTarget(el("textarea"))).toBe(true);
    expect(isTypingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
    // A DOM that does not answer isContentEditable is asked by attribute, the element's or an ancestor's.
    expect(isTypingTarget(el("SPAN", {}, ['[contenteditable="true"]']))).toBe(true);
    expect(isTypingTarget(el("P", {}, ['[contenteditable=""]']))).toBe(true);
  });

  it("counts a terminal as typing — xterm, the Terminal app around it and its window", () => {
    const selectors = TERMINAL_SELECTOR.split(",").map((s) => s.trim());
    expect(selectors).toContain(".xterm");
    expect(selectors).toContain('[data-testid="chrome-window-terminal"]');
    for (const selector of selectors) expect(isTypingTarget(el("DIV", { isContentEditable: false }, [selector])), selector).toBe(true);
    // xterm's input is itself a text area.
    expect(isTypingTarget(el("TEXTAREA", {}, [".xterm"]))).toBe(true);
  });

  it("does not count controls that take no text, or the desktop itself", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "range", "color", "file"]) {
      expect(isTypingTarget(el("INPUT", { type })), type).toBe(false);
    }
    expect(isTypingTarget(el("BUTTON", { isContentEditable: false }))).toBe(false);
    expect(isTypingTarget(el("BODY", { isContentEditable: false }))).toBe(false);
    expect(isTypingTarget(el("CANVAS", { isContentEditable: false }))).toBe(false);
    // An element a browser says is not editable stays so, whatever an attribute selector would say.
    expect(isTypingTarget(el("DIV", { isContentEditable: false }, ['[contenteditable="true"]']))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget(windowLike())).toBe(false);
  });

  /** The window: an event target with no tag and no `closest`. */
  function windowLike(): unknown {
    return { addEventListener: () => {} };
  }
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

  it("knows whether an overlay is mounted, and releases each one once", () => {
    expect(overlayMounted()).toBe(false);
    const first = registerOverlay();
    const second = registerOverlay();
    expect(overlayMounted()).toBe(true);
    first.release();
    first.release();
    expect(overlayMounted()).toBe(true);
    second.release();
    expect(overlayMounted()).toBe(false);
    expect(primaryOverlayId()).toBeNull();
  });
});

describe("overlays: several mounted, one in charge", () => {
  it("tells a window's own overlay from the desktop's", () => {
    const own = registerOverlay("app");
    expect(overlayMounted()).toBe(true);
    expect(desktopOverlayMounted()).toBe(false);
    const desktop = registerOverlay("desktop");
    expect(desktopOverlayMounted()).toBe(true);
    desktop.release();
    expect(desktopOverlayMounted()).toBe(false);
    own.release();
  });

  it("puts the desktop's overlay in charge the moment it appears", () => {
    // A restored Screenshot window drew first and brought its own overlay ...
    const own = registerOverlay("app");
    expect(primaryOverlayId()).toBe(own.id);
    // ... then the desktop learnt its user is the owner and mounted the real one.
    const desktop = registerOverlay("desktop");
    expect(primaryOverlayId()).toBe(desktop.id);
    // The window lets its own go; the desktop's stays in charge.
    own.release();
    expect(primaryOverlayId()).toBe(desktop.id);
    desktop.release();
    expect(primaryOverlayId()).toBeNull();
  });

  it("never has two in charge: of two windows' own overlays only the first acts", () => {
    const a = registerOverlay("app");
    const b = registerOverlay("app");
    expect(primaryOverlayId()).toBe(a.id);
    expect(primaryOverlayId()).not.toBe(b.id);
    // When the first goes, the second takes over rather than leaving nobody.
    a.release();
    expect(primaryOverlayId()).toBe(b.id);
    b.release();
  });

  it("gives every registration its own id", () => {
    const a = registerOverlay();
    const b = registerOverlay();
    expect(a.id).not.toBe(b.id);
    a.release();
    b.release();
  });

  it("announces every registration and release, so a window can follow them", () => {
    const seen: Array<{ any: boolean; desktop: boolean; primary: number | null }> = [];
    const off = subscribeOverlays(() => seen.push({ any: overlayMounted(), desktop: desktopOverlayMounted(), primary: primaryOverlayId() }));
    const own = registerOverlay("app");
    const desktop = registerOverlay("desktop");
    own.release();
    own.release();
    desktop.release();
    expect(seen).toEqual([
      { any: true, desktop: false, primary: own.id },
      { any: true, desktop: true, primary: desktop.id },
      { any: true, desktop: true, primary: desktop.id },
      { any: false, desktop: false, primary: null },
    ]);
    off();
    registerOverlay().release();
    expect(seen).toHaveLength(4);
  });
});
