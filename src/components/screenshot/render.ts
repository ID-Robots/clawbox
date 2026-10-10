// Canvas rendering for the Screenshot editor: draws an EditorDoc's annotations
// over its base bitmap, and produces the flattened image that is saved. The
// same code paints the editor and the export, so what is saved is what was on
// screen. Browser-only (needs a 2D canvas); the model it draws is in
// annotations.ts.

import {
  type Annotation,
  type CalloutAnnotation,
  type EditorDoc,
  type EffectAnnotation,
  type TextMeasurer,
  CALLOUT_PADDING,
  TEXT_LINE_HEIGHT,
  annotationBounds,
  boxAnchor,
  calloutBox,
  contrastColor,
  effectStrengthFor,
  highlighterWidthFor,
  textLines,
} from "@/lib/screenshot/annotations";
import { type Rect, type Size, clampRect, expandRect, normalizeRect, rectCenter } from "@/lib/screenshot/geometry";

export type Bitmap = HTMLCanvasElement;

export const TEXT_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
export const EMOJI_FONT_FAMILY = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export function textFont(fontSize: number): string {
  return `600 ${fontSize}px ${TEXT_FONT_FAMILY}`;
}

export function createBitmap(width: number, height: number): Bitmap {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  return ctx;
}

/** Text width as the canvas will really draw it, so hit boxes match the glyphs. */
export function canvasMeasurer(ctx: CanvasRenderingContext2D): TextMeasurer {
  return (text, fontSize) => {
    ctx.save();
    ctx.font = textFont(fontSize);
    const width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  };
}

let sharedMeasureCtx: CanvasRenderingContext2D | null = null;

/** A measurer that needs no canvas of the caller's own — for hit testing outside a paint. */
export function sharedMeasurer(): TextMeasurer {
  if (!sharedMeasureCtx) sharedMeasureCtx = context(createBitmap(1, 1));
  return canvasMeasurer(sharedMeasureCtx);
}

function drawArrow(ctx: CanvasRenderingContext2D, a: Extract<Annotation, { type: "arrow" | "line" }>) {
  const { from, to, strokeWidth } = a;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (a.type === "line" || length < 1) {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    return;
  }
  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(length, Math.max(12, strokeWidth * 4));
  const half = Math.max(6, strokeWidth * 2);
  // The shaft stops inside the head so its round cap does not blunt the point.
  const baseX = to.x - ux * head;
  const baseY = to.y - uy * head;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(baseX + ux * Math.min(head / 2, strokeWidth), baseY + uy * Math.min(head / 2, strokeWidth));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(baseX - uy * half, baseY + ux * half);
  ctx.lineTo(baseX + uy * half, baseY - ux * half);
  ctx.closePath();
  ctx.fill();
}

function drawStroke(ctx: CanvasRenderingContext2D, a: Extract<Annotation, { type: "pen" | "highlighter" }>) {
  const points = a.points;
  if (points.length === 0) return;
  const highlighter = a.type === "highlighter";
  const width = highlighter ? highlighterWidthFor(a.strokeWidth) : a.strokeWidth;
  if (highlighter) {
    ctx.globalAlpha = 0.4;
    // A marker tints what is under it instead of painting it over.
    ctx.globalCompositeOperation = "multiply";
  }
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = width;
  ctx.lineCap = highlighter ? "butt" : "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    ctx.beginPath();
    if (highlighter) ctx.rect(points[0].x - width / 2, points[0].y - width / 2, width, width);
    else ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  // Curves through the midpoints: the stroke bends instead of cornering at every sample.
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  outline: boolean,
) {
  ctx.font = textFont(fontSize);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const lineHeight = fontSize * TEXT_LINE_HEIGHT;
  const lines = textLines(text);
  for (let i = 0; i < lines.length; i++) {
    const lineY = y + lineHeight * (i + 0.5);
    if (outline) {
      // A thin halo keeps the words readable on a background of their own colour.
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, fontSize / 7);
      ctx.strokeStyle = contrastColor(color) === "#000000" ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.7)";
      ctx.strokeText(lines[i], x, lineY);
    }
    ctx.fillStyle = color;
    ctx.fillText(lines[i], x, lineY);
  }
}

function roundedRectPath(ctx: CanvasRenderingContext2D, r: Rect, radius: number) {
  const rad = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.width, r.y, r.x + r.width, r.y + r.height, rad);
  ctx.arcTo(r.x + r.width, r.y + r.height, r.x, r.y + r.height, rad);
  ctx.arcTo(r.x, r.y + r.height, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.width, r.y, rad);
  ctx.closePath();
}

