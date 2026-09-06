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
 */
export function wallpaperIdAfterDelete(
  wallpaperId: string,
  deletedIndex: number,
  fallbackId: string,
): string {
  const active = customWallpaperIndex(wallpaperId);
  // A built-in is selected: a custom one going away cannot change it.
  if (active === null) return wallpaperId;
  if (active === deletedIndex) return fallbackId;
  return active > deletedIndex ? customWallpaperId(active - 1) : wallpaperId;
}
