// Two visible bugs live or die on this measurement:
//
//   - a pet whose feet float above the taskbar, because the CELL was aligned to
//     the bar and not the drawing inside it;
//   - a pet that vanishes for 183-367 ms every loop, because a ragged row was
//     stepped as if it had six frames.
//
// So the scan is tested against a hand-built alpha plane where the answers are
// known by construction, and against the shapes a bad payload can take.

import { describe, expect, it } from "vitest";
import {
  ALPHA_THRESHOLD,
  fallbackRow,
  fallbackRowMetrics,
  framesPerRow,
  normaliseRowMetrics,
  scanRowMetrics,
  type SheetGrid,
} from "@/lib/pet-sheet-metrics";

/** A tiny stand-in for a Petdex atlas: 4 columns x 2 rows of 10x12 cells. */
const GRID: SheetGrid = { frameW: 10, frameH: 12, cols: 4, rows: 2, framesPerState: 4 };
const W = GRID.frameW * GRID.cols;
const H = GRID.frameH * GRID.rows;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  alpha?: number;
}

/** An alpha plane with one solid rectangle drawn inside each named cell. */
function plane(cells: Record<string, Rect | null>) {
  const data = new Uint8Array(W * H);
  for (const [key, rect] of Object.entries(cells)) {
    if (!rect) continue;
    const [r, c] = key.split(",").map(Number);
    const x0 = c * GRID.frameW;
    const y0 = r * GRID.frameH;
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        data[(y0 + rect.y + y) * W + (x0 + rect.x + x)] = rect.alpha ?? 255;
      }
    }
  }
  return { data, width: W, height: H };
}

describe("scanRowMetrics", () => {
  it("measures the drawing, not the cell", () => {
    // A 6x4 block at (2,3) inside a 10x12 cell: 2 columns of padding on the
    // left, 2 on the right, 3 rows above and 12 - 3 - 4 = 5 below.
    const rect: Rect = { x: 2, y: 3, w: 6, h: 4 };
    const rows = scanRowMetrics(
      plane({ "0,0": rect, "0,1": rect, "0,2": rect, "0,3": rect, "1,0": rect, "1,1": rect, "1,2": rect, "1,3": rect }),
      GRID,
    );
    expect(rows[0]).toEqual({ frames: 4, bottom: [5, 5, 5, 5], head: 4, left: 2, right: 2 });
  });

  it("gives every frame its OWN foot offset", () => {
    // Within one row the art moves — this is exactly the bob that put the pet
    // 3px off the bar on one frame and 30px off it on the next.
    const rows = scanRowMetrics(
      plane({
        "0,0": { x: 1, y: 0, w: 2, h: 12 },
        "0,1": { x: 1, y: 0, w: 2, h: 8 },
        "0,2": { x: 1, y: 0, w: 2, h: 6 },
        "0,3": { x: 1, y: 0, w: 2, h: 12 },
      }),
      GRID,
    );
    expect(rows[0].bottom).toEqual([0, 4, 6, 0]);
    // The head is the TALLEST frame's: the bubble has to clear all of them.
    expect(rows[0].head).toBe(12);
  });

  it("counts a ragged row's real frames and stops at the first blank cell", () => {
    const art: Rect = { x: 3, y: 4, w: 4, h: 4 };
    const rows = scanRowMetrics(
      plane({ "0,0": art, "0,1": art, "0,2": null, "0,3": art }),
      GRID,
    );
    // The trailing `0,3` is drawn but not contiguous; frames stop at the gap so
    // a stepped background animation never lands on the empty cell.
    expect(rows[0].frames).toBe(2);
    expect(rows[0].bottom).toHaveLength(2);
  });

  it("survives a row with no art at all", () => {
    const rows = scanRowMetrics(plane({}), GRID);
    expect(rows[0]).toEqual({ frames: 1, bottom: [0], head: GRID.frameH, left: 0, right: 0 });
  });

  it("ignores alpha at or below the threshold", () => {
    const rows = scanRowMetrics(
      plane({ "0,0": { x: 0, y: 0, w: 10, h: 12, alpha: ALPHA_THRESHOLD } }),
      GRID,
    );
    expect(rows[0].frames).toBe(1);
    expect(rows[0].head).toBe(GRID.frameH);
  });

  it("returns one entry per row, whatever the sheet's shape", () => {
    const tall: SheetGrid = { ...GRID, rows: 2 };
    expect(scanRowMetrics(plane({}), tall)).toHaveLength(2);
  });

  it("never looks past the frames-per-state cap", () => {
    // A 9-column legacy atlas still animates six frames; upstream caps the
    // same way, and scanning the rest would only find decoration.
    expect(framesPerRow({ ...GRID, cols: 9, framesPerState: 6 })).toBe(6);
    expect(framesPerRow({ ...GRID, cols: 3, framesPerState: 6 })).toBe(3);
  });
});

describe("the un-measured fallback", () => {
  it("reproduces the old flush-to-the-cell behaviour", () => {
    // An unreadable sheet costs a pet its foot alignment, not its existence.
    expect(fallbackRow(GRID)).toEqual({
      frames: 4,
      bottom: [0, 0, 0, 0],
      head: GRID.frameH,
      left: 0,
      right: 0,
    });
    expect(fallbackRowMetrics(GRID)).toHaveLength(GRID.rows);
  });
});

describe("normaliseRowMetrics", () => {
  const good = scanRowMetrics(plane({ "0,0": { x: 2, y: 3, w: 6, h: 4 } }), GRID);

  it("passes measured metrics through", () => {
    expect(normaliseRowMetrics(JSON.parse(JSON.stringify(good)), GRID)).toEqual(good);
  });

  it("falls back rather than trusting a payload of the wrong shape", () => {
    const fallback = fallbackRowMetrics(GRID);
    expect(normaliseRowMetrics(undefined, GRID)).toEqual(fallback);
    expect(normaliseRowMetrics([], GRID)).toEqual(fallback);
    expect(normaliseRowMetrics([{ frames: 4 }, null], GRID)).toEqual(fallback);
    // Fewer offsets than frames would step onto `undefined`.
    expect(normaliseRowMetrics([{ frames: 4, bottom: [0, 0] }, null], GRID)).toEqual(fallback);
  });

  it("clamps values that would draw the pet off its own cell", () => {
    const rows = normaliseRowMetrics(
      [
        { frames: 99, bottom: [-5, 1e9, Number.NaN, 2], head: 0, left: -1, right: 999 },
        { frames: 1, bottom: [3], head: 4, left: 1, right: 1 },
      ],
      GRID,
    );
    expect(rows[0].frames).toBe(4);
    expect(rows[0].bottom).toEqual([0, GRID.frameH - 1, 0, 2]);
    expect(rows[0].head).toBe(1);
    expect(rows[0].left).toBe(0);
    expect(rows[0].right).toBe(GRID.frameW - 1);
  });
});
