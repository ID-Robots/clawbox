// ── The Files app's selection ────────────────────────────────────────────────
//
// What a desktop file manager does with a click, kept out of the component so
// every rule is a plain function a test can call:
//
//   click            → just this item (and it becomes the anchor)
//   Ctrl/⌘-click     → this item in or out, the rest untouched (new anchor)
//   Shift-click      → everything from the anchor to here, and nothing else
//   Ctrl/⌘-Shift     → the range ADDED to what was already selected
//
// The anchor stays put through Shift-clicks, so a second Shift-click re-draws
// the range from the same place instead of from the last click — which is what
// Finder, Explorer and GNOME Files all do.

export interface FilesSelection {
  ids: ReadonlySet<string>;
  /** Where a Shift-click's range starts; null before anything was clicked. */
  anchor: string | null;
}

export const EMPTY_SELECTION: FilesSelection = { ids: new Set<string>(), anchor: null };

/**
 * The selection after a click on `id`. `order` is the list as it is shown —
 * the range runs through it — and an anchor that is no longer in it (the list
 * was filtered, or the anchored item deleted) makes the click a plain one.
 */
export function clickSelection(
  current: FilesSelection,
  order: readonly string[],
  id: string,
  mods: { range: boolean; toggle: boolean },
): FilesSelection {
  if (mods.range) {
    const anchor = current.anchor !== null && order.includes(current.anchor) ? current.anchor : null;
    const to = order.indexOf(id);
    if (anchor === null || to < 0) return { ids: new Set([id]), anchor: id };
    const from = order.indexOf(anchor);
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const range = order.slice(lo, hi + 1);
    return { ids: new Set(mods.toggle ? [...current.ids, ...range] : range), anchor };
  }
  if (mods.toggle) {
    const ids = new Set(current.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { ids, anchor: id };
  }
  return { ids: new Set([id]), anchor: id };
}

/** Everything shown, anchored at the first. */
export function selectAll(order: readonly string[]): FilesSelection {
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/** The browse-relative folder `rel` is in (`a/b/c.txt` → `a/b`, `c.txt` → ``). */
export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/** Whether `dest` IS `source` or lies inside it — the one move no folder can make. */
export function isInsideOrSame(dest: string, source: string): boolean {
  return dest === source || dest.startsWith(`${source}/`);
}

/**
 * Whether moving `sources` into `dest` does anything at all: none may be
 * `dest` or one of its ancestors, and at least one must live somewhere else
 * (dropping items on the folder they are already in moves nothing).
 */
export function canMoveInto(sources: readonly string[], dest: string): boolean {
  if (sources.length === 0) return false;
  if (sources.some((src) => isInsideOrSame(dest, src))) return false;
  return sources.some((src) => parentOf(src) !== dest);
}
