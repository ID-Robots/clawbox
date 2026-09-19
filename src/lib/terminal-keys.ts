/**
 * The Terminal's own keyboard shortcuts, as one pure function, so the xterm
 * key handler and the tab strip around it cannot disagree about a key.
 *
 * Nothing here takes a key a shell program needs:
 * - Ctrl+Shift+letter is the terminal convention (GNOME Terminal, Konsole,
 *   Windows Terminal) precisely because the shell has no use for the Shift:
 *   Ctrl+C stays SIGINT, Ctrl+V stays nano's next page and vim's block select,
 *   Ctrl+T and Ctrl+W stay readline's transpose and delete-word.
 * - Ctrl+Tab has no meaning to a shell or a TUI.
 * - Alt+Shift+T/W and Alt+Shift+PageUp/PageDown are the same tab actions under
 *   keys no browser binds. In an ordinary browser tab Chrome keeps Ctrl+Shift+T,
 *   Ctrl+Shift+W and Ctrl+Tab for itself and the page never sees them; an app
 *   window (the box's own screen, an installed PWA) hands them over. The Alt
 *   pair is what works everywhere.
 * - Cmd+C and Cmd+V on a Mac, where Cmd is never the shell's.
 */

export type TerminalShortcut = "copy" | "paste" | "newTab" | "closeTab" | "nextTab" | "prevTab";

export type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"> & { code?: string };

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * The letter a key names, on any layout: `key` when it is a Latin letter, else
 * the physical key — Ctrl+Shift+T on a Bulgarian layout reports "Т" (Cyrillic)
 * as its key and `KeyT` as its code, and Alt+Shift+T on a Mac reports "ˇ".
 */
function letterOf(ev: ShortcutKeyEvent): string {
  if (/^[a-z]$/i.test(ev.key)) return ev.key.toLowerCase();
  if (ev.code && /^Key[A-Z]$/.test(ev.code)) return ev.code.slice(3).toLowerCase();
  return "";
}

export function terminalShortcut(ev: ShortcutKeyEvent, mac: boolean = isMacPlatform()): TerminalShortcut | null {
  const letter = letterOf(ev);
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
    if (letter === "c") return "copy";
    if (letter === "v") return "paste";
    if (letter === "t") return "newTab";
    if (letter === "w") return "closeTab";
    if (ev.key === "Tab") return "prevTab";
    return null;
  }
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
    return ev.key === "Tab" ? "nextTab" : null;
  }
  if (ev.altKey && ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
    if (letter === "t") return "newTab";
    if (letter === "w") return "closeTab";
    if (ev.key === "PageDown") return "nextTab";
    if (ev.key === "PageUp") return "prevTab";
    return null;
  }
  if (mac && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
    if (letter === "c") return "copy";
    if (letter === "v") return "paste";
  }
  return null;
}

/** How a shortcut is written on this platform, for tooltips and the menu. */
export function shortcutLabel(action: TerminalShortcut, mac: boolean = isMacPlatform()): string {
  switch (action) {
    case "copy": return mac ? "⌘C" : "Ctrl+Shift+C";
    case "paste": return mac ? "⌘V" : "Ctrl+Shift+V";
    case "newTab": return "Ctrl+Shift+T";
    case "closeTab": return "Ctrl+Shift+W";
    case "nextTab": return "Ctrl+Tab";
    case "prevTab": return "Ctrl+Shift+Tab";
  }
}

/** The browser-proof alternative for a tab shortcut. */
export function shortcutFallbackLabel(action: "newTab" | "closeTab" | "nextTab" | "prevTab"): string {
  switch (action) {
    case "newTab": return "Alt+Shift+T";
    case "closeTab": return "Alt+Shift+W";
    case "nextTab": return "Alt+Shift+PageDown";
    case "prevTab": return "Alt+Shift+PageUp";
  }
}
