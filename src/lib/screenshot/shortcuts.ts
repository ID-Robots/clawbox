// The Screenshot app's desktop-wide keys, as a pure decision: given a key
// event, which capture (if any) it asks for. The overlay feeds it real events;
// the tests feed it plain objects.

export type CaptureMode = "full" | "region";

export interface KeyLike {
  type: string;
  key: string;
  code?: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

/** What has to be remembered between a key going down and coming back up. */
export interface ShortcutState {
  /** Shift was held when Print Screen went down — it is often released first. */
  printShift: boolean;
}

export function createShortcutState(): ShortcutState {
  return { printShift: false };
}

function isPrintScreen(event: KeyLike): boolean {
  return event.key === "PrintScreen" || event.code === "PrintScreen";
}

/**
 *   Print Screen         → the whole screen
 *   Shift + Print Screen → a region
 *   Alt + Shift + S      → a region, for where Print Screen never reaches the
 *                          page (the OS or the browser keeps it, or the
 *                          keyboard has no such key)
 *
 * Print Screen is acted on when it is RELEASED: Windows delivers no keydown
 * for it at all, only the keyup, and every other platform delivers both.
 */
export function captureShortcut(event: KeyLike, state: ShortcutState): CaptureMode | null {
  if (isPrintScreen(event)) {
    // Alt / Ctrl / Meta + Print Screen are the operating system's own captures.
    if (event.altKey || event.ctrlKey || event.metaKey) return null;
    if (event.type === "keydown") {
      state.printShift = event.shiftKey;
      return null;
    }
    if (event.type !== "keyup") return null;
    const mode: CaptureMode = event.shiftKey || state.printShift ? "region" : "full";
    state.printShift = false;
    return mode;
  }
  if (
    event.type === "keydown" &&
    !event.repeat &&
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    // `code`, not `key`: with Alt held, macOS reports the character the combination types.
    (event.code === "KeyS" || (!event.code && event.key.toLowerCase() === "s"))
  ) {
    return "region";
  }
  return null;
}

/** Whether the event belongs to a capture shortcut at all (so its default can be stopped). */
export function isCaptureShortcutKey(event: KeyLike): boolean {
  if (isPrintScreen(event)) return !(event.altKey || event.ctrlKey || event.metaKey);
  return (
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.code === "KeyS" || (!event.code && event.key.toLowerCase() === "s"))
  );
}

/** The shortcuts as shown in help: a translation key for what each does, and every key that does it. */
export const CAPTURE_SHORTCUTS: ReadonlyArray<{ id: CaptureMode; labelKey: string; keys: readonly string[] }> = [
  { id: "full", labelKey: "screenshot.shortcutFull", keys: ["Print Screen"] },
  { id: "region", labelKey: "screenshot.shortcutRegion", keys: ["Shift+Print Screen", "Alt+Shift+S"] },
];

/** The keys that take a capture of this kind, for a help list that words the action itself. */
export function captureShortcutKeys(mode: CaptureMode): string[] {
  return [...(CAPTURE_SHORTCUTS.find((shortcut) => shortcut.id === mode)?.keys ?? [])];
}
