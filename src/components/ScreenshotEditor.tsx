"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/file-icons";
import {
  TEXT_FONT_FAMILY,
  bitmapToBlob,
  cropBitmap,
  drawSelection,
  flattenDoc,
  renderDoc,
  resizeBitmap,
  sharedMeasurer,
} from "@/components/screenshot/render";
import { useT } from "@/lib/i18n";
import {
  type Annotation,
  type AnnotationStyle,
  type AnnotationType,
  type EditorDoc,
  ANNOTATION_COLORS,
  CALLOUT_PADDING,
  DEFAULT_STYLE,
  EMOJI_STAMPS,
  STROKE_WIDTHS,
  TEXT_LINE_HEIGHT,
  addAnnotation,
  clampText,
  clearAnnotations,
  contrastColor,
  createDoc,
  cropDoc,
  emojiSizeFor,
  findAnnotationAt,
  fontSizeFor,
  getAnnotation,
  isMeaningful,
  moveAnnotation,
  newAnnotationId,
  nextStepNumber,
  removeAnnotation,
  resizeDoc,
  restyleAnnotation,
  simplifyStroke,
  stepRadiusFor,
  textBlockSize,
  updateAnnotation,
} from "@/lib/screenshot/annotations";
import {
  MAX_SCREENSHOT_BYTES,
  SCREENSHOTS_DIR,
  type ScreenshotFormat,
  formatByteSize,
  screenshotFileName,
} from "@/lib/screenshot/files";
import {
  type Point,
  type Rect,
  type Size,
  MAX_IMAGE_SIDE,
  clampPoint,
  clampRect,
  distance,
  fitZoom,
  formatSize,
  isUsableRegion,
  normalizeRect,
  rectFromPoints,
  resizeDimensions,
  stepZoom,
} from "@/lib/screenshot/geometry";
import { type History, canRedo, canUndo, createHistory, historyValues, pushHistory, redo, undo } from "@/lib/screenshot/history";
import type { SkippedSurface } from "@/lib/screenshot/session";
import { dispatchOpenApp } from "@/lib/ui-events";

/**
 * The Screenshot app's editor (TASK-1475): one picture, the annotations drawn
 * over it, and the ways out — save into the Screenshots folder, download,
 * copy.
 *
 * The picture is never modified in place. What is on screen is an EditorDoc
 * (src/lib/screenshot/annotations.ts): the base bitmap's key plus a list of
 * annotation objects, redrawn from scratch on every change. That is what makes
 * select / move / delete and undo / redo possible at all, and it means the
 * saved file is produced by the same drawing code that painted the editor.
 */

export interface EditorImage {
  id: number;
  bitmap: HTMLCanvasElement;
  /** The file it was opened from; null for a capture that has never been saved. */
  name: string | null;
  skipped: SkippedSurface[];
  regionApplied: boolean;
  /** The source was larger than the editor's limit and was scaled down on the way in. */
  scaledDown: boolean;
}

interface ScreenshotEditorProps {
  image: EditorImage;
  /** Leave the editor. Only called once the owner has agreed to lose unsaved work. */
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  /** Whether the browser's own (exact) capture can be offered for what was not captured. */
  canUseBrowserCapture: boolean;
  onBrowserCapture: () => void;
  /** Whether there is a desktop to open the Files app on (the standalone page has none). */
  canShowInFiles: boolean;
}

type Tool = AnnotationType | "select" | "crop";

const TOOLS: ReadonlyArray<{ id: Tool; icon: string; label: string }> = [
  { id: "select", icon: "arrow_selector_tool", label: "screenshot.toolSelect" },
  { id: "arrow", icon: "north_east", label: "screenshot.toolArrow" },
  { id: "line", icon: "horizontal_rule", label: "screenshot.toolLine" },
  { id: "rect", icon: "rectangle", label: "screenshot.toolRect" },
  { id: "ellipse", icon: "circle", label: "screenshot.toolEllipse" },
  { id: "pen", icon: "draw", label: "screenshot.toolPen" },
  { id: "highlighter", icon: "ink_highlighter", label: "screenshot.toolHighlighter" },
  { id: "text", icon: "title", label: "screenshot.toolText" },
  { id: "callout", icon: "chat_bubble", label: "screenshot.toolCallout" },
  { id: "step", icon: "counter_1", label: "screenshot.toolStep" },
  { id: "blur", icon: "blur_on", label: "screenshot.toolBlur" },
  { id: "pixelate", icon: "grid_on", label: "screenshot.toolPixelate" },
  { id: "emoji", icon: "add_reaction", label: "screenshot.toolEmoji" },
  { id: "crop", icon: "crop", label: "screenshot.toolCrop" },
];

interface TextEdit {
  /** Set when an existing annotation is being re-edited. */
  id: string | null;
  type: "text" | "callout";
  at: Point;
  tip: Point | null;
  value: string;
  color: string;
  strokeWidth: number;
  fontSize: number;
}

