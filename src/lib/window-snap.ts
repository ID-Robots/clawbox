/**
 * Where a dragged surface lands when it is dropped against a screen edge.
 *
 * Shared because there are now TWO draggable surfaces on the desktop — the
 * app windows in `ChromeWindow` and the mascot chat in `ChatPopup` — and
 * "similar to regular windows" is the whole requirement for the second one.
 * A second copy of these zones is a copy that drifts: the threshold, the
 * shelf's real height and the strip the docked chat reserves all have to be
 * the same answer for both, or a chat snapped to the right half would sit at a
 * different edge than a window snapped to the same half.
 */

export type SnapZone =
  | "left" | "right" | "top"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | null;

/** Pixels from an edge that count as "dropped against it". */
export const SNAP_THRESHOLD = 12;

const SHELF_HEIGHT = 56;

/**
 * The shelf's real height, safe-area inset included.
 *
 * ChromeShelf is `calc(56px + env(safe-area-inset-bottom))`; a flat 56 made a
 * maximized window overlap the bar — and the mascot standing on it. The inset
 * is a device property that cannot be read from JS, so the live element is
 * measured (it already marks itself `data-mascot-ground` for the mascot) and
 * 56 stays the fallback for a surface that has no shelf mounted.
 */
export function shelfHeight(): number {
  if (typeof document === "undefined") return SHELF_HEIGHT;
  const el = document.querySelector("[data-mascot-ground]") as HTMLElement | null;
  const h = el?.getBoundingClientRect().height ?? 0;
  return h > 0 ? h : SHELF_HEIGHT;
}

export function getSnapZone(clientX: number, clientY: number, rInset = 0): SnapZone {
  const w = window.innerWidth - rInset;
  const h = window.innerHeight - shelfHeight();
  const nearLeft = clientX <= SNAP_THRESHOLD;
  const nearRight = clientX >= w - SNAP_THRESHOLD;
  const nearTop = clientY <= SNAP_THRESHOLD;
  const nearBottom = clientY >= h - SNAP_THRESHOLD;

  if (nearTop && nearLeft) return "top-left";
  if (nearTop && nearRight) return "top-right";
  if (nearBottom && nearLeft) return "bottom-left";
  if (nearBottom && nearRight) return "bottom-right";
  if (nearLeft) return "left";
  if (nearRight) return "right";
  if (nearTop) return "top";
  return null;
}

export interface SnapRect { x: number; y: number; width: number; height: number }

export function getSnapRect(zone: SnapZone, rInset = 0): SnapRect | null {
  if (!zone) return null;
  const w = window.innerWidth - rInset;
  const h = window.innerHeight - shelfHeight();
  switch (zone) {
    case "left": return { x: 0, y: 0, width: w / 2, height: h };
    case "right": return { x: w / 2, y: 0, width: w / 2, height: h };
    case "top": return { x: 0, y: 0, width: w, height: h };
    case "top-left": return { x: 0, y: 0, width: w / 2, height: h / 2 };
    case "top-right": return { x: w / 2, y: 0, width: w / 2, height: h / 2 };
    case "bottom-left": return { x: 0, y: h / 2, width: w / 2, height: h / 2 };
    case "bottom-right": return { x: w / 2, y: h / 2, width: w / 2, height: h / 2 };
    default: return null;
  }
}
