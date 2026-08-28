"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect, useId, ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { StripButton, StripIcon, WIN_STRIP_HEIGHT, win } from "@/components/window-chrome";
import { createPortal } from "react-dom";
import * as kv from "@/lib/client-kv";

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
}

function getSavedSize(appId: string | undefined, defaultWidth: number, defaultHeight: number) {
  if (!appId || typeof window === "undefined") return { width: defaultWidth, height: defaultHeight };
  const saved = kv.getJSON<{ width: number; height: number }>(`clawbox-winsize-${appId}`);
  if (saved && saved.width >= 300 && saved.height >= 200) return saved;
  return { width: defaultWidth, height: defaultHeight };
}

type SnapZone = "left" | "right" | "top" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | null;

const SNAP_THRESHOLD = 12; // pixels from edge to trigger snap
const SHELF_HEIGHT = 56;

/**
 * The shelf's real height, safe-area inset included.
 *
 * ChromeShelf is `calc(56px + env(safe-area-inset-bottom))`; this file assumed
 * a flat 56, so on a device WITH an inset a maximized window overlapped the
 * bar — and the mascot standing on it. The inset is a device property that
 * cannot be read from JS, so the live element is measured (it marks itself
 * `data-mascot-ground` for the mascot already) and 56 stays the fallback for
 * a surface that has no shelf mounted.
 */
function shelfHeight(): number {
  if (typeof document === "undefined") return SHELF_HEIGHT;
  const el = document.querySelector("[data-mascot-ground]") as HTMLElement | null;
  const h = el?.getBoundingClientRect().height ?? 0;
  return h > 0 ? h : SHELF_HEIGHT;
}

function getSnapZone(clientX: number, clientY: number, rInset = 0): SnapZone {
  const w = window.innerWidth - rInset;
  const h = window.innerHeight - shelfHeight();
  const nearLeft = clientX <= SNAP_THRESHOLD;
  const nearRight = clientX >= w - SNAP_THRESHOLD;
  const nearTop = clientY <= SNAP_THRESHOLD;
  const nearBottom = clientY >= h - SNAP_THRESHOLD;

  if (nearTop && nearLeft) return "top-left";
  if (nearTop && nearRight) return "top-right";
  if (nearBottom && nearLeft) return "bottom-left";
  if (nearBottom && nearRight) return "bottom-right";
  if (nearLeft) return "left";
  if (nearRight) return "right";
  if (nearTop) return "top";
  return null;
}

