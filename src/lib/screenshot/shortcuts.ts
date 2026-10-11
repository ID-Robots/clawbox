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

// `code`, not `key`: with Alt held, macOS reports the character the combination types.
function isKeyS(event: KeyLike): boolean {
  return event.code === "KeyS" || (!event.code && event.key.toLowerCase() === "s");
}

/** Ctrl + Shift + S or Alt + Shift + S — the letter combinations, and which of the two. */
function letterCombo(event: KeyLike): CaptureMode | null {
  if (!isKeyS(event) || !event.shiftKey || event.metaKey) return null;
  if (event.ctrlKey && !event.altKey) return "full";
  if (event.altKey && !event.ctrlKey) return "region";
  return null;
}

/**
 *   Print Screen         → the whole screen
 *   Ctrl + Shift + S     → the whole screen, for where Print Screen never
 *                          reaches the page (the OS or the browser keeps it,
 *                          or the keyboard has no such key)
 *   Shift + Print Screen → a region
 *   Alt + Shift + S      → a region, likewise
 *
 * Print Screen is acted on when it is RELEASED: Windows delivers no keydown
 * for it at all, only the keyup, and every other platform delivers both. A
 * letter combination acts on its first keydown, so holding it takes one
 * picture, not one per repeat.
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
  if (event.type === "keydown" && !event.repeat) return letterCombo(event);
  return null;
}

/** Whether the event belongs to a capture shortcut at all (so its default can be stopped). */
export function isCaptureShortcutKey(event: KeyLike): boolean {
  if (isPrintScreen(event)) return !(event.altKey || event.ctrlKey || event.metaKey);
  return letterCombo(event) !== null;
}

/** The parts of an element the typing check reads: a real one, or a plain object in a test. */
export interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selectors: string) => unknown;
}

/** Inputs that take no text: a key pressed on one of them is not typing. */
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/**
 * A terminal: xterm's own element (in the Terminal app or any app that embeds
 * one), the Terminal app around it — its tab strip and its menus — and the
 * desktop window that holds it.
 */
export const TERMINAL_SELECTOR =
  '.xterm, [data-terminal-tone], [data-terminal-theme], [data-terminal-menu], [data-terminal-tab-menu], [data-testid="chrome-window-terminal"]';

const EDITABLE_SELECTOR = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * Whether a key event aimed here is the owner TYPING — into a text field, a
 * text area, an editable element or a terminal — where the capture keys are
 * left to what has the focus: Ctrl+Shift+S means something to an editor and
 * to a program in a shell, and a capture that fires in the middle of a
 * sentence is not one anybody asked for.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as TargetLike;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has(String(el.type ?? "text").toLowerCase());
  const closest = typeof el.closest === "function" ? (selectors: string) => el.closest!(selectors) : null;
  // Every browser answers `isContentEditable`; a DOM without it (jsdom) is asked by attribute.
  if (typeof el.isContentEditable === "boolean" ? el.isContentEditable : !!closest?.(EDITABLE_SELECTOR)) return true;
  return !!closest?.(TERMINAL_SELECTOR);
}

/** The shortcuts as shown in help: a translation key for what each does, and every key that does it. */
export const CAPTURE_SHORTCUTS: ReadonlyArray<{ id: CaptureMode; labelKey: string; keys: readonly string[] }> = [
  { id: "full", labelKey: "screenshot.shortcutFull", keys: ["Print Screen", "Ctrl+Shift+S"] },
  { id: "region", labelKey: "screenshot.shortcutRegion", keys: ["Shift+Print Screen", "Alt+Shift+S"] },
];

/** The keys that take a capture of this kind, for a help list that words the action itself. */
export function captureShortcutKeys(mode: CaptureMode): string[] {
  return [...(CAPTURE_SHORTCUTS.find((shortcut) => shortcut.id === mode)?.keys ?? [])];
}
