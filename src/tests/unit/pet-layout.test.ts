// The screen geometry every pet surface shares: where the feet go, where the
// head is, how many frames a row really steps, and which stretch of the shelf
// the pet is allowed to walk on.

import { describe, expect, it } from "vitest";
import {
  PET_BODY_PX,
  petKeyframes,
  petLayout,
  rowMetricsFor,
  widestFreeSpan,
} from "@/lib/pet-layout";
import { CODEX_STATE_ROWS } from "@/lib/pet-state-map";
import type { PetRowMetrics } from "@/lib/pet-sheet-metrics";
import type { PetDescriptor } from "@/lib/pet-client";

function row(frames: number, bottom: number[], head: number, left = 20, right = 20): PetRowMetrics {
  return { frames, bottom, head, left, right };
}

const ROWS: PetRowMetrics[] = [
  row(6, [30, 30, 30, 30, 30, 30], 148),
  row(6, [12, 12, 12, 12, 12, 12], 160),
  row(6, [12, 12, 12, 12, 12, 12], 160),
  // `waving` — four real frames; the last two cells are blank on every sheet.
  row(4, [8, 6, 6, 8], 170),
  // `jumping` — five, and the art leaves the ground mid-hop.
  row(5, [20, 40, 60, 40, 20], 150),
  row(6, [30, 30, 30, 30, 30, 30], 148),
  row(6, [30, 30, 30, 30, 30, 30], 148),
  row(6, [12, 12, 12, 12, 12, 12], 160),
  row(6, [30, 30, 30, 30, 30, 30], 148),
];

const PET: PetDescriptor = {
  slug: "boba",
  displayName: "Boba",
  submittedBy: "railly",
  revision: "1:2",
  frameW: 192,
  frameH: 208,
  cols: 8,
  rows: 9,
  framesPerState: 6,
  loopMs: 1100,
  rowMetrics: ROWS,
};

describe("petLayout", () => {
  it("scales a 208px cell to exactly half, so nothing lands on a fraction", () => {
    const layout = petLayout(PET, { state: "idle", facing: "right" });
    expect(layout.scale).toBe(0.5);
    expect(layout.dispH).toBe(PET_BODY_PX);
    expect(Number.isInteger(layout.dispW)).toBe(true);
  });

  it("turns each frame's measured inset into a downward shift", () => {
    const layout = petLayout(PET, { state: "jump", facing: "right" });
    expect(layout.rowIndex).toBe(CODEX_STATE_ROWS.indexOf("jumping"));
    // Source px halved: the cell moves DOWN by this much so the frame's lowest
    // drawn pixel lands on the ground line rather than 20-60 source px above it.
    expect(layout.offsets).toEqual([10, 20, 30, 20, 10]);
  });

  it("reports the row's real frame count, not the sheet's column count", () => {
    expect(petLayout(PET, { state: "dance", facing: "right" }).frames).toBe(4);
    expect(petLayout(PET, { state: "jump", facing: "right" }).frames).toBe(5);
    expect(petLayout(PET, { state: "idle", facing: "right" }).frames).toBe(6);
  });

  it("keeps the frame RATE when a row is short", () => {
    // Four frames stretched over 1100 ms would play the wave in slow motion.
    expect(petLayout(PET, { state: "idle", facing: "right" }).loopMs).toBe(1100);
    expect(petLayout(PET, { state: "dance", facing: "right" }).loopMs).toBe(Math.round((1100 * 4) / 6));
  });

  it("measures the head off the art, so the bubble gap is the same for every pet", () => {
    // Two pets with very different insets, both drawing art of the same height,
    // must give the bubble the same anchor.
    const tall = { ...PET, rowMetrics: [row(6, [0, 0, 0, 0, 0, 0], 148), ...ROWS.slice(1)] };
    const low = { ...PET, rowMetrics: [row(6, [40, 40, 40, 40, 40, 40], 148), ...ROWS.slice(1)] };
    expect(petLayout(tall, { state: "idle", facing: "right" }).headPx).toBe(74);
    expect(petLayout(low, { state: "idle", facing: "right" }).headPx).toBe(74);
  });

  it("falls back to the cell when a descriptor carries no measurements", () => {
    const bare = { ...PET, rowMetrics: undefined };
    const layout = petLayout(bare, { state: "idle", facing: "right" });
    expect(layout.frames).toBe(6);
    expect(layout.offsets).toEqual([0, 0, 0, 0, 0, 0]);
    expect(layout.headPx).toBe(PET_BODY_PX);
    expect(rowMetricsFor(bare, 3).frames).toBe(6);
  });
});

describe("petKeyframes", () => {
  it("carries the frame AND its foot offset in one animation", () => {
    // Split across two animations they would drift out of phase, and the whole
    // point is that the drawn feet are on the bar in every frame.
    const layout = petLayout(PET, { state: "jump", facing: "right" });
    const { name, css } = petKeyframes(layout);
    expect(css.startsWith(`@keyframes ${name}{`)).toBe(true);
    expect(css).toContain("0%{background-position-x:0px;bottom:-10px}");
    expect(css).toContain("20%{background-position-x:-96px;bottom:-20px}");
    expect(css).toContain("40%{background-position-x:-192px;bottom:-30px}");
    // Never a sixth step: that column is empty on every installed sheet.
    expect(css).not.toContain("background-position-x:-480px");
  });

  it("holds the last frame all the way to 100%", () => {
    const { css } = petKeyframes(petLayout(PET, { state: "dance", facing: "right" }));
    // `waving` frame 3 is inset 8 source px -> 4 CSS px of downward shift.
    expect(css).toContain("75%{background-position-x:-288px;bottom:-4px}");
    expect(css).toContain("100%{background-position-x:-288px;bottom:-4px}");
  });

  it("gives different rows different names, and the same row the same one", () => {
    const a = petKeyframes(petLayout(PET, { state: "idle", facing: "right" }));
    const b = petKeyframes(petLayout(PET, { state: "idle", facing: "right" }));
    const c = petKeyframes(petLayout(PET, { state: "jump", facing: "right" }));
    // Stable across re-renders, so a re-render does not restart the animation.
    expect(a.name).toBe(b.name);
    expect(a.name).not.toBe(c.name);
  });
});

describe("widestFreeSpan", () => {
  it("returns the whole span when nothing is in the way", () => {
    expect(widestFreeSpan(0, 1440, [])).toEqual({ lo: 0, hi: 1440 });
  });

  it("walks around the desktop icon column", () => {
    // The measured case: the icon grid starts at x=20 and its bottom row
    // reaches the shelf, so the pet's lane must start after it.
    expect(widestFreeSpan(0, 1440, [{ lo: 20, hi: 120 }])).toEqual({ lo: 120, hi: 1440 });
  });

  it("picks the widest gap when icons sit on both sides", () => {
    expect(
      widestFreeSpan(0, 1000, [
        { lo: 20, hi: 120 },
        { lo: 900, hi: 980 },
      ]),
    ).toEqual({ lo: 120, hi: 900 });
  });

  it("merges overlapping blockers and ignores empty ones", () => {
    expect(
      widestFreeSpan(0, 600, [
        { lo: 100, hi: 300 },
        { lo: 200, hi: 400 },
        { lo: 500, hi: 500 },
      ]),
    ).toEqual({ lo: 400, hi: 600 });
  });

  it("collapses to nothing when the span is covered end to end", () => {
    const span = widestFreeSpan(0, 200, [{ lo: -10, hi: 210 }]);
    expect(span.hi - span.lo).toBe(0);
  });
});
