/**
 * Desktop icon grid layout.
 *
 * The desktop persists icon placement as `icon_grid` — a map of icon id to
 * `{ row, col }`. Everything that turns that map back into a drawn layout lives
 * here, as pure functions, because the previous inline version had two defects
 * that only showed up on a real device:
 *
 * 1. It read the saved map in ROW-major order (`sort` by row, then col) and
 *    wrote it back in COLUMN-major order. That is a permutation, not an
 *    identity: every re-arrange reshuffled the icons. Since a re-arrange is
 *    triggered on almost every load (the active harness resolves after the
 *    first paint, so a couple of icons are transiently undrawn), the desktop
 *    came up in a different order each time the page was opened.
 * 2. It only re-arranged when an icon was missing a slot, overflowed the grid,
 *    or a saved slot belonged to an icon that is no longer drawn. A saved
 *    layout whose ids matched the drawn set exactly was passed through
 *    verbatim — gaps included — so a hole (left behind by a drag, or by an
 *    older build) was permanent.
 *
 * The model here is: **the saved layout encodes an ORDER, and only an order.**
 *
 * - `readSequence` recovers that order by walking the saved cells column by
 *   column. It compares coordinates rather than deriving a linear index, so the
 *   order it recovers does not depend on how tall the window was when the
 *   layout was written.
 * - `assignSlots` writes a sequence back into DENSE slots — 0..n-1, no gaps —
 *   for whatever geometry is being drawn.
 * - The two round-trip exactly, so re-running the layout is a no-op and the
 *   order stops churning.
 * - Icons with no saved slot are appended in a declared CANONICAL order, never
 *   in whatever order the arrays happened to arrive in.
 *
 * Narrow viewports draw row-by-row (`row` flow) but are still SAVED column-major
 * (`STORAGE_FLOW`), so one encoding round-trips everywhere and rotating a phone
 * or crossing the mobile breakpoint reflows the icons without reordering them.
 */

export type IconSlot = { row: number; col: number };
export type IconLayout = Record<string, IconSlot>;

/**
 * How a grid is filled.
 *
 * - `column` (wide viewports): top-to-bottom, wrapping into the next column —
 *   the classic desktop look.
 * - `row` (narrow viewports): left-to-right, wrapping onto the next row — the
 *   phone home-screen look.
 */
export type LayoutFlow = "column" | "row";

export type LayoutGeometry = {
  flow: LayoutFlow;
  /** Columns available across the viewport. At least 1. */
  cols: number;
  /** Icons per column before wrapping, in `column` flow. At least 1. */
  rowsPerColumn: number;
};

/**
 * The flow the saved `icon_grid` is always written in, whatever is on screen.
 * A single storage encoding is what makes the order survive a viewport change.
 */
export const STORAGE_FLOW: LayoutFlow = "column";

/** The geometry to SAVE with, for a given on-screen geometry. */
export function storageGeometry(geometry: LayoutGeometry): LayoutGeometry {
  return { ...geometry, flow: STORAGE_FLOW };
}

/** Position of a slot along the fill direction — the layout's linear index. */
export function slotIndex(slot: IconSlot, geometry: LayoutGeometry): number {
  const cols = Math.max(1, Math.floor(geometry.cols) || 1);
  const rowsPerColumn = Math.max(1, Math.floor(geometry.rowsPerColumn) || 1);
  return geometry.flow === "column" ? slot.col * rowsPerColumn + slot.row : slot.row * cols + slot.col;
}

/**
 * Rank an icon in the canonical order: its index in `canonical`, or — for ids
 * the caller did not declare — a slot after every declared icon, broken by id
 * so the result never depends on array arrival order.
 */
