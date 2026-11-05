"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { dragHasFiles } from "./dropped-files";

/**
 * How long the desktop's drop overlay outlives the last `dragover` the page
 * heard. A drag over the page sends one at least every 350 ms (± 200), the
 * pointer still or not, so a second of silence means the drag ended or left.
 */
export const DESKTOP_DRAG_IDLE_MS = 1000;

export interface DesktopFileDrag {
  /** A drag of files is over the desktop itself: show "Drop files to upload". */
  dragOver: boolean;
  /** Take the overlay down (the desktop's own drop). */
  reset: () => void;
  dropHandlers: {
    onDragEnter: (e: DragEvent<HTMLElement>) => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
  };
}

/**
 * The desktop's own file drop ("saved to Downloads"). The overlay is up while
 * a drag of files is over the desktop and no drop zone of an app took it — a
 * zone (the chat's composer, Prime Radiant's Add) stops its drag events, so
 * the desktop never counts them. Counted by enter and leave like every drop
 * target; but the count alone can stick: a zone that takes the drop stops it,
 * and the desktop never hears the drop that would end its drag. So the
 * overlay also comes down on ANY drop or dragend in the page — heard by the
 * window before any app can stop it — and after {@link DESKTOP_DRAG_IDLE_MS}
 * without a dragover: it can never stay up after a drag.
 */
export function useDesktopFileDrag(): DesktopFileDrag {
  const [dragOver, setDragOver] = useState(false);
  // dragenter/dragleave fire for every element the pointer crosses: the
  // overlay is up while the count of entered-but-not-left ones is above zero.
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setDragOver(false);
  }, []);

  const onDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (!dragHasFiles(e.dataTransfer)) return;
    depth.current += 1;
    setDragOver(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    depth.current -= 1;
    if (depth.current <= 0) reset();
  }, [reset]);

  useEffect(() => {
    if (!dragOver) return;
    let idle = setTimeout(reset, DESKTOP_DRAG_IDLE_MS);
    const heard = () => {
      clearTimeout(idle);
      idle = setTimeout(reset, DESKTOP_DRAG_IDLE_MS);
    };
    // Capture on the window: it hears these before any element can stop them.
    window.addEventListener("dragover", heard, true);
    window.addEventListener("drop", reset, true);
    window.addEventListener("dragend", reset, true);
    return () => {
      clearTimeout(idle);
      window.removeEventListener("dragover", heard, true);
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragend", reset, true);
    };
  }, [dragOver, reset]);

  return { dragOver, reset, dropHandlers: { onDragEnter, onDragOver, onDragLeave } };
}
