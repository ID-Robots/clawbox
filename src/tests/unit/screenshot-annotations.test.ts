/**
 * The Screenshot editor's annotation model (TASK-1475): hit testing, moving,
 * restyling, step numbering, and what a crop or a resize does to a document —
 * together with the undo / redo that steps through documents.
 */
import { describe, expect, it } from "vitest";
import {
  type Annotation,
  type EditorDoc,
  ANNOTATION_TYPES,
  CALLOUT_PADDING,
  MAX_STROKE_POINTS,
  MAX_TEXT_LENGTH,
  addAnnotation,
  annotationBounds,
  boxAnchor,
  calloutBox,
  clampText,
  clearAnnotations,
  contrastColor,
  createDoc,
  cropDoc,
  emojiSizeFor,
  findAnnotationAt,
  fontSizeFor,
  getAnnotation,
  hitTest,
  isMeaningful,
  moveAnnotation,
  newAnnotationId,
  nextStepNumber,
  removeAnnotation,
  resizeDoc,
  restyleAnnotation,
  scaleAnnotation,
  simplifyStroke,
  stepRadiusFor,
  textBlockSize,
  textLines,
  updateAnnotation,
} from "@/lib/screenshot/annotations";
import { createHistory, pushHistory, redo, undo } from "@/lib/screenshot/history";

const style = { color: "#ef4444", strokeWidth: 4 };

const arrow: Annotation = { id: "arrow", type: "arrow", ...style, from: { x: 10, y: 10 }, to: { x: 110, y: 10 } };
const line: Annotation = { id: "line", type: "line", ...style, from: { x: 0, y: 0 }, to: { x: 0, y: 100 } };
const rect: Annotation = { id: "rect", type: "rect", ...style, rect: { x: 100, y: 100, width: 200, height: 100 } };
const ellipse: Annotation = { id: "ellipse", type: "ellipse", ...style, rect: { x: 0, y: 0, width: 200, height: 100 } };
const pen: Annotation = { id: "pen", type: "pen", ...style, points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }] };
const marker: Annotation = { id: "marker", type: "highlighter", ...style, points: [{ x: 0, y: 200 }, { x: 100, y: 200 }] };
const text: Annotation = { id: "text", type: "text", ...style, at: { x: 20, y: 300 }, text: "Hello\nworld!", fontSize: 20 };
const callout: Annotation = { id: "callout", type: "callout", ...style, at: { x: 300, y: 300 }, tip: { x: 250, y: 400 }, text: "Look", fontSize: 20 };
const step: Annotation = { id: "step", type: "step", ...style, at: { x: 500, y: 50 }, number: 1, radius: 16 };
const blur: Annotation = { id: "blur", type: "blur", ...style, rect: { x: 400, y: 400, width: 100, height: 50 } };
const pixelate: Annotation = { id: "pixelate", type: "pixelate", ...style, rect: { x: 600, y: 400, width: 100, height: 50 } };
const emoji: Annotation = { id: "emoji", type: "emoji", ...style, at: { x: 700, y: 100 }, emoji: "👍", size: 48 };

const all = [arrow, line, rect, ellipse, pen, marker, text, callout, step, blur, pixelate, emoji];

