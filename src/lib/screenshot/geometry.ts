// Region and viewport maths for the Screenshot app. Pure: no DOM, no canvas,
// so the selection overlay, the cropper and the zoom control can all be
// reasoned about (and unit tested) without a browser.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** A drag that ends closer than this to where it began is a click, not a region. */
export const MIN_REGION_SIZE = 8;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** The stops the zoom buttons step through; the wheel and "fit" land between them. */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;

/** The largest side an image may be resized to: a canvas this big still allocates on a tablet. */
export const MAX_IMAGE_SIDE = 8192;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** The rectangle spanned by two corners, whichever way the drag went. */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x1 = finite(a.x);
  const y1 = finite(a.y);
  const x2 = finite(b.x);
  const y2 = finite(b.y);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** A rectangle with a negative width or height, turned the right way round. */
export function normalizeRect(rect: Rect): Rect {
  return rectFromPoints(
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  );
}

export function clampPoint(point: Point, bounds: Size): Point {
  return {
    x: Math.min(Math.max(finite(point.x), 0), Math.max(0, bounds.width)),
    y: Math.min(Math.max(finite(point.y), 0), Math.max(0, bounds.height)),
  };
}

/** The part of `rect` that lies inside `0,0 … bounds`; an empty rect when none does. */
export function clampRect(rect: Rect, bounds: Size): Rect {
  const r = normalizeRect(rect);
  const left = Math.min(Math.max(r.x, 0), Math.max(0, bounds.width));
  const top = Math.min(Math.max(r.y, 0), Math.max(0, bounds.height));
  const right = Math.min(Math.max(r.x + r.width, 0), Math.max(0, bounds.width));
  const bottom = Math.min(Math.max(r.y + r.height, 0), Math.max(0, bounds.height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function isUsableRegion(rect: Size, min = MIN_REGION_SIZE): boolean {
  return rect.width >= min && rect.height >= min;
}

export function scaleRect(rect: Rect, sx: number, sy = sx): Rect {
  return { x: rect.x * sx, y: rect.y * sy, width: rect.width * sx, height: rect.height * sy };
}

export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/**
 * A region in CSS pixels as whole bitmap pixels. The edges are rounded
 * independently (not x and width), so two regions that touch on screen still
 * touch in the bitmap, and the result never reaches outside the bitmap.
 */
export function toPixelRect(rect: Rect, scale: number, bitmap: Size): Rect {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const r = normalizeRect(rect);
  const maxW = Math.max(0, Math.floor(bitmap.width));
  const maxH = Math.max(0, Math.floor(bitmap.height));
  const left = Math.min(Math.max(Math.round(r.x * s), 0), maxW);
  const top = Math.min(Math.max(Math.round(r.y * s), 0), maxH);
  const right = Math.min(Math.max(Math.round((r.x + r.width) * s), 0), maxW);
  const bottom = Math.min(Math.max(Math.round((r.y + r.height) * s), 0), maxH);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function rectContains(rect: Rect, point: Point, pad = 0): boolean {
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.width + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.height + pad
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function expandRect(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** How far `p` is from the segment a–b (not from the infinite line through it). */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** "640 × 480" — the live readout beside the selection, in bitmap pixels. */
export function formatSize(size: Size, scale = 1): string {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  return `${Math.round(size.width * s)} × ${Math.round(size.height * s)}`;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The zoom at which `content` fits inside `viewport`, never enlarging past `maxZoom`. */
export function fitZoom(content: Size, viewport: Size, maxZoom = 1): number {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  const zoom = Math.min(viewport.width / content.width, viewport.height / content.height, maxZoom);
  return clampZoom(zoom);
}

/** The next stop above (`direction` 1) or below (-1) the current zoom. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const current = clampZoom(zoom);
  const epsilon = 1e-6;
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > current + epsilon) ?? MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < current - epsilon) return ZOOM_STEPS[i];
  }
  return MIN_ZOOM;
}

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_IMAGE_SIDE, Math.max(1, Math.round(value)));
}

/**
 * The size an image is resized to when the owner types one side. With the
 * aspect ratio locked the other side follows; both stay whole pixels inside
 * 1 … MAX_IMAGE_SIDE, and the ratio is kept when the cap is what binds.
 */
export function resizeDimensions(
  original: Size,
  requested: { width?: number; height?: number },
  keepAspect: boolean,
): Size {
  const ow = Math.max(1, original.width);
  const oh = Math.max(1, original.height);
  if (!keepAspect) {
    return {
      width: clampSide(requested.width ?? ow),
      height: clampSide(requested.height ?? oh),
    };
  }
  let factor = 1;
  if (requested.width !== undefined && Number.isFinite(requested.width)) factor = requested.width / ow;
  else if (requested.height !== undefined && Number.isFinite(requested.height)) factor = requested.height / oh;
  if (!(factor > 0)) factor = 1 / Math.max(ow, oh);
  factor = Math.min(factor, MAX_IMAGE_SIDE / ow, MAX_IMAGE_SIDE / oh);
  return { width: clampSide(ow * factor), height: clampSide(oh * factor) };
}

/**
 * The scale a capture is rendered at. A phone reports a device pixel ratio of
 * 3 or more; rendering the whole desktop at that would allocate a bitmap the
 * browser refuses, so the ratio is capped by a total pixel budget.
 */
export function captureScale(viewport: Size, devicePixelRatio: number, maxPixels = 16_000_000): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const area = Math.max(1, viewport.width * viewport.height);
  const budget = Math.sqrt(maxPixels / area);
  return Math.max(0.5, Math.min(dpr, 3, budget));
}