type Gesture =
  | { kind: "draw" }
  | { kind: "box"; start: Point }
  | { kind: "move"; id: string; start: Point }
  | { kind: "pan"; x: number; y: number; left: number; top: number }
  | { kind: "callout"; tip: Point }
  | { kind: "crop"; start: Point };

interface Status {
  kind: "ok" | "error" | "saved";
  text: string;
}

function canCopyImages(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

function ToolButton({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
  testId,
}: {
  icon: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      // `aria-disabled`, not `disabled`: a focused button that becomes disabled
      // swallows every key press after it, and Undo is exactly the button that
      // disables itself under the hand that presses Ctrl+Z next.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      data-testid={testId}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors ${
        active
          ? "bg-[var(--coral-bright)] text-white"
          : "text-[var(--text-secondary)] hover:bg-white/[0.08] hover:text-[var(--text-primary)]"
      } ${disabled ? "cursor-default opacity-35 hover:bg-transparent" : "cursor-pointer"}`}
    >
      <Icon name={icon} size={20} />
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-6 w-px shrink-0 bg-white/10" aria-hidden />;
}

function ScreenshotEditor({ image, onBack, onDirtyChange, onSaved, canUseBrowserCapture, onBrowserCapture, canShowInFiles }: ScreenshotEditorProps) {
  const { t } = useT();
  const measure = useMemo(() => sharedMeasurer(), []);

  // Base bitmaps by key. A crop or a resize adds one; undo steps back to the
  // older key, so the bitmaps a history entry still names are kept.
  const images = useRef<Map<string, HTMLCanvasElement> | null>(null);
  if (!images.current) images.current = new Map([["0", image.bitmap]]);
  const nextKey = useRef(1);

  const [history, setHistory] = useState<History<EditorDoc>>(() => createHistory(createDoc("0", image.bitmap)));
  const doc = history.present;
  // What the saved file holds. A capture that was never saved has no such state.
  const [savedDoc, setSavedDoc] = useState<EditorDoc | null>(() => (image.name ? history.present : null));
  const dirty = doc !== savedDoc;

  const [tool, setTool] = useState<Tool>("arrow");
  const [style, setStyle] = useState<AnnotationStyle>(DEFAULT_STYLE);
  const [emoji, setEmoji] = useState<string>(EMOJI_STAMPS[0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [draft, setDraftState] = useState<Annotation | null>(null);
  const draftRef = useRef<Annotation | null>(null);
  const setDraft = useCallback((next: Annotation | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const [moving, setMovingState] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const movingRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const setMoving = useCallback((next: { id: string; dx: number; dy: number } | null) => {
    movingRef.current = next;
    setMovingState(next);
  }, []);

  const [cropRect, setCropState] = useState<Rect | null>(null);
  const cropRef = useRef<Rect | null>(null);
  const setCropRect = useCallback((next: Rect | null) => {
    cropRef.current = next;
    setCropState(next);
  }, []);

  const [textEdit, setTextState] = useState<TextEdit | null>(null);
  const textRef = useRef<TextEdit | null>(null);
  const setTextEdit = useCallback((next: TextEdit | null) => {
    textRef.current = next;
    setTextState(next);
  }, []);
  const textInput = useRef<HTMLTextAreaElement>(null);

  const [resize, setResize] = useState<{ width: string; height: string; lock: boolean } | null>(null);
  const [zoomMode, setZoomMode] = useState<"fit" | "manual">("fit");
  const [manualZoom, setManualZoom] = useState(1);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);

  const zoom = zoomMode === "fit" ? fitZoom(doc, { width: box.width - 32, height: box.height - 32 }, 1) : manualZoom;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bitmaps no step of the history names any more are let go.
  useEffect(() => {
    const used = new Set(historyValues(history).map((entry) => entry.image));
    for (const key of Array.from(images.current?.keys() ?? [])) {
      if (!used.has(key)) images.current?.delete(key);
    }
  }, [history]);

  useEffect(() => {
    if (selectedId && !getAnnotation(doc, selectedId)) setSelectedId(null);
  }, [doc, selectedId]);

  // What is drawn: the document, plus whatever gesture is in flight.
  const shown = useMemo(() => {
    let next = doc;
    if (moving) {
      const target = getAnnotation(next, moving.id);
      if (target) next = updateAnnotation(next, moveAnnotation(target, moving.dx, moving.dy));
    }
    if (textEdit?.id) next = removeAnnotation(next, textEdit.id);
    if (draft) next = addAnnotation(next, draft);
    return next;
  }, [doc, draft, moving, textEdit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const base = images.current?.get(shown.image);
    if (!canvas || !base) return;
    const frame = requestAnimationFrame(() => {
      renderDoc(canvas, base, shown);
      const selected = getAnnotation(shown, selectedId);
      const context = selected ? canvas.getContext("2d") : null;
      if (selected && context) drawSelection(context, selected, zoom);
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, selectedId, zoom]);

  const editing = textEdit !== null;
  useEffect(() => {
    if (!editing) return;
    // On the next frame, not now: the press that opened the box is still being
    // handled, and its mouse-down would move the focus straight back off the
    // box — which reads as "finished typing" and closed it before a key was hit.
    const frame = requestAnimationFrame(() => textInput.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
    // Only when an edit OPENS: refocusing on every keystroke would fight the caret.
  }, [editing, textEdit?.at.x, textEdit?.at.y, textEdit?.id]);

  /** Once the text box is gone the focus is nowhere; bring it home so Ctrl+Z and Delete still reach the editor. */
  const refocus = useCallback(() => {
    requestAnimationFrame(() => {
      // Only when it fell to the page itself — never pulled back from another window the owner clicked into.
      if (document.activeElement === document.body) rootRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const commit = useCallback((next: EditorDoc) => {
    setHistory((prev) => pushHistory(prev, next));
  }, []);

  const commitText = useCallback(() => {
    const edit = textRef.current;
    if (!edit) return;
    setTextEdit(null);
    refocus();
    const text = clampText(edit.value).replace(/\s+$/, "");
    if (edit.id) {
      const existing = getAnnotation(doc, edit.id);
      if (!existing || (existing.type !== "text" && existing.type !== "callout")) return;
      if (!text.trim()) commit(removeAnnotation(doc, edit.id));
      else if (existing.text !== text) commit(updateAnnotation(doc, { ...existing, text }));
      return;
    }
    if (!text.trim()) return;
    const base = { id: newAnnotationId(), color: edit.color, strokeWidth: edit.strokeWidth, at: edit.at, text, fontSize: edit.fontSize };
    commit(
      addAnnotation(
        doc,
        edit.type === "callout" ? { ...base, type: "callout", tip: edit.tip ?? edit.at } : { ...base, type: "text" },
      ),
    );
  }, [commit, doc, refocus, setTextEdit]);

  const openText = useCallback(
    (type: "text" | "callout", at: Point, tip: Point | null) => {
      setSelectedId(null);
      setTextEdit({
        id: null,
        type,
        at,
        tip,
        value: "",
        color: style.color,
        strokeWidth: style.strokeWidth,
        fontSize: fontSizeFor(style.strokeWidth),
      });
    },
    [setTextEdit, style],
  );

  const toImage = (e: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) / rect.width) * doc.width,
      y: ((e.clientY - rect.top) / rect.height) * doc.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (textRef.current) {
      // A press outside the text box finishes the typing; it does not also start something new.
      commitText();
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImage(e);
    const id = newAnnotationId();
    switch (tool) {
      case "select": {
        const hit = findAnnotationAt(doc.annotations, p, (e.pointerType === "mouse" ? 6 : 16) / zoom, measure);
        if (hit) {
          setSelectedId(hit.id);
          gesture.current = { kind: "move", id: hit.id, start: p };
        } else {
          setSelectedId(null);
          const viewport = viewportRef.current;
          gesture.current = {
            kind: "pan",
            x: e.clientX,
            y: e.clientY,
            left: viewport?.scrollLeft ?? 0,
            top: viewport?.scrollTop ?? 0,
          };
        }
        break;
      }
      case "arrow":
      case "line":
        setSelectedId(null);
        setDraft({ id, type: tool, ...style, from: p, to: p });
        gesture.current = { kind: "draw" };
        break;
      case "rect":
      case "ellipse":
      case "blur":
      case "pixelate":
        setSelectedId(null);
        setDraft({ id, type: tool, ...style, rect: { x: p.x, y: p.y, width: 0, height: 0 } });
        gesture.current = { kind: "box", start: p };
        break;
      case "pen":
      case "highlighter":
        setSelectedId(null);
        setDraft({ id, type: tool, ...style, points: [p] });
        gesture.current = { kind: "draw" };
        break;
      case "text":
        openText("text", p, null);
        break;
      case "callout":
        setSelectedId(null);
        setDraft({ id, type: "line", ...style, from: p, to: p });
        gesture.current = { kind: "callout", tip: p };
        break;
      case "step":
        commit(
          addAnnotation(doc, {
            id,
            type: "step",
            ...style,
            at: p,
            number: nextStepNumber(doc.annotations),
            radius: stepRadiusFor(style.strokeWidth),
          }),
        );
        break;
      case "emoji":
        commit(addAnnotation(doc, { id, type: "emoji", ...style, at: p, emoji, size: emojiSizeFor(style.strokeWidth) }));
        break;
      case "crop":
        setSelectedId(null);
        setCropRect({ x: p.x, y: p.y, width: 0, height: 0 });
        gesture.current = { kind: "crop", start: p };
        break;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g) return;
    const p = toImage(e);
    const current = draftRef.current;
    switch (g.kind) {
      case "draw":
        if (!current) break;
        if (current.type === "arrow" || current.type === "line") setDraft({ ...current, to: p });
        else if (current.type === "pen" || current.type === "highlighter") setDraft({ ...current, points: [...current.points, p] });
        break;
      case "box":
        if (current && "rect" in current) setDraft({ ...current, rect: rectFromPoints(g.start, p) });
        break;
      case "callout":
        if (current && current.type === "line") setDraft({ ...current, to: p });
        break;
      case "move":
        setMoving({ id: g.id, dx: p.x - g.start.x, dy: p.y - g.start.y });
        break;
      case "pan": {
        const viewport = viewportRef.current;
        if (viewport) {
          viewport.scrollLeft = g.left - (e.clientX - g.x);
          viewport.scrollTop = g.top - (e.clientY - g.y);
        }
        break;
      }
      case "crop":
        setCropRect(clampRect(rectFromPoints(g.start, p), doc));
        break;
    }
  };

  const endGesture = (e: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = toImage(e);
    const current = draftRef.current;
    switch (g.kind) {
      case "draw":
      case "box": {
        setDraft(null);
        if (cancelled || !current) break;
        let final = current;
        if (final.type === "pen" || final.type === "highlighter") final = { ...final, points: simplifyStroke(final.points) };
        else if ("rect" in final) final = { ...final, rect: normalizeRect(final.rect) };
        if (isMeaningful(final)) commit(addAnnotation(doc, final));
        break;
      }
      case "callout": {
        setDraft(null);
        if (cancelled) break;
        // Dragged: the bubble goes where the drag ended. Just pressed: beside the point.
        const at = distance(g.tip, p) >= 12 ? p : { x: g.tip.x + 36, y: g.tip.y - 72 };
        openText("callout", clampPoint(at, { width: doc.width - 40, height: doc.height - 20 }), g.tip);
        break;
      }
      case "move": {
        const moved = movingRef.current;
        setMoving(null);
        if (cancelled || !moved || (moved.dx === 0 && moved.dy === 0)) break;
        const target = getAnnotation(doc, moved.id);
        if (target) commit(updateAnnotation(doc, moveAnnotation(target, moved.dx, moved.dy)));
        break;
      }
      case "crop":
        if (cancelled || !cropRef.current || !isUsableRegion(cropRef.current, 4)) setCropRect(null);
        break;
      case "pan":
        break;
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool !== "select") return;
    const hit = findAnnotationAt(doc.annotations, toImage(e), 6 / zoom, measure);
    if (!hit || (hit.type !== "text" && hit.type !== "callout")) return;
    setTextEdit({
      id: hit.id,
      type: hit.type,
      at: hit.at,
      tip: hit.type === "callout" ? hit.tip : null,
      value: hit.text,
      color: hit.color,
      strokeWidth: hit.strokeWidth,
      fontSize: hit.fontSize,
    });
  };

  const doUndo = () => setHistory((prev) => undo(prev));
  const doRedo = () => setHistory((prev) => redo(prev));
  const deleteSelected = () => {
    if (!selectedId) return;
    commit(removeAnnotation(doc, selectedId));
    setSelectedId(null);
  };

  const applyStyle = (patch: Partial<AnnotationStyle>) => {
    setStyle((prev) => ({ ...prev, ...patch }));
    const selected = getAnnotation(doc, selectedId);
    if (selected) commit(updateAnnotation(doc, restyleAnnotation(selected, patch)));
    const edit = textRef.current;
    if (edit) {
      const strokeWidth = patch.strokeWidth ?? edit.strokeWidth;
      setTextEdit({ ...edit, color: patch.color ?? edit.color, strokeWidth, fontSize: fontSizeFor(strokeWidth) });
    }
  };

  const chooseTool = (next: Tool) => {
    if (textRef.current) commitText();
    if (next !== "crop") setCropRect(null);
    if (next !== "select") setSelectedId(null);
    setTool(next);
  };

  const applyCrop = () => {
    const base = images.current?.get(doc.image);
    const rect = cropRef.current;
    if (!base || !rect) return;
    const area = clampRect(
      { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      doc,
    );
    if (!isUsableRegion(area, 2)) return;
    const key = String(nextKey.current++);
    images.current?.set(key, cropBitmap(base, area));
    commit(cropDoc(doc, area, key, measure));
    setCropRect(null);
    setSelectedId(null);
    setTool("select");
    setZoomMode("fit");
  };

  const applyResize = () => {
    const base = images.current?.get(doc.image);
    if (!base || !resize) return;
    const size = resizeDimensions(
      doc,
      { width: Number.parseInt(resize.width, 10) || doc.width, height: Number.parseInt(resize.height, 10) || doc.height },
      false,
    );
    setResize(null);
    if (size.width === doc.width && size.height === doc.height) return;
    const key = String(nextKey.current++);
    images.current?.set(key, resizeBitmap(base, size));
    commit(resizeDoc(doc, size, key));
    setSelectedId(null);
    setZoomMode("fit");
  };

  const exportBlob = async (format: ScreenshotFormat): Promise<Blob> => {
    const base = images.current?.get(doc.image);
    if (!base) throw new Error("no picture");
    return bitmapToBlob(flattenDoc(base, doc), format);
  };

  const tooLargeText = (bytes: number) =>
    t("screenshot.tooLarge", { size: formatByteSize(bytes), limit: formatByteSize(MAX_SCREENSHOT_BYTES) });

  const save = async (format: ScreenshotFormat) => {
    if (busy) return;
    setBusy(format);
    setStatus(null);
    try {
      const blob = await exportBlob(format);
      if (blob.size > MAX_SCREENSHOT_BYTES) {
        setStatus({ kind: "error", text: tooLargeText(blob.size) });
        return;
      }
      const name = screenshotFileName(new Date(), format);
      const response = await fetch(`/setup-api/screenshots?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": blob.type },
        body: blob,
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; name?: string; code?: string } | null;
      if (!response.ok || !data?.ok || !data.name) {
        const text =
          data?.code === "too_large"
            ? tooLargeText(blob.size)
            : data?.code === "disk_full"
              ? t("screenshot.diskFull")
              : t("screenshot.saveFailed");
        setStatus({ kind: "error", text });
        return;
      }
      setSavedDoc(doc);
      setStatus({ kind: "saved", text: t("screenshot.saved", { name: data.name }) });
      onSaved();
    } catch {
      setStatus({ kind: "error", text: t("screenshot.saveFailed") });
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (busy) return;
    setBusy("download");
    try {
      const blob = await exportBlob("png");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = screenshotFileName(new Date(), "png");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setStatus({ kind: "error", text: t("screenshot.saveFailed") });
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (busy) return;
    if (!canCopyImages()) {
      // Plain http is not a secure context: the browser hides the picture clipboard entirely.
      setStatus({ kind: "error", text: t("screenshot.copyUnavailable") });
      return;
    }
    setBusy("copy");
    try {
      // The promise form keeps the write inside the click's gesture while the PNG is encoded.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": exportBlob("png") })]);
      setStatus({ kind: "ok", text: t("screenshot.copied") });
    } catch {
      setStatus({ kind: "error", text: t("screenshot.copyFailed") });
    } finally {
      setBusy(null);
    }
  };

  const leave = () => {
    if (textRef.current) commitText();
    if (dirty) setConfirmLeave(true);
    else onBack();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT") return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z" && !e.shiftKey) {
      e.preventDefault();
      doUndo();
    } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
      e.preventDefault();
      doRedo();
    } else if (mod && key === "s") {
      e.preventDefault();
      void save("png");
    } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "Escape") {
      if (cropRef.current) {
        e.stopPropagation();
        setCropRect(null);
      } else if (resize) {
        e.stopPropagation();
        setResize(null);
      } else if (selectedId) {
        e.stopPropagation();
        setSelectedId(null);
      }
    }
  };

  const selected = getAnnotation(doc, selectedId);
  const activeStyle: AnnotationStyle = selected ? { color: selected.color, strokeWidth: selected.strokeWidth } : style;
  const customColor = /^#[0-9a-f]{6}$/i.test(activeStyle.color) ? activeStyle.color : "#ef4444";
  const skippedNames = Array.from(
    new Set(image.skipped.map((surface) => surface.label.trim() || t("screenshot.skippedUnnamed"))),
  );
  const cursor = tool === "select" ? (moving ? "grabbing" : "default") : tool === "text" ? "text" : "crosshair";

  // The text box while typing: sized to what has been typed, in screen pixels.
  let textBox: { left: number; top: number; width: number; height: number; padding: number } | null = null;
  if (textEdit) {
    const block = textBlockSize(textEdit.value || t("screenshot.textPlaceholder"), textEdit.fontSize, measure);
    const padding = textEdit.type === "callout" ? CALLOUT_PADDING : 2;
    textBox = {
      left: textEdit.at.x * zoom,
      top: textEdit.at.y * zoom,
      // + 2: the box's own 1px border, which would otherwise shave the last line.
      width: (block.width + padding * 2 + textEdit.fontSize) * zoom + 2,
      height: (block.height + padding * 2) * zoom + 2,
      padding: padding * zoom,
    };
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col bg-[var(--bg-deep)] text-[var(--text-primary)] outline-none"
      data-testid="screenshot-editor"
    >
      {/* Actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5">
        <ToolButton icon="arrow_back" label={t("screenshot.back")} onClick={leave} testId="screenshot-back" />
        <Divider />
        <ToolButton icon="undo" label={t("screenshot.undo")} disabled={!canUndo(history)} onClick={doUndo} testId="screenshot-undo" />
        <ToolButton icon="redo" label={t("screenshot.redo")} disabled={!canRedo(history)} onClick={doRedo} testId="screenshot-redo" />
        <ToolButton icon="delete" label={t("screenshot.deleteSelected")} disabled={!selected} onClick={deleteSelected} testId="screenshot-delete-selected" />
        <ToolButton
          icon="layers_clear"
          label={t("screenshot.clearAll")}
          disabled={doc.annotations.length === 0}
          onClick={() => {
            commit(clearAnnotations(doc));
            setSelectedId(null);
          }}
          testId="screenshot-clear"
        />
        <Divider />
        <ToolButton
          icon="zoom_out"
          label={t("screenshot.zoomOut")}
          onClick={() => {
            setManualZoom(stepZoom(zoom, -1));
            setZoomMode("manual");
          }}
        />
        <button
          type="button"
          title={t("screenshot.zoomActual")}
          aria-label={t("screenshot.zoomActual")}
          onClick={() => {
            setManualZoom(1);
            setZoomMode("manual");
          }}
          className="h-9 min-w-[3.25rem] shrink-0 cursor-pointer rounded-lg px-1 text-xs tabular-nums text-[var(--text-secondary)] hover:bg-white/[0.08] hover:text-[var(--text-primary)]"
          data-testid="screenshot-zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <ToolButton
          icon="zoom_in"
          label={t("screenshot.zoomIn")}
          onClick={() => {
            setManualZoom(stepZoom(zoom, 1));
            setZoomMode("manual");
          }}
        />
        <ToolButton icon="fit_screen" label={t("screenshot.zoomFit")} active={zoomMode === "fit"} onClick={() => setZoomMode("fit")} />
        <ToolButton
          icon="aspect_ratio"
          label={t("screenshot.resize")}
          active={!!resize}
          onClick={() => setResize(resize ? null : { width: String(doc.width), height: String(doc.height), lock: true })}
          testId="screenshot-resize"
        />
        <span className="ml-1 hidden shrink-0 text-xs tabular-nums text-[var(--text-muted)] md:inline" data-testid="screenshot-size">
          {formatSize(doc)}
        </span>
        <span className="min-w-2 flex-1" />
        <button
          type="button"
          onClick={() => void save("png")}
          disabled={!!busy}
          className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--coral-bright)] px-3 text-sm font-medium text-white hover:brightness-110 disabled:cursor-default disabled:opacity-50"
          data-testid="screenshot-save-png"
        >
          <Icon name={busy === "png" ? "progress_activity" : "save"} size={18} className={busy === "png" ? "motion-safe:animate-spin" : ""} />
          {t("screenshot.savePng")}
        </button>
        <button
          type="button"
          onClick={() => void save("jpg")}
          disabled={!!busy}
          className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-white/[0.08] px-3 text-sm text-[var(--text-primary)] hover:bg-white/[0.14] disabled:cursor-default disabled:opacity-50"
          data-testid="screenshot-save-jpg"
        >
          {busy === "jpg" && <Icon name="progress_activity" size={18} className="motion-safe:animate-spin" />}
          {t("screenshot.saveJpg")}
        </button>
        <ToolButton icon="download" label={t("screenshot.download")} disabled={!!busy} onClick={() => void download()} testId="screenshot-download" />
        <ToolButton icon="content_copy" label={t("screenshot.copy")} disabled={!!busy} onClick={() => void copy()} testId="screenshot-copy" />
      </div>

      {/* Tools */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5"
        role="toolbar"
        aria-label={t("screenshot.tools")}
      >
        {TOOLS.map((entry) => (
          <ToolButton
            key={entry.id}
            icon={entry.icon}
            label={t(entry.label)}
            active={tool === entry.id}
            onClick={() => chooseTool(entry.id)}
            testId={`screenshot-tool-${entry.id}`}
          />
        ))}
      </div>

      {/* The style of the tool in hand, and what only that tool needs. ONE line
          that scrolls sideways when the window is narrow, never a second one:
          the stamps or the crop buttons appearing must not change this bar's
          height, or the picture below would shift under the pointer. */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 [scrollbar-width:none] [&>*]:shrink-0">
        <div className="flex items-center gap-1.5" role="group" aria-label={t("screenshot.color")}>
          {ANNOTATION_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              aria-label={`${t("screenshot.color")} ${color}`}
              aria-pressed={activeStyle.color === color}
              onClick={() => applyStyle({ color })}
              className={`h-7 w-7 shrink-0 cursor-pointer rounded-full border-2 transition-transform ${
                activeStyle.color === color ? "scale-110 border-white" : "border-white/20 hover:scale-105"
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
          <label
            className="relative flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-white/20"
            title={t("screenshot.customColor")}
            style={{ background: "conic-gradient(#ef4444, #facc15, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)" }}
          >
            <input
              type="color"
              value={customColor}
              onChange={(e) => applyStyle({ color: e.target.value })}
              aria-label={t("screenshot.customColor")}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
        </div>
        <Divider />
        <div className="flex items-center gap-0.5" role="group" aria-label={t("screenshot.strokeWidth")}>
          {STROKE_WIDTHS.map((width) => (
            <button
              key={width}
              type="button"
              title={`${t("screenshot.strokeWidth")} ${width}`}
              aria-label={`${t("screenshot.strokeWidth")} ${width}`}
              aria-pressed={activeStyle.strokeWidth === width}
              onClick={() => applyStyle({ strokeWidth: width })}
              className={`flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg ${
                activeStyle.strokeWidth === width ? "bg-white/[0.16]" : "hover:bg-white/[0.08]"
              }`}
            >
              <span className="rounded-full bg-current" style={{ width: 18, height: Math.min(width, 12) }} />
            </button>
          ))}
        </div>
        {tool === "crop" && (
          // In this row rather than a bar of its own: a bar would push the
          // picture down just as the owner reaches for it.
          <>
            <Divider />
            <div className="flex items-center gap-2 text-sm" data-testid="screenshot-crop-panel">
              <span className="whitespace-nowrap tabular-nums text-[var(--text-secondary)]">
                {cropRect && isUsableRegion(cropRect, 4) ? formatSize(cropRect) : t("screenshot.cropHint")}
              </span>
              <button
                type="button"
                onClick={applyCrop}
                disabled={!cropRect || !isUsableRegion(cropRect, 4)}
                className="h-9 cursor-pointer whitespace-nowrap rounded-lg bg-[var(--coral-bright)] px-3 text-sm font-medium text-white hover:brightness-110 disabled:cursor-default disabled:opacity-40"
                data-testid="screenshot-crop-apply"
              >
                {t("screenshot.cropApply")}
              </button>
              <button type="button" onClick={() => chooseTool("select")} className="h-9 cursor-pointer rounded-lg bg-white/[0.08] px-3 text-sm hover:bg-white/[0.14]">
                {t("screenshot.cancel")}
              </button>
            </div>
          </>
        )}
        {tool === "emoji" && (
          <>
            <Divider />
            <div className="flex items-center gap-0.5" role="group" aria-label={t("screenshot.toolEmoji")}>
              {EMOJI_STAMPS.map((stamp) => (
                <button
                  key={stamp}
                  type="button"
                  aria-label={stamp}
                  aria-pressed={emoji === stamp}
                  onClick={() => setEmoji(stamp)}
                  className={`flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-lg ${
                    emoji === stamp ? "bg-white/[0.16]" : "hover:bg-white/[0.08]"
                  }`}
                >
                  {stamp}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {resize && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-sm" data-testid="screenshot-resize-panel">
          <label className="flex items-center gap-1.5">
            <span className="text-[var(--text-secondary)]">{t("screenshot.resizeWidth")}</span>
            <input
              type="number"
              min={1}
              max={MAX_IMAGE_SIDE}
              inputMode="numeric"
              value={resize.width}
              onChange={(e) => {
                const width = e.target.value;
                const parsed = Number.parseInt(width, 10);
                setResize({
                  ...resize,
                  width,
                  height: resize.lock && parsed > 0 ? String(resizeDimensions(doc, { width: parsed }, true).height) : resize.height,
                });
              }}
              className="w-24 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-deep)] px-2 py-1 text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)]"
              data-testid="screenshot-resize-width"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-[var(--text-secondary)]">{t("screenshot.resizeHeight")}</span>
            <input
              type="number"
              min={1}
              max={MAX_IMAGE_SIDE}
              inputMode="numeric"
              value={resize.height}
              onChange={(e) => {
                const height = e.target.value;
                const parsed = Number.parseInt(height, 10);
                setResize({
                  ...resize,
                  height,
                  width: resize.lock && parsed > 0 ? String(resizeDimensions(doc, { height: parsed }, true).width) : resize.width,
                });
              }}
              className="w-24 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-deep)] px-2 py-1 text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)]"
              data-testid="screenshot-resize-height"
            />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-[var(--text-secondary)]">
            <input type="checkbox" checked={resize.lock} onChange={(e) => setResize({ ...resize, lock: e.target.checked })} />
            {t("screenshot.resizeLock")}
          </label>
          <button
            type="button"
            onClick={applyResize}
            className="cursor-pointer rounded-lg bg-[var(--coral-bright)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
            data-testid="screenshot-resize-apply"
          >
            {t("screenshot.apply")}
          </button>
          <button type="button" onClick={() => setResize(null)} className="cursor-pointer rounded-lg bg-white/[0.08] px-3 py-1.5 text-sm hover:bg-white/[0.14]">
            {t("screenshot.cancel")}
          </button>
        </div>
      )}

      {confirmLeave && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm" role="alertdialog" data-testid="screenshot-discard">
          <Icon name="warning" size={18} color="#fbbf24" />
          <span className="min-w-0 flex-1">{t("screenshot.discardConfirm")}</span>
          <button type="button" onClick={onBack} className="cursor-pointer rounded-lg bg-red-500/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500" data-testid="screenshot-discard-yes">
            {t("screenshot.discard")}
          </button>
          <button type="button" onClick={() => setConfirmLeave(false)} className="cursor-pointer rounded-lg bg-white/[0.08] px-3 py-1.5 text-sm hover:bg-white/[0.14]">
            {t("screenshot.keepEditing")}
          </button>
        </div>
      )}

      {noticeOpen && (skippedNames.length > 0 || !image.regionApplied || image.scaledDown) && (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm" role="status" data-testid="screenshot-notice">
          <Icon name="info" size={18} color="#fbbf24" className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            {skippedNames.length > 0 && (
              <p>
                {t("screenshot.skippedNotice", { names: skippedNames.join(", ") })}{" "}
                {!canUseBrowserCapture && <span className="text-[var(--text-secondary)]">{t("screenshot.skippedNoRetry")}</span>}
              </p>
            )}
            {!image.regionApplied && <p>{t("screenshot.regionNotApplied")}</p>}
            {image.scaledDown && <p>{t("screenshot.scaledDown", { max: MAX_IMAGE_SIDE })}</p>}
            {skippedNames.length > 0 && canUseBrowserCapture && (
              <button
                type="button"
                onClick={onBrowserCapture}
                className="cursor-pointer rounded-lg bg-white/[0.1] px-3 py-1.5 text-sm hover:bg-white/[0.18]"
                data-testid="screenshot-retry-browser"
              >
                {t("screenshot.skippedRetry")}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setNoticeOpen(false)}
            title={t("screenshot.dismiss")}
            aria-label={t("screenshot.dismiss")}
            className="cursor-pointer rounded-md p-1 text-[var(--text-secondary)] hover:bg-white/[0.08] hover:text-[var(--text-primary)]"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {/* The picture */}
      <div ref={viewportRef} className="relative flex min-h-0 flex-1 overflow-auto bg-[#0b0f17]" data-testid="screenshot-viewport">
        {/* Auto margins centre a picture smaller than the view and collapse for a larger one, which then scrolls. */}
        <div className="m-auto shrink-0 p-4">
        <div
          className="relative shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_12px_40px_rgba(0,0,0,0.5)]"
          style={{ width: doc.width * zoom, height: doc.height * zoom }}
        >
          <canvas
            ref={canvasRef}
            aria-label={t("screenshot.canvasLabel")}
            data-testid="screenshot-canvas"
            className="block h-full w-full"
            style={{ touchAction: "none", cursor, imageRendering: zoom >= 3 ? "pixelated" : "auto" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => endGesture(e, false)}
            onPointerCancel={(e) => endGesture(e, true)}
            onDoubleClick={onDoubleClick}
            onContextMenu={(e) => e.preventDefault()}
          />
          {cropRect && tool === "crop" && (
            <div
              className="pointer-events-none absolute border border-white"
              style={{
                left: cropRect.x * zoom,
                top: cropRect.y * zoom,
                width: cropRect.width * zoom,
                height: cropRect.height * zoom,
                boxShadow: "0 0 0 100000px rgba(0, 0, 0, 0.55)",
              }}
            />
          )}
          {textEdit && textBox && (
            <textarea
              ref={textInput}
              value={textEdit.value}
              placeholder={t("screenshot.textPlaceholder")}
              spellCheck={false}
              onChange={(e) => setTextEdit({ ...textEdit, value: clampText(e.target.value) })}
              onBlur={commitText}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.preventDefault();
                  setTextEdit(null);
                  refocus();
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  commitText();
                }
              }}
              data-testid="screenshot-text-input"
              className="absolute resize-none overflow-hidden whitespace-pre rounded-md border border-dashed border-white/80 outline-none placeholder:text-current placeholder:opacity-50"
              style={{
                left: textBox.left,
                top: textBox.top,
                width: Math.max(textBox.width, 48),
                height: Math.max(textBox.height, 20),
                padding: textBox.padding,
                fontFamily: TEXT_FONT_FAMILY,
                fontWeight: 600,
                fontSize: textEdit.fontSize * zoom,
                lineHeight: TEXT_LINE_HEIGHT,
                color: textEdit.type === "callout" ? contrastColor(textEdit.color) : textEdit.color,
                background: textEdit.type === "callout" ? textEdit.color : "rgba(0, 0, 0, 0.35)",
              }}
            />
          )}
        </div>
        </div>
      </div>

      {status && (
        <div
          className={`flex shrink-0 items-center gap-2 border-t px-3 py-2 text-sm ${
            status.kind === "error" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
          }`}
          role={status.kind === "error" ? "alert" : "status"}
          data-testid="screenshot-status"
        >
          <Icon name={status.kind === "error" ? "error" : "check_circle"} size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">{status.text}</span>
          {status.kind === "saved" && canShowInFiles && (
            <button
              type="button"
              onClick={() => dispatchOpenApp("files", { forceNew: true, meta: { path: SCREENSHOTS_DIR } })}
              className="shrink-0 cursor-pointer rounded-lg bg-white/[0.1] px-3 py-1.5 text-sm hover:bg-white/[0.18]"
              data-testid="screenshot-show-in-files"
            >
              {t("screenshot.showInFiles")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setStatus(null)}
            title={t("screenshot.dismiss")}
            aria-label={t("screenshot.dismiss")}
            className="shrink-0 cursor-pointer rounded-md p-1 hover:bg-white/[0.08]"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(ScreenshotEditor);
