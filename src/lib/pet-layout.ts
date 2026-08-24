// ── Turning a pet's measured sheet into screen geometry ──
//
// One module so the sprite, the speech bubble, the thinking dots and the drag
// hit-box all read the SAME numbers. They used to each guess off the 192x208
// cell, which is why the feet floated, the bubble sat a different distance
// above every pet's head, and the body box swallowed clicks meant for a
// desktop icon standing behind a transparent corner.

import { petFrameFor, type MascotStateName } from "@/lib/pet-state-map";
import {
  fallbackRow,
  framesPerRow,
  type PetRowMetrics,
  type SheetGrid,
} from "@/lib/pet-sheet-metrics";
import type { PetDescriptor } from "@/lib/pet-client";

/** Rendered cell height, in px.
 *
 *  Deliberately SMALLER than the crab's 150px body. Matching the crab was the
 *  original choice, so that every offset in Mascot.tsx kept working untouched —
 *  but the two bodies are not the same shape. The crab is one illustration that
 *  fills its box; a Petdex cell is 192x208 with the character inset inside it,
 *  so at 150 the pet read as oversized next to its own speech bubble and left
 *  no room above its head.
 *
 *  104 rather than 112 because 104/208 is EXACTLY 0.5. At 112 the scale was
 *  0.538461…, the per-frame step (round(6 x 103.3846) / 6) drifted a quarter of
 *  a pixel by the last frame, and `image-rendering: pixelated` re-rounded which
 *  source rows survived on every step — a foot line that jittered a device
 *  pixel per frame. A clean half scale steps on integers.
 *
 *  Hermes' own `display.pet.scale` (0.33) is still not used: it is a shared
 *  scalar tuned for a terminal corner sprite, and writing to it would resize
 *  the CLI and TUI too. */
export const PET_BODY_PX = 104;

/** Everything the mascot needs to draw the pet in its current pose. */
export interface PetLayout {
  /** Sheet row for the current mood. */
  rowIndex: number;
  /** True when the row's art has to be flipped to face `facing`. */
  mirror: boolean;
  /** Real frames in this row — NOT a sheet-wide constant. */
  frames: number;
  /** Source px -> CSS px. */
  scale: number;
  /** One cell, in CSS px. */
  dispW: number;
  dispH: number;
  /** Per frame, how far DOWN to shift the cell so that frame's feet land on
   *  the ground line. CSS px, already rounded to whole pixels. */
  offsets: number[];
  /** How far ABOVE the ground line this row's tallest frame reaches, CSS px.
   *  The bubble, the thinking dots and the ZZZ cluster all hang off this. */
  headPx: number;
  /** Symmetric horizontal inset of the art inside the cell, CSS px. Symmetric
   *  on purpose: the sprite cancels the shell's flip on directional rows, so a
   *  left/right-specific box would land on the wrong side half the time. */
  artInsetPx: number;
  /** One full loop of this row. Shorter rows keep the same FRAME RATE rather
   *  than stretching four frames over six frames' worth of time. */
  loopMs: number;
}

/** The grid a descriptor describes. */
export function gridOf(pet: PetDescriptor): SheetGrid {
  return {
    frameW: pet.frameW,
    frameH: pet.frameH,
    cols: pet.cols,
    rows: pet.rows,
    framesPerState: pet.framesPerState,
  };
}

/** Metrics for one row, with a safe fallback for a descriptor that has none. */
export function rowMetricsFor(pet: PetDescriptor, rowIndex: number): PetRowMetrics {
  const grid = gridOf(pet);
  const rows = pet.rowMetrics;
  const row = Array.isArray(rows) ? rows[rowIndex] : undefined;
  if (row && Number.isFinite(row.frames) && Array.isArray(row.bottom) && row.bottom.length > 0) {
    return row;
  }
  return fallbackRow(grid);
}

export interface PetPose {
  state: MascotStateName;
  thinking?: boolean;
  facing: "left" | "right";
}

/** Screen geometry for a pet in a pose. Pure — safe to call during render. */
export function petLayout(pet: PetDescriptor, pose: PetPose, bodyPx = PET_BODY_PX): PetLayout {
  const grid = gridOf(pet);
  const { rowIndex, mirror } = petFrameFor(pose, pet.rows);
  const metrics = rowMetricsFor(pet, rowIndex);

  const scale = bodyPx / (pet.frameH || 1);
  const dispW = pet.frameW * scale;
  const dispH = pet.frameH * scale;

  const frames = Math.max(1, Math.min(metrics.frames, metrics.bottom.length));
  const offsets = metrics.bottom.slice(0, frames).map((b) => Math.round(b * scale));
  const headPx = Math.round(metrics.head * scale);
  const artInsetPx = Math.round(Math.min(metrics.left, metrics.right) * scale);

  const perRow = framesPerRow(grid);
  const loopMs = Math.max(1, Math.round((pet.loopMs * frames) / perRow));

  return { rowIndex, mirror, frames, scale, dispW, dispH, offsets, headPx, artInsetPx, loopMs };
}

/** djb2 — just enough to keep one row's keyframes from colliding with another's. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export interface PetKeyframes {
  name: string;
  css: string;
}

/**
 * The stepped animation for one row.
 *
 * Two properties move together: `background-position-x` selects the frame and
 * `bottom` carries that frame's own foot offset. They HAVE to be one animation
 * — a separate transform would not stay in phase with the frame selection, and
 * the whole point is that the drawn feet stay on the bar in every frame.
 *
 * Written as explicit stops under `step-end` rather than `steps(n)`, because
 * `steps()` can only interpolate one from/to pair and the offsets are not a
 * ramp. `step-end` holds each stop's value for its whole interval, which is
 * exactly frame-selection semantics.
 */
export function petKeyframes(layout: PetLayout): PetKeyframes {
  const { frames, dispW, offsets } = layout;
  const parts: string[] = [];
  for (let i = 0; i < frames; i++) {
    const pct = ((i * 100) / frames).toFixed(4).replace(/\.?0+$/, "");
    parts.push(`${pct || "0"}%{background-position-x:${-i * dispW}px;bottom:${-offsets[i]}px}`);
  }
  const last = frames - 1;
  parts.push(`100%{background-position-x:${-last * dispW}px;bottom:${-offsets[last]}px}`);
  const body = parts.join("");
  const name = `pet-frames-${frames}-${hash(body)}`;
  return { name, css: `@keyframes ${name}{${body}}` };
}

/** A closed horizontal interval, in viewport px. */
export interface Span {
  lo: number;
  hi: number;
}

/**
 * The widest stretch of `[lo, hi]` that no blocker covers.
 *
 * The pet's roaming lane comes from the shelf, but the desktop icon grid's
 * bottom padding is exactly the bar height — so its lowest icons stand in the
 * pet's band, and the left end of the lane sat on top of one, hiding it and
 * (at 104px of `pointer-events: auto`) swallowing its clicks. Subtracting what
 * actually intrudes is what keeps the two apart, at whatever width the grid
 * happens to be centred to.
 */
export function widestFreeSpan(lo: number, hi: number, blockers: Span[]): Span {
  const sorted = blockers.filter((b) => b.hi > b.lo).sort((a, b) => a.lo - b.lo);
  let best: Span = { lo, hi: lo };
  let cursor = lo;
  for (const b of sorted) {
    if (b.lo > cursor && b.lo - cursor > best.hi - best.lo) best = { lo: cursor, hi: Math.min(b.lo, hi) };
    cursor = Math.max(cursor, b.hi);
    if (cursor >= hi) break;
  }
  if (hi - cursor > best.hi - best.lo) best = { lo: cursor, hi };
  return best;
}