function getSnapRect(zone: SnapZone, rInset = 0): { x: number; y: number; width: number; height: number } | null {
  if (!zone) return null;
  const w = window.innerWidth - rInset;
  const h = window.innerHeight - shelfHeight();
  switch (zone) {
    case "left": return { x: 0, y: 0, width: w / 2, height: h };
    case "right": return { x: w / 2, y: 0, width: w / 2, height: h };
    case "top": return { x: 0, y: 0, width: w, height: h };
    case "top-left": return { x: 0, y: 0, width: w / 2, height: h / 2 };
    case "top-right": return { x: w / 2, y: 0, width: w / 2, height: h / 2 };
    case "bottom-left": return { x: 0, y: h / 2, width: w / 2, height: h / 2 };
    case "bottom-right": return { x: w / 2, y: h / 2, width: w / 2, height: h / 2 };
    default: return null;
  }
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
  icon,
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
}: ChromeWindowProps) {
  const { t } = useT();
  const titleId = useId();
  const [size, setSize] = useState(() => initialSize || getSavedSize(appId, defaultWidth, defaultHeight));
  const [position, setPosition] = useState(() => initialPosition || getInitialPosition(size.width, size.height, rightInset));
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
  const MIN_WIDTH = 300;
  const MIN_HEIGHT = 200;

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
      const newX = clientX - restoreW / 2;
      const newY = clientY - WIN_STRIP_HEIGHT / 2; // centre the strip on the cursor
      setSize({ width: restoreW, height: restoreH });
      setPosition({ x: newX, y: Math.max(0, newY) });
      setSnapped(null);
      dragRef.current = {
        isDragging: true,
        startX: clientX,
        startY: clientY,
        startPosX: newX,
        startPosY: Math.max(0, newY),
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

        if (r.edge.includes("r")) newW = Math.max(MIN_WIDTH, r.startW + dx);
        if (r.edge.includes("b")) newH = Math.max(MIN_HEIGHT, r.startH + dy);
        if (r.edge.includes("l")) {
          const dw = Math.min(dx, r.startW - MIN_WIDTH);
          newW = r.startW - dw;
          newX = r.startPosX + dw;
        }
        if (r.edge.includes("t")) {
          const dh = Math.min(dy, r.startH - MIN_HEIGHT);
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
      const newX = dragRef.current.startPosX + dx;
      const newY = Math.max(0, dragRef.current.startPosY + dy);

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

  const handleMinimize = useCallback(() => {
    setMinimizing(true);
    setTimeout(() => {
      setMinimizing(false);
      onMinimize();
    }, 250);
  }, [onMinimize]);

  if (minimized && !restoring) return null;

  const windowStyle = maximized
    ? { left: 0, top: 0, width: `calc(100% - ${rightInset}px)`, height: `calc(100vh - ${SHELF_HEIGHT}px - env(safe-area-inset-bottom, 0px))` }
    : { left: position.x, top: position.y, width: size.width, height: size.height };

  return (
    <div
      ref={windowRef}
      data-testid={appId ? `chrome-window-${appId}` : undefined}
      role="region"
      aria-labelledby={titleId}
      data-active={isActive ? "true" : "false"}
      className={`fixed flex flex-col overflow-hidden ${
        opening ? "chrome-window-opening" : ""
      } ${closing ? "chrome-window-closing" : ""} ${
        minimizing ? "chrome-window-minimizing" : ""
      } ${restoring ? "chrome-window-restoring" : ""}`}
      style={{
        ...windowStyle,
        zIndex,
        background: win.ground,
        borderRadius: maximized || snapped ? 0 : win.radius,
        boxShadow: isActive ? win.shadow : win.shadowIdle,
        opacity: 1,
        transition: snapped && !isDragging
          ? "left 0.2s ease-out, top 0.2s ease-out, width 0.2s ease-out, height 0.2s ease-out, opacity 0.15s, box-shadow 0.15s"
          : "opacity 0.15s, box-shadow 0.15s",
      }}
      onMouseDown={isActive ? undefined : onFocus}
    >
      {/*
        The strip — the chat popup's control strip, in flow rather than absolute.
        Window bodies are iframes (webapp, OpenClaw), an xterm canvas and a VNC
        canvas that must own their top rows; nothing in a window scrolls under
        the strip, and over the same ground an in-flow strip is pixel-identical
        to the chat's at rest.
      */}
      <div
        data-testid="chrome-window-strip"
        className="flex items-center gap-2 shrink-0 select-none"
        style={{
          height: WIN_STRIP_HEIGHT,
          paddingLeft: 10,
          paddingRight: 8,
          background: win.stripFade,
          cursor: maximized ? "default" : "grab",
          touchAction: "none",
        }}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        onDoubleClick={handleMaximize}
      >
        {/*
          Identity: icon + muted title. Always visible: unlike the single chat,
          several windows can be open and a focused Terminal or Browser gives no
          other cue of which app it is. A fade-on-focus title was considered and
          rejected for that reason.
        */}
        {icon && (
          <span
            className="shrink-0 flex items-center [&>*]:w-4 [&>*]:h-4 [&>*]:rounded-[4px]"
            style={{ opacity: isActive ? 0.9 : 0.6 }}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <span id={titleId} className="win-strip-title flex-1 min-w-0">{title}</span>

        {/*
          Controls. Capture-phase focus: StripButton stops mousedown/touchstart
          in the bubble phase so a press never starts a drag, which would also
          stop the root's onMouseDown focus — clicking Maximize on an INACTIVE
          window would then maximise it BEHIND the active one. Capture handlers
          on this wrapper run before the button's stopPropagation. The
          onDoubleClick stop keeps a fast double-click on Maximize/Restore from
          also firing the strip's maximise.
        */}
        <div
          className="flex items-center gap-2 shrink-0"
          onMouseDownCapture={() => { if (!isActive) onFocus(); }}
          onTouchStartCapture={() => { if (!isActive) onFocus(); }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <StripButton label={t("window.minimize")} onClick={handleMinimize}>{StripIcon.minimize}</StripButton>
          <StripButton label={maximized ? t("window.restore") : t("window.maximize")} onClick={handleMaximize}>
            {maximized ? StripIcon.restore : StripIcon.maximize}
          </StripButton>
          <StripButton label={t("window.close")} onClick={handleClose}>{StripIcon.close}</StripButton>
        </div>
      </div>

      {/* Content — on the window ground, so app padding, loading states and iframe gaps show the family colour */}
      <div ref={contentRef} data-chrome-window-content="true" className="flex-1 min-h-0 overflow-hidden bg-[var(--win-ground)]">{children}</div>

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

function SnapPreviewOverlay({ zone, rightInset = 0 }: { zone: SnapZone; rightInset?: number }) {
  const rect = getSnapRect(zone, rightInset);
  if (!rect) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        background: "rgba(249,115,22,0.10)",
        border: "2px solid rgba(249,115,22,0.45)",
        borderRadius: win.radius,
        zIndex: 99999,
        pointerEvents: "none",
        transition: "all 0.15s ease-out",
      }}
    />
  );
}
