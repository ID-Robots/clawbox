// The Screenshot editor's annotation model. Pure data and pure functions: an
// annotation is a plain object in IMAGE pixel coordinates, an editor document
// is the base bitmap's key plus the list drawn over it. Rendering lives in
// render.ts; nothing here touches a canvas, so hit testing, moving, cropping
// and step numbering are unit tested without a browser.

import {
  type Point,
  type Rect,
  type Size,
  clampRect,
  distance,
  distanceToSegment,
  expandRect,
  normalizeRect,
  rectContains,
  rectsIntersect,
  translateRect,
  unionRects,
} from "./geometry";

export const ANNOTATION_TYPES = [
  "arrow",
  "line",
  "rect",
  "ellipse",
  "pen",
  "highlighter",
  "text",
  "callout",
  "step",
  "blur",
  "pixelate",
  "emoji",
] as const;

export type AnnotationType = (typeof ANNOTATION_TYPES)[number];

interface AnnotationBase {
  id: string;
  color: string;
  strokeWidth: number;
}

export interface SegmentAnnotation extends AnnotationBase {
  type: "arrow" | "line";
  from: Point;
  to: Point;
}

export interface BoxAnnotation extends AnnotationBase {
  type: "rect" | "ellipse";
  rect: Rect;
}

export interface StrokeAnnotation extends AnnotationBase {
  type: "pen" | "highlighter";
  points: Point[];
}

export interface TextAnnotation extends AnnotationBase {
  type: "text";
  /** Top-left corner of the text block. */
  at: Point;
  text: string;
  fontSize: number;
}

export interface CalloutAnnotation extends AnnotationBase {
  type: "callout";
  /** Top-left corner of the bubble. */
  at: Point;
  /** What the bubble's tail points at. */
  tip: Point;
  text: string;
  fontSize: number;
}

export interface StepAnnotation extends AnnotationBase {
  type: "step";
  /** Centre of the marker. */
  at: Point;
  number: number;
  radius: number;
}

export interface EffectAnnotation extends AnnotationBase {
  type: "blur" | "pixelate";
  rect: Rect;
}

export interface EmojiAnnotation extends AnnotationBase {
  type: "emoji";
  /** Centre of the stamp. */
  at: Point;
  emoji: string;
  size: number;
}

export type Annotation =
  | SegmentAnnotation
  | BoxAnnotation
  | StrokeAnnotation
  | TextAnnotation
  | CalloutAnnotation
  | StepAnnotation
  | EffectAnnotation
  | EmojiAnnotation;

export interface AnnotationStyle {
  color: string;
  strokeWidth: number;
}

/** The palette offered in the toolbar. The first entry is the default. */
export const ANNOTATION_COLORS = [
  "#ef4444",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
  "#ffffff",
  "#111827",
] as const;

export const STROKE_WIDTHS = [2, 4, 6, 10, 16] as const;
export const DEFAULT_STYLE: AnnotationStyle = { color: ANNOTATION_COLORS[0], strokeWidth: 4 };

/** The stamps offered by the emoji tool. Plain Unicode: drawn with the device's own emoji font. */
export const EMOJI_STAMPS = ["👍", "👎", "✅", "❌", "⚠️", "❓", "⭐", "❤️", "🔥", "👀", "💡", "👉"] as const;

export const CALLOUT_PADDING = 10;
export const TEXT_LINE_HEIGHT = 1.25;
/** Longest text an annotation keeps: a pasted novel would only stall the renderer. */
export const MAX_TEXT_LENGTH = 2000;
/** Longest free-hand stroke kept; beyond it the stroke is thinned, not cut. */
export const MAX_STROKE_POINTS = 4000;

export function fontSizeFor(strokeWidth: number): number {
  return Math.round(12 + Math.max(1, strokeWidth) * 3);
}

export function stepRadiusFor(strokeWidth: number): number {
  return Math.round(10 + Math.max(1, strokeWidth) * 1.5);
}

export function emojiSizeFor(strokeWidth: number): number {
  return Math.round(24 + Math.max(1, strokeWidth) * 6);
}

/** The highlighter is a broad translucent band, not a thin line. */
export function highlighterWidthFor(strokeWidth: number): number {
  return Math.round(10 + Math.max(1, strokeWidth) * 3);
}

/** The side of one mosaic block, or the reach of the blur, for an effect area. */
export function effectStrengthFor(strokeWidth: number): number {
  return Math.round(6 + Math.max(1, strokeWidth) * 2);
}

let idCounter = 0;

