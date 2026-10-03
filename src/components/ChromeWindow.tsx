"use client";

import { memo, useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { WINDOW_CHROME, WindowChromeContext, type WindowChrome, type WindowTone } from "@/lib/window-chrome";
import { createPortal } from "react-dom";
import * as kv from "@/lib/client-kv";
import SnapPreviewOverlay from "@/components/SnapPreviewOverlay";
import {
  DESKTOP_GAP,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  clampWindowPosition,
  desktopTop,
  fitPlacedWindow,
  fitWindowSize,
  getSnapRect,
  getSnapZone,
  maximizedRect,
  snapTargetAt,
  workArea,
  type SnapTarget,
  type SnapZone,
} from "@/lib/window-snap";
import { useKioskBarInset } from "@/lib/kiosk-bar-inset";
import { followLayout, mainScreen, rejoinLayout, screenAt, screenIdOf } from "@/lib/desktop-screens";
import { useDeskScreens } from "@/lib/use-desk-screens";

/** Flat fallback for the CSS `calc()` that maximizes a window. */
const SHELF_HEIGHT = 56;

interface ChromeWindowProps {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  appId?: string;
  defaultWidth?: number;
  defaultHeight?: number;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  isActive: boolean;
  zIndex: number;
  onClose: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  onGeometryChange?: (geo: { x: number; y: number; width: number; height: number }) => void;
  minimized?: boolean;
  rightInset?: number;
  /** Bumped by the desktop when something asks for this window maximized; each new value maximizes. */
  maximizeSignal?: number;
  /**
   * How a restored window stood when it was saved (TASK-1306): maximized, or
   * snapped to a zone (laid out again for THIS desktop), and the rect either
   * one goes back to. Read once, when the window mounts.
   */
  initialMaximized?: boolean;
  initialSnapped?: SnapZone;
  initialRestore?: WindowRect;
  /**
   * Told whenever the window is maximized, snapped or set free again, with
   * the rect it goes back to and where it stands now — what the desktop saves
   * so a refresh brings it back the same way. Not told at mount.
   */
  onModeChange?: (mode: WindowMode) => void;
  /** The desktop's id for this window, carried as `data-window-id`. */
  windowId?: string;
}

export interface WindowRect { x: number; y: number; width: number; height: number }

export interface WindowMode {
  maximized: boolean;
  snapped: SnapZone;
  /** Where a maximized or snapped window goes back to; null for a free one. */
  restore: WindowRect | null;
  /** Where it stands now — a snapped window's zone rect, a maximized one's free rect. */
  geometry: WindowRect;
}

function getSavedSize(appId: string | undefined, defaultWidth: number, defaultHeight: number) {
  if (!appId || typeof window === "undefined") return { width: defaultWidth, height: defaultHeight };
  const saved = kv.getJSON<{ width: number; height: number }>(`clawbox-winsize-${appId}`);
  if (saved && saved.width >= 300 && saved.height >= 200) return saved;
  return { width: defaultWidth, height: defaultHeight };
}

// Calculate initial centered position within available space
function getInitialPosition(width: number, height: number, rInset = 0) {
  if (typeof window === "undefined") return { x: 100, y: 50 };
  // Centred on the MAIN monitor's work area — the viewport with one screen:
  // the strip between the kiosk bar (0 without one) and the shelf.
  const area = workArea(mainScreen(), rInset);
  const maxWidth = area.width;
  const top = area.y;
  const maxHeight = area.height;
  const centredX = Math.max(20, (maxWidth - width) / 2);
  return {
    // Beside a docked chat the 20px floor alone could still put the right end
    // of a strip-wide window — where its controls live — under the panel, so
    // the window ends DESKTOP_GAP before the chat's edge, the margin the
    // desktop's floating surfaces keep from each other.
    x: area.x + (rInset > 0 ? Math.min(centredX, Math.max(DESKTOP_GAP, maxWidth - DESKTOP_GAP - width)) : centredX),
    y: top + Math.max(20, (maxHeight - height) / 2),
  };
}

/** How long a window restored snapped waits for the monitors before it forgets which one it was on. */
const SAVED_SNAP_ANCHOR_MS = 15_000;

/** A point that says which monitor a rect is on: its centre, near its top. */
function anchorOf(r: { x: number; y: number; width: number; height: number }) {
  return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 18) };
}