describe("annotation model", () => {
  it("covers every tool the editor offers", () => {
    expect(new Set(all.map((a) => a.type))).toEqual(new Set(ANNOTATION_TYPES));
  });

  it("gives every new annotation its own id without needing a secure context", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAnnotationId()));
    expect(ids.size).toBe(200);
  });

  it("derives sizes from the line width, growing with it", () => {
    expect(fontSizeFor(8)).toBeGreaterThan(fontSizeFor(2));
    expect(stepRadiusFor(8)).toBeGreaterThan(stepRadiusFor(2));
    expect(emojiSizeFor(8)).toBeGreaterThan(emojiSizeFor(2));
    expect(fontSizeFor(0)).toBe(fontSizeFor(1));
  });

  it("measures a text block line by line", () => {
    expect(textLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
    const measure = (s: string, size: number) => s.length * size;
    expect(textBlockSize("ab\nabcd", 10, measure)).toEqual({ width: 40, height: 25 });
    expect(textBlockSize("", 10, measure).width).toBeGreaterThan(0);
  });

  it("picks a readable text colour for a fill", () => {
    expect(contrastColor("#ffffff")).toBe("#000000");
    expect(contrastColor("#facc15")).toBe("#000000");
    expect(contrastColor("#111827")).toBe("#ffffff");
    expect(contrastColor("#00f")).toBe("#ffffff");
    expect(contrastColor("not a colour")).toBe("#ffffff");
  });

  it("bounds every annotation with a box that holds what it paints", () => {
    for (const a of all) {
      const box = annotationBounds(a);
      expect(box.width, a.type).toBeGreaterThan(0);
      expect(box.height, a.type).toBeGreaterThan(0);
    }
    expect(annotationBounds(rect)).toEqual({ x: 98, y: 98, width: 204, height: 104 });
    expect(annotationBounds(step)).toEqual({ x: 484, y: 34, width: 32, height: 32 });
    expect(annotationBounds(blur)).toEqual({ x: 400, y: 400, width: 100, height: 50 });
    // A callout's box reaches out to what its tail points at.
    const bounds = annotationBounds(callout);
    expect(bounds.x).toBe(250);
    expect(bounds.y + bounds.height).toBe(400);
  });

  it("sizes a callout bubble around its text", () => {
    const measure = (s: string, size: number) => s.length * size;
    const box = calloutBox(callout as Extract<Annotation, { type: "callout" }>, measure);
    expect(box).toEqual({ x: 300, y: 300, width: 80 + CALLOUT_PADDING * 2, height: 25 + CALLOUT_PADDING * 2 });
    expect(boxAnchor(box, { x: 0, y: 310 })).toEqual({ x: 300, y: 310 });
    expect(boxAnchor(box, { x: 320, y: 1000 })).toEqual({ x: 320, y: box.y + box.height });
  });
});

describe("hit testing", () => {
  it("hits a line near its stroke and nowhere else", () => {
    expect(hitTest(arrow, { x: 60, y: 12 })).toBe(true);
    expect(hitTest(arrow, { x: 60, y: 40 })).toBe(false);
    expect(hitTest(arrow, { x: 200, y: 10 })).toBe(false);
    expect(hitTest(line, { x: 3, y: 50 })).toBe(true);
  });

  it("hits a rectangle on its outline, not in the middle it frames", () => {
    expect(hitTest(rect, { x: 100, y: 150 })).toBe(true);
    expect(hitTest(rect, { x: 200, y: 200 })).toBe(true);
    expect(hitTest(rect, { x: 200, y: 150 })).toBe(false);
    expect(hitTest(rect, { x: 50, y: 150 })).toBe(false);
  });

  it("hits a rectangle too small to have a middle anywhere inside it", () => {
    const small: Annotation = { ...rect, id: "small", rect: { x: 0, y: 0, width: 10, height: 10 } } as Annotation;
    expect(hitTest(small, { x: 5, y: 5 })).toBe(true);
  });

  it("hits an ellipse on its outline", () => {
    expect(hitTest(ellipse, { x: 0, y: 50 })).toBe(true);
    expect(hitTest(ellipse, { x: 100, y: 0 })).toBe(true);
    expect(hitTest(ellipse, { x: 100, y: 50 })).toBe(false);
    expect(hitTest(ellipse, { x: 2, y: 2 })).toBe(false);
    const flat: Annotation = { ...ellipse, id: "flat", rect: { x: 0, y: 0, width: 200, height: 6 } } as Annotation;
    expect(hitTest(flat, { x: 100, y: 3 })).toBe(true);
  });

  it("hits a free-hand stroke along its path, and a single dot", () => {
    expect(hitTest(pen, { x: 25, y: 2 })).toBe(true);
    expect(hitTest(pen, { x: 52, y: 30 })).toBe(true);
    expect(hitTest(pen, { x: 20, y: 30 })).toBe(false);
    const dot: Annotation = { ...pen, id: "dot", points: [{ x: 5, y: 5 }] } as Annotation;
    expect(hitTest(dot, { x: 7, y: 7 })).toBe(true);
    expect(hitTest(dot, { x: 40, y: 40 })).toBe(false);
  });

  it("gives the highlighter its broad band", () => {
    expect(hitTest(marker, { x: 50, y: 212 })).toBe(true);
    expect(hitTest({ ...marker, type: "pen" } as Annotation, { x: 50, y: 212 })).toBe(false);
  });

  it("hits filled shapes anywhere inside", () => {
    expect(hitTest(text, { x: 30, y: 310 })).toBe(true);
    expect(hitTest(text, { x: 30, y: 400 })).toBe(false);
    expect(hitTest(step, { x: 510, y: 55 })).toBe(true);
    expect(hitTest(step, { x: 540, y: 55 })).toBe(false);
    expect(hitTest(emoji, { x: 700, y: 100 })).toBe(true);
    expect(hitTest(blur, { x: 450, y: 425 })).toBe(true);
    expect(hitTest(pixelate, { x: 450, y: 425 })).toBe(false);
  });

  it("hits a callout on its bubble and along its tail", () => {
    expect(hitTest(callout, { x: 310, y: 310 })).toBe(true);
    expect(hitTest(callout, { x: 275, y: 370 })).toBe(true);
    expect(hitTest(callout, { x: 100, y: 100 })).toBe(false);
  });

  it("widens with the tolerance a finger needs", () => {
    expect(hitTest(arrow, { x: 60, y: 24 }, 6)).toBe(false);
    expect(hitTest(arrow, { x: 60, y: 24 }, 16)).toBe(true);
  });

  it("finds the topmost annotation under a point", () => {
    const under: Annotation = { ...blur, id: "under" } as Annotation;
    const over: Annotation = { ...blur, id: "over", type: "pixelate" } as Annotation;
    expect(findAnnotationAt([under, over], { x: 450, y: 425 })?.id).toBe("over");
    expect(findAnnotationAt([over, under], { x: 450, y: 425 })?.id).toBe("under");
    expect(findAnnotationAt([under, over], { x: 0, y: 0 })).toBeNull();
    expect(findAnnotationAt([], { x: 0, y: 0 })).toBeNull();
  });
});

