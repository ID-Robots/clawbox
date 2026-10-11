// The screen geometry every pet surface shares: where the feet go, where the
// head is, how many frames a row really steps, and which stretch of the shelf
// the pet is allowed to walk on.

import { describe, expect, it } from "vitest";
import {
  PET_BODY_PX,
  petFrameMs,
  petFrameTransforms,
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

describe("petFrameTransforms", () => {
  it("carries the frame AND its foot offset in one transform", () => {
    // Split across two properties they would drift out of phase, and the whole
    // point is that the drawn feet are on the bar in every frame.
    const frames = petFrameTransforms(petLayout(PET, { state: "jump", facing: "right" }));
    expect(frames[0]).toBe("translate(0px, 10px)");
    expect(frames[1]).toBe("translate(-96px, 20px)");
    expect(frames[2]).toBe("translate(-192px, 30px)");
    // Never a sixth step: that column is empty on every installed sheet.
    expect(frames).toHaveLength(5);
    expect(frames.join()).not.toContain("translate(-480px");
  });

  it("stops at the last frame the row really draws", () => {
    const frames = petFrameTransforms(petLayout(PET, { state: "dance", facing: "right" }));
    // `waving` frame 3 is inset 8 source px -> 4 CSS px of downward shift.
    expect(frames).toHaveLength(4);
    expect(frames[3]).toBe("translate(-288px, 4px)");
  });

  it("shows each frame for the row's loop split evenly", () => {
    const layout = petLayout(PET, { state: "dance", facing: "right" });
    expect(petFrameMs(layout)).toBe(Math.round(layout.loopMs / layout.frames));
  });
});

describe("a sleeping pet", () => {
  // The crab sleeps on `waiting`, whose frame 3 has its eyes OPEN; stepped
  // whole, the row blinked it awake once a loop. Its pack names the frames
  // with the eyes shut.
  const CRAB: PetDescriptor = { ...PET, slug: "vibrant-clawd", sleepFrames: [0, 1, 2] };
  const WAITING = CODEX_STATE_ROWS.indexOf("waiting");
  const w = 96;

  it("steps only the pack's sleep frames, on the sleep row", () => {
    const layout = petLayout(CRAB, { state: "sleep", facing: "right" });
    expect(layout.rowIndex).toBe(WAITING);
    expect(layout.frames).toBe(6);
    expect(layout.sequence).toEqual([0, 1, 2]);
    const frames = petFrameTransforms(layout);
    expect(frames).toEqual(["translate(0px, 15px)", `translate(${-w}px, 15px)`, `translate(${-2 * w}px, 15px)`]);
    expect(frames.join()).not.toContain(`translate(${-3 * w}px`);
  });

  it("spreads the row's loop over the frames it sleeps on", () => {
    const layout = petLayout(CRAB, { state: "sleep", facing: "right" });
    // Three of six frames at the row's own rate would fidget twice as fast as
    // the pet breathes awake; a sleep loop keeps the loop's length instead.
    expect(petFrameMs(layout)).toBe(Math.round(1100 / 3));
  });

  it("holds the row's first frame when the pack declares none", () => {
    const layout = petLayout(PET, { state: "sleep", facing: "right" });
    expect(layout.rowIndex).toBe(WAITING);
    expect(layout.sequence).toEqual([0]);
    expect(petFrameTransforms(layout)).toEqual(["translate(0px, 15px)"]);
  });

  it("holds the first frame when the list does not fit the row it sleeps on", () => {
    expect(petLayout({ ...PET, sleepFrames: [0, 6] }, { state: "sleep", facing: "right" }).sequence).toEqual([0]);
    expect(petLayout({ ...PET, sleepFrames: [] }, { state: "sleep", facing: "right" }).sequence).toEqual([0]);
    // A row measured shorter than the list was written for.
    const short = { ...CRAB, sleepFrames: [0, 4], rowMetrics: ROWS.map((r, i) => (i === WAITING ? row(4, [30, 30, 30, 30], 148) : r)) };
    expect(petLayout(short, { state: "sleep", facing: "right" }).sequence).toEqual([0]);
  });

  it("wakes onto the whole row of whatever comes next", () => {
    expect(petLayout(CRAB, { state: "idle", facing: "right" }).sequence).toEqual([0, 1, 2, 3, 4, 5]);
    // `sass` shares the sleep row, awake: it keeps every frame, blink included.
    const sass = petLayout(CRAB, { state: "sass", facing: "right" });
    expect(sass.rowIndex).toBe(WAITING);
    expect(sass.sequence).toEqual([0, 1, 2, 3, 4, 5]);
    expect(petFrameMs(sass)).toBe(Math.round(1100 / 6));
    // Thinking outranks sleep and draws its own row.
    const thinking = petLayout(CRAB, { state: "sleep", thinking: true, facing: "right" });
    expect(thinking.rowIndex).toBe(CODEX_STATE_ROWS.indexOf("review"));
    expect(thinking.sequence).toEqual([0, 1, 2, 3, 4, 5]);
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