/** crypto.randomUUID is absent on plain http, which is exactly where the box is usually opened. */
export function newAnnotationId(): string {
  idCounter += 1;
  return `a${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Width of one line of text. The renderer passes the canvas's own measure; tests use the estimate. */
export type TextMeasurer = (text: string, fontSize: number) => number;

export const estimateTextWidth: TextMeasurer = (text, fontSize) => {
  let units = 0;
  for (const ch of text) {
    // Wide scripts and emoji take about a full em, Latin text a little over half.
    units += ch.codePointAt(0)! > 0x2e7f ? 1 : 0.58;
  }
  return units * fontSize;
};

export function textLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

export function textBlockSize(text: string, fontSize: number, measure: TextMeasurer = estimateTextWidth): Size {
  const lines = textLines(text);
  let width = 0;
  for (const line of lines) width = Math.max(width, measure(line, fontSize));
  return { width: Math.max(width, fontSize * 0.5), height: lines.length * fontSize * TEXT_LINE_HEIGHT };
}

/** The bubble of a callout, without its tail. */
export function calloutBox(a: CalloutAnnotation, measure: TextMeasurer = estimateTextWidth): Rect {
  const block = textBlockSize(a.text, a.fontSize, measure);
  return {
    x: a.at.x,
    y: a.at.y,
    width: block.width + CALLOUT_PADDING * 2,
    height: block.height + CALLOUT_PADDING * 2,
  };
}

/** Black or white, whichever reads on `color` — for the number in a step marker and callout text. */
export function contrastColor(color: string): "#000000" | "#ffffff" {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return "#ffffff";
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Perceived luminance (ITU-R BT.601).
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#000000" : "#ffffff";
}

/** The box that contains everything the annotation paints. */
export function annotationBounds(a: Annotation, measure: TextMeasurer = estimateTextWidth): Rect {
  switch (a.type) {
    case "arrow":
    case "line": {
      // An arrow head is wider than its shaft.
      const pad = a.type === "arrow" ? a.strokeWidth * 2.5 + 4 : a.strokeWidth / 2;
      return expandRect(
        {
          x: Math.min(a.from.x, a.to.x),
          y: Math.min(a.from.y, a.to.y),
          width: Math.abs(a.to.x - a.from.x),
          height: Math.abs(a.to.y - a.from.y),
        },
        pad,
      );
    }
    case "rect":
    case "ellipse":
      return expandRect(normalizeRect(a.rect), a.strokeWidth / 2);
    case "blur":
    case "pixelate":
      return normalizeRect(a.rect);
    case "pen":
    case "highlighter": {
      const width = a.type === "highlighter" ? highlighterWidthFor(a.strokeWidth) : a.strokeWidth;
      const box = unionRects(a.points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })));
      return expandRect(box ?? { x: 0, y: 0, width: 0, height: 0 }, width / 2);
    }
    case "text": {
      const block = textBlockSize(a.text, a.fontSize, measure);
      return { x: a.at.x, y: a.at.y, width: block.width, height: block.height };
    }
    case "callout": {
      const box = calloutBox(a, measure);
      return unionRects([box, { x: a.tip.x, y: a.tip.y, width: 0, height: 0 }])!;
    }
    case "step":
      return { x: a.at.x - a.radius, y: a.at.y - a.radius, width: a.radius * 2, height: a.radius * 2 };
    case "emoji":
      return { x: a.at.x - a.size / 2, y: a.at.y - a.size / 2, width: a.size, height: a.size };
  }
}

/** Whether a press at `p` lands on the annotation. `tolerance` is the slack a finger needs. */
export function hitTest(
  a: Annotation,
  p: Point,
  tolerance = 6,
  measure: TextMeasurer = estimateTextWidth,
): boolean {
  switch (a.type) {
    case "arrow":
    case "line":
      return distanceToSegment(p, a.from, a.to) <= a.strokeWidth / 2 + tolerance;
    case "rect": {
      // An outline: the inside stays free, so what it frames can still be picked.
      const r = normalizeRect(a.rect);
      const reach = a.strokeWidth / 2 + tolerance;
      if (!rectContains(r, p, reach)) return false;
      const inner = expandRect(r, -reach);
      return inner.width <= 0 || inner.height <= 0 || !rectContains(inner, p);
    }
    case "ellipse": {
      const r = normalizeRect(a.rect);
      const rx = r.width / 2;
      const ry = r.height / 2;
      const reach = a.strokeWidth / 2 + tolerance;
      if (rx <= reach || ry <= reach) return rectContains(r, p, reach);
      const nx = (p.x - (r.x + rx)) / rx;
      const ny = (p.y - (r.y + ry)) / ry;
      return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry) <= reach;
    }
    case "pen":
    case "highlighter": {
      const width = a.type === "highlighter" ? highlighterWidthFor(a.strokeWidth) : a.strokeWidth;
      const reach = width / 2 + tolerance;
      if (a.points.length === 1) return distance(p, a.points[0]) <= reach;
      for (let i = 1; i < a.points.length; i++) {
        if (distanceToSegment(p, a.points[i - 1], a.points[i]) <= reach) return true;
      }
      return false;
    }
    case "callout":
      if (rectContains(calloutBox(a, measure), p, tolerance)) return true;
      return distanceToSegment(p, a.tip, boxAnchor(calloutBox(a, measure), a.tip)) <= tolerance + 2;
    case "step":
      return distance(p, a.at) <= a.radius + tolerance;
    case "text":
    case "emoji":
    case "blur":
    case "pixelate":
      return rectContains(annotationBounds(a, measure), p, tolerance);
  }
}

/** The point on `box`'s edge nearest to `target` — where a callout's tail leaves the bubble. */
export function boxAnchor(box: Rect, target: Point): Point {
  return {
    x: Math.min(Math.max(target.x, box.x), box.x + box.width),
    y: Math.min(Math.max(target.y, box.y), box.y + box.height),
  };
}

/** The topmost annotation under `p`: the last drawn wins, as it does on screen. */
export function findAnnotationAt(
  annotations: readonly Annotation[],
  p: Point,
  tolerance = 6,
  measure: TextMeasurer = estimateTextWidth,
): Annotation | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (hitTest(annotations[i], p, tolerance, measure)) return annotations[i];
  }
  return null;
}

function movePoint(p: Point, dx: number, dy: number): Point {
  return { x: p.x + dx, y: p.y + dy };
}

export function moveAnnotation<A extends Annotation>(a: A, dx: number, dy: number): A;
export function moveAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.type) {
    case "arrow":
    case "line":
      return { ...a, from: movePoint(a.from, dx, dy), to: movePoint(a.to, dx, dy) };
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
      return { ...a, rect: translateRect(a.rect, dx, dy) };
    case "pen":
    case "highlighter":
      return { ...a, points: a.points.map((p) => movePoint(p, dx, dy)) };
    case "callout":
      return { ...a, at: movePoint(a.at, dx, dy), tip: movePoint(a.tip, dx, dy) };
    case "text":
    case "step":
    case "emoji":
      return { ...a, at: movePoint(a.at, dx, dy) };
  }
}

function scalePoint(p: Point, sx: number, sy: number): Point {
  return { x: p.x * sx, y: p.y * sy };
}

/** The annotation as it should sit on the image after the image was resized by sx, sy. */
export function scaleAnnotation<A extends Annotation>(a: A, sx: number, sy?: number): A;
export function scaleAnnotation(a: Annotation, sx: number, sy = sx): Annotation {
  // Line weight and type follow the smaller factor, so a squashed image does not get fat strokes.
  const s = Math.min(sx, sy);
  const strokeWidth = Math.max(1, a.strokeWidth * s);
  switch (a.type) {
    case "arrow":
    case "line":
      return { ...a, strokeWidth, from: scalePoint(a.from, sx, sy), to: scalePoint(a.to, sx, sy) };
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
      return {
        ...a,
        strokeWidth,
        rect: { x: a.rect.x * sx, y: a.rect.y * sy, width: a.rect.width * sx, height: a.rect.height * sy },
      };
    case "pen":
    case "highlighter":
      return { ...a, strokeWidth, points: a.points.map((p) => scalePoint(p, sx, sy)) };
    case "text":
      return { ...a, strokeWidth, at: scalePoint(a.at, sx, sy), fontSize: Math.max(6, a.fontSize * s) };
    case "callout":
      return {
        ...a,
        strokeWidth,
        at: scalePoint(a.at, sx, sy),
        tip: scalePoint(a.tip, sx, sy),
        fontSize: Math.max(6, a.fontSize * s),
      };
    case "step":
      return { ...a, strokeWidth, at: scalePoint(a.at, sx, sy), radius: Math.max(4, a.radius * s) };
    case "emoji":
      return { ...a, strokeWidth, at: scalePoint(a.at, sx, sy), size: Math.max(8, a.size * s) };
  }
}

/** A new colour or weight for an existing annotation; sizes derived from the weight follow it. */
export function restyleAnnotation<A extends Annotation>(a: A, style: Partial<AnnotationStyle>): A;
export function restyleAnnotation(a: Annotation, style: Partial<AnnotationStyle>): Annotation {
  const color = style.color ?? a.color;
  const strokeWidth = style.strokeWidth ?? a.strokeWidth;
  const next = { ...a, color, strokeWidth };
  if (style.strokeWidth === undefined || style.strokeWidth === a.strokeWidth) return next;
  switch (next.type) {
    case "text":
    case "callout":
      return { ...next, fontSize: fontSizeFor(strokeWidth) };
    case "step":
      return { ...next, radius: stepRadiusFor(strokeWidth) };
    case "emoji":
      return { ...next, size: emojiSizeFor(strokeWidth) };
    default:
      return next;
  }
}

/** One more than the highest marker on the image, so a deleted step's number is not reused mid-sequence. */
export function nextStepNumber(annotations: readonly Annotation[]): number {
  let highest = 0;
  for (const a of annotations) {
    if (a.type === "step" && a.number > highest) highest = a.number;
  }
  return highest + 1;
}

/**
 * Whether a finished gesture left something worth keeping. A press without a
 * drag must not litter the image with zero-length arrows and empty boxes.
 */
export function isMeaningful(a: Annotation): boolean {
  switch (a.type) {
    case "arrow":
    case "line":
      return distance(a.from, a.to) >= 4;
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate": {
      const r = normalizeRect(a.rect);
      return r.width >= 4 && r.height >= 4;
    }
    case "pen":
    case "highlighter":
      return a.points.length >= 1;
    case "text":
    case "callout":
      return a.text.trim().length > 0;
    case "step":
      return a.radius > 0;
    case "emoji":
      return a.emoji.length > 0;
  }
}

/** Free-hand input thinned to points at least `minDistance` apart, and to MAX_STROKE_POINTS at most. */
export function simplifyStroke(points: readonly Point[], minDistance = 1.5): Point[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const kept: Point[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    if (distance(points[i], kept[kept.length - 1]) >= minDistance) kept.push({ ...points[i] });
  }
  kept.push({ ...points[points.length - 1] });
  if (kept.length <= MAX_STROKE_POINTS) return kept;
  const step = kept.length / MAX_STROKE_POINTS;
  const thinned: Point[] = [];
  for (let i = 0; i < MAX_STROKE_POINTS - 1; i++) thinned.push(kept[Math.floor(i * step)]);
  thinned.push(kept[kept.length - 1]);
  return thinned;
}

export function clampText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  return normalized.length > MAX_TEXT_LENGTH ? normalized.slice(0, MAX_TEXT_LENGTH) : normalized;
}

// ── The editor document ─────────────────────────────────────────────────────

/**
 * What the editor shows and what undo / redo step through. `image` names the
 * base bitmap (kept outside the document — a canvas is not a value); a crop or
 * a resize produces a new bitmap and therefore a new key.
 */
export interface EditorDoc {
  image: string;
  width: number;
  height: number;
  annotations: readonly Annotation[];
}

export function createDoc(image: string, size: Size): EditorDoc {
  return { image, width: size.width, height: size.height, annotations: [] };
}

export function addAnnotation(doc: EditorDoc, a: Annotation): EditorDoc {
  return { ...doc, annotations: [...doc.annotations, a] };
}

/** Replaces the annotation with the same id. A document that does not hold it is returned unchanged. */
export function updateAnnotation(doc: EditorDoc, next: Annotation): EditorDoc {
  const index = doc.annotations.findIndex((a) => a.id === next.id);
  if (index < 0 || doc.annotations[index] === next) return doc;
  const annotations = doc.annotations.slice();
  annotations[index] = next;
  return { ...doc, annotations };
}

export function removeAnnotation(doc: EditorDoc, id: string): EditorDoc {
  if (!doc.annotations.some((a) => a.id === id)) return doc;
  return { ...doc, annotations: doc.annotations.filter((a) => a.id !== id) };
}

export function clearAnnotations(doc: EditorDoc): EditorDoc {
  return doc.annotations.length === 0 ? doc : { ...doc, annotations: [] };
}

export function getAnnotation(doc: EditorDoc, id: string | null): Annotation | null {
  if (!id) return null;
  return doc.annotations.find((a) => a.id === id) ?? null;
}

/**
 * The document after cropping to `crop` (image pixels): the new bitmap's key,
 * the annotations shifted into its coordinates, and those left wholly outside
 * dropped — they would otherwise come back as invisible things to trip over.
 */
export function cropDoc(
  doc: EditorDoc,
  crop: Rect,
  image: string,
  measure: TextMeasurer = estimateTextWidth,
): EditorDoc {
  const area = clampRect(
    {
      x: Math.round(crop.x),
      y: Math.round(crop.y),
      width: Math.round(crop.width),
      height: Math.round(crop.height),
    },
    doc,
  );
  if (area.width < 1 || area.height < 1) return doc;
  const annotations = doc.annotations
    .filter((a) => rectsIntersect(annotationBounds(a, measure), area))
    .map((a) => moveAnnotation(a, -area.x, -area.y));
  return { image, width: area.width, height: area.height, annotations };
}

/** The document after the image was resized to `size`; annotations keep their place on it. */
export function resizeDoc(doc: EditorDoc, size: Size, image: string): EditorDoc {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const sx = width / Math.max(1, doc.width);
  const sy = height / Math.max(1, doc.height);
  return { image, width, height, annotations: doc.annotations.map((a) => scaleAnnotation(a, sx, sy)) };
}
