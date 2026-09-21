/**
 * The Terminal's own keys (src/lib/terminal-keys.ts): the tab and clipboard
 * shortcuts it answers, and — the half that matters more — every key a shell
 * program needs still reaching the shell.
 */
import { describe, expect, it } from "vitest";
import { shortcutFallbackLabel, shortcutLabel, terminalShortcut, type ShortcutKeyEvent } from "@/lib/terminal-keys";

const key = (k: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("terminalShortcut", () => {
  it("answers the Ctrl+Shift tab and clipboard keys on Linux and Windows", () => {
    expect(terminalShortcut(key("T", { ctrlKey: true, shiftKey: true }), false)).toBe("newTab");
    expect(terminalShortcut(key("W", { ctrlKey: true, shiftKey: true }), false)).toBe("closeTab");
    expect(terminalShortcut(key("C", { ctrlKey: true, shiftKey: true }), false)).toBe("copy");
    expect(terminalShortcut(key("V", { ctrlKey: true, shiftKey: true }), false)).toBe("paste");
    expect(terminalShortcut(key("Tab", { ctrlKey: true }), false)).toBe("nextTab");
    expect(terminalShortcut(key("Tab", { ctrlKey: true, shiftKey: true }), false)).toBe("prevTab");
  });

  it("answers the Alt+Shift twins a browser tab never keeps for itself", () => {
    expect(terminalShortcut(key("T", { altKey: true, shiftKey: true }), false)).toBe("newTab");
    expect(terminalShortcut(key("W", { altKey: true, shiftKey: true }), false)).toBe("closeTab");
    expect(terminalShortcut(key("PageDown", { altKey: true, shiftKey: true }), false)).toBe("nextTab");
    expect(terminalShortcut(key("PageUp", { altKey: true, shiftKey: true }), false)).toBe("prevTab");
  });

  it("leaves every plain Ctrl key to the shell", () => {
    // SIGINT, EOF, readline's transpose and delete-word, nano's next page,
    // vim's block select, suspend, clear, reverse search.
    for (const letter of ["c", "d", "t", "w", "v", "z", "l", "r", "a", "e", "u", "k"]) {
      expect(terminalShortcut(key(letter, { ctrlKey: true }), false), `Ctrl+${letter}`).toBeNull();
    }
    // Plain typing, Shift+letters, Alt as Meta for readline, arrows.
    expect(terminalShortcut(key("t"), false)).toBeNull();
    expect(terminalShortcut(key("T", { shiftKey: true }), false)).toBeNull();
    expect(terminalShortcut(key("b", { altKey: true }), false)).toBeNull();
    expect(terminalShortcut(key("Tab"), false)).toBeNull();
    expect(terminalShortcut(key("Tab", { shiftKey: true }), false)).toBeNull();
    expect(terminalShortcut(key("PageUp", { shiftKey: true }), false)).toBeNull();
    // Ctrl+Alt+Shift is nobody's shortcut here.
    expect(terminalShortcut(key("T", { ctrlKey: true, altKey: true, shiftKey: true }), false)).toBeNull();
  });

  it("finds the letter by its physical key on a non-Latin layout", () => {
    // Ctrl+Shift+T on a Bulgarian layout reports the Cyrillic letter.
    expect(terminalShortcut({ ...key("Т", { ctrlKey: true, shiftKey: true }), code: "KeyT" }, false)).toBe("newTab");
    expect(terminalShortcut({ ...key("С", { ctrlKey: true, shiftKey: true }), code: "KeyC" }, false)).toBe("copy");
  });

  it("takes Cmd+C and Cmd+V on a Mac only", () => {
    expect(terminalShortcut(key("c", { metaKey: true }), true)).toBe("copy");
    expect(terminalShortcut(key("v", { metaKey: true }), true)).toBe("paste");
    expect(terminalShortcut(key("c", { metaKey: true }), false)).toBeNull();
    // Ctrl+C on a Mac is still SIGINT.
    expect(terminalShortcut(key("c", { ctrlKey: true }), true)).toBeNull();
  });
});

describe("shortcut labels", () => {
  it("writes each shortcut the way the platform does", () => {
    expect(shortcutLabel("copy", false)).toBe("Ctrl+Shift+C");
    expect(shortcutLabel("copy", true)).toBe("⌘C");
    expect(shortcutLabel("paste", true)).toBe("⌘V");
    expect(shortcutLabel("newTab", true)).toBe("Ctrl+Shift+T");
    expect(shortcutLabel("prevTab", false)).toBe("Ctrl+Shift+Tab");
    expect(shortcutFallbackLabel("nextTab")).toBe("Alt+Shift+PageDown");
  });
});