function drawCallout(ctx: CanvasRenderingContext2D, a: CalloutAnnotation, measure: TextMeasurer) {
  const box = calloutBox(a, measure);
  const anchor = boxAnchor(box, a.tip);
  const centre = rectCenter(box);
  ctx.fillStyle = a.color;
  // The tail: a wedge from the bubble towards what it points at.
  const dx = a.tip.x - centre.x;
  const dy = a.tip.y - centre.y;
  const length = Math.hypot(dx, dy);
  if (length > 0 && (anchor.x !== a.tip.x || anchor.y !== a.tip.y)) {
    const half = Math.max(6, Math.min(box.width, box.height) / 4);
    const nx = -dy / length;
    const ny = dx / length;
    ctx.beginPath();
    ctx.moveTo(a.tip.x, a.tip.y);
    ctx.lineTo(centre.x + nx * half, centre.y + ny * half);
    ctx.lineTo(centre.x - nx * half, centre.y - ny * half);
    ctx.closePath();
    ctx.fill();
  }
  roundedRectPath(ctx, box, 8);
  ctx.fill();
  drawTextBlock(ctx, a.text, box.x + CALLOUT_PADDING, box.y + CALLOUT_PADDING, a.fontSize, contrastColor(a.color), false);
}

/** Destructive by construction: the detail is thrown away when the area is shrunk, not merely covered. */
function drawEffect(ctx: CanvasRenderingContext2D, a: EffectAnnotation, base: Bitmap) {
  const area = normalizeRect(a.rect);
  const r = clampRect(
    {
      x: Math.floor(area.x),
      y: Math.floor(area.y),
      width: Math.ceil(area.width),
      height: Math.ceil(area.height),
    },
    base,
  );
  if (r.width < 1 || r.height < 1) return;
  const strength = effectStrengthFor(a.strokeWidth);
  if (a.type === "pixelate") {
    const cols = Math.max(1, Math.ceil(r.width / strength));
    const rows = Math.max(1, Math.ceil(r.height / strength));
    const small = shrink(base, r, cols, rows);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, cols, rows, r.x, r.y, r.width, r.height);
    ctx.imageSmoothingEnabled = true;
    return;
  }
  const cols = Math.max(1, Math.ceil(r.width / strength));
  const rows = Math.max(1, Math.ceil(r.height / strength));
  let current = shrink(base, r, cols, rows);
  // Grown back in doublings: each pass smooths the last, which reads as a blur
  // rather than as the soft squares one big stretch would leave.
  while (current.width < r.width || current.height < r.height) {
    const w = Math.min(r.width, current.width * 2);
    const h = Math.min(r.height, current.height * 2);
    const next = createBitmap(w, h);
    const nctx = context(next);
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = "high";
    nctx.drawImage(current, 0, 0, current.width, current.height, 0, 0, w, h);
    current = next;
  }
  ctx.drawImage(current, 0, 0, current.width, current.height, r.x, r.y, r.width, r.height);
}

