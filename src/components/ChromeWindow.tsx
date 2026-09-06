"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect, ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { createPortal } from "react-dom";
import * as kv from "@/lib/client-kv";
import SnapPreviewOverlay from "@/components/SnapPreviewOverlay";
import {
  DESKTOP_GAP,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  clampWindowPosition,
  fitWindowSize,
  getSnapRect,
  getSnapZone,
  shelfHeight,
  type SnapZone,
} from "@/lib/window-snap";

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
  const maxWidth = window.innerWidth - rInset;
  const maxHeight = window.innerHeight - shelfHeight();
  return {
    x: Math.max(20, (maxWidth - width) / 2),
    y: Math.max(20, (maxHeight - height) / 2),
  };
}

export default function ChromeWindow({
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
}: ChromeWindowProps) {
  const { t } = useT();
  // Geometry that arrives from outside — a restored workspace, a size saved on
  // a bigger screen — is fitted to THIS desktop before it is ever painted: a
  // window restored with its title bar under the shelf or its controls past the
  // right edge cannot be reached by hand, and minimize/restore and every reload
  // put it back in exactly the same place.
  const [size, setSize] = useState(() => fitWindowSize(initialSize || getSavedSize(appId, defaultWidth, defaultHeight)));
  const [position, setPosition] = useState(() => (
    initialPosition
      ? clampWindowPosition({ ...initialPosition, ...size })
      : getInitialPosition(size.width, size.height, rightInset)
  ));
  const [maximized, setMaximized] = useState(false);
  const [snapped, setSnapped] = useState<SnapZone>(null);
  const [snapPreview, setSnapPreview] = useState<SnapZone>(null);
  const [closing, setClosing] = useState(false);
  const [opening, setOpening] = useState(true);
  const [minimizing, setMinimizing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ isDragging: false, startX: 0, startY: 0, startPosX: 0, startPosY: 0 });
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
  const prevSizeRef = useRef({ width: defaultWidth, height: defaultHeight, x: 0, y: 0 });
  const currentSizeRef = useRef({ width: defaultWidth, height: defaultHeight });
  const currentPosRef = useRef(position);
  const prevMinimizedRef = useRef(minimized);
  const rightInsetRef = useRef(rightInset);

  useLayoutEffect(() => {
    rightInsetRef.current = rightInset;
  }, [rightInset]);

  useLayoutEffect(() => {
    currentSizeRef.current = size;
  }, [size]);

  useLayoutEffect(() => {
    currentPosRef.current = position;
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
    if (maximized) return;
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
        startX: clientX,
        startY: clientY,
        startPosX: newX,
        startPosY: newY,
      };
    } else {
      dragRef.current = {
        isDragging: true,
        startX: clientX,
        startY: clientY,
        startPosX: position.x,
        startPosY: position.y,
      };
    }
    setIsDragging(true);
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
          newY = Math.max(0, r.startPosY + dh);
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

      // Direct DOM update — no React re-render during drag
      if (el) {
        el.style.left = newX + "px";
        el.style.top = newY + "px";
      }
      currentPosRef.current = { x: newX, y: newY };
      // Disable pointer events on content during drag
      if (contentRef.current) contentRef.current.style.pointerEvents = "none";
      setSnapPreview(getSnapZone(clientX, clientY, rightInsetRef.current));
    };

    const notifyGeometry = () => {
      if (onGeometryChange) {
        const s = currentSizeRef.current;
        const p = currentPosRef.current;
        onGeometryChange({ x: p.x, y: p.y, width: s.width, height: s.height });
      }
    };

    const handleEnd = (e: MouseEvent | TouchEvent) => {
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
      setIsDragging(false);

      const clientX = "changedTouches" in e ? e.changedTouches[0].clientX : (e as MouseEvent).clientX;
      const clientY = "changedTouches" in e ? e.changedTouches[0].clientY : (e as MouseEvent).clientY;
      const zone = getSnapZone(clientX, clientY, rightInsetRef.current);
      setSnapPreview(null);

      if (zone) {
        const rect = getSnapRect(zone, rightInsetRef.current)!;
        const cur = currentSizeRef.current;
        const pos = currentPosRef.current;
        prevSizeRef.current = { width: cur.width, height: cur.height, x: pos.x, y: pos.y };
        setPosition({ x: rect.x, y: rect.y });
        setSize({ width: rect.width, height: rect.height });
        setSnapped(zone);
      } else {
        // Commit final drag position to React state
        setPosition(currentPosRef.current);
      }
      notifyGeometry();
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleEnd);
    window.addEventListener("touchmove", handleMove);
    window.addEventListener("touchend", handleEnd);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
    };
  }, [appId, onGeometryChange]);

  const handleClose = useCallback(() => {
    // Save window size per app
    if (appId) {
      const cur = currentSizeRef.current;
      kv.setJSON(`clawbox-winsize-${appId}`, { width: cur.width, height: cur.height });
    }
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
  // follows both.
  useEffect(() => {
    if (maximized) return;
    const relayout = () => {
      if (snapped) {
        const rect = getSnapRect(snapped, rightInset);
        if (!rect) return;
        // The desktop's shape is external state this window synchronises to.
        setPosition((p) => (p.x === rect.x && p.y === rect.y ? p : { x: rect.x, y: rect.y }));
        setSize((s) => (s.width === rect.width && s.height === rect.height ? s : { width: rect.width, height: rect.height }));
        return;
      }
      setPosition((p) => {
        const next = clampWindowPosition({ ...p, ...currentSizeRef.current });
        return next.x === p.x && next.y === p.y ? p : next;
      });
    };
    relayout();
    window.addEventListener("resize", relayout);
    return () => window.removeEventListener("resize", relayout);
  }, [maximized, snapped, rightInset]);

  const handleMinimize = useCallback(() => {
    setMinimizing(true);
    setTimeout(() => {
      setMinimizing(false);
      onMinimize();
    }, 250);
  }, [onMinimize]);

  if (minimized && !restoring) return null;

  // Maximized: the desktop's one gap on every side — beside a docked chat,
  // between the window and the chat as well, because `rightInset` ends at the
  // chat's left edge and the chat's own gap is on its far side. Corners kept,
  // so a full-screen window sits in the desktop the way the chat does.
  const windowStyle = maximized
    ? {
      left: DESKTOP_GAP,
      top: DESKTOP_GAP,
      width: `calc(100% - ${DESKTOP_GAP * 2 + rightInset}px)`,
      height: `calc(100vh - ${SHELF_HEIGHT}px - env(safe-area-inset-bottom, 0px) - ${DESKTOP_GAP * 2}px)`,
    }
      : { left: position.x, top: position.y, width: size.width, height: size.height };

  return (
    <div
      ref={windowRef}
      data-testid={appId ? `chrome-window-${appId}` : undefined}
      className={`fixed flex flex-col overflow-hidden ${
        opening ? "chrome-window-opening" : ""
      } ${closing ? "chrome-window-closing" : ""} ${
        minimizing ? "chrome-window-minimizing" : ""
      } ${restoring ? "chrome-window-restoring" : ""}`}
      style={{
        ...windowStyle,
        zIndex,
        borderRadius: snapped ? 0 : 8,
        boxShadow: isActive
          ? "0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)"
          : "0 4px 20px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.04)",
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
          background: isActive
            ? "linear-gradient(180deg, #292d36 0%, #242830 100%)"
            : "#1f2228",
          borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
          borderRadius: snapped ? 0 : "8px 8px 0 0",
        }}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        onDoubleClick={handleMaximize}
      >
        {/* Left: title */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`text-xs font-medium truncate ${isActive ? "text-white/80" : "text-white/50"}`}>{title}</span>
        </div>

        {/* Right: window controls — ChromeOS circular buttons */}
        <div className="flex items-center gap-1.5 ml-2">
          {/* Minimize */}
          <button
            onClick={handleMinimize}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20 transition-colors cursor-pointer"
            title={t("window.minimize")}
            aria-label={t("window.minimize")}
          >
            <span className="material-symbols-rounded text-white/60" style={{ fontSize: 16 }}>minimize</span>
          </button>

          {/* Maximize */}
          <button
            onClick={handleMaximize}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20 transition-colors cursor-pointer"
            title={maximized ? t("window.restore") : t("window.maximize")}
            aria-label={maximized ? t("window.restore") : t("window.maximize")}
          >
            <span className="material-symbols-rounded text-white/60" style={{ fontSize: 16 }}>{maximized ? "filter_none" : "crop_square"}</span>
          </button>

          {/* Close */}
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-red-500/80 active:bg-red-600 transition-colors cursor-pointer group"
            title={t("window.close")}
            aria-label={t("window.close")}
          >
            <span className="material-symbols-rounded text-white/60 group-hover:text-white" style={{ fontSize: 16 }}>close</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div ref={contentRef} data-chrome-window-content="true" className="flex-1 overflow-hidden bg-[#181c22]">{children}</div>

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
        <SnapPreviewOverlay zone={snapPreview} rightInset={rightInset} />,
        document.body
      )}
    </div>
  );
}