describe("moving, scaling and restyling", () => {
  it("moves every kind of annotation by the same offset, without touching the original", () => {
    for (const a of all) {
      const before = annotationBounds(a);
      const snapshot = JSON.stringify(a);
      const moved = moveAnnotation(a, 7, -3);
      const after = annotationBounds(moved);
      expect(after.x, a.type).toBeCloseTo(before.x + 7);
      expect(after.y, a.type).toBeCloseTo(before.y - 3);
      expect(after.width, a.type).toBeCloseTo(before.width);
      expect(moved.id).toBe(a.id);
      expect(JSON.stringify(a)).toBe(snapshot);
    }
  });

  it("scales geometry, line weight and type with the image", () => {
    const scaled = scaleAnnotation(rect, 2);
    expect(scaled).toMatchObject({ strokeWidth: 8, rect: { x: 200, y: 200, width: 400, height: 200 } });
    expect(scaleAnnotation(text, 0.5)).toMatchObject({ at: { x: 10, y: 150 }, fontSize: 10 });
    expect(scaleAnnotation(step, 2)).toMatchObject({ at: { x: 1000, y: 100 }, radius: 32 });
    expect(scaleAnnotation(emoji, 2)).toMatchObject({ size: 96 });
    expect(scaleAnnotation(pen, 2)).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] });
    expect(scaleAnnotation(callout, 2)).toMatchObject({ at: { x: 600, y: 600 }, tip: { x: 500, y: 800 }, fontSize: 40 });
    expect(scaleAnnotation(arrow, 2)).toMatchObject({ from: { x: 20, y: 20 }, to: { x: 220, y: 20 } });
  });

  it("follows the smaller factor for weight, and never lets a stroke vanish", () => {
    expect(scaleAnnotation(rect, 4, 1).strokeWidth).toBe(4);
    expect(scaleAnnotation(rect, 0.01).strokeWidth).toBe(1);
    expect(scaleAnnotation(text, 0.01)).toMatchObject({ fontSize: 6 });
  });

  it("restyles colour and weight, and resizes what the weight drives", () => {
    expect(restyleAnnotation(rect, { color: "#3b82f6" })).toMatchObject({ color: "#3b82f6", strokeWidth: 4 });
    expect(restyleAnnotation(text, { strokeWidth: 10 })).toMatchObject({ strokeWidth: 10, fontSize: fontSizeFor(10) });
    expect(restyleAnnotation(step, { strokeWidth: 10 })).toMatchObject({ radius: stepRadiusFor(10) });
    expect(restyleAnnotation(emoji, { strokeWidth: 10 })).toMatchObject({ size: emojiSizeFor(10) });
    // A colour change alone leaves a hand-scaled size alone.
    expect(restyleAnnotation(text, { color: "#000000" })).toMatchObject({ fontSize: 20 });
  });
});

