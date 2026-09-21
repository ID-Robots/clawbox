/**
 * The desktop's custom wallpapers are addressed by POSITION: the pictures live
 * in one browser's `localStorage`, and the selection is the string
 * `custom-<n>` naming an index into that list.
 *
 * That format was spelled out four different ways across two files — a
 * `startsWith` compare, a template literal, a radix-less `parseInt` on
 * `split("-")[1]`, and a `slice`. None of them ever asked the question that
 * actually matters, which is whether the position still EXISTS: a list that
 * has shrunk (or a `wp_id` saved by a different browser, which holds a
 * different list) leaves the id pointing past the end, and the desktop then
 * paints the default while Settings goes on claiming the slot. One parser, so
 * the range check has a single place to live.
 */

export const CUSTOM_WALLPAPER_PREFIX = "custom-";

/** The index a `custom-<n>` id names, or null for any other wallpaper id. */
export function customWallpaperIndex(wallpaperId: string): number | null {
  if (!wallpaperId.startsWith(CUSTOM_WALLPAPER_PREFIX)) return null;
  const raw = wallpaperId.slice(CUSTOM_WALLPAPER_PREFIX.length);
  // Digits only: `parseInt` would read "2abc" as 2 and "" as NaN, and neither
  // is an id this app ever wrote.
  if (!/^\d+$/.test(raw)) return null;
  const index = Number.parseInt(raw, 10);
  return Number.isSafeInteger(index) ? index : null;
}

/** The id for the picture at `index`. */
export function customWallpaperId(index: number): string {
  return `${CUSTOM_WALLPAPER_PREFIX}${index}`;
}

/** Whether `wallpaperId` names a picture a list of `count` entries still holds. */
export function isCustomWallpaperInRange(wallpaperId: string, count: number): boolean {
  const index = customWallpaperIndex(wallpaperId);
  return index !== null && index >= 0 && index < count;
}

/**
 * Which wallpaper should be selected once the picture at `deletedIndex` is
 * removed from the list.
 *
 * The positions RENUMBER: deleting an earlier entry moves every later one down
 * a slot, so a selection that is not re-indexed ends up naming a different
 * picture — or, in the common case, none at all, and the desktop falls back to
 * the default. The owner deletes one wallpaper and a different one disappears
 * (TASK-719).
 *
 * `fallbackId` is what to select when the deleted one WAS the selected one —
 * the harness's own art, the same default a box that has never chosen one
 * opens on, so a Hermes box does not land on the ClawBox wallpaper.
 *
 * `null` there means the edition is NOT KNOWN YET, and then this returns the id
 * unchanged rather than guessing. The guess would be persisted box-wide and is
 * wrong half the time: every read that resolves the edition falls back to
 * OpenClaw when nothing on the device could answer, so a Hermes box whose probe
 * was slow or failed would write the ClawBox art over the owner's selection,
 * permanently, on a delete that had nothing to do with the edition. Callers get
 * the null from `brandWallpaperId` (src/lib/builtin-wallpapers.ts), which is the
 * one place that decides whether this device may be branded at all. The desktop
 * already refuses that write on the MOUNT path; this is the same refusal on the
 * delete path. What the owner sees meanwhile is the render fallback — the
 * NEUTRAL wallpaper while the edition is unknown, never the other edition's
 * brand — which costs nothing and corrects itself the moment the probe lands.
 *
 * `before` is the list as it stood BEFORE the removal, and it is what decides
 * whether the rule applies at all: renumbering only makes sense for a selection
 * that was an index into this very list. The range check lives here rather than
 * at the two callers for the reason the whole module exists — a caller that
 * forgets it writes the corruption box-wide. The list rather than its length
 * for the same reason: `(id, deletedIndex, count, fallback)` is two adjacent
 * numbers that transpose silently, and a caller that swapped them would disable
 * the guard and renumber against the wrong pivot.
 *
 * In the other direction the check is a HEURISTIC, and knowingly so: an
 * IN-range `custom-<n>` is ASSUMED to be this browser's, because a positional
 * id carries nothing that could prove whose it is. A phone holding three of its
 * own pictures and the laptop's `custom-2` still renumbers it. Only a
 * non-positional id closes that half; the range check closes the half a
 * position can actually answer.
 */
export function wallpaperIdAfterDelete(
  wallpaperId: string,
  deletedIndex: number,
  before: readonly string[],
  fallbackId: string | null,
): string {
  const active = customWallpaperIndex(wallpaperId);
  // A built-in is selected: a custom one going away cannot change it.
  if (active === null) return wallpaperId;
  // A `custom-<n>` this list never held is not ours to renumber. `wp_id` is
  // box-wide and the pictures are per-browser, so a selection past the end of
  // the list being deleted from is almost always ANOTHER browser's, still
  // resolving perfectly there. Shifting it down a slot would write this
  // browser's shorter list over a choice it cannot even paint — the same write
  // the mount path already refuses to make (TASK-719).
  if (!isCustomWallpaperInRange(wallpaperId, before.length)) return wallpaperId;
  if (active === deletedIndex) return fallbackId ?? wallpaperId;
  return active > deletedIndex ? customWallpaperId(active - 1) : wallpaperId;
}
