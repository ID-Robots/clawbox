/**
 * How the chat is laid out on a PHONE, and how big its conversation reads
 * (TASK-1157).
 *
 * On a phone the chat is full-screen, and the bars around the conversation —
 * the tab header above it, the composer's pickers below it — took close to half
 * of a landscape screen. Two view settings answer that, both kept per device:
 *
 *  - FULLSCREEN CHAT. The header folds into a slim strip and the composer
 *    keeps only the text box and its send action, the pickers tucked behind
 *    one control. On by default: the chat is what a phone opens the box for.
 *    Leaving it brings every bar back, and that choice is remembered.
 *  - TEXT SIZE of the conversation alone, in steps (the header, the composer
 *    and the page itself keep their size, and pinch-zoom stays the browser's).
 *
 * Kept in this browser's localStorage, like the chat's other view state (its
 * size, its tabs, its thinking level): a phone and the big screen beside it are
 * different screens, and the choice made on one says nothing about the other.
 * Nothing here applies at or above the desktop breakpoint — the components only
 * read it while they draw their phone layout.
 *
 * The store is a tiny external store (`subscribe` + `read*`) so every chat
 * surface on the page — the mascot chat and the full-page `/app/clawbox` —
 * follows one toggle at once, and another tab follows through `storage` events.
 */

export const CHAT_FULLSCREEN_STORAGE_KEY = "clawbox-chat-fullscreen";
export const CHAT_TEXT_SCALE_STORAGE_KEY = "clawbox-chat-text-scale";

/** Fullscreen chat is where a phone starts until the owner leaves it. */
export const DEFAULT_CHAT_FULLSCREEN = true;

/** The conversation's text size, as a factor of the chat's own sizes. */
export const CHAT_TEXT_SCALES = [0.85, 1, 1.15, 1.3, 1.5] as const;
export type ChatTextScale = (typeof CHAT_TEXT_SCALES)[number];
export const DEFAULT_CHAT_TEXT_SCALE: ChatTextScale = 1;

/** A stored fullscreen flag, read strictly: only "0" turns it off. */
export function parseChatFullscreen(raw: string | null | undefined): boolean {
  if (raw === "0") return false;
  if (raw === "1") return true;
  return DEFAULT_CHAT_FULLSCREEN;
}

/**
 * A stored text size, read strictly: anything that is not one of the steps —
 * a hand-edited value, a step a later build dropped — reads as the default
 * rather than as some size no control can reach or undo.
 */
export function parseChatTextScale(raw: string | null | undefined): ChatTextScale {
  if (raw === null || raw === undefined || raw.trim() === "") return DEFAULT_CHAT_TEXT_SCALE;
  const n = Number(raw);
  return CHAT_TEXT_SCALES.find((step) => step === n) ?? DEFAULT_CHAT_TEXT_SCALE;
}

/** One step smaller (-1) or larger (+1), stopping at either end. */
export function stepChatTextScale(current: ChatTextScale, direction: 1 | -1): ChatTextScale {
  const at = CHAT_TEXT_SCALES.indexOf(current);
  const from = at < 0 ? CHAT_TEXT_SCALES.indexOf(DEFAULT_CHAT_TEXT_SCALE) : at;
  const next = Math.min(CHAT_TEXT_SCALES.length - 1, Math.max(0, from + direction));
  return CHAT_TEXT_SCALES[next];
}

export function isSmallestChatTextScale(scale: ChatTextScale): boolean {
  return scale === CHAT_TEXT_SCALES[0];
}

export function isLargestChatTextScale(scale: ChatTextScale): boolean {
  return scale === CHAT_TEXT_SCALES[CHAT_TEXT_SCALES.length - 1];
}

/** "115" for 1.15 — what the control says. */
export function chatTextScalePercent(scale: ChatTextScale): number {
  return Math.round(scale * 100);
}

// ── The store ───────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage ?? null;
  } catch {
    // A browser with storage switched off throws on the ACCESS, not the call.
    return null;
  }
}

function readKey(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * What this page chose when the browser would not keep it: a private window
 * that refuses the write must not snap the toggle back on the next render.
 * Only ever holds a key the storage refused, so a working storage stays the
 * one source of truth (and clearing it resets the choice).
 */
const memory = new Map<string, string>();

function writeKey(key: string, value: string): void {
  let kept = false;
  try {
    const store = storage();
    if (store) {
      store.setItem(key, value);
      kept = true;
    }
  } catch {
    /* localStorage unavailable or full — held in memory below */
  }
  if (kept) memory.delete(key);
  else memory.set(key, value);
  for (const listener of [...listeners]) listener();
}

function current(key: string): string | null {
  const held = memory.get(key);
  return held !== undefined ? held : readKey(key);
}

export function readChatFullscreen(): boolean {
  return parseChatFullscreen(current(CHAT_FULLSCREEN_STORAGE_KEY));
}

export function writeChatFullscreen(on: boolean): void {
  writeKey(CHAT_FULLSCREEN_STORAGE_KEY, on ? "1" : "0");
}

export function readChatTextScale(): ChatTextScale {
  return parseChatTextScale(current(CHAT_TEXT_SCALE_STORAGE_KEY));
}

export function writeChatTextScale(scale: ChatTextScale): void {
  writeKey(CHAT_TEXT_SCALE_STORAGE_KEY, String(parseChatTextScale(String(scale))));
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== CHAT_FULLSCREEN_STORAGE_KEY && event.key !== CHAT_TEXT_SCALE_STORAGE_KEY) return;
  for (const listener of [...listeners]) listener();
}

/** Called on every change, from this page or from another tab. */
export function subscribeChatPhoneLayout(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Test seam: forget what this page chose without storage. */
export function resetChatPhoneLayoutMemory(): void {
  memory.clear();
}
