// ── Where the art actually is inside a Petdex cell ──
//
// A Petdex atlas is a grid of 192x208 cells, but the CHARACTER does not fill
// its cell: every sheet insets the drawing by an amount that differs per pet,
// per animation row and per frame. Two visible bugs come straight out of that:
//
//   - aligning the CELL's bottom edge to the taskbar leaves the pet's feet
//     floating 3-30 px above the bar, and the float changes when the state
//     changes, so the pet bobs off the bar mid-animation;
//   - the atlases are RAGGED. `waving` carries four real frames and `jumping`
//     five, but the sheet is six columns wide, so stepping a fixed six frames
//     lands on empty cells and the pet disappears for 183-367 ms at a time.
//
// Both are answered by the same measurement: scan the sheet's ALPHA channel
// once, per cell, and record where the drawing really is. This module is the
// pure half of that — it takes an alpha plane and returns per-row metrics, with
// no Node imports, so the server can produce it with sharp and the browser can
// validate what arrives over the wire with the same code.

/** Alpha above this counts as drawn. Petdex art has no faint padding: sweeping
 *  this from 1 to 250 moves the measured foot line by zero pixels. */
export const ALPHA_THRESHOLD = 8;

/** Everything measured about ONE animation row of a sheet. All in SOURCE px. */
export interface PetRowMetrics {
  /** Real animation frames: leading non-blank cells, capped at the sheet's
   *  frames-per-state. Never 0 — a fully blank row still reports 1. */
  frames: number;
  /** Per frame, transparent rows BELOW the art. Shift the cell down by this
   *  much and that frame's lowest drawn pixel lands exactly on the ground. */
  bottom: number[];
  /** Tallest drawn frame in the row, once its feet are on the ground. This is
   *  what a speech bubble has to clear, not the cell's top edge. */
  head: number;
  /** Transparent columns to the left of the art (min over the row's frames). */
  left: number;
  /** Transparent columns to the right of the art (min over the row's frames). */
  right: number;
}

/** The cell grid the metrics are measured against. */
export interface SheetGrid {
  frameW: number;
  frameH: number;
  cols: number;
  rows: number;
  framesPerState: number;
}

/** One decoded alpha plane: one byte per pixel, row-major. */
export interface AlphaPlane {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Frames a row may contain: the sheet's cap, never more than it has columns. */
export function framesPerRow(grid: SheetGrid): number {
  return Math.max(1, Math.min(Math.trunc(grid.framesPerState) || 1, Math.trunc(grid.cols) || 1));
}

function cellBbox(
  plane: AlphaPlane,
  x0: number,
  y0: number,
  frameW: number,
  frameH: number,
): Bbox | null {
  const { data, width, height } = plane;
  const xEnd = Math.min(x0 + frameW, width);
  const yEnd = Math.min(y0 + frameH, height);
  let minX = frameW;
  let minY = frameH;
  let maxX = -1;
  let maxY = -1;
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    const rowStart = y * width;
    for (let x = Math.max(0, x0); x < xEnd; x++) {
      if (data[rowStart + x] <= ALPHA_THRESHOLD) continue;
      const lx = x - x0;
      const ly = y - y0;
      if (lx < minX) minX = lx;
      if (lx > maxX) maxX = lx;
      if (ly < minY) minY = ly;
      if (ly > maxY) maxY = ly;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** A row that carries no art at all — nothing to align, nothing to step. */
function blankRow(frameH: number): PetRowMetrics {
  return { frames: 1, bottom: [0], head: frameH, left: 0, right: 0 };
}

/**
 * Per-row metrics for a whole sheet.
 *
 * Only the first `framesPerRow(grid)` columns are looked at: a sheet may
 * physically carry more (the 9-column legacy atlases do) and upstream animates
 * the first six the same way we do.
 *
 * A row's frame count is its LEADING run of drawn cells. Petdex pads short
 * states at the END of the row, so counting the run — rather than counting
 * drawn cells anywhere — keeps the frames contiguous, which is what a stepped
 * background-position animation needs.
 */
export function scanRowMetrics(plane: AlphaPlane, grid: SheetGrid): PetRowMetrics[] {
  const perRow = framesPerRow(grid);
  const { frameW, frameH } = grid;
  const rows = Math.max(1, Math.trunc(grid.rows) || 1);
  const out: PetRowMetrics[] = [];

  for (let r = 0; r < rows; r++) {
    const cells: (Bbox | null)[] = [];
    for (let c = 0; c < perRow; c++) {
      cells.push(cellBbox(plane, c * frameW, r * frameH, frameW, frameH));
    }
    let frames = 0;
    while (frames < cells.length && cells[frames]) frames++;
    if (frames === 0) {
      out.push(blankRow(frameH));
      continue;
    }
    const bottom: number[] = [];
    let head = 1;
    let left = frameW;
    let right = frameW;
    for (let i = 0; i < frames; i++) {
      const b = cells[i] as Bbox;
      bottom.push(frameH - 1 - b.maxY);
      head = Math.max(head, b.maxY - b.minY + 1);
      left = Math.min(left, b.minX);
      right = Math.min(right, frameW - 1 - b.maxX);
    }
    out.push({ frames, bottom, head, left, right });
  }
  return out;
}

/**
 * One row's worth of "no measurement".
 *
 * Deliberately the OLD behaviour — every frame flush with the cell, six frames
 * per row — so an unreadable sheet costs a pet its foot alignment, not its
 * existence. A pet is decoration; nothing here may ever fail a desktop.
 */
export function fallbackRow(grid: SheetGrid): PetRowMetrics {
  const perRow = framesPerRow(grid);
  return {
    frames: perRow,
    bottom: new Array<number>(perRow).fill(0),
    head: grid.frameH,
    left: 0,
    right: 0,
  };
}

/** `fallbackRow` for every row of a sheet. */
export function fallbackRowMetrics(grid: SheetGrid): PetRowMetrics[] {
  const rows = Math.max(1, Math.trunc(grid.rows) || 1);
  return Array.from({ length: rows }, () => fallbackRow(grid));
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Coerce metrics that arrived as JSON into something safe to render.
 *
 * The payload is our own route, but it is also a cache file on disk that an
 * older build wrote, so it is validated rather than trusted: a short array, a
 * NaN or a negative inset would otherwise become a pet drawn off its own cell.
 */
export function normaliseRowMetrics(raw: unknown, grid: SheetGrid): PetRowMetrics[] {
  const fallback = fallbackRowMetrics(grid);
  if (!Array.isArray(raw) || raw.length !== fallback.length) return fallback;
  const perRow = framesPerRow(grid);
  return fallback.map((def, i) => {
    const row = raw[i] as Partial<PetRowMetrics> | null | undefined;
    if (!row || typeof row !== "object") return def;
    const frames = clampInt(row.frames, 1, perRow, def.frames);
    const rawBottom = Array.isArray(row.bottom) ? row.bottom : [];
    if (rawBottom.length < frames) return def;
    const bottom = rawBottom
      .slice(0, frames)
      .map((v) => clampInt(v, 0, Math.max(0, grid.frameH - 1), 0));
    return {
      frames,
      bottom,
      head: clampInt(row.head, 1, grid.frameH, def.head),
      left: clampInt(row.left, 0, Math.max(0, grid.frameW - 1), 0),
      right: clampInt(row.right, 0, Math.max(0, grid.frameW - 1), 0),
    };
  });
}