function canonicalCompare(a: string, b: string, canonical: readonly string[]): number {
  const ia = canonical.indexOf(a);
  const ib = canonical.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isUsableSlot(slot: IconSlot | undefined): slot is IconSlot {
  return !!slot && Number.isFinite(slot.row) && Number.isFinite(slot.col);
}

/**
 * The ordered sequence the given icons should be drawn in.
 *
 * Saved cells are walked column by column (the storage flow), comparing
 * coordinates directly — never a linear index — so the recovered order is
 * independent of the window size the layout was saved at. Icons without a saved
 * slot (newly installed, or never placed) are appended in canonical order.
 * Icons sharing a slot — reachable only from a hand-edited or corrupted
 * `icon_grid` — are broken by canonical order so the result stays deterministic.
 */
export function readSequence(
  ids: readonly string[],
  saved: IconLayout,
  canonical: readonly string[],
): string[] {
  const placed: string[] = [];
  const unplaced: string[] = [];
  for (const id of ids) {
    if (isUsableSlot(saved[id])) placed.push(id);
    else unplaced.push(id);
  }
  placed.sort((a, b) => {
    const pa = saved[a];
    const pb = saved[b];
    if (pa.col !== pb.col) return pa.col - pb.col;
    if (pa.row !== pb.row) return pa.row - pb.row;
    return canonicalCompare(a, b, canonical);
  });
  unplaced.sort((a, b) => canonicalCompare(a, b, canonical));
  return [...placed, ...unplaced];
}

/**
 * Place an ordered sequence into dense grid slots — no gaps, ever.
 *
 * In `column` flow the last column keeps growing past `rowsPerColumn` rather
 * than dropping icons, so an over-full desktop scrolls instead of losing
 * shortcuts.
 */
export function assignSlots(sequence: readonly string[], geometry: LayoutGeometry): IconLayout {
  const cols = Math.max(1, Math.floor(geometry.cols) || 1);
  const rowsPerColumn = Math.max(1, Math.floor(geometry.rowsPerColumn) || 1);
  const layout: IconLayout = {};
  sequence.forEach((id, i) => {
    if (geometry.flow === "column") {
      const col = Math.min(Math.floor(i / rowsPerColumn), cols - 1);
      layout[id] = { row: i - col * rowsPerColumn, col };
    } else {
      layout[id] = { row: Math.floor(i / cols), col: i % cols };
    }
  });
  return layout;
}

/**
 * The dense layout for `ids`, honouring the order implied by `saved`.
 *
 * This is the only function the desktop needs: it repairs holes, drops slots
 * belonging to icons that are no longer drawn, places new icons, and reflows
 * for the current viewport — in one pass, idempotently.
 */
export function layoutIcons(
  ids: readonly string[],
  saved: IconLayout,
  geometry: LayoutGeometry,
  canonical: readonly string[],
): IconLayout {
  return assignSlots(readSequence(ids, saved, canonical), geometry);
}

/** Structural equality, so an unchanged layout never triggers a state write. */
export function layoutsEqual(a: IconLayout, b: IconLayout): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && a[k].row === b[k].row && a[k].col === b[k].col);
}

/** True when every slot 0..n-1 along the fill direction is occupied exactly once. */
export function isDense(layout: IconLayout, geometry: LayoutGeometry): boolean {
  const indices = Object.values(layout).map((slot) => slotIndex(slot, geometry));
  if (new Set(indices).size !== indices.length) return false;
  return indices.every((i) => i >= 0 && i < indices.length);
}

/**
 * Move `id` to the slot the user dropped it on, keeping every other icon's
 * relative order and compacting the result into the storage encoding.
 *
 * Manual placement is honoured as an ORDER, not as an absolute cell: the icon
 * lands where it was dropped in the reading sequence, and the rest close ranks
 * behind it. An absolute cell survives neither of the two things this grid has
 * to do — stay dense, and reflow when the window changes shape — so the order
 * is what gets preserved.
 *
 * `target` is a cell in `drawnGeometry` (what the user sees); the result is
 * written in `storageGeometry(drawnGeometry)`.
 */
export function moveIcon(
  id: string,
  target: IconSlot,
  ids: readonly string[],
  saved: IconLayout,
  drawnGeometry: LayoutGeometry,
  canonical: readonly string[],
): IconLayout {
  const full = readSequence(ids, saved, canonical);
  const from = full.indexOf(id);
  const sequence = full.filter((other) => other !== id);
  // Dropping ON an icon means "take its place". Pulling the dragged icon out of
  // the sequence first shifts everything after it down by one, so a drop that
  // was ahead of the icon's old position has to shift with it.
  const dropped = slotIndex(target, drawnGeometry);
  const index = Math.max(0, Math.min(from !== -1 && from < dropped ? dropped - 1 : dropped, sequence.length));
  sequence.splice(index, 0, id);
  return assignSlots(sequence, storageGeometry(drawnGeometry));
}
