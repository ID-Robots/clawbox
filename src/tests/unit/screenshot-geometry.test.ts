/**
 * Region and viewport maths of the Screenshot app (TASK-1475): what a drag
 * selects, how it maps onto the bitmap, and how zoom and resize are bounded.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_SIDE,
  MAX_ZOOM,
  MIN_ZOOM,
  captureScale,
  clampPoint,
  clampRect,
  clampZoom,
  distanceToSegment,
  expandRect,
  fitZoom,
  formatSize,
  isUsableRegion,
  normalizeRect,
  rectContains,
  rectFromPoints,
  rectsIntersect,
  resizeDimensions,
  scaleRect,
  stepZoom,
  toPixelRect,
  translateRect,
  unionRects,
} from "@/lib/screenshot/geometry";

describe("region selection", () => {
  it("spans two corners whichever way the drag went", () => {
    const expected = { x: 10, y: 20, width: 30, height: 40 };
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected);
    expect(rectFromPoints({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected);
    expect(rectFromPoints({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected);
  });

  it("treats a non-finite coordinate as zero instead of poisoning the rect", () => {
    expect(rectFromPoints({ x: Number.NaN, y: 5 }, { x: 10, y: Number.POSITIVE_INFINITY })).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 5,
    });
  });

  it("normalizes a rect with negative extent", () => {
    expect(normalizeRect({ x: 50, y: 50, width: -20, height: -10 })).toEqual({ x: 30, y: 40, width: 20, height: 10 });
  });

  it("keeps only the part of a selection that is on screen", () => {
    const viewport = { width: 100, height: 80 };
    expect(clampRect({ x: -10, y: -10, width: 50, height: 50 }, viewport)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(clampRect({ x: 90, y: 70, width: 50, height: 50 }, viewport)).toEqual({ x: 90, y: 70, width: 10, height: 10 });
    expect(clampRect({ x: 200, y: 200, width: 50, height: 50 }, viewport)).toMatchObject({ width: 0, height: 0 });
  });

  it("clamps a point into the bounds", () => {
    expect(clampPoint({ x: -5, y: 500 }, { width: 100, height: 80 })).toEqual({ x: 0, y: 80 });
  });

  it("tells a click from a drag", () => {
    expect(isUsableRegion({ width: 3, height: 200 })).toBe(false);
    expect(isUsableRegion({ width: 8, height: 8 })).toBe(true);
    expect(isUsableRegion({ width: 2, height: 2 }, 2)).toBe(true);
  });

  it("maps a CSS-pixel region onto whole bitmap pixels", () => {
    expect(toPixelRect({ x: 10, y: 20, width: 30, height: 40 }, 2, { width: 400, height: 400 })).toEqual({
      x: 20,
      y: 40,
      width: 60,
      height: 80,
    });
  });

  it("rounds the edges, so two touching regions still touch in the bitmap", () => {
    const bitmap = { width: 1000, height: 1000 };
    const left = toPixelRect({ x: 0, y: 0, width: 33.3, height: 10 }, 1.5, bitmap);
    const right = toPixelRect({ x: 33.3, y: 0, width: 33.3, height: 10 }, 1.5, bitmap);
    expect(left.x + left.width).toBe(right.x);
  });

  it("never reaches outside the bitmap", () => {
    expect(toPixelRect({ x: 90, y: 90, width: 50, height: 50 }, 2, { width: 200, height: 200 })).toEqual({
      x: 180,
      y: 180,
      width: 20,
      height: 20,
    });
    expect(toPixelRect({ x: -5, y: -5, width: 10, height: 10 }, 1, { width: 200, height: 200 })).toEqual({
      x: 0,
      y: 0,
      width: 5,
      height: 5,
    });
  });

  it("falls back to a scale of one for a nonsense scale", () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(toPixelRect(rect, 0, { width: 50, height: 50 })).toEqual(rect);
    expect(toPixelRect(rect, Number.NaN, { width: 50, height: 50 })).toEqual(rect);
  });

  it("formats the live readout in bitmap pixels", () => {
    expect(formatSize({ width: 320, height: 240 })).toBe("320 × 240");
    expect(formatSize({ width: 320.4, height: 240.6 }, 2)).toBe("641 × 481");
  });
});

describe("rect helpers", () => {
  it("scales, translates and expands", () => {
    const rect = { x: 2, y: 4, width: 6, height: 8 };
    expect(scaleRect(rect, 2)).toEqual({ x: 4, y: 8, width: 12, height: 16 });
    expect(scaleRect(rect, 2, 0.5)).toEqual({ x: 4, y: 2, width: 12, height: 4 });
    expect(translateRect(rect, -2, 1)).toEqual({ x: 0, y: 5, width: 6, height: 8 });
    expect(expandRect(rect, 1)).toEqual({ x: 1, y: 3, width: 8, height: 10 });
  });

  it("tests containment with slack", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectContains(rect, { x: 10, y: 10 })).toBe(true);
    expect(rectContains(rect, { x: 12, y: 5 })).toBe(false);
    expect(rectContains(rect, { x: 12, y: 5 }, 3)).toBe(true);
  });

  it("tests intersection; rects that only share an edge do not intersect", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it("unions rects", () => {
    expect(unionRects([])).toBeNull();
    expect(
      unionRects([
        { x: 0, y: 0, width: 2, height: 2 },
        { x: 10, y: 5, width: 5, height: 5 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 15, height: 10 });
  });

  it("measures the distance to a segment, not to its infinite line", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distanceToSegment({ x: 5, y: 3 }, a, b)).toBe(3);
    expect(distanceToSegment({ x: 14, y: 3 }, a, b)).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, a, a)).toBe(5);
  });
});

describe("zoom", () => {
  it("clamps to the supported range and repairs nonsense", () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(-2)).toBe(1);
  });

  it("fits a picture inside the view without enlarging it", () => {
    expect(fitZoom({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.5);
    expect(fitZoom({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
    expect(fitZoom({ width: 100, height: 100 }, { width: 1000, height: 1000 }, 4)).toBe(4);
    expect(fitZoom({ width: 0, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
    expect(fitZoom({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1);
  });

  it("steps through the stops in both directions", () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.6, 1)).toBe(0.75);
    expect(stepZoom(0.6, -1)).toBe(0.5);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe("resize", () => {
  const original = { width: 1600, height: 900 };

  it("follows the typed side when the proportions are locked", () => {
    expect(resizeDimensions(original, { width: 800 }, true)).toEqual({ width: 800, height: 450 });
    expect(resizeDimensions(original, { height: 300 }, true)).toEqual({ width: 533, height: 300 });
  });

  it("takes both sides as typed when they are not", () => {
    expect(resizeDimensions(original, { width: 100, height: 700 }, false)).toEqual({ width: 100, height: 700 });
    expect(resizeDimensions(original, { width: 100 }, false)).toEqual({ width: 100, height: 900 });
  });

  it("keeps every side inside 1 … MAX_IMAGE_SIDE, and the ratio when the cap binds", () => {
    expect(resizeDimensions(original, { width: 100_000 }, true)).toEqual({ width: MAX_IMAGE_SIDE, height: 4608 });
    expect(resizeDimensions(original, { width: 0, height: -5 }, false)).toEqual({ width: 1, height: 1 });
    expect(resizeDimensions(original, { width: Number.NaN }, true)).toEqual(original);
    const tiny = resizeDimensions(original, { width: 0 }, true);
    expect(tiny.width).toBeGreaterThanOrEqual(1);
    expect(tiny.height).toBeGreaterThanOrEqual(1);
  });
});

describe("capture scale", () => {
  it("uses the device pixel ratio while the bitmap stays inside the budget", () => {
    expect(captureScale({ width: 1280, height: 800 }, 2)).toBe(2);
    expect(captureScale({ width: 1280, height: 800 }, 1)).toBe(1);
  });

  it("caps a phone's ratio and a huge viewport", () => {
    expect(captureScale({ width: 390, height: 844 }, 5)).toBe(3);
    const scale = captureScale({ width: 3840, height: 2160 }, 2, 8_000_000);
    expect(scale).toBeLessThan(1);
    expect(3840 * scale * 2160 * scale).toBeLessThanOrEqual(8_000_001);
  });

  it("never drops below half, and repairs a missing ratio", () => {
    expect(captureScale({ width: 100_000, height: 100_000 }, 2)).toBe(0.5);
    expect(captureScale({ width: 100, height: 100 }, Number.NaN)).toBe(1);
  });
});