function sameRect(a: WindowRect | null, b: WindowRect): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// Memoized (see the export at the bottom): the desktop re-renders for things
// no window shows — the shelf clock, a poll, an icon dragged across the
// wallpaper — and every window re-rendered with it, its whole app inside.
function ChromeWindow({
  title,
  children,
  appId,
  defaultWidth = 800,
  defaultHeight = 600,
  initialPosition,
  initialSize,
  isActive,
  zIndex,
  onClose,
  onFocus,
  onMinimize,
  onGeometryChange,
  minimized = false,
  rightInset = 0,
  maximizeSignal,
  initialMaximized = false,
  initialSnapped = null,
  initialRestore,
  onModeChange,
  windowId,
}: ChromeWindowProps) {
  const { t } = useT();
  // Geometry that arrives from outside — a restored workspace, a size saved on
  // a bigger screen — is fitted to THIS desktop before it is ever painted: a
  // window restored with its title bar under the shelf or its controls past the
  // right edge cannot be reached by hand, and minimize/restore and every reload
  // put it back in exactly the same place.
  // A window the desktop places for the FIRST time is fitted to the strip
  // beside a docked chat as well (see `fitWindowSize`); one restored to a
  // saved place keeps the size it had there, like every window already open.
  // A window restored SNAPPED takes its zone's rect on this desktop, whatever
  // rect it had on the one it was saved on.
  const [initialSnapRect] = useState(() => (initialSnapped && typeof window !== "undefined"
    // On the monitor it was saved on, when the saved rect says which.
    ? getSnapRect(initialSnapped, rightInset, initialPosition && initialSize ? anchorOf({ ...initialPosition, ...initialSize }) : undefined)
    : null));
  const [size, setSize] = useState(() => initialSnapRect
    ? { width: initialSnapRect.width, height: initialSnapRect.height }
    : initialPosition
      // Restored to a place: fitted where it stands (a window stretched over
      // two monitors keeps its width; see `fitPlacedWindow`).
      ? fitPlacedWindow({ ...initialPosition, ...(initialSize || getSavedSize(appId, defaultWidth, defaultHeight)) })
      : fitWindowSize(initialSize || getSavedSize(appId, defaultWidth, defaultHeight), rightInset));
  const [position, setPosition] = useState(() => (
    initialSnapRect
      ? { x: initialSnapRect.x, y: initialSnapRect.y }
      : initialPosition
        ? clampWindowPosition({ ...initialPosition, ...size })
        : getInitialPosition(size.width, size.height, rightInset)
  ));
  const [maximized, setMaximized] = useState(initialMaximized);
  const [snapped, setSnapped] = useState<SnapZone>(initialSnapRect ? initialSnapped : null);
  // The zone a drag would snap to and the monitor it would be laid on, so the
  // preview plate stands where the drop will put the window.
  const [snapPreview, setSnapPreview] = useState<SnapTarget | null>(null);
  const [closing, setClosing] = useState(false);
  const [opening, setOpening] = useState(true);
  const [minimizing, setMinimizing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // The title bar's slot for the app's own controls, and the face of the
  // chrome the app asked for (see window-chrome.ts).
  const [actionsEl, setActionsEl] = useState<HTMLDivElement | null>(null);
  const [tone, setTone] = useState<WindowTone>("dark");
  const chrome = useMemo<WindowChrome>(() => ({ actions: actionsEl, active: isActive, tone, setTone }), [actionsEl, isActive, tone]);
  const palette = WINDOW_CHROME[tone];
  const windowRef = useRef<HTMLDivElement>(null);
  // `moved`: the window has left the place the press found it — the moment it
  // takes a compositor layer of its own (see handleMove).
  const dragRef = useRef({ isDragging: false, moved: false, startX: 0, startY: 0, startPosX: 0, startPosY: 0 });
  const resizeRef = useRef<{
    isResizing: boolean;
    edge: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startPosX: number;
    startPosY: number;
  }>({ isResizing: false, edge: "", startX: 0, startY: 0, startW: 0, startH: 0, startPosX: 0, startPosY: 0 });
  // Where Restore (or dragging a snapped window free) goes back to. A window
  // restored maximized or snapped brings its own; otherwise it is set the
  // moment the window is maximized or snapped.
  const [initialPrevRect] = useState<WindowRect>(() => {
    if (initialRestore && (initialMaximized || initialSnapRect)) {
      const fitted = fitPlacedWindow(initialRestore);
      return { ...fitted, ...clampWindowPosition({ ...initialRestore, ...fitted }) };
    }
    return { width: size.width, height: size.height, x: position.x, y: position.y };
  });
  const prevSizeRef = useRef<WindowRect>(initialPrevRect);
  const currentSizeRef = useRef({ width: defaultWidth, height: defaultHeight });
  const currentPosRef = useRef(position);
  const prevMinimizedRef = useRef(minimized);
  const rightInsetRef = useRef(rightInset);
  // Read through refs by the pointer listeners, so a desktop that hands a
  // fresh callback on every render does not tear down and re-add the four
  // window listeners each time (they are installed once per window).
  const onGeometryChangeRef = useRef(onGeometryChange);
  const onModeChangeRef = useRef(onModeChange);
  // The geometry the desktop's record of this window holds — what it was
  // mounted from, or the last rect this window told it. A press that moves
  // nothing tells it nothing: the same numbers again rebuilt the desktop and
  // every app in every window for a record that did not change.
  const [mountedRect] = useState<WindowRect | null>(() => (initialPosition && initialSize ? { ...initialPosition, ...initialSize } : null));
  const reportedRef = useRef<WindowRect | null>(mountedRect);
  // The snap zone as last committed, for the drop path's listeners.
  const snappedRef = useRef<SnapZone>(snapped);
  // Where a snap drop put the window, for the layout effect that writes it
  // once the drop has committed (see there).
  const snapLandingRef = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    rightInsetRef.current = rightInset;
  }, [rightInset]);

  useLayoutEffect(() => {
    onGeometryChangeRef.current = onGeometryChange;
    onModeChangeRef.current = onModeChange;
  }, [onGeometryChange, onModeChange]);

  useLayoutEffect(() => {
    snappedRef.current = snapped;
  }, [snapped]);

  useLayoutEffect(() => {
    currentSizeRef.current = size;
  }, [size]);

  useLayoutEffect(() => {
    currentPosRef.current = position;
  }, [position]);

  // A snap drop lands the window on its zone's left/top. The drop writes the
  // DROP POINT onto the element (so nothing jumps before React commits), and
  // React writes only a style that differs from what it LAST rendered — which
  // is where the window stood before the drag. So a zone whose corner is that
  // same spot (a window at the top-left snapped to the left half) was given
  // the zone's size and left standing at the drop point. Written here, after
  // the commit, because the commit is what turns the glide on (`transition`,
  // for a snapped window that is not being dragged): the drop computed the
  // drop point's style, so the window still glides from where it was let go.
  useLayoutEffect(() => {
    const landing = snapLandingRef.current;
    if (!landing) return;
    snapLandingRef.current = null;
    const el = windowRef.current;
    if (!el) return;
    el.style.left = `${landing.x}px`;
    el.style.top = `${landing.y}px`;
  }, [position]);

  // Opening animation - runs once on mount
  useEffect(() => {
    const timer = setTimeout(() => setOpening(false), 200);
    return () => clearTimeout(timer);
  }, []);

  // Handle minimize state changes - synchronize animation state with minimized prop
  useLayoutEffect(() => {
    const wasMinimized = prevMinimizedRef.current;
    prevMinimizedRef.current = minimized;
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (minimized && !wasMinimized) {
      // Starting minimize animation
      frame = requestAnimationFrame(() => {
        setMinimizing(true);
      });
    } else if (!minimized && wasMinimized) {
      frame = requestAnimationFrame(() => {
        // Clear any leftover minimizing state before restoring
        setMinimizing(false);
        // Starting restore animation
        setRestoring(true);
        timer = setTimeout(() => setRestoring(false), 250);
      });
    }

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
    };
  }, [minimized]);

  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    // The app's own controls in the bar are buttons, not a grip.
    if ((e.target as HTMLElement | null)?.closest?.("[data-window-titlebar-actions]")) return;
    if (maximized) {
      // No drag from a maximized bar — but a mousedown's other default, moving
      // focus, is still refused, as the drag path below refuses it: that is
      // what keeps the keyboard in the window's content when Maximize is
      // clicked, and the early return here let a click on Restore leave focus
      // on the button, so a terminal swallowed every keystroke until it was
      // clicked again (sweep FT-3). Touch is left alone: a cancelled
      // touchstart cancels the tap it would have become.
      if (!("touches" in e)) e.preventDefault();
      return;
    }
    e.preventDefault();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;

    // If snapped, restore to pre-snap size and center on cursor
    if (snapped) {
      const restoreW = prevSizeRef.current.width;
      const restoreH = prevSizeRef.current.height;
      // Centred on the cursor, then pulled back onto the desktop: a snapped
      // window grabbed near the left edge would otherwise be dropped half its
      // width off-screen if the pointer never moved.
      const { x: newX, y: newY } = clampWindowPosition(
        { x: clientX - restoreW / 2, y: clientY - 18, width: restoreW, height: restoreH },
      );
      setSize({ width: restoreW, height: restoreH });
      setPosition({ x: newX, y: newY });
      setSnapped(null);
      dragRef.current = {
        isDragging: true,
        moved: false,
        startX: clientX,
        startY: clientY,
        startPosX: newX,
        startPosY: newY,
      };
    } else {
      dragRef.current = {
        isDragging: true,
        moved: false,
        startX: clientX,
        startY: clientY,
        startPosX: position.x,
        startPosY: position.y,
      };
    }
    setIsDragging(true);
    // No layer yet: a press is mostly a click (focus, a double-click to
    // maximize), and promoting the window here rastered all of it into a layer
    // of its own and the release painted it back, with nothing moved between.
    // handleMove promotes it once it actually moves.
    //
    // Asked even of the ACTIVE window: the floating chat takes its layers
    // from the same counter, so the window on top of the others can still be
    // under the chat, and grabbing its title bar is what brings it forward.
    // Whether it already holds the top layer is the desktop's to know — its
    // focus handler is where a press on the top window is answered with
    // nothing.
    onFocus();
  }, [maximized, snapped, position.x, position.y, onFocus]);

  const handleResizeStart = useCallback((edge: string, e: React.MouseEvent | React.TouchEvent) => {
    if (maximized) return;
    e.preventDefault();
    e.stopPropagation();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    resizeRef.current = {
      isResizing: true,
      edge,
      startX: clientX,
      startY: clientY,
      startW: size.width,
      startH: size.height,
      startPosX: position.x,
      startPosY: position.y,
    };
    if (snapped) setSnapped(null);
    onFocus();
  }, [maximized, snapped, size.width, size.height, position.x, position.y, onFocus]);

  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      const el = windowRef.current;

      if (resizeRef.current.isResizing) {
        const r = resizeRef.current;
        const dx = clientX - r.startX;
        const dy = clientY - r.startY;
        let newW = r.startW;
        let newH = r.startH;
        let newX = r.startPosX;
        let newY = r.startPosY;

        if (r.edge.includes("r")) newW = Math.max(MIN_WINDOW_WIDTH, r.startW + dx);
        if (r.edge.includes("b")) newH = Math.max(MIN_WINDOW_HEIGHT, r.startH + dy);
        if (r.edge.includes("l")) {
          const dw = Math.min(dx, r.startW - MIN_WINDOW_WIDTH);
          newW = r.startW - dw;
          newX = r.startPosX + dw;
        }
        if (r.edge.includes("t")) {
          const dh = Math.min(dy, r.startH - MIN_WINDOW_HEIGHT);
          newH = r.startH - dh;
          // Not above the desktop's top: under the kiosk bar the title bar
          // could not be grabbed again.
          newY = Math.max(desktopTop(), r.startPosY + dh);
        }

        // Direct DOM update — no React re-render during resize
        if (el) {
          el.style.left = newX + "px";
          el.style.top = newY + "px";
          el.style.width = newW + "px";
          el.style.height = newH + "px";
        }
        currentPosRef.current = { x: newX, y: newY };
        currentSizeRef.current = { width: newW, height: newH };
        // Disable pointer events on content during resize
        if (contentRef.current) contentRef.current.style.pointerEvents = "none";
        return;
      }

      if (!dragRef.current.isDragging) return;
      const dx = clientX - dragRef.current.startX;
      const dy = clientY - dragRef.current.startY;
      // Clamped on every edge, not just the top: dragged down until the title
      // bar sat under the shelf, a window was unreachable for good — no context
      // menu offers Close, and minimize/restore and the next reload both put it
      // straight back. The cursor is still free, so the snap zones below still
      // fire at the real screen edges.
      const { x: newX, y: newY } = clampWindowPosition({
        x: dragRef.current.startPosX + dx,
        y: dragRef.current.startPosY + dy,
        ...currentSizeRef.current,
      });
      // Read BEFORE the write below: the snap test measures the shelf, and a
      // measurement taken after a style write forces a synchronous layout on
      // every pointer move.
      const snapAt = snapTargetAt(clientX, clientY, rightInsetRef.current, null);

      // Direct DOM update — no React re-render during drag — and a TRANSFORM
      // from where the drag started, not left/top: the window is on a layer
      // of its own while it moves, so the GPU compositor moves it without a
      // layout or a repaint. Writing left/top here re-laid out the window and
      // repainted the whole desktop under it on every pointer move — 5120x1440
      // of it over two monitors.
      //
      // The layer is taken at the first move that actually moves the window,
      // not at the press (see handleDragStart). And the offset goes in the
      // `translate` property, not `transform`: the open and restore animations
      // run `transform` with fill-mode forwards, and an animation outranks an
      // inline style, so a window grabbed in the first quarter-second after it
      // opened did not follow the pointer until the class came off, and then
      // jumped. `translate` composes with them, and composites exactly as
      // `transform` does under `will-change: transform`.
      const drag = dragRef.current;
      const offsetX = newX - drag.startPosX;
      const offsetY = newY - drag.startPosY;
      if (el && (drag.moved || offsetX !== 0 || offsetY !== 0)) {
        if (!drag.moved) {
          drag.moved = true;
          el.style.willChange = "transform";
        }
        el.style.translate = `${offsetX}px ${offsetY}px`;
      }
      currentPosRef.current = { x: newX, y: newY };
      // Disable pointer events on content during drag
      if (contentRef.current) contentRef.current.style.pointerEvents = "none";
      setSnapPreview((prev) => (snapAt && prev && prev.zone === snapAt.zone && screenAt(prev.at.x, prev.at.y).id === screenAt(snapAt.at.x, snapAt.at.y).id ? prev : snapAt));
    };

    const notifyGeometry = () => {
      const report = onGeometryChangeRef.current;
      if (!report) return;
      const s = currentSizeRef.current;
      const p = currentPosRef.current;
      const geometry = { x: p.x, y: p.y, width: s.width, height: s.height };
      // Already what the desktop holds (a click, a double-click, a grab let go
      // where it began): nothing to tell it. See `reportedRef`.
      if (sameRect(reportedRef.current, geometry)) return;
      reportedRef.current = geometry;
      report(geometry);
    };

    // `release` is false for a touch the browser CANCELLED (it took the
    // gesture for itself): the gesture ends where it stands, as a release
    // there would, but snaps nothing — the owner did not let go. Without it a
    // cancelled drag kept its layer and offset, kept the content deaf to the
    // pointer, and went on following the next touch anywhere on the screen.
    const handleEnd = (e: MouseEvent | TouchEvent, release = true) => {
      // Re-enable pointer events on content
      if (contentRef.current) contentRef.current.style.pointerEvents = "";

      if (resizeRef.current.isResizing) {
        resizeRef.current.isResizing = false;
        // Commit final size/position to React state
        const cur = currentSizeRef.current;
        const pos = currentPosRef.current;
        setSize({ width: cur.width, height: cur.height });
        setPosition({ x: pos.x, y: pos.y });
        // Save resized size per app
        if (appId) {
          kv.setJSON(`clawbox-winsize-${appId}`, { width: cur.width, height: cur.height });
        }
        notifyGeometry();
        return;
      }

      if (!dragRef.current.isDragging) return;
      dragRef.current.isDragging = false;
      dragRef.current.moved = false;
      setIsDragging(false);

      // Where it lands, measured BEFORE the writes below, as handleMove does:
      // on the main monitor the snap test measures the shelf, and measured
      // after a style write it forced a synchronous layout of the whole page.
      let zone: SnapZone = null;
      let rect: ReturnType<typeof getSnapRect> = null;
      if (release) {
        const point = "changedTouches" in e ? e.changedTouches[0] : (e as MouseEvent);
        if (point) {
          zone = getSnapZone(point.clientX, point.clientY, rightInsetRef.current);
          // On the monitor the window was dropped on.
          rect = getSnapRect(zone, rightInsetRef.current, { x: point.clientX, y: point.clientY });
          if (!rect) zone = null;
        }
      }

      // The drag's offset becomes the window's position again: written to
      // left/top here so nothing jumps before React commits the same values.
      const el = windowRef.current;
      if (el) {
        el.style.translate = "";
        el.style.willChange = "";
        el.style.left = currentPosRef.current.x + "px";
        el.style.top = currentPosRef.current.y + "px";
        // A snap glides from the drop point to the zone, and a CSS transition
        // starts from the last style the browser COMPUTED — which, the motion
        // having been all in the offset, is the left/top the drag began at:
        // with nothing computed in between, the window jumped back to where
        // it was grabbed and slid from there. (On the main monitor the shelf
        // measurement above used to come after these writes and computed the
        // style by the way, which is why only the other monitors showed it.)
        // A style read is enough — no layout — and only a snap needs it.
        if (rect) void getComputedStyle(el).opacity;
      }
      setSnapPreview(null);

      if (zone && rect) {
        const cur = currentSizeRef.current;
        const pos = currentPosRef.current;
        prevSizeRef.current = { width: cur.width, height: cur.height, x: pos.x, y: pos.y };
        snapLandingRef.current = { x: rect.x, y: rect.y };
        setPosition({ x: rect.x, y: rect.y });
        setSize({ width: rect.width, height: rect.height });
        setSnapped(zone);
        // The mode report that follows (the effect on `snapped`) carries the
        // zone's rect as the window's geometry, and the drop point as the rect
        // it goes back to: reporting the drop point here first rebuilt the
        // desktop twice for one drop, ending in the same record.
        if (onModeChangeRef.current && zone !== snappedRef.current) return;
      } else {
        // Commit final drag position to React state
        setPosition(currentPosRef.current);
      }
      notifyGeometry();
    };
    const handleCancel = (e: TouchEvent) => handleEnd(e, false);

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleEnd);
    window.addEventListener("touchmove", handleMove);
    window.addEventListener("touchend", handleEnd);
    window.addEventListener("touchcancel", handleCancel);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
      window.removeEventListener("touchcancel", handleCancel);
    };
  }, [appId]);

  const handleClose = useCallback(() => {
    // No size write here: the resize-end path saves what the owner chose the
    // moment they let go, and a close-time write of `currentSizeRef` saved
    // whatever geometry the window ended in — the strip beside a docked chat
    // it was fitted to, or a snap after the owner's own resize — as the
    // app's remembered size (the sweep of 2026-09-07 and its review).
    setClosing(true);
    setTimeout(() => onClose(), 150);
  }, [onClose, appId]);

  const handleMaximize = useCallback(() => {
    if (maximized) {
      setSize({ width: prevSizeRef.current.width, height: prevSizeRef.current.height });
      setPosition({ x: prevSizeRef.current.x, y: prevSizeRef.current.y });
      setMaximized(false);
    } else {
      // If snapped, save pre-snap size; otherwise save current
      if (!snapped) {
        prevSizeRef.current = { width: size.width, height: size.height, x: position.x, y: position.y };
      }
      setSnapped(null);
      setMaximized(true);
    }
  }, [maximized, snapped, size.width, size.height, position.x, position.y]);

  // Asked for maximized from outside (the chat's View lands on a run's page
  // with the whole desktop for it): each new signal value maximizes once, a
  // window already maximized stays as it is.
  const lastMaximizeSignal = useRef(0);
  useEffect(() => {
    if (!maximizeSignal || maximizeSignal === lastMaximizeSignal.current) return;
    lastMaximizeSignal.current = maximizeSignal;
    if (maximized) return;
    if (!snapped) {
      prevSizeRef.current = { width: size.width, height: size.height, x: position.x, y: position.y };
    }
    // A request from outside is external state the window synchronises to.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapped(null);
    setMaximized(true);
  }, [maximizeSignal, maximized, snapped, size.width, size.height, position.x, position.y]);

  // The desktop can change shape under a window: the viewport resizes, or the
  // chat is docked and then dragged wider. A SNAPPED window keeps the rect it
  // was given at drop time, so widening the panel by 80px buried its minimize,
  // maximize and close buttons under the chat; a free window can be left with
  // its title bar off the smaller desktop, which is the one handle it has. A
  // MAXIMIZED window needs nothing — its geometry is a CSS calc that already
  // follows both. The kiosk bar showing or hiding (`barInset`) moves the top
  // of the desktop, which is the same kind of change.
  const barInset = useKioskBarInset();
  // The monitors the desktop is spread over (null with one screen): a monitor
  // added, removed or rearranged is the same kind of change again.
  const deskScreens = useDeskScreens();
  // The monitors were rearranged, resized or one was turned off: the window
  // moves WITH its monitor — its free rect and the rect Restore goes back to
  // alike — before the relayout below fits it to that monitor. Without this a
  // left/right swap left every window where it was in the row, which is now
  // the other monitor.
  //
  // A row that becomes ONE screen (mirrored, or every other monitor off) and
  // comes back is two changes: the window remembers which monitor it was on
  // as the row goes (`wasOnRef`) and returns to it after. A page that only
  // LEARNS the row at load (null, then the monitors) moves nothing — its
  // windows were restored in the row's own coordinates.
  const prevScreensRef = useRef(deskScreens);
  const wasOnRef = useRef<{ window: string | null; restore: string | null } | null>(null);
  // A window restored SNAPPED usually mounts before the page knows the
  // monitors (the desktop's state is read before the monitors are), so its
  // zone was laid on the one screen there was — the viewport, the whole row
  // — and its rect no longer says which monitor it was snapped on. The saved
  // rect does: kept until the monitors are known, the first relayout with
  // them puts it back on THAT monitor, not on the one the viewport-wide
  // rect's centre happened to fall on. Dropped at the first change of mode
  // made by hand, too: from then on the window is where it was put.
  const savedSnapAnchorRef = useRef<{ zone: SnapZone; at: { x: number; y: number } } | null>(
    initialSnapRect && initialPosition && initialSize
      ? { zone: initialSnapped, at: anchorOf({ ...initialPosition, ...initialSize }) }
      : null,
  );
  // The desktop asks for its monitors as it loads; a memory still unused well
  // after that belongs to a page that is on ONE screen, and must not throw a
  // snapped window onto a monitor plugged in hours later.
  useEffect(() => {
    if (!savedSnapAnchorRef.current) return;
    const timer = setTimeout(() => { savedSnapAnchorRef.current = null; }, SAVED_SNAP_ANCHOR_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const prev = prevScreensRef.current;
    prevScreensRef.current = deskScreens;
    if (prev === deskScreens) return;
    const rect = { ...currentPosRef.current, ...currentSizeRef.current };
    const r = prevSizeRef.current;
    if (prev && !deskScreens) wasOnRef.current = { window: screenIdOf(rect, prev), restore: screenIdOf(r, prev) };
    const back = !prev && deskScreens ? wasOnRef.current : null;
    if (deskScreens) wasOnRef.current = null;
    const moved = back ? rejoinLayout(rect, back.window, deskScreens) : followLayout(rect, prev, deskScreens);
    if (moved) {
      currentPosRef.current = moved;
      // The monitors are external state this window synchronises to.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPosition(moved);
    }
    const restore = back ? rejoinLayout(r, back.restore, deskScreens) : followLayout(r, prev, deskScreens);
    if (restore) prevSizeRef.current = { ...r, ...restore };
  }, [deskScreens]);
  useEffect(() => {
    if (maximized) return;
    const relayout = () => {
      if (snapped) {
        // Kept on the monitor it is snapped on — the one its saved rect names
        // until the monitors are known (see `savedSnapAnchorRef`).
        const saved = savedSnapAnchorRef.current;
        const at = saved && saved.zone === snapped ? saved.at : anchorOf({ ...currentPosRef.current, ...currentSizeRef.current });
        if (deskScreens) savedSnapAnchorRef.current = null;
        const rect = getSnapRect(snapped, rightInset, at);
        if (!rect) return;
        // The desktop's shape is external state this window synchronises to.
        setPosition((p) => (p.x === rect.x && p.y === rect.y ? p : { x: rect.x, y: rect.y }));
        setSize((s) => (s.width === rect.width && s.height === rect.height ? s : { width: rect.width, height: rect.height }));
        return;
      }
      // FIT, then place. `clampWindowPosition` keeps whatever dimensions it is
      // handed, so a window sized on a bigger display — or restored from
      // maximized onto a viewport that shrank while it was full-screen — kept
      // that size and the clamp could only choose which edge hung off: pushed
      // left, its right-hand controls stayed past the right edge; pinned to the
      // top, its bottom resize handle stayed under the shelf. Both are the
      // handles needed to fix it by hand, which is the same trap `fitWindowSize`
      // was written for at mount.
      // Fitted where it stands: its height to its monitor, its width to the
      // row, which a window stretched across the seam may need.
      const fitted = fitPlacedWindow({ ...currentPosRef.current, ...currentSizeRef.current });
      // The ref is advanced by hand because `setSize`'s write has not landed
      // yet: a second resize event arriving before the re-render would read the
      // size this one just replaced.
      currentSizeRef.current = fitted;
      setSize((s) => (s.width === fitted.width && s.height === fitted.height ? s : fitted));
      setPosition((p) => {
        const next = clampWindowPosition({ ...p, ...fitted });
        return next.x === p.x && next.y === p.y ? p : next;
      });
    };
    relayout();
    window.addEventListener("resize", relayout);
    return () => window.removeEventListener("resize", relayout);
  }, [maximized, snapped, rightInset, barInset, deskScreens]);

  // Maximized, snapped, set free: the desktop hears each change (not the
  // mount — it already knows how the window started) so a refresh brings the
  // window back the way it was left. (`onModeChangeRef` is declared with the
  // other callback refs above.)
  const modeMountedRef = useRef(false);
  useEffect(() => {
    if (!modeMountedRef.current) {
      modeMountedRef.current = true;
      return;
    }
    savedSnapAnchorRef.current = null;
    const pos = currentPosRef.current;
    const cur = currentSizeRef.current;
    const geometry = { x: pos.x, y: pos.y, width: cur.width, height: cur.height };
    const report = onModeChangeRef.current;
    if (!report) return;
    // The desktop's record takes this geometry too (see `reportedRef`).
    reportedRef.current = geometry;
    report({
      maximized,
      snapped,
      restore: maximized || snapped ? { ...prevSizeRef.current } : null,
      geometry,
    });
  }, [maximized, snapped]);

  const handleMinimize = useCallback(() => {
    setMinimizing(true);
    setTimeout(() => {
      setMinimizing(false);
      onMinimize();
    }, 250);
  }, [onMinimize]);

  if (minimized && !restoring) return null;

  // Maximized: edge to edge, flush with the screen and the shelf, square
  // corners — exactly what a snapped window is (the owner's ask, 2026-09-30:
  // no small paddings around the windows; it used to keep DESKTOP_GAP on every
  // side, with its corners). Beside a docked chat it ends where `rightInset`
  // ends, the chat's left edge, so the one margin left on screen is the chat's
  // own, on the chat's side of that line. On the laptop's kiosk it starts
  // under the kiosk bar while that bar is up (`barInset`, 0 everywhere else).
  //
  // Over a row of monitors (`deskScreens`) it fills the monitor its free rect
  // is on — the main one stops above the shelf and short of a docked chat,
  // another is filled whole.
  const maxRect = maximized && deskScreens ? maximizedRect(rightInset, anchorOf({ ...position, ...size })) : null;
  const windowStyle = maxRect
    ? { left: maxRect.x, top: maxRect.y, width: maxRect.width, height: maxRect.height }
    : maximized
    ? {
      left: 0,
      top: barInset,
      width: rightInset > 0 ? `calc(100% - ${rightInset}px)` : "100%",
      height: `calc(100vh - ${SHELF_HEIGHT + barInset}px - env(safe-area-inset-bottom, 0px))`,
    }
      : { left: position.x, top: position.y, width: size.width, height: size.height };
  // A flush window has no corners to round: snapped to an edge, or maximized.
  const flush = snapped || maximized;

  return (
    <div
      ref={windowRef}
      data-testid={appId ? `chrome-window-${appId}` : undefined}
      data-window-id={windowId}
      data-active={isActive ? "true" : "false"}
      data-maximized={maximized ? "true" : undefined}
      data-snapped={snapped ?? undefined}
      className={`fixed flex flex-col overflow-hidden ${
        opening ? "chrome-window-opening" : ""
      } ${closing ? "chrome-window-closing" : ""} ${
        minimizing ? "chrome-window-minimizing" : ""
      } ${restoring ? "chrome-window-restoring" : ""}`}
      style={{
        ...windowStyle,
        zIndex,
        borderRadius: flush ? 0 : 8,
        boxShadow: isActive ? palette.shadow : palette.shadowInactive,
        opacity: 1,
        transition: snapped && !isDragging
          ? "left 0.2s ease-out, top 0.2s ease-out, width 0.2s ease-out, height 0.2s ease-out, opacity 0.15s, box-shadow 0.15s"
          : "opacity 0.15s, box-shadow 0.15s",
      }}
      onMouseDown={isActive ? undefined : onFocus}
    >
      {/* Title bar — ChromeOS style */}
      <div
        className="flex items-center h-9 px-2 cursor-default select-none shrink-0"
        style={{
          background: isActive ? palette.titleBar : palette.titleBarInactive,
          borderBottom: `1px solid ${palette.hairline}`,
          borderRadius: flush ? 0 : "8px 8px 0 0",
        }}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement | null)?.closest?.("[data-window-titlebar-actions]")) return;
          handleMaximize();
        }}
      >
        {/* Left: title */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`text-xs font-medium truncate ${isActive ? palette.titleClass : palette.titleInactiveClass}`}>{title}</span>
        </div>

        {/* The app's own controls (window-chrome.ts), left of the window's. */}
        <div ref={setActionsEl} data-window-titlebar-actions="true" className="flex items-center gap-1 ml-2 empty:hidden" />

        {/* Right: window controls — ChromeOS circular buttons */}
        <div className="flex items-center gap-1.5 ml-2">
          {/* Minimize */}
          <button
            onClick={handleMinimize}
            className={`w-6 h-6 flex items-center justify-center rounded-full ${palette.controlHoverClass} transition-colors cursor-pointer`}
            title={t("window.minimize")}
            aria-label={t("window.minimize")}
          >
            <span className={`material-symbols-rounded ${palette.controlClass}`} style={{ fontSize: 16 }}>minimize</span>
          </button>

          {/* Maximize */}
          <button
            onClick={handleMaximize}
            className={`w-6 h-6 flex items-center justify-center rounded-full ${palette.controlHoverClass} transition-colors cursor-pointer`}
            title={maximized ? t("window.restore") : t("window.maximize")}
            aria-label={maximized ? t("window.restore") : t("window.maximize")}
          >
            <span className={`material-symbols-rounded ${palette.controlClass}`} style={{ fontSize: 16 }}>{maximized ? "filter_none" : "crop_square"}</span>
          </button>

          {/* Close */}
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-red-500/80 active:bg-red-600 transition-colors cursor-pointer group"
            title={t("window.close")}
            aria-label={t("window.close")}
          >
            <span className={`material-symbols-rounded ${palette.controlClass} group-hover:text-white`} style={{ fontSize: 16 }}>close</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div ref={contentRef} data-chrome-window-content="true" className="flex-1 overflow-hidden" style={{ background: palette.ground }}>
        <WindowChromeContext.Provider value={chrome}>{children}</WindowChromeContext.Provider>
      </div>

      {/* Resize handles — hidden when maximized/snapped */}
      {!maximized && !snapped && (
        <>
          {/* Edges */}
          <div className="absolute top-0 left-2 right-2 h-1 cursor-n-resize" onMouseDown={(e) => handleResizeStart("t", e)} onTouchStart={(e) => handleResizeStart("t", e)} />
          <div className="absolute bottom-0 left-2 right-2 h-1 cursor-s-resize" onMouseDown={(e) => handleResizeStart("b", e)} onTouchStart={(e) => handleResizeStart("b", e)} />
          <div className="absolute left-0 top-2 bottom-2 w-1 cursor-w-resize" onMouseDown={(e) => handleResizeStart("l", e)} onTouchStart={(e) => handleResizeStart("l", e)} />
          <div className="absolute right-0 top-2 bottom-2 w-1 cursor-e-resize" onMouseDown={(e) => handleResizeStart("r", e)} onTouchStart={(e) => handleResizeStart("r", e)} />
          {/* Corners */}
          <div className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize" onMouseDown={(e) => handleResizeStart("tl", e)} onTouchStart={(e) => handleResizeStart("tl", e)} />
          <div className="absolute top-0 right-0 w-3 h-3 cursor-ne-resize" onMouseDown={(e) => handleResizeStart("tr", e)} onTouchStart={(e) => handleResizeStart("tr", e)} />
          <div className="absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize" onMouseDown={(e) => handleResizeStart("bl", e)} onTouchStart={(e) => handleResizeStart("bl", e)} />
          <div className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize" onMouseDown={(e) => handleResizeStart("br", e)} onTouchStart={(e) => handleResizeStart("br", e)} />
        </>
      )}

      {/* Snap preview overlay */}
      {snapPreview && createPortal(
        <SnapPreviewOverlay zone={snapPreview.zone} at={snapPreview.at} rightInset={rightInset} />,
        document.body
      )}
    </div>
  );
}

// A window re-renders for its own props and state only. Everything it draws
// from outside them comes through hooks of its own (the language, the kiosk
// bar, the monitors), so a desktop render that hands it the same props —
// stable callbacks and the same app element — leaves it, and the app inside,
// alone.
export default memo(ChromeWindow);