/** `area` of `base` averaged down to cols × rows, by halving so every source pixel counts. */
function shrink(base: Bitmap, area: Rect, cols: number, rows: number): Bitmap {
  let current = createBitmap(area.width, area.height);
  context(current).drawImage(base, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
  while (current.width > cols || current.height > rows) {
    const w = Math.max(cols, Math.ceil(current.width / 2));
    const h = Math.max(rows, Math.ceil(current.height / 2));
    const next = createBitmap(w, h);
    const nctx = context(next);
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = "high";
    nctx.drawImage(current, 0, 0, current.width, current.height, 0, 0, w, h);
    current = next;
  }
  return current;
}

export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  base: Bitmap,
  measure: TextMeasurer = canvasMeasurer(ctx),
): void {
  ctx.save();
  switch (a.type) {
    case "arrow":
    case "line":
      drawArrow(ctx, a);
      break;
    case "rect": {
      const r = normalizeRect(a.rect);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.strokeWidth;
      ctx.lineJoin = "round";
      ctx.strokeRect(r.x, r.y, r.width, r.height);
      break;
    }
    case "ellipse": {
      const r = normalizeRect(a.rect);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.strokeWidth;
      ctx.beginPath();
      ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "pen":
    case "highlighter":
      drawStroke(ctx, a);
      break;
    case "text":
      drawTextBlock(ctx, a.text, a.at.x, a.at.y, a.fontSize, a.color, true);
      break;
    case "callout":
      drawCallout(ctx, a, measure);
      break;
    case "step": {
      ctx.beginPath();
      ctx.arc(a.at.x, a.at.y, a.radius, 0, Math.PI * 2);
      ctx.fillStyle = a.color;
      ctx.fill();
      ctx.lineWidth = Math.max(2, a.radius / 7);
      ctx.strokeStyle = contrastColor(a.color);
      ctx.stroke();
      ctx.fillStyle = contrastColor(a.color);
      const label = String(a.number);
      const size = a.radius * (label.length > 2 ? 0.8 : label.length > 1 ? 1 : 1.2);
      ctx.font = `700 ${size}px ${TEXT_FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, a.at.x, a.at.y + size * 0.04);
      break;
    }
    case "emoji":
      ctx.font = `${a.size * 0.86}px ${EMOJI_FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#000000";
      ctx.fillText(a.emoji, a.at.x, a.at.y + a.size * 0.04);
      break;
    case "blur":
    case "pixelate":
      drawEffect(ctx, a, base);
      break;
  }
  ctx.restore();
}

function isEffect(a: Annotation): a is EffectAnnotation {
  return a.type === "blur" || a.type === "pixelate";
}

/**
 * Paints the document: the base bitmap, then the blur / pixelate areas (they
 * rework the picture itself), then everything drawn on top of it — so a mark
 * placed over a blurred area is not swallowed by the blur.
 */
export function renderDoc(target: HTMLCanvasElement, base: Bitmap, doc: EditorDoc): void {
  if (target.width !== doc.width) target.width = doc.width;
  if (target.height !== doc.height) target.height = doc.height;
  const ctx = context(target);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(base, 0, 0);
  const measure = canvasMeasurer(ctx);
  for (const a of doc.annotations) if (isEffect(a)) drawAnnotation(ctx, a, base, measure);
  for (const a of doc.annotations) if (!isEffect(a)) drawAnnotation(ctx, a, base, measure);
}

/** The image as it will be saved: one bitmap with every annotation burnt in. */
export function flattenDoc(base: Bitmap, doc: EditorDoc): Bitmap {
  const out = createBitmap(doc.width, doc.height);
  renderDoc(out, base, doc);
  return out;
}

/** The dashed frame around the selected annotation. `zoom` keeps it one screen pixel wide. */
export function drawSelection(ctx: CanvasRenderingContext2D, a: Annotation, zoom: number): void {
  const pad = 4 / zoom;
  const box = expandRect(annotationBounds(a, canvasMeasurer(ctx)), pad);
  ctx.save();
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeStyle = "#2563eb";
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.restore();
}

export function cropBitmap(source: CanvasImageSource & Size, rect: Rect): Bitmap {
  const area = clampRect(
    { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    source,
  );
  const out = createBitmap(Math.max(1, area.width), Math.max(1, area.height));
  context(out).drawImage(source, area.x, area.y, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export function resizeBitmap(source: Bitmap, size: Size): Bitmap {
  const out = createBitmap(size.width, size.height);
  const ctx = context(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, out.width, out.height);
  return out;
}

export type ImageFormat = "png" | "jpg";

export function mimeFor(format: ImageFormat): "image/png" | "image/jpeg" {
  return format === "jpg" ? "image/jpeg" : "image/png";
}

/** The canvas encoded as a file. JPEG has no transparency, so it is laid on white first. */
export function bitmapToBlob(bitmap: Bitmap, format: ImageFormat, quality = 0.92): Promise<Blob> {
  let source = bitmap;
  if (format === "jpg") {
    source = createBitmap(bitmap.width, bitmap.height);
    const ctx = context(source);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, source.width, source.height);
    ctx.drawImage(bitmap, 0, 0);
  }
  return new Promise((resolve, reject) => {
    source.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded"))),
      mimeFor(format),
      format === "jpg" ? quality : undefined,
    );
  });
}

/** Decodes an image file into a bitmap the editor can draw on. */
export async function blobToBitmap(blob: Blob): Promise<Bitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The image could not be decoded"));
      img.src = url;
    });
    const out = createBitmap(img.naturalWidth || 1, img.naturalHeight || 1);
    context(out).drawImage(img, 0, 0);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}