describe("step markers", () => {
  it("numbers from one and continues after the highest marker", () => {
    expect(nextStepNumber([])).toBe(1);
    expect(nextStepNumber([arrow, rect])).toBe(1);
    expect(nextStepNumber([step, { ...step, id: "s3", number: 3 } as Annotation])).toBe(4);
  });

  it("does not reuse a deleted step's number mid-sequence", () => {
    let doc = createDoc("img", { width: 800, height: 600 });
    for (let i = 0; i < 3; i++) {
      doc = addAnnotation(doc, { ...step, id: `s${i}`, number: nextStepNumber(doc.annotations) } as Annotation);
    }
    doc = removeAnnotation(doc, "s1");
    expect(nextStepNumber(doc.annotations)).toBe(4);
  });
});

describe("what is worth keeping", () => {
  it("discards a press without a drag", () => {
    expect(isMeaningful({ ...arrow, to: { x: 10, y: 10 } } as Annotation)).toBe(false);
    expect(isMeaningful({ ...rect, rect: { x: 5, y: 5, width: 1, height: 80 } } as Annotation)).toBe(false);
    expect(isMeaningful({ ...blur, rect: { x: 5, y: 5, width: 0, height: 0 } } as Annotation)).toBe(false);
    expect(isMeaningful({ ...text, text: "  \n " } as Annotation)).toBe(false);
    expect(isMeaningful({ ...callout, text: "" } as Annotation)).toBe(false);
    expect(isMeaningful({ ...emoji, emoji: "" } as Annotation)).toBe(false);
  });

  it("keeps real marks, a single pen dot included", () => {
    for (const a of all) expect(isMeaningful(a), a.type).toBe(true);
    expect(isMeaningful({ ...pen, points: [{ x: 1, y: 1 }] } as Annotation)).toBe(true);
    // Drawn right-to-left: still a rectangle.
    expect(isMeaningful({ ...rect, rect: { x: 50, y: 50, width: -40, height: -40 } } as Annotation)).toBe(true);
  });

  it("thins a free-hand stroke but keeps both ends", () => {
    const dense = Array.from({ length: 101 }, (_, i) => ({ x: i * 0.1, y: 0 }));
    const thinned = simplifyStroke(dense, 1.5);
    expect(thinned.length).toBeLessThan(dense.length);
    expect(thinned[0]).toEqual(dense[0]);
    expect(thinned[thinned.length - 1]).toEqual(dense[dense.length - 1]);
    expect(simplifyStroke([{ x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
  });

  it("caps the length of a very long stroke", () => {
    const long = Array.from({ length: MAX_STROKE_POINTS * 3 }, (_, i) => ({ x: i * 5, y: 0 }));
    const thinned = simplifyStroke(long);
    expect(thinned).toHaveLength(MAX_STROKE_POINTS);
    expect(thinned[thinned.length - 1]).toEqual(long[long.length - 1]);
  });

  it("caps the length of typed text and normalizes its line ends", () => {
    expect(clampText("a\r\nb")).toBe("a\nb");
    expect(clampText("x".repeat(MAX_TEXT_LENGTH + 50))).toHaveLength(MAX_TEXT_LENGTH);
  });
});

describe("the editor document", () => {
  const empty = createDoc("img0", { width: 800, height: 600 });

  it("starts with the picture and nothing on it", () => {
    expect(empty).toEqual({ image: "img0", width: 800, height: 600, annotations: [] });
  });

  it("adds, updates and removes without mutating", () => {
    const one = addAnnotation(empty, rect);
    const two = addAnnotation(one, arrow);
    expect(empty.annotations).toHaveLength(0);
    expect(one.annotations).toEqual([rect]);
    expect(two.annotations.map((a) => a.id)).toEqual(["rect", "arrow"]);

    const moved = moveAnnotation(rect, 10, 10);
    const updated = updateAnnotation(two, moved);
    expect(getAnnotation(updated, "rect")).toBe(moved);
    expect(getAnnotation(two, "rect")).toBe(rect);
    expect(updated.annotations.map((a) => a.id)).toEqual(["rect", "arrow"]);

    const removed = removeAnnotation(updated, "rect");
    expect(removed.annotations.map((a) => a.id)).toEqual(["arrow"]);
    expect(getAnnotation(removed, "rect")).toBeNull();
    expect(getAnnotation(removed, null)).toBeNull();
  });

  it("returns the same document when an edit changes nothing", () => {
    const one = addAnnotation(empty, rect);
    expect(updateAnnotation(one, rect)).toBe(one);
    expect(updateAnnotation(one, arrow)).toBe(one);
    expect(removeAnnotation(one, "nobody")).toBe(one);
    expect(clearAnnotations(empty)).toBe(empty);
  });

  it("clears everything at once", () => {
    const full = all.reduce(addAnnotation, empty);
    expect(clearAnnotations(full)).toEqual(empty);
  });

  it("crops: shifts what stays into the new picture and drops what falls outside", () => {
    const doc = [rect, arrow, step].reduce(addAnnotation, empty);
    const cropped = cropDoc(doc, { x: 90, y: 90, width: 300, height: 200 }, "img1");
    expect(cropped).toMatchObject({ image: "img1", width: 300, height: 200 });
    expect(cropped.annotations.map((a) => a.id)).toEqual(["rect"]);
    expect(cropped.annotations[0]).toMatchObject({ rect: { x: 10, y: 10, width: 200, height: 100 } });
  });

  it("crops to whole pixels inside the picture, and ignores an empty crop", () => {
    const doc = addAnnotation(empty, rect);
    expect(cropDoc(doc, { x: -50.4, y: 10.6, width: 2000, height: 100.2 }, "img1")).toMatchObject({ width: 800, height: 100 });
    expect(cropDoc(doc, { x: 900, y: 900, width: 50, height: 50 }, "img1")).toBe(doc);
    expect(cropDoc(doc, { x: 10, y: 10, width: 0.2, height: 50 }, "img1")).toBe(doc);
  });

  it("resizes: annotations keep their place on the picture", () => {
    const doc = [rect, text].reduce(addAnnotation, empty);
    const resized = resizeDoc(doc, { width: 400, height: 300 }, "img2");
    expect(resized).toMatchObject({ image: "img2", width: 400, height: 300 });
    expect(resized.annotations[0]).toMatchObject({ strokeWidth: 2, rect: { x: 50, y: 50, width: 100, height: 50 } });
    expect(resized.annotations[1]).toMatchObject({ at: { x: 10, y: 150 }, fontSize: 10 });
    expect(resizeDoc(doc, { width: 0, height: -3 }, "img3")).toMatchObject({ width: 1, height: 1 });
  });
});

describe("undo and redo over documents", () => {
  it("steps back through annotations, a crop and a clear, and forward again", () => {
    const start = createDoc("img0", { width: 800, height: 600 });
    const drawn = addAnnotation(start, rect);
    const cropped = cropDoc(drawn, { x: 50, y: 50, width: 400, height: 300 }, "img1");
    const cleared = clearAnnotations(cropped);

    let history = createHistory<EditorDoc>(start);
    for (const doc of [drawn, cropped, cleared]) history = pushHistory(history, doc);
    expect(history.present.annotations).toHaveLength(0);

    history = undo(history);
    expect(history.present).toBe(cropped);
    expect(history.present.image).toBe("img1");
    history = undo(history);
    // Undoing a crop brings back the uncropped picture AND the annotation's old place.
    expect(history.present).toMatchObject({ image: "img0", width: 800, height: 600 });
    expect(history.present.annotations[0]).toBe(rect);
    history = undo(history);
    expect(history.present).toBe(start);

    history = redo(redo(redo(history)));
    expect(history.present).toBe(cleared);
  });
});
