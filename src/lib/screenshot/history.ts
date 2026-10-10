// Undo / redo for the Screenshot editor: an immutable past–present–future
// stack. Every value is a whole editor document, so undo is a pointer move and
// nothing has to know how to reverse an individual edit.

export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
}

/** How many steps back the editor remembers. */
export const HISTORY_LIMIT = 100;

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [] };
}

/** Records `next` as a new step. Anything that had been undone is dropped. */
export function pushHistory<T>(history: History<T>, next: T, limit = HISTORY_LIMIT): History<T> {
  if (Object.is(next, history.present)) return history;
  const cap = Math.max(1, Math.floor(limit));
  const past = [...history.past, history.present];
  return { past: past.length > cap ? past.slice(past.length - cap) : past, present: next, future: [] };
}

/**
 * Swaps the present without recording a step — for the frames of a drag, which
 * are committed as ONE step when the pointer is released.
 */
export function replacePresent<T>(history: History<T>, next: T): History<T> {
  if (Object.is(next, history.present)) return history;
  return { ...history, present: next };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history;
  const past = history.past.slice(0, -1);
  return { past, present: history.past[history.past.length - 1], future: [history.present, ...history.future] };
}

export function redo<T>(history: History<T>): History<T> {
  if (!canRedo(history)) return history;
  const [next, ...future] = history.future;
  return { past: [...history.past, history.present], present: next, future };
}

/** Every value the history still holds, so resources only they reference can be kept. */
export function historyValues<T>(history: History<T>): T[] {
  return [...history.past, history.present, ...history.future];
}
